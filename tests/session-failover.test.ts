import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index";
import { accounts, requestLogs, sessionStates } from "../src/db/schema";
import { flushDatabaseWriteQueue } from "../src/db/write-queue";
import { config } from "../src/config";
import { handleChatCompletion } from "../src/proxy/index";
import { pool } from "../src/proxy/pool";
import { provider } from "../src/proxy/router";
import { acquireSessionLock, clearSessionLocks } from "../src/proxy/session-lock";
import {
  commitSession,
  deleteSessionState,
  estimateSessionTokens,
  getSessionMessages,
  mergeSessionMessages,
  prepareSession,
} from "../src/provider/session-state";
import {
  clearConversations,
  getConversationId,
  setConversationId,
} from "../src/provider/conversation-store";

const sessions = new Set<string>();
const accountIds = new Set<number>();

function sessionId(label: string): string {
  const id = `codex:test-${label}-${crypto.randomUUID()}`;
  sessions.add(id);
  return id;
}

async function createAccount(label: string) {
  const [created] = await db.insert(accounts).values({
    email: `${label}-${crypto.randomUUID()}@example.com`,
    password: "unused",
    status: "active",
    enabled: true,
    tokens: JSON.stringify({
      postman_sid: `sid-${label}`,
      user_id: `user-${label}`,
      workspace_id: `workspace-${label}`,
      workspace_subdomain: `workspace-${label}`,
    }),
  }).returning();
  accountIds.add(created!.id);
  return created!;
}

afterEach(async () => {
  clearSessionLocks();
  clearConversations();
  pool.clearRuntimeState();
  await flushDatabaseWriteQueue();
  for (const id of sessions) await deleteSessionState(id);
  sessions.clear();
  for (const id of accountIds) {
    await db.delete(requestLogs).where(eq(requestLogs.accountId, id));
    await db.delete(accounts).where(eq(accounts.id, id));
  }
  accountIds.clear();
});

describe("persistent session state", () => {
  test("restores stable history when the client sends only the next turn", async () => {
    const id = sessionId("restore");
    await commitSession(
      id,
      [{ role: "user", content: "first question" }],
      { role: "assistant", content: "first answer" },
      101,
    );

    const prepared = await prepareSession(id, [{ role: "user", content: "second question" }]);

    expect(prepared.messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
    ]);
  });

  test("keeps the full local transcript when the outbound context is trimmed", async () => {
    const id = sessionId("trimmed-history");
    const fullHistory = [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "latest question" },
    ];
    const outboundHistory = [
      { role: "user", content: "latest question" },
    ];

    await commitSession(
      id,
      outboundHistory,
      { role: "assistant", content: "latest answer" },
      101,
      fullHistory,
    );

    expect(await getSessionMessages(id)).toEqual([
      ...fullHistory,
      { role: "assistant", content: "latest answer" },
    ]);
  });

  test("persists the replacement account after a successful failover", async () => {
    const id = sessionId("failover");
    const first = await createAccount("first");
    const second = await createAccount("second");
    await commitSession(
      id,
      [{ role: "user", content: "remember this" }],
      { role: "assistant", content: "remembered" },
      first.id,
    );

    const poolAny = pool as any;
    const providerAny = provider as any;
    const originals = {
      getActiveAccounts: poolAny.getActiveAccounts,
      markExhausted: poolAny.markExhausted,
      markUsed: poolAny.markUsed,
      chatCompletion: providerAny.chatCompletion,
    };
    const attempts: Array<{ accountId: number; messages: unknown[] }> = [];

    try {
      poolAny.getActiveAccounts = async () => [first, second];
      poolAny.markExhausted = async (accountId: number) => {
        pool.releaseAccountBindings(accountId);
      };
      poolAny.markUsed = async () => {};
      providerAny.chatCompletion = async (selectedAccount: any, request: any) => {
        attempts.push({ accountId: selectedAccount.id, messages: request.messages });
        if (attempts.length === 1) {
          return { success: false, quotaExhausted: true, error: "Quota exhausted" };
        }
        return {
          success: true,
          response: {
            id: "response",
            object: "chat.completion",
            created: 0,
            model: request.model,
            choices: [{
              index: 0,
              message: { role: "assistant", content: "continued on replacement" },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      };

      const response = await handleChatCompletion({
        model: "auto",
        messages: [{ role: "user", content: "continue" }],
        stream: false,
        _sessionId: id,
      });

      expect(response.status).toBe(200);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]!.accountId).not.toBe(attempts[0]!.accountId);
      expect(attempts[0]!.messages).toEqual(attempts[1]!.messages);
      expect(attempts[1]!.messages).toEqual([
        { role: "user", content: "remember this" },
        { role: "assistant", content: "remembered" },
        { role: "user", content: "continue" },
      ]);
      expect(await getSessionMessages(id)).toEqual([
        ...attempts[1]!.messages,
        { role: "assistant", content: "continued on replacement" },
      ]);
      const [state] = await db.select().from(sessionStates)
        .where(eq(sessionStates.sessionId, id)).limit(1);
      expect(state?.accountId).toBe(attempts[1]!.accountId);
      expect(state?.estimatedTokens).toBeGreaterThan(0);
      expect(state?.messageChars).toBeGreaterThan(0);
    } finally {
      poolAny.getActiveAccounts = originals.getActiveAccounts;
      poolAny.markExhausted = originals.markExhausted;
      poolAny.markUsed = originals.markUsed;
      providerAny.chatCompletion = originals.chatCompletion;
    }
  });

  test("restores the persisted account binding after runtime state is cleared", async () => {
    const id = sessionId("restart-binding");
    const first = await createAccount("restart-first");
    const second = await createAccount("restart-second");
    const poolAny = pool as any;
    const originalGetActiveAccounts = poolAny.getActiveAccounts;

    try {
      await commitSession(
        id,
        [{ role: "user", content: "remember account" }],
        { role: "assistant", content: "remembered" },
        first.id,
      );
      pool.clearRuntimeState();
      poolAny.getActiveAccounts = async () => [first, second];

      expect((await pool.getNextAccount(id))?.id).toBe(first.id);
    } finally {
      poolAny.getActiveAccounts = originalGetActiveAccounts;
    }
  });

  test("restores a persisted Postman conversation only for its original account", async () => {
    const id = sessionId("restart-conversation");
    const first = await createAccount("conversation-first");
    const second = await createAccount("conversation-second");
    const poolAny = pool as any;
    const originalGetActiveAccounts = poolAny.getActiveAccounts;

    try {
      setConversationId(first.id, id, "persisted-postman-conversation");
      await commitSession(
        id,
        [{ role: "user", content: "remember upstream conversation" }],
        { role: "assistant", content: "remembered" },
        first.id,
      );
      clearConversations();
      pool.clearRuntimeState();
      poolAny.getActiveAccounts = async () => [first, second];

      expect((await pool.getNextAccount(id))?.id).toBe(first.id);
      expect(getConversationId(first.id, id)).toBe("persisted-postman-conversation");
      expect(getConversationId(second.id, id)).toBeNull();
    } finally {
      poolAny.getActiveAccounts = originalGetActiveAccounts;
    }
  });

  test("returns request-level Postman rejections as 422 without disabling the account", async () => {
    const id = sessionId("request-rejection");
    const account = await createAccount("request-rejection");
    const poolAny = pool as any;
    const providerAny = provider as any;
    const originals = {
      getActiveAccounts: poolAny.getActiveAccounts,
      chatCompletion: providerAny.chatCompletion,
    };

    try {
      poolAny.getActiveAccounts = async () => [account];
      providerAny.chatCompletion = async () => ({
        success: false,
        requestRejected: true,
        httpStatus: 422,
        error: "That was unexpected :(. Try starting a new chat, or remove any configured MCP servers.",
      });

      const response = await handleChatCompletion({
        model: "auto",
        messages: [{ role: "user", content: "use MCP" }],
        stream: false,
        _sessionId: id,
      });
      const payload = await response.json() as any;
      const [savedAccount] = await db.select().from(accounts)
        .where(eq(accounts.id, account.id)).limit(1);

      expect(response.status).toBe(422);
      expect(payload.error.type).toBe("invalid_request_error");
      expect(savedAccount?.status).toBe("active");
      expect(savedAccount?.errorMessage).toBeNull();
    } finally {
      poolAny.getActiveAccounts = originals.getActiveAccounts;
      providerAny.chatCompletion = originals.chatCompletion;
    }
  });

  test("hides partial output and replays the stream after quota exhaustion", async () => {
    const id = sessionId("stream-failover");
    const first = await createAccount("stream-first");
    const second = await createAccount("stream-second");
    const poolAny = pool as any;
    const providerAny = provider as any;
    const originals = {
      getActiveAccounts: poolAny.getActiveAccounts,
      markUsed: poolAny.markUsed,
      chatCompletionStream: providerAny.chatCompletionStream,
    };
    const attemptedAccountIds: number[] = [];
    const encoder = new TextEncoder();

    try {
      pool.clearRuntimeState();
      poolAny.getActiveAccounts = async () => [first, second];
      poolAny.markUsed = async () => {};
      providerAny.chatCompletionStream = async (selectedAccount: any) => {
        attemptedAccountIds.push(selectedAccount.id);
        if (attemptedAccountIds.length === 1) {
          let failureHandler: ((failure: any) => void | Promise<void>) | undefined;
          let streamFailure: any;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("data: partial-from-exhausted-account\n\n"));
            },
            async pull(controller) {
              streamFailure = {
                kind: "quota_exhausted",
                error: new Error("Quota exhausted after partial output"),
              };
              await failureHandler?.(streamFailure);
              controller.error(streamFailure.error);
            },
          });
          return {
            success: true,
            stream,
            getStreamMessage: () => ({
              role: "assistant",
              content: "partial-from-exhausted-account",
            }),
            getStreamFailure: () => streamFailure,
            setStreamFailureHandler(handler: typeof failureHandler) {
              failureHandler = handler;
            },
          };
        }

        return {
          success: true,
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("data: replacement-complete\n\n"));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          getStreamMessage: () => ({
            role: "assistant",
            content: "replacement-complete",
          }),
        };
      };

      const response = await handleChatCompletion({
        model: "auto",
        messages: [{ role: "user", content: "continue safely" }],
        stream: true,
        _sessionId: id,
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(attemptedAccountIds).toHaveLength(2);
      expect(attemptedAccountIds[1]).not.toBe(attemptedAccountIds[0]);
      expect(text).not.toContain("partial-from-exhausted-account");
      expect(text).toContain("replacement-complete");
      expect(text).toContain("[DONE]");

      const [exhausted] = await db.select().from(accounts)
        .where(eq(accounts.id, attemptedAccountIds[0]!)).limit(1);
      expect(exhausted?.status).toBe("exhausted");
      const [state] = await db.select().from(sessionStates)
        .where(eq(sessionStates.sessionId, id)).limit(1);
      expect(state?.accountId).toBe(attemptedAccountIds[1]);
      expect(await getSessionMessages(id)).toEqual([
        { role: "user", content: "continue safely" },
        { role: "assistant", content: "replacement-complete" },
      ]);
    } finally {
      poolAny.getActiveAccounts = originals.getActiveAccounts;
      poolAny.markUsed = originals.markUsed;
      providerAny.chatCompletionStream = originals.chatCompletionStream;
    }
  });

  test("cancels the active upstream and releases the lease when the client disconnects", async () => {
    const id = sessionId("stream-cancel");
    const account = await createAccount("cancel-account");
    const poolAny = pool as any;
    const providerAny = provider as any;
    const originals = {
      getActiveAccounts: poolAny.getActiveAccounts,
      markUsed: poolAny.markUsed,
      chatCompletionStream: providerAny.chatCompletionStream,
    };
    let sourceCancelCount = 0;

    try {
      pool.clearRuntimeState();
      poolAny.getActiveAccounts = async () => [account];
      poolAny.markUsed = async () => {};
      providerAny.chatCompletionStream = async () => ({
        success: true,
        stream: new ReadableStream<Uint8Array>({
          cancel() {
            sourceCancelCount++;
          },
        }),
      });

      const response = await handleChatCompletion({
        model: "auto",
        messages: [{ role: "user", content: "wait" }],
        stream: true,
        _sessionId: id,
      });
      await Bun.sleep(0);
      await response.body!.cancel("client disconnected");

      expect(sourceCancelCount).toBe(1);
      expect(poolAny.getInFlightCount(account.id)).toBe(0);
      const release = await acquireSessionLock(id);
      release();
    } finally {
      poolAny.getActiveAccounts = originals.getActiveAccounts;
      poolAny.markUsed = originals.markUsed;
      providerAny.chatCompletionStream = originals.chatCompletionStream;
    }
  });
});

describe("session execution order", () => {
  test("serializes the same session while allowing another session through", async () => {
    const firstRelease = await acquireSessionLock("same-session");
    const order: string[] = [];

    const second = acquireSessionLock("same-session").then((release) => {
      order.push("same");
      release();
    });
    const other = acquireSessionLock("other-session").then((release) => {
      order.push("other");
      release();
    });

    await other;
    expect(order).toEqual(["other"]);
    firstRelease();
    await second;
    expect(order).toEqual(["other", "same"]);
  });
});

describe("session context preservation", () => {
  test("keeps session merging lossless before the configured context trimmer runs", () => {
    const messages = [
      { role: "system", content: "Always keep this instruction." },
      { role: "user", content: "old question ".repeat(20) },
      { role: "assistant", content: "old answer ".repeat(20) },
      { role: "user", content: "latest question" },
    ] as any;
    const merged = mergeSessionMessages(messages.slice(0, -1), messages.slice(-1));

    expect(merged).toEqual(messages);
    expect(estimateSessionTokens(merged)).toBeGreaterThan(0);
  });
});

describe("account leasing", () => {
  test("balances concurrent sessions and releases only the matching lease", async () => {
    const first = await createAccount("lease-first");
    const second = await createAccount("lease-second");
    const poolAny = pool as any;
    const originalGetActiveAccounts = poolAny.getActiveAccounts;

    try {
      pool.clearRuntimeState();
      poolAny.getActiveAccounts = async () => [first, second];
      const leases = await Promise.all([
        pool.acquireNextAccount("session-1"),
        pool.acquireNextAccount("session-2"),
        pool.acquireNextAccount("session-3"),
        pool.acquireNextAccount("session-4"),
      ]);
      const assigned = leases.map((lease) => lease!.account.id);

      expect(assigned.filter((id) => id === first.id)).toHaveLength(2);
      expect(assigned.filter((id) => id === second.id)).toHaveLength(2);
      expect(poolAny.getInFlightCount(first.id)).toBe(2);
      expect(poolAny.getInFlightCount(second.id)).toBe(2);

      for (const lease of leases) {
        pool.trackRequestEnd(lease!.account.id, lease!.leaseId);
      }
      expect(poolAny.getInFlightCount(first.id)).toBe(0);
      expect(poolAny.getInFlightCount(second.id)).toBe(0);
    } finally {
      poolAny.getActiveAccounts = originalGetActiveAccounts;
    }
  });

  test("does not report no active accounts during a full multi-session burst", async () => {
    const accountCount = 8;
    const activeAccounts = await Promise.all(
      Array.from({ length: accountCount }, (_, index) => createAccount(`burst-${index}`)),
    );
    const poolAny = pool as any;
    const originalGetActiveAccounts = poolAny.getActiveAccounts;

    try {
      pool.clearRuntimeState();
      poolAny.getActiveAccounts = async () => activeAccounts;
      const leaseCount = accountCount * config.accountMaxConcurrency;
      const leases = await Promise.all(
        Array.from({ length: leaseCount }, (_, index) => (
          pool.acquireNextAccount(`parallel-session-${index}`)
        )),
      );

      expect(leases.every(Boolean)).toBe(true);
      const counts = new Map<number, number>();
      for (const lease of leases) {
        counts.set(lease!.account.id, (counts.get(lease!.account.id) ?? 0) + 1);
      }
      expect([...counts.values()].every((count) => count <= config.accountMaxConcurrency)).toBe(true);

      for (const lease of leases) {
        pool.trackRequestEnd(lease!.account.id, lease!.leaseId);
      }
    } finally {
      poolAny.getActiveAccounts = originalGetActiveAccounts;
    }
  });

  test("reports account status counts when no account is selectable", async () => {
    const active = await createAccount("availability-active");
    const exhausted = await createAccount("availability-exhausted");
    const errored = await createAccount("availability-error");
    const disabled = await createAccount("availability-disabled");

    await db.update(accounts).set({ status: "exhausted" })
      .where(eq(accounts.id, exhausted.id));
    await db.update(accounts).set({ status: "error" })
      .where(eq(accounts.id, errored.id));
    await db.update(accounts).set({ enabled: false })
      .where(eq(accounts.id, disabled.id));

    pool.clearRuntimeState();
    pool.markCooling(active.id, 60_000, "test cooldown");
    const availability = await pool.getAccountAvailability();

    expect(availability.total).toBeGreaterThanOrEqual(4);
    expect(availability.active).toBeGreaterThanOrEqual(1);
    expect(availability.selectable).toBe(0);
    expect(availability.cooling).toBeGreaterThanOrEqual(1);
    expect(availability.exhausted).toBeGreaterThanOrEqual(1);
    expect(availability.error).toBeGreaterThanOrEqual(1);
    expect(availability.disabled).toBeGreaterThanOrEqual(1);
    expect(pool.formatNoAccountError(availability)).toContain("selectable=0");
  });

  test("does not let an old request release a newer lease", () => {
    const poolAny = pool as any;
    const realNow = Date.now;
    let now = 1_000;
    Date.now = () => now;

    try {
      pool.clearRuntimeState();
      const oldLease = pool.trackRequestStart(999_001);
      now += 10 * 60 * 1000 + 1;
      expect(poolAny.getInFlightCount(999_001)).toBe(0);

      const freshLease = pool.trackRequestStart(999_001);
      pool.trackRequestEnd(999_001, oldLease);
      expect(poolAny.getInFlightCount(999_001)).toBe(1);

      pool.trackRequestEnd(999_001, freshLease);
      expect(poolAny.getInFlightCount(999_001)).toBe(0);
    } finally {
      Date.now = realNow;
    }
  });

  test("waits for account capacity and resumes when a lease is released", async () => {
    const account = await createAccount("capacity-wait");
    const poolAny = pool as any;
    const originalGetActiveAccounts = poolAny.getActiveAccounts;
    const activeLeases: Array<{ account: typeof account; leaseId: string }> = [];

    try {
      pool.clearRuntimeState();
      poolAny.getActiveAccounts = async () => [account];
      for (let index = 0; index < config.accountMaxConcurrency; index++) {
        activeLeases.push((await pool.acquireNextAccount(`capacity-active-${index}`))!);
      }

      let resolved = false;
      const waiting = pool.acquireNextAccount("capacity-waiting").then((lease) => {
        resolved = true;
        return lease;
      });
      await Bun.sleep(20);
      expect(resolved).toBe(false);

      const released = activeLeases.shift()!;
      pool.trackRequestEnd(released.account.id, released.leaseId);
      const resumed = await waiting;
      expect(resumed?.account.id).toBe(account.id);

      if (resumed) pool.trackRequestEnd(resumed.account.id, resumed.leaseId);
      for (const lease of activeLeases) pool.trackRequestEnd(lease.account.id, lease.leaseId);
    } finally {
      poolAny.getActiveAccounts = originalGetActiveAccounts;
    }
  });

  test("waits for the earliest account cooldown instead of reporting no active accounts", async () => {
    const account = await createAccount("cooldown-wait");
    const poolAny = pool as any;
    const cooldownMs = 30;

    pool.clearRuntimeState();
    poolAny.cooldownByAccountId.set(account.id, {
      until: Date.now() + cooldownMs,
      reason: "temporary upstream failure",
    });

    const startedAt = performance.now();
    const lease = await pool.acquireNextAccount("cooldown-waiting-session");

    expect(lease?.account.id).toBe(account.id);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(cooldownMs - 10);
    if (lease) pool.trackRequestEnd(lease.account.id, lease.leaseId);
  });

  test("returns a cooldown-specific error when every account stays cooling past the wait limit", async () => {
    const account = await createAccount("cooldown-timeout");
    const poolAny = pool as any;
    const configAny = config as any;
    const originalWaitMs = configAny.accountCapacityWaitMs;

    try {
      pool.clearRuntimeState();
      configAny.accountCapacityWaitMs = 20;
      poolAny.cooldownByAccountId.set(account.id, {
        until: Date.now() + 1_000,
        reason: "temporary upstream failure",
      });

      await expect(
        pool.acquireNextAccount("cooldown-timeout-session"),
      ).rejects.toThrow("temporarily cooling down");
    } finally {
      configAny.accountCapacityWaitMs = originalWaitMs;
    }
  });

  test("rebalances an idle bound session when its account is full", async () => {
    const first = await createAccount("rebalance-first");
    const second = await createAccount("rebalance-second");
    const poolAny = pool as any;
    const originalGetActiveAccounts = poolAny.getActiveAccounts;
    const session = "idle-rebalance-session";
    const fillerLeases: string[] = [];

    try {
      pool.clearRuntimeState();
      poolAny.getActiveAccounts = async () => [first, second];

      const initial = await pool.acquireNextAccount(session);
      expect(initial?.account.id).toBe(first.id);
      pool.trackRequestEnd(initial!.account.id, initial!.leaseId);
      poolAny.sessionBindings.get(session).updatedAt = Date.now()
        - config.sessionRebalanceIdleMs
        - 1;

      for (let index = 0; index < config.accountMaxConcurrency; index++) {
        fillerLeases.push(pool.trackRequestStart(first.id, `rebalance-filler-${index}`));
      }

      const rebalanced = await pool.acquireNextAccount(session);
      expect(rebalanced?.account.id).toBe(second.id);
      expect(poolAny.sessionBindings.get(session).accountId).toBe(second.id);

      if (rebalanced) pool.trackRequestEnd(rebalanced.account.id, rebalanced.leaseId);
      for (const leaseId of fillerLeases) pool.trackRequestEnd(first.id, leaseId);
    } finally {
      poolAny.getActiveAccounts = originalGetActiveAccounts;
    }
  });

  test("switches immediately after rate limiting and cools the failed account", async () => {
    const first = await createAccount("rate-first");
    const second = await createAccount("rate-second");
    const poolAny = pool as any;
    const providerAny = provider as any;
    const originals = {
      getActiveAccounts: poolAny.getActiveAccounts,
      markUsed: poolAny.markUsed,
      chatCompletionStream: providerAny.chatCompletionStream,
    };
    const attempts: number[] = [];

    try {
      pool.clearRuntimeState();
      poolAny.getActiveAccounts = async () => [first, second];
      poolAny.markUsed = async () => {};
      providerAny.chatCompletionStream = async (selectedAccount: any) => {
        attempts.push(selectedAccount.id);
        if (attempts.length === 1) {
          return {
            success: false,
            rateLimited: true,
            retryAfterMs: 60_000,
            error: "Postman rate limited",
          };
        }
        return {
          success: true,
          stream: new ReadableStream({ start(controller) { controller.close(); } }),
        };
      };

      const startedAt = performance.now();
      const routed = await (await import("../src/proxy/router")).routeRequest({
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        _sessionId: "rate-limit-session",
      }, true);

      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(attempts).toEqual([first.id, second.id]);
      expect((await pool.getNextAccount("new-session"))?.id).toBe(second.id);
      pool.trackRequestEnd(routed.account.id, routed.leaseId);
    } finally {
      poolAny.getActiveAccounts = originals.getActiveAccounts;
      poolAny.markUsed = originals.markUsed;
      providerAny.chatCompletionStream = originals.chatCompletionStream;
    }
  });
});
