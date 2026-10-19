import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { databasePath } from "./db/client.js";

export interface OAuthDiagnosticSnapshot {
  databaseExists: boolean;
  clients: number;
  activeAccessTokens: number;
  activeRefreshTokens: number;
  /** Authorization codes that are still unconsumed and unexpired. */
  pendingAuthorizationCodes: number;
  soonestRefreshExpiry?: number;
}

/**
 * Read-only inventory of the OAuth state database.
 *
 * Never returns or prints client IDs, token values, token hashes, authorization
 * codes, or owner secrets: only counts and one expiry timestamp.
 */
export function inspectOAuthState(
  stateDir: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): OAuthDiagnosticSnapshot {
  const empty: OAuthDiagnosticSnapshot = {
    databaseExists: false,
    clients: 0,
    activeAccessTokens: 0,
    activeRefreshTokens: 0,
    pendingAuthorizationCodes: 0,
  };
  const path = databasePath(stateDir);
  if (!existsSync(path)) return empty;

  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    database.pragma("busy_timeout = 5000");

    const hasTable = (table: string): boolean =>
      Boolean(
        database
          .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
          .get(table),
      );
    const count = (table: string, expirationColumn?: "expires_at"): number => {
      if (!hasTable(table)) return 0;
      const sql = expirationColumn
        ? `select count(*) as count from ${table} where ${expirationColumn} >= ?`
        : `select count(*) as count from ${table}`;
      const row = database.prepare(sql).get(...(expirationColumn ? [nowSeconds] : [])) as
        | { count: number }
        | undefined;
      return Number(row?.count ?? 0);
    };

    const snapshot: OAuthDiagnosticSnapshot = {
      databaseExists: true,
      clients: count("oauth_clients"),
      activeAccessTokens: count("oauth_access_tokens", "expires_at"),
      activeRefreshTokens: count("oauth_refresh_tokens", "expires_at"),
      pendingAuthorizationCodes: count("oauth_authorization_codes", "expires_at"),
    };

    if (snapshot.activeRefreshTokens > 0 && hasTable("oauth_refresh_tokens")) {
      const soonest = database
        .prepare("select min(expires_at) as expires_at from oauth_refresh_tokens where expires_at >= ?")
        .get(nowSeconds) as { expires_at: number | null } | undefined;
      if (typeof soonest?.expires_at === "number") {
        snapshot.soonestRefreshExpiry = soonest.expires_at;
      }
    }

    return snapshot;
  } finally {
    database.close();
  }
}
