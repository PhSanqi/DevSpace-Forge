import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { SqliteOAuthStore } from "./oauth-store.js";
import { createServer } from "./server.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

test("HTTP MCP enforces canonical and exact alias bearer resources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-http-oauth-"));
  const canonical = "https://agent.example.com/mcp";
  const alias = "https://tunnel.example.com/v1/mcp/tunnel_123";
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    server: { publicBaseUrl: "https://agent.example.com" },
    storage: { stateDir: join(root, "state") },
    workspaces: { allowedRoots: [root] },
    oauth: { allowedResourceUrls: [alias] },
    logging: { level: "silent" },
  }));
  const store = new SqliteOAuthStore(config.stateDir);
  const client = store.registerClient({
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
  }, config.oauth.allowedRedirectHosts);
  const cases = [
    { resource: canonical, accepted: true },
    { resource: alias, accepted: true },
    { resource: `${alias}/child`, accepted: false },
    { resource: `${alias}?other=1`, accepted: false },
    { resource: "https://tunnel.example.com/v1/mcp/other", accepted: false },
  ];
  for (const { resource } of cases) {
    store.saveAccessToken(createHash("sha256").update(resource).digest("base64url"), {
      clientId: client.client_id, scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600, resource,
    });
  }
  store.close();
  const running = createServer(config);
  const listener = running.app.listen(0, "127.0.0.1");
  t.after(async () => {
    await running.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  for (const { resource, accepted } of cases) {
    const response: Response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resource}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "resource-test", version: "1.0.0" } },
      }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.text();
    assert.equal(response.status, accepted ? 200 : 401, `${resource}: ${body}`);
    if (accepted) assert.match(body, /"serverInfo"/);
  }
});

test("HTTP authorization code exchange and refresh survive a service restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-oauth-restart-http-"));
  const publicBaseUrl = "https://stable.example.test";
  const aliasResource = "https://tunnel.example.test/v1/mcp/t_123";
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const verifier = "restart-integration-verifier-01234567890123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    server: { publicBaseUrl },
    storage: { stateDir: join(root, "state") },
    workspaces: { allowedRoots: [root] },
    oauth: { allowedResourceUrls: [aliasResource] },
    logging: { level: "warn", format: "json", requests: false },
  }));

  let running = createServer(config);
  let listener = running.app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const baseUrl = (): string => {
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  };
  const stop = async (): Promise<void> => {
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    await running.close();
  };
  const start = async (serverConfig = config): Promise<void> => {
    running = createServer(serverConfig);
    listener = running.app.listen(0, "127.0.0.1");
    await once(listener, "listening");
  };
  t.after(async () => {
    await stop();
    await rm(root, { recursive: true, force: true });
  });

  const registration = await fetch(`${baseUrl()}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Restart test",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201, await registration.clone().text());
  const { client_id: clientId } = await registration.json() as { client_id: string };
  assert.ok(clientId);

  const authorize = async (state: string): Promise<string> => {
    const approval = await fetch(`${baseUrl()}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "devspace",
        resource: aliasResource,
        state,
        owner_token: config.oauth.ownerToken,
      }),
    });
    assert.equal(approval.status, 302, await approval.clone().text());
    const redirect = new URL(approval.headers.get("location") ?? "");
    assert.equal(redirect.searchParams.get("state"), state);
    const code = redirect.searchParams.get("code");
    assert.ok(code);
    return code;
  };
  const exchangeCode = (code: string): Promise<Response> => fetch(`${baseUrl()}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: aliasResource,
    }),
  });

  // Authorize, then restart the whole server before exchanging the code.
  const code = await authorize("restart-state");
  await stop();
  await start();

  const exchange = await exchangeCode(code);
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const issued = await exchange.json() as { access_token: string; refresh_token: string };
  assert.ok(issued.access_token);
  assert.ok(issued.refresh_token);

  const refreshed = await fetch(`${baseUrl()}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: issued.refresh_token,
      resource: aliasResource,
    }),
  });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const rotated = await refreshed.json() as { access_token: string; refresh_token: string };
  assert.ok(rotated.access_token);
  assert.notEqual(rotated.refresh_token, issued.refresh_token);

  // Replaying a consumed code is rejected with a diagnostic event.
  const replayEvents: unknown[] = [];
  const replay = await captureRejections(replayEvents, () => exchangeCode(code));
  assert.equal(replay.status, 400, await replay.clone().text());
  assert.deepEqual(oauthRejectionEvents(replayEvents), [
    { phase: "authorization_code", reason: "code_already_used_or_expired" },
  ]);

  // A code saved while a resource alias was allowed is rejected after the
  // alias is removed and the server restarts.
  const aliasedCode = await authorize("alias-removed");
  await stop();
  await start({ ...config, oauth: { ...config.oauth, allowedResourceUrls: [] } });
  const aliasEvents: unknown[] = [];
  const aliasExchange = await captureRejections(aliasEvents, () => exchangeCode(aliasedCode));
  assert.equal(aliasExchange.status, 400, await aliasExchange.clone().text());
  assert.deepEqual(oauthRejectionEvents(aliasEvents), [
    { phase: "authorization_code", reason: "resource_mismatch" },
  ]);
});

test("HTTP MCP supports a path-based public base URL", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-http-base-path-"));
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    server: { publicBaseUrl: "https://dev.example.com/server" },
    storage: { stateDir: join(root, "state") },
    workspaces: { allowedRoots: [root] },
    logging: { level: "silent" },
  }));
  const running = createServer(config);
  const listener = running.app.listen(0, "127.0.0.1");
  t.after(async () => {
    await running.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const rootMcp = await fetch(`${base}/mcp`);
  assert.equal(rootMcp.status, 404);

  const mcp = await fetch(`${base}/server/mcp`);
  assert.equal(mcp.status, 401);
  assert.match(
    mcp.headers.get("www-authenticate") ?? "",
    /resource_metadata="https:\/\/dev\.example\.com\/\.well-known\/oauth-protected-resource\/server\/mcp"/,
  );

  const authorizationMetadata = await fetch(
    `${base}/.well-known/oauth-authorization-server/server`,
  );
  assert.equal(authorizationMetadata.status, 200);
  const authorization = await authorizationMetadata.json() as Record<string, unknown>;
  assert.equal(authorization.issuer, "https://dev.example.com/server");
  assert.equal(authorization.authorization_endpoint, "https://dev.example.com/server/authorize");
  assert.equal(authorization.token_endpoint, "https://dev.example.com/server/token");
  assert.equal(authorization.registration_endpoint, "https://dev.example.com/server/register");
  assert.equal(authorization.revocation_endpoint, "https://dev.example.com/server/revoke");

  const resourceMetadata = await fetch(
    `${base}/.well-known/oauth-protected-resource/server/mcp`,
  );
  assert.equal(resourceMetadata.status, 200);
  const resource = await resourceMetadata.json() as Record<string, unknown>;
  assert.equal(resource.resource, "https://dev.example.com/server/mcp");
  assert.deepEqual(resource.authorization_servers, ["https://dev.example.com/server"]);

  const registration = await fetch(`${base}/server/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.notEqual(registration.status, 404);
});

async function captureRejections<T>(lines: unknown[], run: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = ((...args: unknown[]) => {
    lines.push(args);
  }) as typeof console.warn;
  try {
    return await run();
  } finally {
    console.warn = original;
  }
}

function oauthRejectionEvents(lines: unknown[]): Array<{ phase: string; reason: string }> {
  return lines.flatMap((args) => {
    const line = Array.isArray(args) ? args.map(String).join(" ") : String(args);
    try {
      const entry = JSON.parse(line) as { event?: string; phase?: string; reason?: string };
      return entry.event === "oauth_rejected" && entry.phase && entry.reason
        ? [{ phase: entry.phase, reason: entry.reason }]
        : [];
    } catch {
      return [];
    }
  });
}
