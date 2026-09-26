const INSTANCES = {
  group: "group-origin.sanqi.org",
  server: "server-origin.sanqi.org",
};

export function resolveInstance(pathname) {
  for (const name of Object.keys(INSTANCES)) {
    if (
      pathname === `/${name}` ||
      pathname.startsWith(`/${name}/`) ||
      pathname.startsWith(`/.well-known/oauth-authorization-server/${name}`) ||
      pathname.startsWith(`/.well-known/oauth-protected-resource/${name}`)
    ) {
      return name;
    }
  }
  return null;
}

export function gatewayRoute(input) {
  const url = new URL(input);
  const instance = resolveInstance(url.pathname);
  if (!instance) return { kind: "not-found" };
  if (url.protocol === "http:") {
    const canonical = new URL(url);
    canonical.protocol = "https:";
    return { kind: "redirect", url: canonical };
  }
  const origin = new URL(url);
  origin.protocol = "https:";
  origin.hostname = INSTANCES[instance];
  return { kind: "origin", instance, url: origin };
}

export default {
  async fetch(request) {
    const route = gatewayRoute(request.url);
    if (route.kind === "not-found") return new Response("Not found", { status: 404 });
    if (route.kind === "redirect") return Response.redirect(route.url, 308);
    return fetch(new Request(route.url, request));
  },
};
