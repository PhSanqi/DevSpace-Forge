const { app, BrowserWindow, Menu, Tray } = require('electron');
const path = require('node:path');

const DEFAULT_URL = 'http://127.0.0.1:17678/';

/** @param {string | undefined} value */
function controlUrl(value) {
  const url = new URL(value || DEFAULT_URL);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      !((url.pathname === '/') || url.pathname.startsWith('/next/')) || url.username || url.password) {
    throw new Error('DEVSPACE_CONTROL_URL must be an HTTP loopback Control URL.');
  }
  return url;
}

const target = controlUrl(process.env.DEVSPACE_CONTROL_URL);
/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;
/** @type {import('electron').Tray | null} */
let tray = null;
let quitting = false;
const errorPage = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><html><meta charset="utf-8"><title>Control unavailable</title>' +
  '<body style="font:16px system-ui;padding:3rem"><h1>Control is unavailable</h1>' +
  '<p>The local Control UI could not be loaded. Check the Runtime Console and reopen the desktop app.</p></body></html>');

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1180, height: 820, minWidth: 760, minHeight: 580,
    backgroundColor: '#f7f7f5',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  mainWindow = window;
  /** @param {string} value */
  const allowed = (value) => {
    try {
      const url = new URL(value);
      return url.origin === target.origin && !url.username && !url.password;
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
    callback({ cancel: !(details.url === errorPage || allowed(details.url)) });
  });
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  window.loadURL(target.href).catch(() => window.loadURL(errorPage));

  tray = new Tray(path.join(__dirname, 'DevSpaceForge.ico'));
  tray.setToolTip('DevSpace-Forge');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open DevSpace-Forge', click: showMainWindow },
    { type: 'separator' },
    { label: 'Exit', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', showMainWindow);
});

app.on('activate', showMainWindow);
app.on('before-quit', () => { quitting = true; });

module.exports = { controlUrl, showMainWindow };
