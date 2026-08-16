import type { NewRequestLog } from "./schema";
import { client } from "./index";

type WriteOperation =
  | { type: "probe" }
  | {
      type: "commit_session";
      sessionId: string;
      accountId: number;
      conversationId: string | null;
      conversationUpdatedAt: number | null;
      messages: string;
      turnCount: number;
      estimatedTokens: number;
      messageChars: number;
      timestamp: number;
    }
  | {
      type: "record_request";
      entry: {
        accountId: number | null;
        sessionId: string | null;
        model: string | null;
        reasoningEffort: string | null;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        tokenSource: string | null;
        requestMessages: string | null;
        responseMessage: string | null;
        status: string;
        ttfbMs: number | null;
        durationMs: number | null;
        errorMessage: string | null;
        createdAt: number;
      };
    }
  | {
      type: "clear_session_conversation";
      sessionId: string;
      accountId: number;
      timestamp: number;
    }
  | { type: "mark_account_used"; accountId: number; timestamp: number }
  | { type: "update_account_tokens"; accountId: number; tokens: string; timestamp: number };

/**
 * SQLite already serializes writes per connection. Keeping an additional
 * Bun Worker connection for writes made the process compete with its own
 * Drizzle/retention/API writes for the SQLite writer lock. Under concurrent
 * sessions that amplified "database is locked" waits and made unrelated
 * account state transitions appear to fail.
 *
 * Keep the async queue API, but execute queued writes on the process-wide
 * SQLite connection. Reads and direct Drizzle writes therefore share the same
 * connection and are serialized by the event loop without a second writer.
 */
let queueTail = Promise.resolve();
let pending = 0;
const idleWaiters = new Set<() => void>();

function notifyIdleWaiters(): void {
  if (pending > 0) return;
  for (const resolve of idleWaiters) resolve();
  idleWaiters.clear();
}

function enqueue(operation: WriteOperation): Promise<void> {
  pending++;
  const run = queueTail.then(() => execute(operation));
  queueTail = run.catch(() => {});
  return run.finally(() => {
    pending--;
    notifyIdleWaiters();
  });
}

function timestamp(): number {
  return Math.floor(Date.now() / 1000);
}

export function initializeDatabaseWriteQueue(): Promise<void> {
  return enqueue({ type: "probe" });
}

export function writeSessionState(input: {
  sessionId: string;
  accountId: number;
  conversationId: string | null;
  conversationUpdatedAt: number | null;
  messages: string;
  turnCount: number;
  estimatedTokens: number;
  messageChars: number;
}): Promise<void> {
  return enqueue({ type: "commit_session", ...input, timestamp: timestamp() });
}

export function clearPersistedSessionConversation(
  sessionId: string | undefined,
  accountId: number,
): Promise<void> {
  if (!sessionId) return Promise.resolve();
  return enqueue({
    type: "clear_session_conversation",
    sessionId,
    accountId,
    timestamp: timestamp(),
  });
}

export function writeRequestLog(entry: NewRequestLog): Promise<void> {
  return enqueue({
    type: "record_request",
    entry: {
      accountId: entry.accountId ?? null,
      sessionId: entry.sessionId ?? null,
      model: entry.model ?? null,
      reasoningEffort: entry.reasoningEffort ?? null,
      promptTokens: entry.promptTokens ?? 0,
      completionTokens: entry.completionTokens ?? 0,
      totalTokens: entry.totalTokens ?? 0,
      tokenSource: entry.tokenSource ?? null,
      requestMessages: entry.requestMessages ?? null,
      responseMessage: entry.responseMessage ?? null,
      status: entry.status,
      ttfbMs: entry.ttfbMs ?? null,
      durationMs: entry.durationMs ?? null,
      errorMessage: entry.errorMessage ?? null,
      createdAt: timestamp(),
    },
  });
}

export function writeAccountUsed(accountId: number): Promise<void> {
  return enqueue({ type: "mark_account_used", accountId, timestamp: timestamp() });
}

export function writeAccountTokens(accountId: number, tokens: unknown): Promise<void> {
  return enqueue({
    type: "update_account_tokens",
    accountId,
    tokens: JSON.stringify(tokens),
    timestamp: timestamp(),
  });
}

export function flushDatabaseWriteQueue(): Promise<void> {
  if (pending === 0) return Promise.resolve();
  return new Promise<void>((resolve) => idleWaiters.add(resolve));
}

export async function closeDatabaseWriteQueue(): Promise<void> {
  await flushDatabaseWriteQueue();
}

function execute(operation: WriteOperation): void {
  switch (operation.type) {
    case "probe":
      client.query("SELECT 1").get();
      return;
    case "commit_session":
      client.query(`
        INSERT INTO session_states (
          session_id, account_id, conversation_id, conversation_updated_at,
          messages, turn_count, estimated_tokens, message_chars,
          revision, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9)
        ON CONFLICT(session_id) DO UPDATE SET
          account_id = excluded.account_id,
          conversation_id = excluded.conversation_id,
          conversation_updated_at = excluded.conversation_updated_at,
          messages = excluded.messages,
          turn_count = excluded.turn_count,
          estimated_tokens = excluded.estimated_tokens,
          message_chars = excluded.message_chars,
          revision = session_states.revision + 1,
          updated_at = excluded.updated_at
      `).run(
        operation.sessionId,
        operation.accountId,
        operation.conversationId,
        operation.conversationUpdatedAt,
        operation.messages,
        operation.turnCount,
        operation.estimatedTokens,
        operation.messageChars,
        operation.timestamp,
      );
      return;
    case "record_request": {
      const entry = operation.entry;
      client.query(`
        INSERT INTO request_logs (
          account_id, session_id, model, reasoning_effort,
          prompt_tokens, completion_tokens, total_tokens, token_source,
          request_messages, response_message, status, ttfb_ms,
          duration_ms, error_message, created_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
        )
      `).run(
        entry.accountId,
        entry.sessionId,
        entry.model,
        entry.reasoningEffort,
        entry.promptTokens,
        entry.completionTokens,
        entry.totalTokens,
        entry.tokenSource,
        entry.requestMessages,
        entry.responseMessage,
        entry.status,
        entry.ttfbMs,
        entry.durationMs,
        entry.errorMessage,
        entry.createdAt,
      );
      return;
    }
    case "clear_session_conversation":
      client.query(`
        UPDATE session_states
        SET conversation_id = NULL,
            conversation_updated_at = NULL,
            updated_at = ?1
        WHERE session_id = ?2 AND account_id = ?3
      `).run(operation.timestamp, operation.sessionId, operation.accountId);
      return;
    case "mark_account_used":
      client.query("UPDATE accounts SET last_used_at = ?1, updated_at = ?1 WHERE id = ?2")
        .run(operation.timestamp, operation.accountId);
      return;
    case "update_account_tokens":
      client.query("UPDATE accounts SET tokens = ?1, updated_at = ?2 WHERE id = ?3")
        .run(operation.tokens, operation.timestamp, operation.accountId);
  }
}
