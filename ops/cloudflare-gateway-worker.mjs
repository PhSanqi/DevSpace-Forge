const INSTANCES = {
  group: "group-origin.sanqi.org",
  server: "server-origin.sanqi.org",
};

function resolveInstance(pathname) {
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

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const instance = resolveInstance(url.pathname);
    if (!instance) return new Response("Not found", { status: 404 });
    url.hostname = INSTANCES[instance];
    return fetch(new Request(url, request));
  },
};
