import type { Database } from "bun:sqlite";
import { config } from "../config";
import { client } from "./index";
import { pool } from "../proxy/pool";

const SESSION_CLEANUP_BATCH_SIZE = 500;

export interface RetentionResult {
  archivedRequestLogs: number;
  deletedSessions: number;
}

interface ArchivedRequestStats {
  totalRequests: number;
  successRequests: number;
  errorRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface SessionCandidate {
  sessionId: string;
  accountId: number | null;
}

let cleanupTimer: ReturnType<typeof setInterval> | undefined;
let cleanupRunning = false;

export function pruneRequestLogs(
  database: Database,
  retainCount = config.requestLogRetainCount,
  cleanupThreshold = config.requestLogCleanupThreshold,
): number {
  const retain = Math.max(1, Math.floor(retainCount));
  const threshold = Math.max(retain + 1, Math.floor(cleanupThreshold));
  const row = database.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM request_logs",
  ).get();
  if ((row?.count ?? 0) < threshold) return 0;

  const archiveWhere = `id NOT IN (
    SELECT id FROM request_logs ORDER BY id DESC LIMIT ${retain}
  )`;
  const transaction = database.transaction(() => {
    const totals = database.query<ArchivedRequestStats, []>(`
      SELECT
        COUNT(*) AS totalRequests,
        COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS successRequests,
        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errorRequests,
        COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
        COALESCE(SUM(completion_tokens), 0) AS completionTokens,
        COALESCE(SUM(total_tokens), 0) AS totalTokens
      FROM request_logs
      WHERE ${archiveWhere}
    `).get();
    if (!totals || totals.totalRequests === 0) return 0;

    database.query(`
      INSERT INTO request_stats_totals (
        id, total_requests, success_requests, error_requests,
        prompt_tokens, completion_tokens, total_tokens, updated_at
      ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(id) DO UPDATE SET
        total_requests = total_requests + excluded.total_requests,
        success_requests = success_requests + excluded.success_requests,
        error_requests = error_requests + excluded.error_requests,
        prompt_tokens = prompt_tokens + excluded.prompt_tokens,
        completion_tokens = completion_tokens + excluded.completion_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        updated_at = excluded.updated_at
    `).run(
      totals.totalRequests,
      totals.successRequests,
      totals.errorRequests,
      totals.promptTokens,
      totals.completionTokens,
      totals.totalTokens,
      Math.floor(Date.now() / 1000),
    );
    database.exec(`DELETE FROM request_logs WHERE ${archiveWhere}`);
    return totals.totalRequests;
  });

  return transaction.immediate();
}

export function pruneExpiredSessions(
  database: Database,
  retentionDays = config.sessionRetentionDays,
  isInFlight: (sessionId: string) => boolean = (sessionId) => pool.isSessionInFlight(sessionId),
  onDeleted: (sessionId: string, accountId: number | null) => void = (sessionId, accountId) => {
    pool.forgetSession(sessionId, accountId);
  },
): number {
  const cutoff = Math.floor(Date.now() / 1000) - Math.max(1, Math.floor(retentionDays)) * 86_400;
  const candidates = database.query<SessionCandidate, [number, number]>(`
    SELECT session_id AS sessionId, account_id AS accountId
    FROM session_states
    WHERE updated_at < ?1
    ORDER BY updated_at ASC
    LIMIT ?2
  `).all(cutoff, SESSION_CLEANUP_BATCH_SIZE);
  if (candidates.length === 0) return 0;

  const deleteStatement = database.query(
    "DELETE FROM session_states WHERE session_id = ?1 AND updated_at < ?2",
  );
  const deletedSessions: SessionCandidate[] = [];
  const transaction = database.transaction(() => {
    let deleted = 0;
    for (const candidate of candidates) {
      if (isInFlight(candidate.sessionId)) continue;
      const result = deleteStatement.run(candidate.sessionId, cutoff);
      if (result.changes > 0) {
        deleted++;
        deletedSessions.push(candidate);
      }
    }
    return deleted;
  });

  const deleted = transaction.immediate();
  for (const candidate of deletedSessions) {
    onDeleted(candidate.sessionId, candidate.accountId);
  }
  return deleted;
}

export async function runRetentionCleanup(): Promise<RetentionResult> {
  if (cleanupRunning) return { archivedRequestLogs: 0, deletedSessions: 0 };
  cleanupRunning = true;
  try {
    const archivedRequestLogs = pruneRequestLogs(client);
    const deletedSessions = pruneExpiredSessions(client);
    if (archivedRequestLogs > 0 || deletedSessions > 0) {
      console.log(
        `[retention] Archived ${archivedRequestLogs} request log(s); deleted ${deletedSessions} expired session(s)`,
      );
    }
    return { archivedRequestLogs, deletedSessions };
  } catch (error) {
    console.error("[retention] Cleanup failed:", error);
    return { archivedRequestLogs: 0, deletedSessions: 0 };
  } finally {
    cleanupRunning = false;
  }
}

export function startRetentionScheduler(): void {
  if (cleanupTimer) return;
  void runRetentionCleanup();
  cleanupTimer = setInterval(() => void runRetentionCleanup(), config.requestLogCleanupIntervalMs);
  cleanupTimer.unref?.();
  console.log(`[retention] Scheduler started (interval: ${config.requestLogCleanupIntervalMs}ms)`);
}

export function stopRetentionScheduler(): void {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = undefined;
}
