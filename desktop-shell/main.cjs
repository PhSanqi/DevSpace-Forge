const { app, BrowserWindow } = require('electron');

const DEFAULT_URL = 'http://127.0.0.1:17678/next/';

/** @param {string | undefined} value */
function controlUrl(value) {
  const url = new URL(value || DEFAULT_URL);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.startsWith('/next/') || url.username || url.password) {
    throw new Error('DEVSPACE_CONTROL_URL must be an HTTP loopback /next/ URL.');
  }
  return url;
}

const target = controlUrl(process.env.DEVSPACE_CONTROL_URL);
const errorPage = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><html><meta charset="utf-8"><title>Control unavailable</title>' +
  '<body style="font:16px system-ui;padding:3rem"><h1>Control is unavailable</h1>' +
  '<p>The local Control UI could not be loaded. Check the Runtime Console and reopen the desktop app.</p></body></html>');

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1180, height: 820, minWidth: 760, minHeight: 580,
    backgroundColor: '#f7f7f5',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  /** @param {string} value */
  const allowed = (value) => {
    try {
      const url = new URL(value);
      return url.origin === target.origin && url.pathname.startsWith('/next/');
    } catch { return false; }
  };
  window.webContents.on('will-navigate', (event, value) => {
    if (!allowed(value)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, value) => {
    if (!allowed(value)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !(details.url === errorPage || details.url.startsWith(target.origin + '/api/') || allowed(details.url)) });
  });
  window.loadURL(target.href).catch(() => window.loadURL(errorPage));
});

app.on('window-all-closed', () => app.quit());

module.exports = { controlUrl };
