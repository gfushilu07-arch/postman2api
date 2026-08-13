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

export const db = drizzle(sqlite, { schema });
export { sqlite as client };
export type DB = typeof db;
