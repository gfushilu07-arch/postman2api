import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import * as schema from "./schema";
import { config } from "../config";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

mkdirSync(dirname(config.databasePath), { recursive: true });

const sqlite = new Database(config.databasePath, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA synchronous = NORMAL;");
sqlite.exec("PRAGMA busy_timeout = 5000;");
sqlite.exec("PRAGMA foreign_keys = ON;");
sqlite.exec(`CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  enabled INTEGER NOT NULL DEFAULT 1,
  tokens TEXT,
  quota_limit REAL DEFAULT 0,
  quota_remaining REAL DEFAULT 0,
  quota_reset_at INTEGER,
  last_used_at INTEGER,
  last_login_at INTEGER,
  error_message TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);`);
sqlite.exec(`CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER REFERENCES accounts(id),
  session_id TEXT,
  model TEXT,
  reasoning_effort TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  token_source TEXT,
  request_messages TEXT,
  response_message TEXT,
  status TEXT NOT NULL,
  ttfb_ms INTEGER,
  duration_ms INTEGER,
  error_message TEXT,
  created_at INTEGER NOT NULL
);`);
sqlite.exec(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);`);
sqlite.exec(`CREATE TABLE IF NOT EXISTS session_states (
  session_id TEXT PRIMARY KEY,
  account_id INTEGER,
  conversation_id TEXT,
  conversation_updated_at INTEGER,
  messages TEXT NOT NULL,
  turn_count INTEGER NOT NULL DEFAULT 0,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  message_chars INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);`);
sqlite.exec("CREATE INDEX IF NOT EXISTS session_states_updated_at_idx ON session_states(updated_at);");
sqlite.exec("CREATE INDEX IF NOT EXISTS session_states_account_idx ON session_states(account_id);");
sqlite.exec("CREATE INDEX IF NOT EXISTS request_logs_created_at_idx ON request_logs(created_at);");
sqlite.exec("CREATE INDEX IF NOT EXISTS request_logs_status_created_at_idx ON request_logs(status, created_at);");
sqlite.exec("CREATE INDEX IF NOT EXISTS request_logs_account_idx ON request_logs(account_id);");
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
sqlite.query(
  "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('admin_key', 'postman2api', ?1)",
).run(Math.floor(Date.now() / 1000));

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

const sessionStateColumns = sqlite.query("PRAGMA table_info(session_states);").all() as Array<{ name: string }>;
if (sessionStateColumns.length > 0) {
  const existingColumns = new Set(sessionStateColumns.map((column) => column.name));
  if (!existingColumns.has("conversation_id")) {
    sqlite.exec("ALTER TABLE session_states ADD COLUMN conversation_id TEXT;");
  }
  if (!existingColumns.has("conversation_updated_at")) {
    sqlite.exec("ALTER TABLE session_states ADD COLUMN conversation_updated_at INTEGER;");
  }
  if (!existingColumns.has("turn_count")) {
    sqlite.exec("ALTER TABLE session_states ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0;");
    sqlite.exec(`
      UPDATE session_states
      SET turn_count = (
        SELECT COUNT(*)
        FROM json_each(CASE
          WHEN json_valid(session_states.messages) THEN session_states.messages
          ELSE '[]'
        END)
        WHERE json_extract(json_each.value, '$.role') = 'user'
      );
    `);
  }
  if (!existingColumns.has("estimated_tokens")) {
    sqlite.exec("ALTER TABLE session_states ADD COLUMN estimated_tokens INTEGER NOT NULL DEFAULT 0;");
    sqlite.exec(`
      UPDATE session_states
      SET estimated_tokens = CAST((length(messages) + 3) / 4 AS INTEGER)
      WHERE estimated_tokens = 0 AND messages IS NOT NULL;
    `);
  }
  if (!existingColumns.has("message_chars")) {
    sqlite.exec("ALTER TABLE session_states ADD COLUMN message_chars INTEGER NOT NULL DEFAULT 0;");
    sqlite.exec(`
      UPDATE session_states
      SET message_chars = length(messages)
      WHERE message_chars = 0 AND messages IS NOT NULL;
    `);
  }
}

export const db = drizzle(sqlite, { schema });
export { sqlite as client };
export type DB = typeof db;
