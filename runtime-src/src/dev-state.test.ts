import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const root = await mkdtemp(join(tmpdir(), "devspace-dev-state-test-"));
const checkoutRoot = join(root, "checkout");
const sourceConfigDir = join(root, "config");
const sourceStateDir = join(root, "state");
const scriptPath = fileURLToPath(new URL("../scripts/dev-state.ts", import.meta.url));
const devScriptPath = fileURLToPath(new URL("../scripts/dev.ts", import.meta.url));
const tsxCliPath = fileURLToPath(import.meta.resolve("tsx/cli"));

try {
  await mkdir(checkoutRoot, { recursive: true });
  await mkdir(join(sourceConfigDir, "skills", "example"), { recursive: true });
  await mkdir(sourceStateDir, { recursive: true });
  await writeFile(join(sourceConfigDir, "config.jsonc"), JSON.stringify({
    configVersion: 1,
    storage: { stateDir: sourceStateDir },
  }));
  await writeFile(join(sourceConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "test-owner-token-that-is-long-enough",
  }));
  await writeFile(join(sourceConfigDir, "skills", "example", "SKILL.md"), "example skill\n");

  const sourceDatabase = new Database(join(sourceStateDir, "devspace.sqlite"));
  sourceDatabase.exec(`
    create table marker (value text);
    insert into marker values ('source');
    create table oauth_clients (client_id text primary key, client_json text not null, issued_at integer not null);
    create table oauth_access_tokens (token_hash text primary key, client_id text not null, scopes_json text not null, expires_at integer not null, resource text);
    create table oauth_refresh_tokens (token_hash text primary key, client_id text not null, scopes_json text not null, expires_at integer not null, resource text);
    create table oauth_authorization_codes (code_hash text primary key, client_id text not null, redirect_uri text not null, code_challenge text not null, scopes_json text not null, resource text, created_at integer not null, expires_at integer not null);
    insert into oauth_clients values ('production-client', '{}', 1);
    insert into oauth_access_tokens values ('production-access', 'production-client', '[]', 9999999999, null);
    insert into oauth_refresh_tokens values ('production-refresh', 'production-client', '[]', 9999999999, null);
    insert into oauth_authorization_codes values ('production-code', 'production-client', 'https://chatgpt.com/connector_platform_oauth_redirect', 'challenge', '[]', null, 1, 9999999999);
  `);
  sourceDatabase.close();

  await runDevState("seed");

  const devRoot = join(checkoutRoot, ".devspace-dev");
  const localConfig = JSON.parse(
    await readFile(join(devRoot, "config", "config.jsonc"), "utf8"),
  ) as {
    storage: { stateDir: string };
    server: { host: string; port: number; publicBaseUrl: string | null; allowedHosts: string[] };
    oauth: { allowedResourceUrls: string[] };
  };
  assert.equal(
    await realpath(localConfig.storage.stateDir),
    await realpath(join(devRoot, "state")),
  );
  // QA forks get their own loopback issuer and never reuse production resources.
  assert.equal(localConfig.server.host, "127.0.0.1");
  assert.equal(localConfig.server.port, 8676);
  assert.equal(localConfig.server.publicBaseUrl, "http://127.0.0.1:8676");
  assert.deepEqual(localConfig.server.allowedHosts, []);
  assert.deepEqual(localConfig.oauth.allowedResourceUrls, []);
  assert.equal(existsSync(join(devRoot, "config", "auth.json")), true);
  assert.equal(existsSync(join(devRoot, "config", "skills", "example", "SKILL.md")), true);

  const localDatabasePath = join(devRoot, "state", "devspace.sqlite");
  const localDatabase = new Database(localDatabasePath);
  assert.equal(localDatabase.prepare("select value from marker").pluck().get(), "source");
  for (const table of [
    "oauth_access_tokens",
    "oauth_refresh_tokens",
    "oauth_authorization_codes",
    "oauth_clients",
  ]) {
    assert.equal(
      localDatabase.prepare(`select count(*) from ${table}`).pluck().get(),
      0,
      `${table} should be empty in the QA fork`,
    );
  }
  localDatabase.exec("insert into marker values ('local-only')");
  localDatabase.close();

  await assert.rejects(runDevState("seed"), /already initialized/);

  await rm(join(sourceConfigDir, "auth.json"));
  await assert.rejects(runDevState("reset"), /No auth\.json found/);

  const preservedDatabase = new Database(localDatabasePath, { readonly: true });
  try {
    assert.deepEqual(
      preservedDatabase.prepare("select value from marker order by rowid").pluck().all(),
      ["source", "local-only"],
    );
  } finally {
    preservedDatabase.close();
  }

  await writeFile(join(sourceConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "test-owner-token-that-is-long-enough",
  }));
  await runDevState("reset");

  const resetDatabase = new Database(localDatabasePath, { readonly: true });
  assert.deepEqual(resetDatabase.prepare("select value from marker order by rowid").pluck().all(), ["source"]);
  resetDatabase.close();

  // An old fork that still carries the production issuer must refuse to start.
  const qaConfigPath = join(devRoot, "config", "config.jsonc");
  const qaConfig = JSON.parse(await readFile(qaConfigPath, "utf8")) as Record<string, unknown>;
  qaConfig.server = {
    host: "127.0.0.1",
    port: 7676,
    publicBaseUrl: null,
    allowedHosts: [],
    trustProxy: false,
  };
  await writeFile(qaConfigPath, `${JSON.stringify(qaConfig, null, 2)}\n`);
  await assert.rejects(runDev(), /Refusing to run a QA OAuth database fork/);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("dev state tests passed");

async function runDev(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tsxCliPath, devScriptPath],
      {
        cwd: checkoutRoot,
        env: {
          ...process.env,
          DEVSPACE_CONFIG_DIR: sourceConfigDir,
          DEVSPACE_OAUTH_OWNER_TOKEN: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `dev exited with ${code}`));
    });
  });
}

async function runDevState(command: "seed" | "reset"): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tsxCliPath, scriptPath, command],
      {
        cwd: checkoutRoot,
        env: {
          ...process.env,
          DEVSPACE_CONFIG_DIR: sourceConfigDir,
          DEVSPACE_OAUTH_OWNER_TOKEN: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `dev-state exited with ${code}`));
    });
  });
}
