import { Database } from "bun:sqlite";

declare const self: Worker;

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

interface WriteRequest {
  id: number;
  databasePath: string;
  operation: WriteOperation;
}

let database: Database | undefined;
let openedPath = "";

function getDatabase(databasePath: string): Database {
  if (database && openedPath === databasePath) return database;
  database?.close();
  database = new Database(databasePath, { create: true });
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA synchronous = NORMAL;");
  database.exec("PRAGMA busy_timeout = 5000;");
  database.exec("PRAGMA foreign_keys = ON;");
  openedPath = databasePath;
  return database;
}

function execute(request: WriteRequest): void {
  const db = getDatabase(request.databasePath);
  const operation = request.operation;
  switch (operation.type) {
    case "probe":
      db.query("SELECT 1").get();
      return;
    case "commit_session":
      db.query(`
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
      db.query(`
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
      db.query(`
        UPDATE session_states
        SET conversation_id = NULL,
            conversation_updated_at = NULL,
            updated_at = ?1
        WHERE session_id = ?2 AND account_id = ?3
      `).run(operation.timestamp, operation.sessionId, operation.accountId);
      return;
    case "mark_account_used":
      db.query("UPDATE accounts SET last_used_at = ?1, updated_at = ?1 WHERE id = ?2")
        .run(operation.timestamp, operation.accountId);
      return;
    case "update_account_tokens":
      db.query("UPDATE accounts SET tokens = ?1, updated_at = ?2 WHERE id = ?3")
        .run(operation.tokens, operation.timestamp, operation.accountId);
  }
}

self.onmessage = (event: MessageEvent<WriteRequest>) => {
  const request = event.data;
  try {
    execute(request);
    postMessage({ id: request.id, success: true });
  } catch (error) {
    postMessage({
      id: request.id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
