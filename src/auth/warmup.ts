import { db } from "../db/index";
import { accounts, type Account } from "../db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { PostmanProvider } from "../provider/postman";
import type { ProviderHealthResult, ProviderResult } from "../provider/base";
import { pool } from "../proxy/pool";
import { broadcast } from "../ws/index";
import { resolveWarmupStatus } from "./health-status";
import { ACCOUNT_TEST_MAX_TOKENS, ACCOUNT_TEST_MODEL, ACCOUNT_TEST_PROMPT, ACCOUNT_TEST_TIMEOUT_MS } from "./account-test";

const provider = new PostmanProvider();
const WARMUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const PROVISIONING_RETRY_DELAYS_MS = [15_000, 30_000, 60_000];
const QUOTA_INITIALIZATION_ERROR = "Quota response did not contain a remaining balance";
const QUOTA_INITIALIZATION_COOLDOWN_MS = 5 * 60 * 1000;
const QUOTA_REFRESH_RETRY_DELAYS_MS = [0, 500, 1_500];
const QUOTA_INITIALIZATION_PENDING_MESSAGE = "额度初始化请求已完成，正在等待 Postman 生成额度数据，系统会在后台自动重试";
let warmupTimer: ReturnType<typeof setInterval> | null = null;
const provisioningRetryTimers = new Map<number, ReturnType<typeof setTimeout>>();
const quotaInitializationInFlight = new Map<number, Promise<ProviderResult>>();
const quotaInitializationCompletedAt = new Map<number, number>();

function requiresQuotaInitialization(health: ProviderHealthResult): boolean {
  return !health.success && health.error === QUOTA_INITIALIZATION_ERROR;
}

async function sendQuotaInitializationProbe(account: Account): Promise<ProviderResult> {
  const current = quotaInitializationInFlight.get(account.id);
  if (current) return current;

  const lastCompletedAt = quotaInitializationCompletedAt.get(account.id) ?? 0;
  if (Date.now() - lastCompletedAt < QUOTA_INITIALIZATION_COOLDOWN_MS) {
    return { success: true };
  }

  const request = (async () => {
    const leaseId = pool.trackRequestStart(account.id);
    try {
      const result = await provider.chatCompletion(account, {
        model: ACCOUNT_TEST_MODEL,
        messages: [{ role: "user", content: ACCOUNT_TEST_PROMPT }],
        temperature: 0,
        max_tokens: ACCOUNT_TEST_MAX_TOKENS,
        signal: AbortSignal.timeout(ACCOUNT_TEST_TIMEOUT_MS),
      });
      if (result.success) quotaInitializationCompletedAt.set(account.id, Date.now());
      return result;
    } finally {
      pool.trackRequestEnd(account.id, leaseId);
    }
  })();

  quotaInitializationInFlight.set(account.id, request);
  try {
    return await request;
  } finally {
    quotaInitializationInFlight.delete(account.id);
  }
}

async function refreshHealthAfterQuotaInitialization(account: Account): Promise<ProviderHealthResult> {
  let health: ProviderHealthResult = {
    kind: "transient_error",
    success: false,
    retryable: true,
    error: QUOTA_INITIALIZATION_ERROR,
  };

  for (const delay of QUOTA_REFRESH_RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    health = await provider.healthCheck(account);
    if (!requiresQuotaInitialization(health)) break;
  }
  return health;
}

export interface WarmupResult {
  success: boolean;
  error?: string;
  pending?: boolean;
}

export async function warmupAccount(accountId: number): Promise<WarmupResult> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!account) return { success: false, error: "Account not found" };

  let health = await provider.healthCheck(account);
  if (requiresQuotaInitialization(health)) {
    // 新工作区的额度实体通常要在首次真实 AI 请求后才会创建。
    const initialization = await sendQuotaInitializationProbe(account);
    if (initialization.success) {
      health = await refreshHealthAfterQuotaInitialization(account);
      if (requiresQuotaInitialization(health)) {
        const updatedAt = new Date();
        const updated = await db.update(accounts)
          .set({ errorMessage: QUOTA_INITIALIZATION_PENDING_MESSAGE, updatedAt })
          .where(and(
            eq(accounts.id, accountId),
            eq(accounts.status, account.status),
            account.updatedAt === null
              ? isNull(accounts.updatedAt)
              : eq(accounts.updatedAt, account.updatedAt),
          ))
          .returning({ id: accounts.id });
        if (updated.length > 0) {
          broadcast({
            type: "account_status",
            data: { id: accountId, status: account.status, error: QUOTA_INITIALIZATION_PENDING_MESSAGE },
          });
        }
        return { success: true, pending: true, error: QUOTA_INITIALIZATION_PENDING_MESSAGE };
      }
    } else if (initialization.quotaExhausted) {
      health = { kind: "exhausted", success: true, error: initialization.error };
    } else {
      health = {
        kind: "transient_error",
        success: false,
        retryable: initialization.retryable || initialization.rateLimited || undefined,
        error: initialization.error || "Postman AI 额度初始化失败",
      };
    }
  }
  if (!health.success) {
    const nextStatus = health.kind === "transient_error" ? account.status : "error";
    const updated = await db.update(accounts)
      .set({ status: nextStatus, errorMessage: health.error, updatedAt: new Date() })
      .where(and(
        eq(accounts.id, accountId),
        eq(accounts.status, account.status),
        account.updatedAt === null
          ? isNull(accounts.updatedAt)
          : eq(accounts.updatedAt, account.updatedAt),
      ))
      .returning({ id: accounts.id });
    if (updated.length > 0) {
      if (nextStatus === "error") pool.invalidate(accountId);
      broadcast({ type: "account_status", data: { id: accountId, status: nextStatus, error: health.error } });
    }
    return { success: false, error: health.error };
  }

  const status = resolveWarmupStatus(account.status, health);
  const updatedAt = new Date();
  const updated = await db.update(accounts)
    .set({
      status,
      errorMessage: status === "exhausted" ? "Postman AI quota exhausted" : null,
      quotaLimit: health.quota?.limit ?? account.quotaLimit,
      quotaRemaining: health.quota?.remaining ?? account.quotaRemaining,
      updatedAt,
    })
    // Do not let a stale health result overwrite a quota/error transition that
    // happened while the network check was in flight.
    .where(and(
      eq(accounts.id, accountId),
      eq(accounts.status, account.status),
      account.updatedAt === null
        ? isNull(accounts.updatedAt)
        : eq(accounts.updatedAt, account.updatedAt),
    ))
    .returning({ id: accounts.id });

  if (updated.length > 0) {
    if (status === "exhausted") pool.invalidate(accountId);
    else pool.markAvailable(accountId);
    broadcast({
      type: "account_status",
      data: {
        id: accountId,
        status,
        quotaLimit: health.quota?.limit ?? account.quotaLimit,
        quotaRemaining: health.quota?.remaining ?? account.quotaRemaining,
      },
    });
  }

  return { success: true };
}

export async function warmupAllAccounts(): Promise<void> {
  const allAccounts = await db.select().from(accounts);
  for (const account of allAccounts) {
    if (!account.enabled) continue;
    try {
      await warmupAccount(account.id);
    } catch (err) {
      console.error(`[warmup] Account ${account.email} failed:`, err);
    }
  }
}

export function scheduleProvisioningWarmup(accountId: number): boolean {
  if (provisioningRetryTimers.has(accountId)) return false;

  let attempt = 0;
  const scheduleNext = () => {
    const delay = PROVISIONING_RETRY_DELAYS_MS[attempt++];
    if (delay === undefined) {
      provisioningRetryTimers.delete(accountId);
      return;
    }

    const timer = setTimeout(async () => {
      provisioningRetryTimers.delete(accountId);
      try {
        const result = await warmupAccount(accountId);
        if (!result.success || result.pending) scheduleNext();
      } catch (error) {
        console.error(`[warmup] Provisioning retry for account ${accountId} failed:`, error);
        scheduleNext();
      }
    }, delay);
    provisioningRetryTimers.set(accountId, timer);
  };

  scheduleNext();
  return true;
}

export function startWarmupScheduler(): void {
  if (warmupTimer) clearInterval(warmupTimer);
  warmupTimer = setInterval(() => {
    warmupAllAccounts().catch((err) => {
      console.error("[warmup] Scheduler error:", err);
    });
  }, WARMUP_INTERVAL_MS);
  console.log(`[warmup] Scheduler started (interval: ${WARMUP_INTERVAL_MS / 1000}s)`);
}

export function stopWarmupScheduler(): void {
  if (warmupTimer) {
    clearInterval(warmupTimer);
    warmupTimer = null;
  }
  for (const timer of provisioningRetryTimers.values()) clearTimeout(timer);
  provisioningRetryTimers.clear();
  quotaInitializationInFlight.clear();
  quotaInitializationCompletedAt.clear();
}
