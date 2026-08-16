import { db } from "../db/index";
import { accounts, sessionStates } from "../db/schema";
import { eq, and } from "drizzle-orm";
import type { Account } from "../db/schema";
import { broadcast } from "../ws/index";
import {
  clearAccountConversations,
  deleteConversationId,
  restoreConversationId,
} from "../provider/conversation-store";
import { writeAccountTokens, writeAccountUsed } from "../db/write-queue";
import { config } from "../config";

interface PoolState {
  lastIndex: number;
}

interface SessionBinding {
  accountId: number;
  updatedAt: number;
}

interface InFlightLease {
  startedAt: number;
  sessionId?: string;
}

interface AccountCooldown {
  until: number;
  reason: string;
}

export interface AccountLease {
  account: Account;
  leaseId: string;
}

interface AccountSelection {
  lease?: AccountLease;
  capacityLimited: boolean;
  cooldownUntil?: number;
}

export interface AccountAvailability {
  total: number;
  enabled: number;
  disabled: number;
  active: number;
  selectable: number;
  cooling: number;
  runtimeUnavailable: number;
  pending: number;
  exhausted: number;
  error: number;
  other: number;
}

class AccountPool {
  private state: PoolState = { lastIndex: -1 };
  private inFlightByAccountId = new Map<number, Map<string, InFlightLease>>();
  private sessionBindings = new Map<string, SessionBinding>();
  private unavailableAccountIds = new Set<number>();
  private cooldownByAccountId = new Map<number, AccountCooldown>();
  private cooldownTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private capacityWaiters = new Set<() => void>();
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
    const active = await this.getEnabledActiveAccounts();
    return active.filter((account) => this.isAccountSelectable(account.id));
  }

  private async getEnabledActiveAccounts(): Promise<Account[]> {
    return db.select().from(accounts).where(
      and(eq(accounts.status, "active"), eq(accounts.enabled, true)),
    ).orderBy(accounts.id);
  }

  async getAccountAvailability(): Promise<AccountAvailability> {
    const rows = await db.select({
      id: accounts.id,
      status: accounts.status,
      enabled: accounts.enabled,
    }).from(accounts);
    const availability: AccountAvailability = {
      total: rows.length,
      enabled: 0,
      disabled: 0,
      active: 0,
      selectable: 0,
      cooling: 0,
      runtimeUnavailable: 0,
      pending: 0,
      exhausted: 0,
      error: 0,
      other: 0,
    };

    for (const row of rows) {
      if (!row.enabled) {
        availability.disabled++;
        continue;
      }
      availability.enabled++;
      switch (row.status) {
        case "active": {
          availability.active++;
          if (this.isAccountSelectable(row.id)) {
            availability.selectable++;
          } else if ((this.cooldownByAccountId.get(row.id)?.until ?? 0) > Date.now()) {
            availability.cooling++;
          } else {
            availability.runtimeUnavailable++;
          }
          break;
        }
        case "pending":
          availability.pending++;
          break;
        case "exhausted":
          availability.exhausted++;
          break;
        case "error":
          availability.error++;
          break;
        default:
          availability.other++;
      }
    }

    return availability;
  }

  formatNoAccountError(availability: AccountAvailability): string {
    if (availability.total === 0) {
      return "No active accounts available: no Postman accounts are configured. Add a Postman account first.";
    }
    return [
      "No active accounts available",
      `total=${availability.total}`,
      `enabled=${availability.enabled}`,
      `active=${availability.active}`,
      `selectable=${availability.selectable}`,
      `cooling=${availability.cooling}`,
      `runtime_unavailable=${availability.runtimeUnavailable}`,
      `exhausted=${availability.exhausted}`,
      `error=${availability.error}`,
      `pending=${availability.pending}`,
      `disabled=${availability.disabled}`,
      "Open /accounts and test or re-enable an account",
    ].join("; ");
  }

  async getNextAccount(
    sessionId?: string,
    excludedAccountIds: ReadonlySet<number> = new Set(),
  ): Promise<Account | null> {
    const selected = await this.selectNextAccount(sessionId, excludedAccountIds, false);
    return selected.lease?.account || null;
  }

  async acquireNextAccount(
    sessionId?: string,
    excludedAccountIds: ReadonlySet<number> = new Set(),
  ): Promise<AccountLease | null> {
    const deadline = Date.now() + config.accountCapacityWaitMs;
    let cooldownLimited = false;
    while (true) {
      const selected = await this.selectNextAccount(sessionId, excludedAccountIds, true);
      if (selected.lease) return selected.lease;
      if (!selected.capacityLimited && selected.cooldownUntil === undefined) return null;
      cooldownLimited = selected.cooldownUntil !== undefined;

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        if (cooldownLimited) {
          throw new Error(
            `All active accounts are temporarily cooling down; waited ${config.accountCapacityWaitMs}ms`,
          );
        }
        throw new Error(
          `All active accounts reached the concurrency limit (${config.accountMaxConcurrency})`,
        );
      }
      const cooldownWaitMs = selected.cooldownUntil === undefined
        ? remainingMs
        : Math.max(1, selected.cooldownUntil - Date.now());
      await this.waitForPoolChange(Math.min(remainingMs, cooldownWaitMs));
    }
  }

  private async selectNextAccount(
    sessionId: string | undefined,
    excludedAccountIds: ReadonlySet<number>,
    reserve: boolean,
  ): Promise<AccountSelection> {
    const allActive = (await this.getActiveAccounts())
      .filter((account) => this.isAccountSelectable(account.id));
    let cooldownChecked = false;
    let cooldownUntil: number | undefined;
    const resolveCooldownUntil = async () => {
      if (cooldownChecked) return cooldownUntil;
      cooldownChecked = true;
      const enabledActive = await this.getEnabledActiveAccounts();
      cooldownUntil = this.nextCooldownUntil(
        enabledActive.length > 0 ? enabledActive : allActive,
        excludedAccountIds,
      );
      return cooldownUntil;
    };
    const sessionKey = this.normalizeSessionId(sessionId);
    let binding = sessionKey ? this.getSessionBinding(sessionKey) : undefined;
    if (!binding && sessionKey) {
      const [persisted] = await db.select({
        accountId: sessionStates.accountId,
        conversationId: sessionStates.conversationId,
        conversationUpdatedAt: sessionStates.conversationUpdatedAt,
        updatedAt: sessionStates.updatedAt,
      })
        .from(sessionStates)
        .where(eq(sessionStates.sessionId, sessionKey))
        .limit(1);
      if (
        persisted?.accountId !== null
        && persisted?.accountId !== undefined
        && allActive.some((account) => account.id === persisted.accountId)
      ) {
        this.bindSession(sessionKey, persisted.accountId, persisted.updatedAt.getTime());
        restoreConversationId(
          persisted.accountId,
          sessionKey,
          persisted.conversationId,
          persisted.conversationUpdatedAt,
        );
        binding = this.getSessionBinding(sessionKey);
      }
    }

    if (binding) {
      const preferred = allActive.find(
        (account) => account.id === binding.accountId && !excludedAccountIds.has(account.id),
      );
      if (preferred) {
        const preferredLoad = this.getInFlightCount(preferred.id);
        if (!reserve || preferredLoad < config.accountMaxConcurrency) {
          return {
            lease: {
              account: preferred,
              leaseId: reserve ? this.trackRequestStart(preferred.id, sessionKey) : "",
            },
            capacityLimited: false,
          };
        }

        const idleLongEnough = Date.now() - binding.updatedAt >= config.sessionRebalanceIdleMs;
        const idleAlternative = idleLongEnough
          ? allActive.find((account) => (
            account.id !== preferred.id
            && !excludedAccountIds.has(account.id)
            && this.getInFlightCount(account.id) < config.accountMaxConcurrency
          ))
          : undefined;
        if (idleAlternative && sessionKey) {
          this.releaseSession(sessionKey, preferred.id);
          this.bindSession(sessionKey, idleAlternative.id);
          return {
            lease: {
              account: idleAlternative,
              leaseId: reserve ? this.trackRequestStart(idleAlternative.id, sessionKey) : "",
            },
            capacityLimited: false,
          };
        }
        return { capacityLimited: true, cooldownUntil: await resolveCooldownUntil() };
      }
      this.releaseSession(sessionKey, binding.accountId);
    }

    if (allActive.length === 0) {
      return { capacityLimited: false, cooldownUntil: await resolveCooldownUntil() };
    }

    const startIdx = (this.state.lastIndex + 1) % allActive.length;
    let selected: Account | undefined;
    let selectedIdx = -1;
    let selectedLoad = Number.POSITIVE_INFINITY;

    for (let i = 0; i < allActive.length; i++) {
      const idx = (startIdx + i) % allActive.length;
      const candidate = allActive[idx];
      if (!candidate || excludedAccountIds.has(candidate.id)) continue;
      const load = this.getInFlightCount(candidate.id);
      if (reserve && load >= config.accountMaxConcurrency) continue;
      if (!selected || load < selectedLoad) {
        selected = candidate;
        selectedIdx = idx;
        selectedLoad = load;
        if (load === 0) break;
      }
    }

    if (!selected) {
      const hasCandidate = allActive.some((account) => !excludedAccountIds.has(account.id));
      return {
        capacityLimited: reserve && hasCandidate,
        cooldownUntil: await resolveCooldownUntil(),
      };
    }
    this.state.lastIndex = selectedIdx;
    if (sessionKey) this.bindSession(sessionKey, selected.id);
    return {
      lease: {
        account: selected,
        leaseId: reserve ? this.trackRequestStart(selected.id, sessionKey) : "",
      },
      capacityLimited: false,
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

  forgetSession(sessionId: string | undefined, accountId?: number | null): void {
    const sessionKey = this.normalizeSessionId(sessionId);
    if (!sessionKey) return;
    const binding = this.sessionBindings.get(sessionKey);
    this.sessionBindings.delete(sessionKey);
    if (binding) deleteConversationId(binding.accountId, sessionKey);
    if (accountId !== null && accountId !== undefined && accountId !== binding?.accountId) {
      deleteConversationId(accountId, sessionKey);
    }
  }

  isSessionInFlight(sessionId: string | undefined): boolean {
    const sessionKey = this.normalizeSessionId(sessionId);
    if (!sessionKey) return false;
    for (const accountId of this.inFlightByAccountId.keys()) {
      const leases = this.inFlightByAccountId.get(accountId);
      if (!leases) continue;
      this.getInFlightCount(accountId);
      for (const lease of leases.values()) {
        if (lease.sessionId === sessionKey) return true;
      }
    }
    return false;
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
    this.notifyCapacityWaiters();
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
    this.sessionBindings.set(sessionId, binding);
    return binding;
  }

  touchSession(sessionId: string | undefined, accountId: number): void {
    const sessionKey = this.normalizeSessionId(sessionId);
    if (!sessionKey) return;
    const binding = this.sessionBindings.get(sessionKey);
    if (binding && binding.accountId !== accountId) return;
    this.bindSession(sessionKey, accountId);
  }

  private bindSession(sessionId: string, accountId: number, updatedAt = Date.now()): void {
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
    this.sessionBindings.set(sessionId, { accountId, updatedAt });
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

  private nextCooldownUntil(
    activeAccounts: Account[],
    excludedAccountIds: ReadonlySet<number>,
  ): number | undefined {
    const now = Date.now();
    let earliest: number | undefined;
    for (const account of activeAccounts) {
      if (
        excludedAccountIds.has(account.id)
        || this.unavailableAccountIds.has(account.id)
      ) {
        continue;
      }
      const cooldown = this.cooldownByAccountId.get(account.id);
      if (!cooldown || cooldown.until <= now) continue;
      if (earliest === undefined || cooldown.until < earliest) earliest = cooldown.until;
    }
    return earliest;
  }

  trackRequestStart(accountId: number, sessionId?: string): string {
    const leaseId = crypto.randomUUID();
    const leases = this.inFlightByAccountId.get(accountId) || new Map<string, InFlightLease>();
    leases.set(leaseId, { startedAt: Date.now(), sessionId: this.normalizeSessionId(sessionId) });
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
    this.notifyCapacityWaiters();
  }

  private waitForPoolChange(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.capacityWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.capacityWaiters.add(finish);
    });
  }

  private notifyCapacityWaiters(): void {
    for (const waiter of [...this.capacityWaiters]) waiter();
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
      this.notifyCapacityWaiters();
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
    this.notifyCapacityWaiters();
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
    await writeAccountUsed(accountId);
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
    await writeAccountTokens(accountId, tokens);
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
