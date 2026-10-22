import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { inspectOAuthState } from "./oauth-diagnostics.js";
import { SqliteOAuthStore } from "./oauth-store.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const execFileAsync = promisify(execFile);

test("OAuth doctor reads counts without exposing or changing credential state", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-auth-doctor-"));
  const stateDir = join(root, "state");
  const configDir = join(root, "config");
  try {
    const empty = inspectOAuthState(join(root, "not-created"));
    assert.equal(empty.databaseExists, false);
    assert.equal(empty.clients, 0);
    assert.equal(empty.pendingAuthorizationCodes, 0);

    const now = Math.floor(Date.now() / 1000);
    const store = new SqliteOAuthStore(stateDir);
    let clientId = "";
    try {
      const client = store.registerClient({
        redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      }, ["chatgpt.com"]);
      clientId = client.client_id;
      store.saveRefreshToken("secret-refresh-hash", {
        clientId,
        scopes: ["devspace"],
        expiresAt: now + 3600,
        resource: "https://mcp.example.com/mcp",
      });
      store.saveAccessToken("secret-access-hash", {
        clientId,
        scopes: ["devspace"],
        expiresAt: now + 60,
        resource: "https://mcp.example.com/mcp",
      });
      store.saveAuthorizationCode("secret-code-hash", {
        clientId,
        redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
        codeChallenge: "secret-challenge",
        scopes: ["devspace"],
        resource: "https://mcp.example.com/mcp",
        expiresAt: now + 300,
      });
      store.saveAuthorizationCode("secret-expired-code-hash", {
        clientId,
        redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
        codeChallenge: "secret-expired-challenge",
        scopes: ["devspace"],
        expiresAt: now - 1,
      });
    } finally {
      store.close();
    }

    const snapshot = inspectOAuthState(stateDir, now);
    assert.deepEqual(snapshot, {
      databaseExists: true,
      clients: 1,
      activeAccessTokens: 1,
      activeRefreshTokens: 1,
      pendingAuthorizationCodes: 1,
      soonestRefreshExpiry: now + 3600,
    });

    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /secret|client_id|token_hash|challenge/);
    assert.equal(serialized.includes(clientId), false);

    // Diagnostics open the database read-only and leave credentials untouched.
    const reopened = new SqliteOAuthStore(stateDir);
    try {
      assert.ok(reopened.getRefreshToken("secret-refresh-hash"));
      assert.ok(reopened.getAuthorizationCode("secret-code-hash"));
    } finally {
      reopened.close();
    }

    const env = writeTestDevspaceConfig(configDir, {
      storage: { stateDir },
      logging: { level: "silent" },
    });
    const { stdout } = await execFileAsync(
      "node",
      ["--import", "tsx", "src/cli.ts", "doctor", "--auth"],
      { env: { ...process.env, ...env }, timeout: 60_000 },
    );
    assert.match(stdout, /OAuth state path: /);
    assert.match(stdout, /OAuth registered clients: 1/);
    assert.match(stdout, /OAuth unexpired access tokens: 1/);
    assert.match(stdout, /OAuth unexpired refresh tokens: 1/);
    assert.match(stdout, /OAuth pending authorization codes: 1/);
    assert.doesNotMatch(
      stdout,
      /secret-refresh-hash|secret-access-hash|secret-code-hash|secret-challenge/,
    );
    assert.equal(stdout.includes(clientId), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
