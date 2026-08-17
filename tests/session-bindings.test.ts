import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import {
  deleteSessionBindings,
  fetchSessionBindings,
  releaseSessionBindings,
} from "../dashboard/src/lib/api";
import { sessionsRouter } from "../src/api/sessions";
import { db } from "../src/db/index";
import { accounts, sessionStates } from "../src/db/schema";
import { pool } from "../src/proxy/pool";

const sessionIds = new Set<string>();
const accountIds = new Set<number>();

function sessionId(label: string): string {
  const id = `explicit:${label}-${crypto.randomUUID()}`;
  sessionIds.add(id);
  return id;
}

async function createAccount(label: string, overrides: Partial<typeof accounts.$inferInsert> = {}) {
  const [created] = await db.insert(accounts).values({
    email: `${label}-${crypto.randomUUID()}@example.com`,
    password: "unused",
    status: "active",
    enabled: true,
    ...overrides,
  }).returning();
  accountIds.add(created!.id);
  return created!;
}

async function createSession(
  id: string,
  accountId: number | null,
  updatedAt = new Date(),
) {
  await db.insert(sessionStates).values({
    sessionId: id,
    accountId,
    messages: JSON.stringify([
      { role: "system", content: "system" },
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ]),
    turnCount: 2,
    revision: 3,
    createdAt: new Date(updatedAt.getTime() - 60_000),
    updatedAt,
  });
}

afterEach(async () => {
  pool.clearRuntimeState();
  const sessions = [...sessionIds];
  if (sessions.length > 0) {
    await db.delete(sessionStates).where(inArray(sessionStates.sessionId, sessions));
  }
  sessionIds.clear();

  const ids = [...accountIds];
  if (ids.length > 0) await db.delete(accounts).where(inArray(accounts.id, ids));
  accountIds.clear();
});

describe("session binding management", () => {
  test("lists bindings with account health, turn counts, runtime state, and summary", async () => {
    const active = await createAccount("active");
    const disabled = await createAccount("disabled", { enabled: false });
    const activeSession = sessionId("active");
    const abnormalSession = sessionId("abnormal");
    const unboundSession = sessionId("unbound");
    const oldSession = sessionId("old");

    await createSession(activeSession, active.id);
    await createSession(abnormalSession, disabled.id);
    await createSession(unboundSession, null);
    await createSession(oldSession, active.id, new Date(Date.now() - 31 * 60 * 1000));

    const leaseId = pool.trackRequestStart(active.id, activeSession);
    const app = new Hono().route("/api/sessions", sessionsRouter);
    const response = await app.request("/api/sessions");
    pool.trackRequestEnd(active.id, leaseId);

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.summary).toEqual({
      total: body.data.length,
      active30m: body.data.filter(
        (item: any) => Date.now() - new Date(item.updatedAt).getTime() <= 30 * 60 * 1000,
      ).length,
      boundAccounts: new Set(
        body.data.flatMap((item: any) => item.accountId === null ? [] : [item.accountId]),
      ).size,
      abnormal: body.data.filter((item: any) => item.abnormal).length,
      recoverable: body.data.filter(
        (item: any) => item.accountId !== null && !item.hasConversation,
      ).length,
    });
    expect(body.data.find((item: any) => item.sessionId === activeSession)).toMatchObject({
      accountId: active.id,
      accountEmail: active.email,
      turnCount: 2,
      revision: 3,
      isInFlight: true,
      abnormal: false,
    });
    expect(body.data.find((item: any) => item.sessionId === abnormalSession)).toMatchObject({
      accountId: disabled.id,
      accountEnabled: false,
      abnormal: true,
    });
    expect(body.data.find((item: any) => item.sessionId === unboundSession)).toMatchObject({
      accountId: null,
      abnormal: false,
    });
  });

  test("releases bindings while preserving context and deletes complete session state", async () => {
    const account = await createAccount("manage");
    const released = sessionId("release");
    const deleted = sessionId("delete");
    await createSession(released, account.id);
    await createSession(deleted, account.id);
    const app = new Hono().route("/api/sessions", sessionsRouter);

    const releaseResponse = await app.request("/api/sessions/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds: [released] }),
    });
    expect(releaseResponse.status).toBe(200);
    const [releasedState] = await db.select().from(sessionStates)
      .where(eq(sessionStates.sessionId, released)).limit(1);
    expect(releasedState?.accountId).toBeNull();
    expect(JSON.parse(releasedState?.messages || "[]")).toHaveLength(4);

    const deleteResponse = await app.request("/api/sessions/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds: [deleted] }),
    });
    expect(deleteResponse.status).toBe(200);
    const [deletedState] = await db.select().from(sessionStates)
      .where(eq(sessionStates.sessionId, deleted)).limit(1);
    expect(deletedState).toBeUndefined();
  });

  test("rejects release and deletion while a session is in flight", async () => {
    const account = await createAccount("busy");
    const id = sessionId("busy");
    await createSession(id, account.id);
    const leaseId = pool.trackRequestStart(account.id, id);
    const app = new Hono().route("/api/sessions", sessionsRouter);

    try {
      const releaseResponse = await app.request("/api/sessions/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionIds: [id] }),
      });
      expect(releaseResponse.status).toBe(409);

      const deleteResponse = await app.request("/api/sessions/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionIds: [id] }),
      });
      expect(deleteResponse.status).toBe(409);
    } finally {
      pool.trackRequestEnd(account.id, leaseId);
    }
  });

  test("dashboard client uses the session management endpoints", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; method?: string; body?: string }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method, body: String(init?.body) });
      return new Response(JSON.stringify(
        String(input) === "/api/sessions"
          ? { data: [], summary: { total: 0, active30m: 0, boundAccounts: 0, abnormal: 0 } }
          : { success: true, count: 1 },
      ), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    try {
      await fetchSessionBindings();
      await releaseSessionBindings(["one"]);
      await releaseSessionBindings(["one", "two"]);
      await deleteSessionBindings(["one"]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toEqual([
      { url: "/api/sessions", method: undefined, body: "undefined" },
      { url: "/api/sessions/release", method: "POST", body: JSON.stringify({ sessionIds: ["one"] }) },
      { url: "/api/sessions/batch-release", method: "POST", body: JSON.stringify({ sessionIds: ["one", "two"] }) },
      { url: "/api/sessions/delete", method: "POST", body: JSON.stringify({ sessionIds: ["one"] }) },
    ]);
  });
});
