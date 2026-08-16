import { Hono } from "hono";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index";
import { accounts, sessionStates } from "../db/schema";
import { pool } from "../proxy/pool";

const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const MAX_MANAGED_SESSIONS = 500;
const MAX_SESSION_ID_LENGTH = 320;

export const sessionsRouter = new Hono();

function normalizeSessionIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MANAGED_SESSIONS) {
    return null;
  }
  const ids = [...new Set(value.map((item) => typeof item === "string" ? item.trim() : ""))];
  if (ids.some((id) => !id || id.length > MAX_SESSION_ID_LENGTH)) return null;
  return ids;
}

async function readSessionIds(c: { req: { json(): Promise<unknown> } }): Promise<string[] | null> {
  const body = await c.req.json().catch(() => null) as { sessionIds?: unknown } | null;
  return normalizeSessionIds(body?.sessionIds);
}

export async function listSessionBindings() {
  const rows = await db.select({
    sessionId: sessionStates.sessionId,
    accountId: sessionStates.accountId,
    turnCount: sessionStates.turnCount,
    estimatedTokens: sessionStates.estimatedTokens,
    messageChars: sessionStates.messageChars,
    revision: sessionStates.revision,
    createdAt: sessionStates.createdAt,
    updatedAt: sessionStates.updatedAt,
    accountEmail: accounts.email,
    accountStatus: accounts.status,
    accountEnabled: accounts.enabled,
  }).from(sessionStates)
    .leftJoin(accounts, eq(sessionStates.accountId, accounts.id))
    .orderBy(desc(sessionStates.updatedAt));

  const now = Date.now();
  const data = rows.map((row) => {
    const abnormal = row.accountId !== null && (
      !row.accountEmail || !row.accountEnabled || row.accountStatus !== "active"
    );
    return {
      sessionId: row.sessionId,
      accountId: row.accountId,
      accountEmail: row.accountEmail,
      accountStatus: row.accountStatus,
      accountEnabled: row.accountEnabled,
      revision: row.revision,
      turnCount: row.turnCount,
      estimatedTokens: row.estimatedTokens,
      messageChars: row.messageChars,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      isInFlight: pool.isSessionInFlight(row.sessionId),
      abnormal,
    };
  });

  return {
    data,
    summary: {
      total: data.length,
      active30m: data.filter((item) => now - item.updatedAt.getTime() <= ACTIVE_WINDOW_MS).length,
      boundAccounts: new Set(data.flatMap((item) => item.accountId === null ? [] : [item.accountId])).size,
      abnormal: data.filter((item) => item.abnormal).length,
    },
  };
}

export async function releaseSessionBindings(sessionIds: string[]): Promise<void> {
  const rows = await db.select({
    sessionId: sessionStates.sessionId,
    accountId: sessionStates.accountId,
  }).from(sessionStates).where(inArray(sessionStates.sessionId, sessionIds));

  for (const row of rows) pool.forgetSession(row.sessionId, row.accountId);
  await db.update(sessionStates).set({
    accountId: null,
    conversationId: null,
    conversationUpdatedAt: null,
  })
    .where(inArray(sessionStates.sessionId, sessionIds));
}

export async function removeSessionBindings(sessionIds: string[]): Promise<void> {
  const rows = await db.select({
    sessionId: sessionStates.sessionId,
    accountId: sessionStates.accountId,
  }).from(sessionStates).where(inArray(sessionStates.sessionId, sessionIds));

  for (const row of rows) pool.forgetSession(row.sessionId, row.accountId);
  await db.delete(sessionStates).where(inArray(sessionStates.sessionId, sessionIds));
}

sessionsRouter.get("/", async (c) => c.json(await listSessionBindings()));

sessionsRouter.post("/release", async (c) => {
  const sessionIds = await readSessionIds(c);
  if (!sessionIds) return c.json({ error: "sessionIds must contain 1 to 500 valid session IDs" }, 400);
  const busySessionIds = sessionIds.filter((id) => pool.isSessionInFlight(id));
  if (busySessionIds.length > 0) {
    return c.json({ error: "正在处理请求的会话不能解除绑定", busySessionIds }, 409);
  }
  await releaseSessionBindings(sessionIds);
  return c.json({ success: true, count: sessionIds.length });
});

sessionsRouter.post("/batch-release", async (c) => {
  const sessionIds = await readSessionIds(c);
  if (!sessionIds) return c.json({ error: "sessionIds must contain 1 to 500 valid session IDs" }, 400);
  const busySessionIds = sessionIds.filter((id) => pool.isSessionInFlight(id));
  if (busySessionIds.length > 0) {
    return c.json({ error: "正在处理请求的会话不能解除绑定", busySessionIds }, 409);
  }
  await releaseSessionBindings(sessionIds);
  return c.json({ success: true, count: sessionIds.length });
});

sessionsRouter.post("/delete", async (c) => {
  const sessionIds = await readSessionIds(c);
  if (!sessionIds) return c.json({ error: "sessionIds must contain 1 to 500 valid session IDs" }, 400);
  const busySessionIds = sessionIds.filter((id) => pool.isSessionInFlight(id));
  if (busySessionIds.length > 0) {
    return c.json({ error: "正在处理请求的会话不能清除", busySessionIds }, 409);
  }
  await removeSessionBindings(sessionIds);
  return c.json({ success: true, count: sessionIds.length });
});

sessionsRouter.delete("/", async (c) => {
  const sessionIds = await readSessionIds(c);
  if (!sessionIds) return c.json({ error: "sessionIds must contain 1 to 500 valid session IDs" }, 400);
  const busySessionIds = sessionIds.filter((id) => pool.isSessionInFlight(id));
  if (busySessionIds.length > 0) {
    return c.json({ error: "正在处理请求的会话不能清除", busySessionIds }, 409);
  }
  await removeSessionBindings(sessionIds);
  return c.json({ success: true, count: sessionIds.length });
});
