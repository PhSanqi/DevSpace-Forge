import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Response } from "express";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { databasePath, openDatabase } from "./db/client.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-oauth-test-"));
const oauthConfig = {
  ownerToken: "test-owner-token-that-is-long-enough",
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2592000,
  scopes: ["devspace"],
  allowedResourceUrls: ["https://tunnel.example.com/v1/mcp/tunnel_123"],
  allowedRedirectHosts: ["chatgpt.com"],
};
const mcpUrl = new URL("https://agent.example.com/mcp");
const tunnelUrl = new URL(oauthConfig.allowedResourceUrls[0]!);
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";

try {
  await testDatabaseConfiguration(join(root, "database-configuration"));
  testPersistenceAndTokenHashing(join(root, "persistence"));
  testExpiredTokenCleanup(join(root, "expiration"));
  testTransactionalTokenRotation(join(root, "rotation"));
  testAuthorizationCodeLifecycle(join(root, "authorization-codes"));
  testAuthorizationCodeTableIsRollbackSafe(join(root, "rollback-safe"));
  await testAuthorizationCodeSurvivesRestart(join(root, "authorization-code-restart"));
  await testProviderRestartRotationAndRevocation(join(root, "provider"));
  await testRefreshResourcePolicy(join(root, "refresh-policy"));
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testDatabaseConfiguration(stateDir: string): Promise<void> {
  const database = openDatabase(stateDir);
  try {
    assert.equal(database.sqlite.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(database.sqlite.pragma("synchronous", { simple: true }), 1);
    assert.equal(database.sqlite.pragma("busy_timeout", { simple: true }), 5000);
    assert.equal(database.sqlite.pragma("foreign_keys", { simple: true }), 1);

    const migrations = database.sqlite
      .prepare("select version, name from devspace_schema_migrations order by version")
      .all();
    assert.deepEqual(migrations, [
      { version: 1, name: "workspace-state" },
      { version: 2, name: "oauth-state" },
      { version: 3, name: "local-agent-sessions" },
      { version: 4, name: "workspace-conversation-bindings" },
      { version: 5, name: "local-agent-structured-errors" },
      { version: 6, name: "local-agent-effort-rename" },
      { version: 7, name: "workspace-recovery-state" },
      { version: 8, name: "local-agent-turns" },
      { version: 9, name: "workflow-sessions" },
    ]);
  } finally {
    database.close();
  }

  if (process.platform !== "win32") {
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(databasePath(stateDir))).mode & 0o777, 0o600);
  }
}

function testPersistenceAndTokenHashing(stateDir: string): void {
  const accessToken = "access-token-example";
  const refreshToken = "refresh-token-example";
  const firstStore = new SqliteOAuthStore(stateDir);
  const firstClients = new SqliteOAuthClientsStore(firstStore, oauthConfig.allowedRedirectHosts);
  const client = firstClients.registerClient({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
  });

  firstStore.saveTokenPair({
    accessTokenHash: hashToken(accessToken),
    accessToken: {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: mcpUrl.href,
    },
    refreshTokenHash: hashToken(refreshToken),
    refreshToken: {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 2592000,
      resource: mcpUrl.href,
    },
  });
  firstStore.close();

  const database = openDatabase(stateDir);
  try {
    const accessHashes = database.sqlite
      .prepare("select token_hash from oauth_access_tokens")
      .pluck()
      .all() as string[];
    const refreshHashes = database.sqlite
      .prepare("select token_hash from oauth_refresh_tokens")
      .pluck()
      .all() as string[];
    assert.deepEqual(accessHashes, [hashToken(accessToken)]);
    assert.deepEqual(refreshHashes, [hashToken(refreshToken)]);
    assert.equal(accessHashes.includes(accessToken), false);
    assert.equal(refreshHashes.includes(refreshToken), false);
  } finally {
    database.close();
  }

  const restoredStore = new SqliteOAuthStore(stateDir);
  try {
    const restoredClient = restoredStore.getClient(client.client_id);
    assert.equal(restoredClient?.client_id, client.client_id);
    assert.equal(restoredStore.getAccessToken(hashToken(accessToken))?.resource, mcpUrl.href);
    assert.equal(restoredStore.getRefreshToken(hashToken(refreshToken))?.clientId, client.client_id);
  } finally {
    restoredStore.close();
  }
}

function testExpiredTokenCleanup(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  const client = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts).registerClient({
    redirect_uris: [redirectUri],
  });
  const expiredAt = Math.floor(Date.now() / 1000) - 1;
  store.saveTokenPair({
    accessTokenHash: "expired-access-hash",
    accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt: expiredAt },
    refreshTokenHash: "expired-refresh-hash",
    refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt: expiredAt },
  });
  store.close();

  const reopened = new SqliteOAuthStore(stateDir);
  try {
    assert.equal(reopened.getAccessToken("expired-access-hash"), undefined);
    assert.equal(reopened.getRefreshToken("expired-refresh-hash"), undefined);
  } finally {
    reopened.close();
  }
}

function testTransactionalTokenRotation(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const client = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts).registerClient({
      redirect_uris: [redirectUri],
    });
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    store.saveRefreshToken("old-refresh-hash", {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt,
    });

    assert.equal(
      store.saveTokenPair(
        {
          accessTokenHash: "new-access-hash",
          accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
          refreshTokenHash: "new-refresh-hash",
          refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
        },
        "old-refresh-hash",
      ),
      true,
    );
    assert.equal(store.getRefreshToken("old-refresh-hash"), undefined);
    assert.ok(store.getAccessToken("new-access-hash"));
    assert.ok(store.getRefreshToken("new-refresh-hash"));

    assert.equal(
      store.saveTokenPair(
        {
          accessTokenHash: "losing-access-hash",
          accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
          refreshTokenHash: "losing-refresh-hash",
          refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
        },
        "old-refresh-hash",
      ),
      false,
    );
    assert.equal(store.getAccessToken("losing-access-hash"), undefined);
    assert.equal(store.getRefreshToken("losing-refresh-hash"), undefined);
  } finally {
    store.close();
  }
}

function testAuthorizationCodeLifecycle(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const client = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts).registerClient({
      redirect_uris: [redirectUri],
    });
    const now = Math.floor(Date.now() / 1000);
    const rawCode = "code-raw-secret-value";
    store.saveAuthorizationCode(hashToken(rawCode), {
      clientId: client.client_id,
      redirectUri,
      codeChallenge: "lifecycle-challenge",
      scopes: ["devspace"],
      resource: mcpUrl.href,
      expiresAt: now + 300,
    });

    // Only the hash is stored; the raw code is not a lookup key.
    assert.equal(store.getAuthorizationCode(rawCode), undefined);
    const stored = store.getAuthorizationCode(hashToken(rawCode));
    assert.equal(stored?.clientId, client.client_id);
    assert.equal(stored?.redirectUri, redirectUri);
    assert.equal(stored?.codeChallenge, "lifecycle-challenge");
    assert.deepEqual(stored?.scopes, ["devspace"]);
    assert.equal(stored?.resource, mcpUrl.href);

    // Single use: the second consume returns nothing.
    assert.ok(store.consumeAuthorizationCode(hashToken(rawCode)));
    assert.equal(store.consumeAuthorizationCode(hashToken(rawCode)), undefined);

    // Expired codes cannot be consumed and are purged on the next save.
    const expiredCode = "code-expired";
    store.saveAuthorizationCode(hashToken(expiredCode), {
      clientId: client.client_id,
      redirectUri,
      codeChallenge: "expired-challenge",
      scopes: ["devspace"],
      expiresAt: now - 1,
    });
    assert.equal(store.consumeAuthorizationCode(hashToken(expiredCode)), undefined);
    store.saveAuthorizationCode(hashToken("code-live-after-expired"), {
      clientId: client.client_id,
      redirectUri,
      codeChallenge: "live-challenge",
      scopes: ["devspace"],
      expiresAt: now + 300,
    });
    assert.equal(store.getAuthorizationCode(hashToken(expiredCode)), undefined);
    assert.ok(store.getAuthorizationCode(hashToken("code-live-after-expired")));
  } finally {
    store.close();
  }

  // Startup purges codes that expired while the process was stopped.
  const restartStore = new SqliteOAuthStore(stateDir);
  const client = new SqliteOAuthClientsStore(restartStore, oauthConfig.allowedRedirectHosts)
    .registerClient({ redirect_uris: [redirectUri] });
  restartStore.saveAuthorizationCode("expired-at-startup", {
    clientId: client.client_id,
    redirectUri,
    codeChallenge: "startup-challenge",
    scopes: ["devspace"],
    expiresAt: Math.floor(Date.now() / 1000) - 1,
  });
  restartStore.close();
  const purgedStore = new SqliteOAuthStore(stateDir);
  try {
    assert.equal(purgedStore.getAuthorizationCode("expired-at-startup"), undefined);
  } finally {
    purgedStore.close();
  }
}

async function testAuthorizationCodeSurvivesRestart(stateDir: string): Promise<void> {
  const first = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  const client = await first.clientsStore.registerClient?.({
    redirect_uris: [redirectUri],
  });
  assert.ok(client);

  const code = await authorizeAndGetCode(first, client, {
    redirectUri,
    codeChallenge: "restart-pkce-challenge",
    scopes: ["devspace"],
    state: "test-state",
    resource: mcpUrl,
  });
  first.close();

  const second = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  try {
    assert.ok(second.clientsStore.getClient(client.client_id));
    assert.equal(await second.challengeForAuthorizationCode(client, code), "restart-pkce-challenge");
    await assert.rejects(
      second.exchangeAuthorizationCode(client, code, undefined, redirectUri, tunnelUrl),
      InvalidGrantError,
    );
    const tokens = await second.exchangeAuthorizationCode(client, code, undefined, redirectUri, mcpUrl);
    assert.equal((await second.verifyAccessToken(tokens.access_token)).resource?.href, mcpUrl.href);
    await assert.rejects(
      second.exchangeAuthorizationCode(client, code, undefined, redirectUri, mcpUrl),
      InvalidGrantError,
    );
  } finally {
    second.close();
  }

  const database = openDatabase(stateDir);
  try {
    assert.equal(
      database.sqlite.prepare("select count(*) from oauth_authorization_codes").pluck().get(),
      0,
    );
  } finally {
    database.close();
  }
}

async function testProviderRestartRotationAndRevocation(stateDir: string): Promise<void> {
  const firstProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  assert.equal(firstProvider.isResourceAllowed(mcpUrl), true);
  assert.equal(firstProvider.isResourceAllowed(new URL(`${mcpUrl.href}/session`)), true);
  assert.equal(firstProvider.isResourceAllowed(tunnelUrl), true);
  assert.equal(firstProvider.isResourceAllowed(new URL(`${tunnelUrl.href}/session`)), false);
  assert.equal(firstProvider.isResourceAllowed(new URL(`${tunnelUrl.href}?other=1`)), false);
  const client = await firstProvider.clientsStore.registerClient?.({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
  });
  assert.ok(client);

  const code = await authorizeAndGetCode(firstProvider, client, {
    redirectUri,
    codeChallenge: "challenge",
    scopes: ["devspace"],
    resource: tunnelUrl,
  });
  await assert.rejects(
    firstProvider.exchangeAuthorizationCode(client, code, undefined, redirectUri, mcpUrl),
    InvalidGrantError,
  );
  const issued = await firstProvider.exchangeAuthorizationCode(
    client,
    code,
    undefined,
    redirectUri,
    tunnelUrl,
  );
  assert.ok(issued.refresh_token);
  firstProvider.close();

  const removedAliasProvider = new SingleUserOAuthProvider(
    { ...oauthConfig, allowedResourceUrls: [] }, mcpUrl, stateDir,
  );
  try {
    for (const resource of [undefined, tunnelUrl, mcpUrl]) {
      await assert.rejects(
        removedAliasProvider.exchangeRefreshToken(client, issued.refresh_token, undefined, resource),
        InvalidGrantError,
      );
    }
  } finally {
    removedAliasProvider.close();
  }

  const secondProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  try {
    const verified = await secondProvider.verifyAccessToken(issued.access_token);
    assert.equal(verified.clientId, client.client_id);
    assert.equal(verified.resource?.href, tunnelUrl.href);

    await assert.rejects(
      secondProvider.exchangeRefreshToken(client, issued.refresh_token, ["devspace"], mcpUrl),
      InvalidGrantError,
    );

    const refreshed = await secondProvider.exchangeRefreshToken(
      client,
      issued.refresh_token,
      ["devspace"],
      tunnelUrl,
    );
    assert.ok(refreshed.refresh_token);
    assert.notEqual(refreshed.access_token, issued.access_token);

    const inherited = await secondProvider.exchangeRefreshToken(client, refreshed.refresh_token);
    assert.ok(inherited.refresh_token);
    assert.equal((await secondProvider.verifyAccessToken(inherited.access_token)).resource?.href, tunnelUrl.href);

    await assert.rejects(
      secondProvider.exchangeRefreshToken(client, issued.refresh_token, ["devspace"], tunnelUrl),
      InvalidGrantError,
    );

    await secondProvider.revokeToken(client, { token: inherited.access_token });
    await assert.rejects(secondProvider.verifyAccessToken(inherited.access_token), InvalidTokenError);

    await secondProvider.revokeToken(client, { token: inherited.refresh_token });
    await assert.rejects(
      secondProvider.exchangeRefreshToken(client, inherited.refresh_token, ["devspace"], tunnelUrl),
      InvalidGrantError,
    );
  } finally {
    secondProvider.close();
  }
}

async function testRefreshResourcePolicy(stateDir: string): Promise<void> {
  const store = new SqliteOAuthStore(stateDir);
  const client = store.registerClient({ redirect_uris: [redirectUri] }, oauthConfig.allowedRedirectHosts);
  for (const [token, resource] of [["canonical", mcpUrl.href], ["missing", undefined]] as const) {
    store.saveRefreshToken(hashToken(token), {
      clientId: client.client_id, scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600, resource,
    });
  }
  store.close();
  const provider = new SingleUserOAuthProvider({ ...oauthConfig, allowedResourceUrls: [] }, mcpUrl, stateDir);
  try {
    await assert.rejects(provider.exchangeRefreshToken(client, "missing"), InvalidGrantError);
    const tokens = await provider.exchangeRefreshToken(client, "canonical");
    assert.equal((await provider.verifyAccessToken(tokens.access_token)).resource?.href, mcpUrl.href);
  } finally {
    provider.close();
  }
}

async function authorizeAndGetCode(
  provider: SingleUserOAuthProvider,
  client: OAuthClientInformationFull,
  params: Parameters<SingleUserOAuthProvider["authorize"]>[1],
): Promise<string> {
  let location = "";
  const response = {
    req: { method: "POST", body: { owner_token: oauthConfig.ownerToken }, ip: "127.0.0.1" },
    redirect: (_status: number, url: string) => {
      location = url;
    },
  } as unknown as Response;
  await provider.authorize(client, params, response);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);
  return code;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

// Runtime slots share one state dir and older builds reject unknown migration
// versions, so the auth-code table must exist without a new version row.
function testAuthorizationCodeTableIsRollbackSafe(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  store.close();
  const database = openDatabase(stateDir);
  try {
    const maxVersion = database.sqlite
      .prepare("select max(version) as version from devspace_schema_migrations")
      .get() as { version: number };
    assert.equal(maxVersion.version, 9, "no versioned migration may be added for the auth-code table");
    const table = database.sqlite
      .prepare("select name from sqlite_master where type = 'table' and name = 'oauth_authorization_codes'")
      .get();
    assert.ok(table, "auth-code table is ensured on store open");
  } finally {
    database.close();
  }
}
