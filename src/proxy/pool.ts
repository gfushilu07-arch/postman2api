import { db } from "../db/index";
import { accounts, sessionStates } from "../db/schema";
import { eq, and } from "drizzle-orm";
import type { Account } from "../db/schema";
import { broadcast } from "../ws/index";
import {
  clearAccountConversations,
  deleteConversationId,
} from "../provider/conversation-store";

interface PoolState {
  lastIndex: number;
}

interface SessionBinding {
  accountId: number;
  updatedAt: number;
}

interface InFlightLease {
  startedAt: number;
}

interface AccountCooldown {
  until: number;
  reason: string;
}

export interface AccountLease {
  account: Account;
  leaseId: string;
}

class AccountPool {
  private state: PoolState = { lastIndex: -1 };
  private inFlightByAccountId = new Map<number, Map<string, InFlightLease>>();
  private sessionBindings = new Map<string, SessionBinding>();
  private unavailableAccountIds = new Set<number>();
  private cooldownByAccountId = new Map<number, AccountCooldown>();
  private cooldownTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private static readonly IN_FLIGHT_STALE_MS = 10 * 60 * 1000;
  private static readonly SESSION_BINDING_TTL_MS = 6 * 60 * 60 * 1000;
  private static readonly MAX_SESSION_BINDINGS = 10_000;
  private static readonly MAX_SESSION_ID_LENGTH = 320;

  invalidate(accountId?: number): void {
    if (accountId !== undefined) {
      this.releaseAccountBindings(accountId);
      this.markAvailable(accountId);
    } else {
      this.sessionBindings.clear();
    }
  }

  async getActiveAccounts(): Promise<Account[]> {
    const active = await db.select().from(accounts).where(
      and(eq(accounts.status, "active"), eq(accounts.enabled, true)),
    ).orderBy(accounts.id);
    return active.filter((account) => this.isAccountSelectable(account.id));
  }

  async getNextAccount(
    sessionId?: string,
    excludedAccountIds: ReadonlySet<number> = new Set(),
  ): Promise<Account | null> {
    const selected = await this.selectNextAccount(sessionId, excludedAccountIds, false);
    return selected?.account || null;
  }

  async acquireNextAccount(
    sessionId?: string,
    excludedAccountIds: ReadonlySet<number> = new Set(),
  ): Promise<AccountLease | null> {
    return this.selectNextAccount(sessionId, excludedAccountIds, true);
  }

  private async selectNextAccount(
    sessionId: string | undefined,
    excludedAccountIds: ReadonlySet<number>,
    reserve: boolean,
  ): Promise<AccountLease | null> {
    const allActive = (await this.getActiveAccounts())
      .filter((account) => this.isAccountSelectable(account.id));
    const sessionKey = this.normalizeSessionId(sessionId);
    let binding = sessionKey ? this.getSessionBinding(sessionKey) : undefined;
    if (!binding && sessionKey) {
      const [persisted] = await db.select({ accountId: sessionStates.accountId })
        .from(sessionStates)
        .where(eq(sessionStates.sessionId, sessionKey))
        .limit(1);
      if (
        persisted?.accountId !== null
        && persisted?.accountId !== undefined
        && allActive.some((account) => account.id === persisted.accountId)
      ) {
        this.bindSession(sessionKey, persisted.accountId);
        binding = this.getSessionBinding(sessionKey);
      }
    }

    if (binding) {
      const preferred = allActive.find(
        (account) => account.id === binding.accountId && !excludedAccountIds.has(account.id),
      );
      if (preferred) {
        return {
          account: preferred,
          leaseId: reserve ? this.trackRequestStart(preferred.id) : "",
        };
      }
      this.releaseSession(sessionKey, binding.accountId);
    }

    if (allActive.length === 0) return null;

    const startIdx = (this.state.lastIndex + 1) % allActive.length;
    let selected: Account | undefined;
    let selectedIdx = -1;
    let selectedLoad = Number.POSITIVE_INFINITY;

    for (let i = 0; i < allActive.length; i++) {
      const idx = (startIdx + i) % allActive.length;
      const candidate = allActive[idx];
      if (!candidate || excludedAccountIds.has(candidate.id)) continue;
      const load = this.getInFlightCount(candidate.id);
      if (!selected || load < selectedLoad) {
        selected = candidate;
        selectedIdx = idx;
        selectedLoad = load;
        if (load === 0) break;
      }
    }

    if (!selected) return null;
    this.state.lastIndex = selectedIdx;
    if (sessionKey) this.bindSession(sessionKey, selected.id);
    return {
      account: selected,
      leaseId: reserve ? this.trackRequestStart(selected.id) : "",
    };
  }

  releaseSession(sessionId: string | undefined, accountId?: number): void {
    const sessionKey = this.normalizeSessionId(sessionId);
    if (!sessionKey) return;
    const binding = this.sessionBindings.get(sessionKey);
    if (!binding || (accountId !== undefined && binding.accountId !== accountId)) return;
    this.sessionBindings.delete(sessionKey);
    deleteConversationId(binding.accountId, sessionKey);
  }

  releaseAccountBindings(accountId: number): void {
    for (const [sessionId, binding] of this.sessionBindings) {
      if (binding.accountId === accountId) this.sessionBindings.delete(sessionId);
    }
    clearAccountConversations(accountId);
  }

  clearSessionBindings(): void {
    this.sessionBindings.clear();
  }

  clearRuntimeState(): void {
    this.sessionBindings.clear();
    this.inFlightByAccountId.clear();
    this.unavailableAccountIds.clear();
    this.cooldownByAccountId.clear();
    for (const timer of this.cooldownTimers.values()) clearTimeout(timer);
    this.cooldownTimers.clear();
    this.state.lastIndex = -1;
  }

  private normalizeSessionId(sessionId?: string): string | undefined {
    const normalized = sessionId?.trim();
    if (!normalized || normalized.length > AccountPool.MAX_SESSION_ID_LENGTH) return undefined;
    return normalized;
  }

  private getSessionBinding(sessionId: string): SessionBinding | undefined {
    const binding = this.sessionBindings.get(sessionId);
    if (!binding) return undefined;
    if (Date.now() - binding.updatedAt > AccountPool.SESSION_BINDING_TTL_MS) {
      this.sessionBindings.delete(sessionId);
      deleteConversationId(binding.accountId, sessionId);
      return undefined;
    }
    this.sessionBindings.delete(sessionId);
    this.sessionBindings.set(sessionId, { accountId: binding.accountId, updatedAt: Date.now() });
    return binding;
  }

  private bindSession(sessionId: string, accountId: number): void {
    const previous = this.sessionBindings.get(sessionId);
    if (previous && previous.accountId !== accountId) {
      deleteConversationId(previous.accountId, sessionId);
    }
    if (
      this.sessionBindings.size >= AccountPool.MAX_SESSION_BINDINGS
      && !this.sessionBindings.has(sessionId)
    ) {
      const oldestSessionId = this.sessionBindings.keys().next().value;
      if (oldestSessionId) {
        const oldest = this.sessionBindings.get(oldestSessionId);
        this.sessionBindings.delete(oldestSessionId);
        if (oldest) deleteConversationId(oldest.accountId, oldestSessionId);
      }
    }
    this.sessionBindings.delete(sessionId);
    this.sessionBindings.set(sessionId, { accountId, updatedAt: Date.now() });
  }

  private getInFlightCount(accountId: number): number {
    const leases = this.inFlightByAccountId.get(accountId);
    if (!leases) return 0;
    const now = Date.now();
    for (const [leaseId, lease] of leases) {
      if (now - lease.startedAt > AccountPool.IN_FLIGHT_STALE_MS) {
        leases.delete(leaseId);
      }
    }
    if (leases.size === 0) {
      this.inFlightByAccountId.delete(accountId);
      return 0;
    }
    return leases.size;
  }

  trackRequestStart(accountId: number): string {
    const leaseId = crypto.randomUUID();
    const leases = this.inFlightByAccountId.get(accountId) || new Map<string, InFlightLease>();
    leases.set(leaseId, { startedAt: Date.now() });
    this.inFlightByAccountId.set(accountId, leases);
    return leaseId;
  }

  trackRequestEnd(accountId: number, leaseId?: string): void {
    const leases = this.inFlightByAccountId.get(accountId);
    if (!leases) return;
    if (leaseId) {
      leases.delete(leaseId);
    } else {
      const oldestLeaseId = leases.keys().next().value;
      if (oldestLeaseId) leases.delete(oldestLeaseId);
    }
    if (leases.size === 0) this.inFlightByAccountId.delete(accountId);
  }

  markCooling(accountId: number, durationMs: number, reason: string): void {
    const until = Date.now() + Math.max(1_000, durationMs);
    const previous = this.cooldownByAccountId.get(accountId);
    if (previous && previous.until >= until) return;

    this.releaseAccountBindings(accountId);
    this.cooldownByAccountId.set(accountId, { until, reason });
    const previousTimer = this.cooldownTimers.get(accountId);
    if (previousTimer) clearTimeout(previousTimer);
    const timer = setTimeout(() => {
      const cooldown = this.cooldownByAccountId.get(accountId);
      if (!cooldown || cooldown.until > Date.now()) return;
      this.cooldownByAccountId.delete(accountId);
      this.cooldownTimers.delete(accountId);
      broadcast({ type: "account_status", data: { id: accountId, status: "active" } });
    }, Math.max(1, until - Date.now()));
    this.cooldownTimers.set(accountId, timer);
    broadcast({
      type: "account_status",
      data: { id: accountId, status: "cooling", coolingUntil: new Date(until), warning: reason },
    });
  }

  markAvailable(accountId: number): void {
    this.unavailableAccountIds.delete(accountId);
    this.cooldownByAccountId.delete(accountId);
    const timer = this.cooldownTimers.get(accountId);
    if (timer) clearTimeout(timer);
    this.cooldownTimers.delete(accountId);
  }

  private isAccountSelectable(accountId: number): boolean {
    if (this.unavailableAccountIds.has(accountId)) return false;
    const cooldown = this.cooldownByAccountId.get(accountId);
    if (!cooldown) return true;
    if (cooldown.until > Date.now()) return false;
    this.cooldownByAccountId.delete(accountId);
    const timer = this.cooldownTimers.get(accountId);
    if (timer) clearTimeout(timer);
    this.cooldownTimers.delete(accountId);
    return true;
  }

  async markUsed(accountId: number): Promise<void> {
    await db.update(accounts).set({ lastUsedAt: new Date(), updatedAt: new Date() }).where(eq(accounts.id, accountId));
  }

  async markExhausted(accountId: number): Promise<void> {
    this.unavailableAccountIds.add(accountId);
    this.releaseAccountBindings(accountId);
    await db.update(accounts).set({ status: "exhausted", quotaRemaining: 0, updatedAt: new Date() }).where(eq(accounts.id, accountId));
    broadcast({ type: "account_status", data: { id: accountId, status: "exhausted" } });
  }

  async markError(accountId: number, errorMessage: string): Promise<void> {
    this.unavailableAccountIds.add(accountId);
    this.releaseAccountBindings(accountId);
    await db.update(accounts).set({ status: "error", errorMessage, updatedAt: new Date() }).where(eq(accounts.id, accountId));
    broadcast({ type: "account_status", data: { id: accountId, status: "error", error: errorMessage } });
  }

  async markTransientFailure(accountId: number, errorMessage: string): Promise<void> {
    await db.update(accounts).set({ status: "active", errorMessage, updatedAt: new Date() }).where(eq(accounts.id, accountId));
    broadcast({ type: "account_status", data: { id: accountId, status: "active", warning: errorMessage } });
  }

  async updateTokens(accountId: number, tokens: unknown): Promise<void> {
    await db.update(accounts).set({ tokens: JSON.stringify(tokens), updatedAt: new Date() }).where(eq(accounts.id, accountId));
  }

  async setEnabled(accountId: number, enabled: boolean): Promise<Account | null> {
    if (!enabled) {
      this.unavailableAccountIds.add(accountId);
      this.releaseAccountBindings(accountId);
    } else {
      this.markAvailable(accountId);
    }
    const [account] = await db.update(accounts).set({ enabled, updatedAt: new Date() }).where(eq(accounts.id, accountId)).returning();
    broadcast({ type: "account_status", data: { id: accountId, enabled, status: account?.status } });
    return account;
  }
}

export const pool = new AccountPool();
