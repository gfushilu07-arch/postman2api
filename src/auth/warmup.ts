import { db } from "../db/index";
import { accounts } from "../db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { PostmanProvider } from "../provider/postman";
import { pool } from "../proxy/pool";
import { broadcast } from "../ws/index";
import { resolveWarmupStatus } from "./health-status";

const provider = new PostmanProvider();
const WARMUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const PROVISIONING_RETRY_DELAYS_MS = [15_000, 30_000, 60_000];
let warmupTimer: ReturnType<typeof setInterval> | null = null;
const provisioningRetryTimers = new Map<number, ReturnType<typeof setTimeout>>();

export async function warmupAccount(accountId: number): Promise<{ success: boolean; error?: string }> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!account) return { success: false, error: "Account not found" };

  const health = await provider.healthCheck(account);
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
        if (!result.success) scheduleNext();
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
}
