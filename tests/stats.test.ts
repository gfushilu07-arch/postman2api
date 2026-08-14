import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { statsRouter } from "../src/api/stats";
import { db } from "../src/db/index";
import { accounts, requestLogs } from "../src/db/schema";

let accountId: number | undefined;
let requestLogId: number | undefined;

afterEach(async () => {
  if (requestLogId !== undefined) {
    await db.delete(requestLogs).where(eq(requestLogs.id, requestLogId));
    requestLogId = undefined;
  }
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
    requestLogId = requestLog!.id;

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
});
