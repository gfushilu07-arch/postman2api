import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { statsRouter } from "../src/api/stats";
import { db } from "../src/db/index";
import { accounts, requestLogs } from "../src/db/schema";

let accountId: number | undefined;
const requestLogIds = new Set<number>();

afterEach(async () => {
  for (const requestLogId of requestLogIds) {
    await db.delete(requestLogs).where(eq(requestLogs.id, requestLogId));
  }
  requestLogIds.clear();
  if (accountId !== undefined) {
    await db.delete(accounts).where(eq(accounts.id, accountId));
    accountId = undefined;
  }
});

describe("request statistics", () => {
  test("returns the account and first-byte latency for recent requests", async () => {
    const email = `stats-${crypto.randomUUID()}@example.com`;
    const [account] = await db.insert(accounts).values({
      email,
      password: "unused",
      status: "active",
      enabled: true,
    }).returning();
    accountId = account!.id;

    const [requestLog] = await db.insert(requestLogs).values({
      accountId,
      sessionId: "codex:stats-test",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      status: "success",
      promptTokens: 30,
      completionTokens: 12,
      totalTokens: 42,
      tokenSource: "upstream",
      requestMessages: JSON.stringify([
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ]),
      responseMessage: JSON.stringify({ role: "assistant", content: "Hi!" }),
      ttfbMs: 321,
      durationMs: 654,
      createdAt: new Date(),
    }).returning();
    const requestLogId = requestLog!.id;
    requestLogIds.add(requestLogId);

    const app = new Hono().route("/api/stats", statsRouter);
    const response = await app.request("/api/stats");

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.data.recentRequests.find((item: any) => item.id === requestLogId)).toMatchObject({
      accountId,
      accountEmail: email,
      sessionId: "codex:stats-test",
      reasoningEffort: "high",
      tokenSource: "upstream",
      ttfbMs: 321,
      durationMs: 654,
    });

    const detailResponse = await app.request(`/api/stats/requests/${requestLogId}`);
    expect(detailResponse.status).toBe(200);
    const detailBody = await detailResponse.json() as any;
    expect(detailBody.data).toMatchObject({
      id: requestLogId,
      accountEmail: email,
      sessionId: "codex:stats-test",
      reasoningEffort: "high",
      tokenSource: "upstream",
      requestMessages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ],
      responseMessage: { role: "assistant", content: "Hi!" },
    });
  });

  test("filters the latest request list by request and response detail content", async () => {
    const marker = `detail-search-${crypto.randomUUID()}`;
    const [requestMatch] = await db.insert(requestLogs).values({
      model: "gpt-5.6-sol",
      status: "success",
      requestMessages: JSON.stringify([{ role: "user", content: `request ${marker}` }]),
      responseMessage: JSON.stringify({ role: "assistant", content: "ordinary response" }),
      createdAt: new Date(),
    }).returning();
    const [responseMatch] = await db.insert(requestLogs).values({
      model: "claude-sonnet-4-6",
      status: "success",
      requestMessages: JSON.stringify([{ role: "user", content: "ordinary request" }]),
      responseMessage: JSON.stringify({ role: "assistant", content: `response ${marker.toUpperCase()}` }),
      createdAt: new Date(Date.now() + 1),
    }).returning();
    const [nonMatch] = await db.insert(requestLogs).values({
      model: "auto",
      status: "error",
      requestMessages: JSON.stringify([{ role: "user", content: "unrelated request" }]),
      responseMessage: null,
      errorMessage: "unrelated failure",
      createdAt: new Date(Date.now() + 2),
    }).returning();
    requestLogIds.add(requestMatch!.id);
    requestLogIds.add(responseMatch!.id);
    requestLogIds.add(nonMatch!.id);

    const app = new Hono().route("/api/stats", statsRouter);
    const response = await app.request(`/api/stats?q=${encodeURIComponent(marker)}`);

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.data.recentRequests.map((item: any) => item.id).sort()).toEqual([
      requestMatch!.id,
      responseMatch!.id,
    ].sort());
    expect(body.data.recentRequests.some((item: any) => item.id === nonMatch!.id)).toBe(false);
    expect(body.data.recentRequestTotal).toBeGreaterThanOrEqual(3);
  });
});
