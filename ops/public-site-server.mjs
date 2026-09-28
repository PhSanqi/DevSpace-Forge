// Public, read-only DevSpace-Forge landing site. Never reuse the privileged
// management Console or an MCP process to serve this public surface.
import http from 'node:http';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLIC_SITE_PORT = 17679;
const ALLOWED_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/docs/', ['docs/index.html', 'text/html; charset=utf-8']],
  ['/docs/index.html', ['docs/index.html', 'text/html; charset=utf-8']],
  ['/assets/app.js', ['assets/app.js', 'text/javascript; charset=utf-8']],
  ['/assets/styles.css', ['assets/styles.css', 'text/css; charset=utf-8']],
  ['/assets/experience.css', ['assets/experience.css', 'text/css; charset=utf-8']],
  ['/assets/product-icon.png', ['assets/product-icon.png', 'image/png']],
  ['/assets/favicon.ico', ['assets/favicon.ico', 'image/x-icon']],
  ['/robots.txt', ['robots.txt', 'text/plain; charset=utf-8']],
  ['/sitemap.xml', ['sitemap.xml', 'application/xml; charset=utf-8']],
]);
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=3600',
};

export function createPublicSiteServer(root, publicUrl) {
  if (!publicUrl) throw new Error('Set DEVSPACE_SITE_PUBLIC_URL in the private site configuration');
  const canonical = new URL(publicUrl);
  if (canonical.protocol !== 'https:' || canonical.username || canonical.password ||
      canonical.pathname !== '/' || canonical.search || canonical.hash) {
    throw new Error('Public site URL must be an HTTPS origin without credentials, path, query or fragment');
  }
  const staticRoot = resolve(root);
  return http.createServer((request, response) => {
    const headers = { ...SECURITY_HEADERS, 'cache-control': 'no-store' };
    const finish = (status, message, extra = {}) => {
      response.writeHead(status, { ...headers, 'content-type': 'text/plain; charset=utf-8', ...extra });
      response.end(request.method === 'HEAD' ? undefined : message);
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      finish(405, 'Method not allowed', { allow: 'GET, HEAD' });
      return;
    }
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
      // Reject encoded path separators or dot-segment aliases before serving.
      if (/%2f|%5c|%2e|\\/i.test(request.url.split('?')[0])) throw new Error('invalid path');
    } catch {
      finish(400, 'Bad request');
      return;
    }
    // In the Tunnel, Cloudflare sets X-Forwarded-Proto. Redirect to the
    // fixed canonical host; never construct a redirect from the Host header.
    // Local loopback requests without the forwarded header remain HTTP.
    if (request.headers['x-forwarded-proto'] === 'http' && (pathname === '/docs' || ALLOWED_FILES.has(pathname))) {
      response.writeHead(308, { ...headers, location: canonical.origin + request.url });
      response.end();
      return;
    }
    if (pathname === '/docs') {
      response.writeHead(308, { ...headers, location: '/docs/' });
      response.end();
      return;
    }
    const entry = ALLOWED_FILES.get(pathname);
    if (!entry) {
      finish(404, 'Not found');
      return;
    }
    const [file, mime] = entry;
    const absolute = join(staticRoot, file);
    let stat;
    try {
      stat = statSync(absolute);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      finish(404, 'Not found');
      return;
    }
    const etag = `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
    headers['content-type'] = mime;
    headers['cache-control'] = pathname.startsWith('/assets/') ? 'public, max-age=3600' : 'public, max-age=300';
    headers.etag = etag;
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    response.writeHead(200, { ...headers, 'content-length': stat.size });
    if (request.method === 'HEAD') response.end();
    else createReadStream(absolute).pipe(response);
  });
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const value = flag => {
    const index = args.indexOf(flag);
    if (index === -1 || !args[index + 1]) throw new Error(`Missing ${flag}`);
    return args[index + 1];
  };
  const root = value('--root');
  const port = Number(args.includes('--port') ? value('--port') : PUBLIC_SITE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  createPublicSiteServer(root, process.env.DEVSPACE_SITE_PUBLIC_URL).listen(port, '127.0.0.1', () => {
    console.log(`DevSpace public site: http://127.0.0.1:${port}`);
  });
}
