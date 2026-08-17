import { Hono } from "hono";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index";
import { accounts, requestLogs, sessionStates } from "../db/schema";
import { pool } from "../proxy/pool";
import { PostmanProvider } from "../provider/postman";
import { broadcast } from "../ws/index";

const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const MAX_MANAGED_SESSIONS = 500;
const MAX_SESSION_ID_LENGTH = 320;

export const sessionsRouter = new Hono();
const recoveryProvider = new PostmanProvider();

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
    conversationId: sessionStates.conversationId,
    conversationUpdatedAt: sessionStates.conversationUpdatedAt,
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
      hasConversation: Boolean(row.conversationId),
      conversationUpdatedAt: row.conversationUpdatedAt,
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
      recoverable: data.filter((item) => (
        item.accountId !== null && !item.hasConversation
      )).length,
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

sessionsRouter.post("/recover", async (c) => {
  const body = await c.req.json().catch(() => null) as { sessionId?: unknown } | null;
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId || sessionId.length > MAX_SESSION_ID_LENGTH) {
    return c.json({ error: "sessionId must be a valid session ID" }, 400);
  }
  if (pool.isSessionInFlight(sessionId)) {
    return c.json({ error: "正在处理请求的会话不能执行恢复" }, 409);
  }

  const [session] = await db.select().from(sessionStates)
    .where(eq(sessionStates.sessionId, sessionId)).limit(1);
  if (!session) return c.json({ error: "会话不存在" }, 404);
  if (session.accountId === null) {
    return c.json({ error: "会话没有原始绑定账号，无法安全恢复 Postman 上游会话" }, 409);
  }
  if (session.conversationId) {
    return c.json({
      success: true,
      recovered: false,
      alreadyBound: true,
      conversationId: session.conversationId,
    });
  }

  const [account] = await db.select().from(accounts)
    .where(eq(accounts.id, session.accountId)).limit(1);
  if (!account) return c.json({ error: "原始绑定账号已被删除，无法恢复" }, 409);

  const [latestRequest] = await db.select({
    model: requestLogs.model,
  }).from(requestLogs)
    .where(eq(requestLogs.sessionId, sessionId))
    .orderBy(desc(requestLogs.createdAt))
    .limit(1);
  if (!latestRequest?.model) {
    return c.json({ error: "缺少该会话最近使用的模型记录，已停止恢复以避免绑定错误模型" }, 409);
  }

  let messages;
  try {
    messages = JSON.parse(session.messages);
  } catch {
    return c.json({ error: "本地会话历史损坏，无法安全匹配 Postman 云端会话" }, 409);
  }

  const result = await recoveryProvider.recoverConversation(account, {
    model: latestRequest.model,
    messages,
    _sessionId: sessionId,
  });
  if (!result.recovered || !result.conversationId) {
    const reason = {
      no_local_anchor: "本地历史缺少可用于唯一匹配的 assistant/tool 指纹",
      no_history: "原始账号没有可查询的 Postman 云端会话历史",
      no_compatible_candidate: "未找到模型、状态和内容都匹配的 Postman 云端会话",
      ambiguous: "找到多个相近候选，为避免串会话已停止自动绑定",
      history_error: result.error || "Postman 云端历史查询失败",
      recovered: "恢复失败",
    }[result.reason];
    return c.json({
      error: `恢复失败：${reason}`,
      recovery: result,
    }, 409);
  }

  broadcast({ type: "session_updated", data: { sessionId, accountId: account.id } });
  return c.json({
    success: true,
    recovered: true,
    conversationId: result.conversationId,
    score: result.score,
    scanned: result.scanned,
  });
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
