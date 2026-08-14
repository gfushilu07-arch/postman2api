import { db, client } from "./index";
import { sql } from "drizzle-orm";

async function migrate() {
  console.log("[migrate] Creating tables...");

  await db.run(sql`CREATE TABLE IF NOT EXISTS accounts (
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
  )`);

  await db.run(sql`CREATE TABLE IF NOT EXISTS request_logs (
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
  )`);

  // Keep existing SQLite databases compatible with newer request details.
  const requestLogColumns = (await db.all(
    sql`PRAGMA table_info(request_logs)`,
  )) as Array<{ name: string }>;
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
      await db.run(sql.raw(`ALTER TABLE request_logs ADD COLUMN ${name} ${type}`));
    }
  }

  await db.run(sql`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER
  )`);

  await db.run(sql`CREATE TABLE IF NOT EXISTS session_states (
    session_id TEXT PRIMARY KEY,
    account_id INTEGER,
    messages TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  await db.run(sql`CREATE INDEX IF NOT EXISTS request_logs_created_at_idx ON request_logs(created_at)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS request_logs_status_created_at_idx ON request_logs(status, created_at)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS request_logs_account_idx ON request_logs(account_id)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS session_states_updated_at_idx ON session_states(updated_at)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS session_states_account_idx ON session_states(account_id)`);

  await db.run(sql`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('admin_key', 'postman2api', ${Date.now()})`);

  console.log("[migrate] Done. Tables created: accounts, request_logs, settings, session_states");
  client.close();
}

migrate().catch((err) => {
  console.error("[migrate] Error:", err);
  process.exit(1);
});
