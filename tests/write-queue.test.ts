import { afterEach, describe, expect, test } from "bun:test";
import { eq, like } from "drizzle-orm";
import { config } from "../src/config";
import { db } from "../src/db/index";
import { requestLogs, sessionStates } from "../src/db/schema";
import {
  clearPersistedSessionConversation,
  flushDatabaseWriteQueue,
  initializeDatabaseWriteQueue,
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

describe("SQLite serialized write queue", () => {
  test("starts and writes using only the test database", async () => {
    expect(config.runtimeEnvironment).toBe("test");
    expect(config.databasePath).not.toBe(
      new URL("../data/postman2api.db", import.meta.url).pathname,
    );

    await initializeDatabaseWriteQueue();
    await writeRequestLog({
      model: "write-queue-probe",
      status: "success",
    });
    await flushDatabaseWriteQueue();

    const [saved] = await db.select().from(requestLogs)
      .where(eq(requestLogs.model, "write-queue-probe"))
      .orderBy(requestLogs.id)
      .limit(1);
    expect(saved?.status).toBe("success");
    if (saved) requestLogIds.add(saved.id);
  });

  test("serializes a burst of concurrent request-log writes without losing rows", async () => {
    const marker = `write-burst-${crypto.randomUUID()}`;
    const count = 100;

    await Promise.all(Array.from({ length: count }, (_, index) => writeRequestLog({
      model: `${marker}-${index}`,
      status: index % 2 === 0 ? "success" : "error",
    })));
    await flushDatabaseWriteQueue();

    const saved = await db.select().from(requestLogs)
      .where(like(requestLogs.model, `${marker}-%`));
    expect(saved).toHaveLength(count);
    for (const row of saved) requestLogIds.add(row.id);
  });

  test("persists and selectively clears the upstream conversation binding", async () => {
    const sessionId = `codex:write-queue-${crypto.randomUUID()}`;
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
