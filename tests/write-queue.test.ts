import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { config } from "../src/config";
import { db } from "../src/db/index";
import { requestLogs, sessionStates } from "../src/db/schema";
import {
  clearPersistedSessionConversation,
  flushDatabaseWriteQueue,
  initializeDatabaseWriteQueue,
  resolveWriteWorkerUrl,
  writeRequestLog,
  writeSessionState,
} from "../src/db/write-queue";

const requestLogIds = new Set<number>();
const sessionIds = new Set<string>();

afterEach(async () => {
  await flushDatabaseWriteQueue();
  for (const id of requestLogIds) {
    await db.delete(requestLogs).where(eq(requestLogs.id, id));
  }
  requestLogIds.clear();
  for (const sessionId of sessionIds) {
    await db.delete(sessionStates).where(eq(sessionStates.sessionId, sessionId));
  }
  sessionIds.clear();
});

describe("SQLite write worker", () => {
  test("resolves the worker beside source code and inside the compiled db directory", () => {
    expect(resolveWriteWorkerUrl(
      "file:///workspace/src/db/write-queue.ts",
      "/workspace/src/db/write-queue.ts",
    ).pathname).toBe("/workspace/src/db/write-worker.ts");

    expect(resolveWriteWorkerUrl(
      "file:///app/dist/index.js",
      "/app/dist/index.js",
    ).pathname).toBe("/app/dist/db/write-worker.js");
  });

  test("starts and writes through the worker using only the test database", async () => {
    expect(config.runtimeEnvironment).toBe("test");
    expect(config.databasePath).not.toBe(
      new URL("../data/postman2api.db", import.meta.url).pathname,
    );

    await initializeDatabaseWriteQueue();
    await writeRequestLog({
      model: "write-worker-probe",
      status: "success",
    });
    await flushDatabaseWriteQueue();

    const [saved] = await db.select().from(requestLogs)
      .where(eq(requestLogs.model, "write-worker-probe"))
      .orderBy(requestLogs.id)
      .limit(1);
    expect(saved?.status).toBe("success");
    if (saved) requestLogIds.add(saved.id);
  });

  test("persists and selectively clears the upstream conversation binding", async () => {
    const sessionId = `codex:write-worker-${crypto.randomUUID()}`;
    const accountId = 7_001;
    const conversationUpdatedAt = Math.floor(Date.now() / 1000) - 30;
    sessionIds.add(sessionId);

    await writeSessionState({
      sessionId,
      accountId,
      conversationId: "postman-conversation-1",
      conversationUpdatedAt,
      messages: JSON.stringify([{ role: "user", content: "hello" }]),
      turnCount: 1,
      estimatedTokens: 9,
      messageChars: 35,
    });
    await flushDatabaseWriteQueue();

    let [saved] = await db.select().from(sessionStates)
      .where(eq(sessionStates.sessionId, sessionId))
      .limit(1);
    expect(saved?.accountId).toBe(accountId);
    expect(saved?.conversationId).toBe("postman-conversation-1");
    expect(saved?.conversationUpdatedAt?.getTime()).toBe(conversationUpdatedAt * 1000);

    await clearPersistedSessionConversation(sessionId, accountId + 1);
    await flushDatabaseWriteQueue();
    [saved] = await db.select().from(sessionStates)
      .where(eq(sessionStates.sessionId, sessionId))
      .limit(1);
    expect(saved?.conversationId).toBe("postman-conversation-1");

    await clearPersistedSessionConversation(sessionId, accountId);
    await flushDatabaseWriteQueue();
    [saved] = await db.select().from(sessionStates)
      .where(eq(sessionStates.sessionId, sessionId))
      .limit(1);
    expect(saved?.conversationId).toBeNull();
    expect(saved?.conversationUpdatedAt).toBeNull();
    expect(saved?.messages).toContain("hello");
  });
});
