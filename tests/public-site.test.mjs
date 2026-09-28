import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createPublicSiteServer } from '../ops/public-site-server.mjs';

const root = fileURLToPath(new URL('../site/', import.meta.url));
test('public site serves only static marketing pages and assets on loopback', async () => {
  const server = createPublicSiteServer(root, 'https://site.example.com');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await fetch(origin + '/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    const homeHtml = await home.text();
    assert.match(homeHtml, /DevSpace-Forge/);
    assert.match(homeHtml, /<html lang="zh-CN" data-theme="light">/);
    assert.match(homeHtml, /不用离开 Chat/);
    assert.match(homeHtml, /CHAT ALLOWANCE \+ WORK \/ CODEX ALLOWANCE/);
    assert.match(homeHtml, /\/assets\/product-icon\.png/);
    assert.match(home.headers.get('content-security-policy'), /connect-src 'none'/);
    assert.equal(home.headers.get('strict-transport-security'), 'max-age=3600');
    const docs = await fetch(origin + '/docs/', { method: 'HEAD' });
    assert.equal(docs.status, 200);
    assert.equal(await docs.text(), '');
    const redirect = await fetch(origin + '/docs', { redirect: 'manual' });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), '/docs/');
    const httpsUpgrade = await fetch(origin + '/docs/?probe=1', { redirect: 'manual', headers: { 'x-forwarded-proto': 'http', host: 'untrusted.example' } });
    assert.equal(httpsUpgrade.status, 308);
    assert.equal(httpsUpgrade.headers.get('location'), 'https://site.example.com/docs/?probe=1');
    const asset = await fetch(origin + '/assets/app.js');
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
    const etag = asset.headers.get('etag');
    assert.equal((await fetch(origin + '/assets/app.js', { headers: { 'if-none-match': etag } })).status, 304);
    const experience = await fetch(origin + '/assets/experience.css');
    assert.equal(experience.status, 200);
    assert.match(experience.headers.get('content-type'), /text\/css/);
    assert.equal((await fetch(origin + '/assets/product-icon.png')).status, 200);
    assert.equal((await fetch(origin + '/assets/favicon.ico')).status, 200);
    for (const path of ['/server/mcp', '/group/mcp', '/api/status', '/.well-known/oauth-protected-resource/server/mcp', '/.git/config', '/package.json']) {
      const response = await fetch(origin + path, { redirect: 'manual' });
      assert.notEqual(response.status, 200, path);
    }
    // fetch() normalizes encoded dot segments; send a raw HTTP target to
    // verify the server rejects it before pathname normalization.
    const encodedStatus = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/assets/%2e%2e/index.html' }, response => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(encodedStatus, 400);
    assert.equal((await fetch(origin + '/', { method: 'POST' })).status, 405);
    assert.equal((await fetch(origin + '/sitemap.xml')).status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
