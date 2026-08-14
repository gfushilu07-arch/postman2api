import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import * as schema from "./schema";
import { config } from "../config";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

mkdirSync(dirname(config.databasePath), { recursive: true });

const sqlite = new Database(config.databasePath, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");
sqlite.exec(`CREATE TABLE IF NOT EXISTS session_states (
  session_id TEXT PRIMARY KEY,
  account_id INTEGER,
  messages TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);`);
sqlite.exec("CREATE INDEX IF NOT EXISTS session_states_updated_at_idx ON session_states(updated_at);");
sqlite.exec("CREATE INDEX IF NOT EXISTS session_states_account_idx ON session_states(account_id);");
sqlite.exec(`CREATE TABLE IF NOT EXISTS request_stats_totals (
  id INTEGER PRIMARY KEY,
  total_requests INTEGER NOT NULL DEFAULT 0,
  success_requests INTEGER NOT NULL DEFAULT 0,
  error_requests INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);`);
sqlite.query(`INSERT OR IGNORE INTO request_stats_totals (
  id, total_requests, success_requests, error_requests,
  prompt_tokens, completion_tokens, total_tokens, updated_at
) VALUES (1, 0, 0, 0, 0, 0, 0, ?1);`).run(Math.floor(Date.now() / 1000));

const requestLogColumns = sqlite.query("PRAGMA table_info(request_logs);").all() as Array<{ name: string }>;
if (requestLogColumns.length > 0) {
  const existingColumns = new Set(requestLogColumns.map((column) => column.name));
  const additions: Array<[string, string]> = [
    ["session_id", "TEXT"],
    ["reasoning_effort", "TEXT"],
    ["token_source", "TEXT"],
    ["request_messages", "TEXT"],
    ["response_message", "TEXT"],
    ["ttfb_ms", "INTEGER"],
  ];
  for (const [name, type] of additions) {
    if (!existingColumns.has(name)) {
      sqlite.exec(`ALTER TABLE request_logs ADD COLUMN ${name} ${type};`);
    }
  }
}

export const db = drizzle(sqlite, { schema });
export { sqlite as client };
export type DB = typeof db;
