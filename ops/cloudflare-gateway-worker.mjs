// Optional multi-instance Worker. Configure origin hostnames as deployment
// variables; never put real Tunnel domains or credentials in the repository.
const INSTANCES = ['group', 'server'];

export function resolveInstance(pathname) {
  for (const name of INSTANCES) {
    if (
      pathname === '/' + name ||
      pathname.startsWith('/' + name + '/') ||
      pathname.startsWith('/.well-known/oauth-authorization-server/' + name) ||
      pathname.startsWith('/.well-known/oauth-protected-resource/' + name)
    ) return name;
  }
  return null;
}

function validateOriginHost(input) {
  if (typeof input !== 'string' || !/^[a-z0-9.-]+$/i.test(input) ||
      input.includes('..') || !input.includes('.') || input.startsWith('-')) return null;
  try {
    const parsed = new URL('https://' + input);
    return parsed.hostname.toLowerCase() === input.toLowerCase() ? parsed.hostname : null;
  } catch {
    return null;
  }
}

export function gatewayRoute(input, origins = {}) {
  const url = new URL(input);
  const instance = resolveInstance(url.pathname);
  if (!instance) return { kind: 'not-found' };
  if (url.protocol === 'http:') {
    const canonical = new URL(url);
    canonical.protocol = 'https:';
    return { kind: 'redirect', url: canonical };
  }
  const hostname = validateOriginHost(origins[instance]);
  if (!hostname) return { kind: 'misconfigured' };
  const origin = new URL(url);
  origin.protocol = 'https:';
  origin.hostname = hostname;
  return { kind: 'origin', instance, url: origin };
}

export function withGatewaySecurityHeaders(response) {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set('strict-transport-security', 'max-age=3600');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env = {}) {
    const route = gatewayRoute(request.url, {
      group: env.GROUP_ORIGIN_HOST,
      server: env.SERVER_ORIGIN_HOST,
    });
    if (route.kind === 'not-found') return new Response('Not found', { status: 404 });
    if (route.kind === 'misconfigured') return new Response('Gateway origin is not configured', { status: 503 });
    if (route.kind === 'redirect') return Response.redirect(route.url, 308);
    return withGatewaySecurityHeaders(await fetch(new Request(route.url, request)));
  },
};
