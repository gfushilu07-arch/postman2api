import { Hono } from "hono";
import { db } from "../db/index";
import { requestLogs, accounts } from "../db/schema";
import { desc, eq, sql } from "drizzle-orm";

export const statsRouter = new Hono();

statsRouter.get("/", async (c) => {
  const [totalResult] = await db.select({ count: sql<number>`count(*)` }).from(requestLogs);
  const [successResult] = await db.select({ count: sql<number>`count(*)` })
    .from(requestLogs).where(sql`status = 'success'`);
  const [errorResult] = await db.select({ count: sql<number>`count(*)` })
    .from(requestLogs).where(sql`status = 'error'`);
  const [tokenResult] = await db.select({
    prompt: sql<number>`COALESCE(SUM(prompt_tokens), 0)`,
    completion: sql<number>`COALESCE(SUM(completion_tokens), 0)`,
    total: sql<number>`COALESCE(SUM(total_tokens), 0)`,
  }).from(requestLogs);

  const [accountCount] = await db.select({ count: sql<number>`count(*)` }).from(accounts);
  const [activeCount] = await db.select({ count: sql<number>`count(*)` })
    .from(accounts).where(sql`status = 'active' AND enabled = 1`);

  // Recent requests (last 50)
  const recent = await db.select({
    id: requestLogs.id,
    accountId: requestLogs.accountId,
    accountEmail: accounts.email,
    sessionId: requestLogs.sessionId,
    model: requestLogs.model,
    reasoningEffort: requestLogs.reasoningEffort,
    promptTokens: requestLogs.promptTokens,
    completionTokens: requestLogs.completionTokens,
    totalTokens: requestLogs.totalTokens,
    tokenSource: requestLogs.tokenSource,
    status: requestLogs.status,
    ttfbMs: requestLogs.ttfbMs,
    durationMs: requestLogs.durationMs,
    errorMessage: requestLogs.errorMessage,
    createdAt: requestLogs.createdAt,
  })
    .from(requestLogs)
    .leftJoin(accounts, eq(requestLogs.accountId, accounts.id))
    .orderBy(desc(requestLogs.createdAt))
    .limit(50);

  return c.json({
    data: {
      totalRequests: totalResult?.count || 0,
      successRequests: successResult?.count || 0,
      errorRequests: errorResult?.count || 0,
      totalPromptTokens: tokenResult?.prompt || 0,
      totalCompletionTokens: tokenResult?.completion || 0,
      totalTokens: tokenResult?.total || 0,
      totalAccounts: accountCount?.count || 0,
      activeAccounts: activeCount?.count || 0,
      recentRequests: recent,
    },
  });
});

statsRouter.get("/requests/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "Invalid request id" }, 400);
  }

  const [request] = await db.select({
    id: requestLogs.id,
    accountId: requestLogs.accountId,
    accountEmail: accounts.email,
    sessionId: requestLogs.sessionId,
    model: requestLogs.model,
    reasoningEffort: requestLogs.reasoningEffort,
    promptTokens: requestLogs.promptTokens,
    completionTokens: requestLogs.completionTokens,
    totalTokens: requestLogs.totalTokens,
    tokenSource: requestLogs.tokenSource,
    requestMessages: requestLogs.requestMessages,
    responseMessage: requestLogs.responseMessage,
    status: requestLogs.status,
    ttfbMs: requestLogs.ttfbMs,
    durationMs: requestLogs.durationMs,
    errorMessage: requestLogs.errorMessage,
    createdAt: requestLogs.createdAt,
  })
    .from(requestLogs)
    .leftJoin(accounts, eq(requestLogs.accountId, accounts.id))
    .where(eq(requestLogs.id, id))
    .limit(1);

  if (!request) return c.json({ error: "Request log not found" }, 404);

  return c.json({
    data: {
      ...request,
      requestMessages: parseSnapshot(request.requestMessages),
      responseMessage: parseSnapshot(request.responseMessage),
    },
  });
});

function parseSnapshot(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return { unavailable: true, raw: value };
  }
}
