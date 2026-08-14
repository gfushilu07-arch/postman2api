import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { pruneExpiredSessions, pruneRequestLogs } from "../src/db/retention";

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDatabase(): Database {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      status TEXT NOT NULL
    );
    CREATE TABLE request_stats_totals (
      id INTEGER PRIMARY KEY,
      total_requests INTEGER NOT NULL DEFAULT 0,
      success_requests INTEGER NOT NULL DEFAULT 0,
      error_requests INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO request_stats_totals VALUES (1, 0, 0, 0, 0, 0, 0, 0);
    CREATE TABLE session_states (
      session_id TEXT PRIMARY KEY,
      account_id INTEGER,
      messages TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return database;
}

describe("SQLite retention", () => {
  test("archives at the high-water mark and keeps the newest request details", () => {
    const database = createDatabase();
    const insert = database.query(`
      INSERT INTO request_logs (
        prompt_tokens, completion_tokens, total_tokens, status
      ) VALUES (?1, ?2, ?3, ?4)
    `);
    for (let index = 1; index <= 100; index++) {
      insert.run(index, 1, index + 1, index % 4 === 0 ? "error" : "success");
    }

    expect(pruneRequestLogs(database, 50, 100)).toBe(50);
    expect(database.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM request_logs",
    ).get()?.count).toBe(50);
    expect(database.query<{ minId: number; maxId: number }, []>(
      "SELECT MIN(id) AS minId, MAX(id) AS maxId FROM request_logs",
    ).get()).toEqual({ minId: 51, maxId: 100 });
    expect(database.query<{
      totalRequests: number;
      successRequests: number;
      errorRequests: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }, []>(`
      SELECT
        total_requests AS totalRequests,
        success_requests AS successRequests,
        error_requests AS errorRequests,
        prompt_tokens AS promptTokens,
        completion_tokens AS completionTokens,
        total_tokens AS totalTokens
      FROM request_stats_totals WHERE id = 1
    `).get()).toEqual({
      totalRequests: 50,
      successRequests: 38,
      errorRequests: 12,
      promptTokens: 1275,
      completionTokens: 50,
      totalTokens: 1325,
    });

    expect(pruneRequestLogs(database, 50, 100)).toBe(0);
  });

  test("deletes expired idle sessions but preserves in-flight and recent sessions", () => {
    const database = createDatabase();
    const now = Math.floor(Date.now() / 1000);
    const expired = now - 31 * 86_400;
    const recent = now - 2 * 86_400;
    const insert = database.query(`
      INSERT INTO session_states (
        session_id, account_id, messages, created_at, updated_at
      ) VALUES (?1, ?2, '[]', ?3, ?4)
    `);
    insert.run("expired-idle", 1, expired, expired);
    insert.run("expired-busy", 2, expired, expired);
    insert.run("recent-idle", 3, recent, recent);
    const forgotten: string[] = [];

    expect(pruneExpiredSessions(
      database,
      30,
      (sessionId) => sessionId === "expired-busy",
      (sessionId) => forgotten.push(sessionId),
    )).toBe(1);
    expect(forgotten).toEqual(["expired-idle"]);
    expect(database.query<{ sessionId: string }, []>(`
      SELECT session_id AS sessionId FROM session_states ORDER BY session_id
    `).all()).toEqual([
      { sessionId: "expired-busy" },
      { sessionId: "recent-idle" },
    ]);
  });
});
