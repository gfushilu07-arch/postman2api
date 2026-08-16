import type { NewRequestLog } from "./schema";
import { config } from "../config";

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

interface WorkerResponse {
  id: number;
  success: boolean;
  error?: string;
}

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
const idleWaiters = new Set<() => void>();

function notifyIdleWaiters(): void {
  if (pending.size > 0) return;
  for (const resolve of idleWaiters) resolve();
  idleWaiters.clear();
}

function failPending(error: Error): void {
  for (const item of pending.values()) item.reject(error);
  pending.clear();
  notifyIdleWaiters();
}

export function resolveWriteWorkerUrl(
  moduleUrl = import.meta.url,
  modulePath = import.meta.path,
): URL {
  const sourceMode = modulePath.endsWith(".ts");
  return new URL(
    sourceMode ? "./write-worker.ts" : "./db/write-worker.js",
    moduleUrl,
  );
}

function getWorker(): Worker {
  if (worker) return worker;
  const workerUrl = resolveWriteWorkerUrl();
  worker = new Worker(workerUrl.href, { type: "module" });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const item = pending.get(response.id);
    if (!item) return;
    pending.delete(response.id);
    if (response.success) item.resolve();
    else item.reject(new Error(response.error || "SQLite write worker failed"));
    if (pending.size === 0) {
      worker?.unref();
      notifyIdleWaiters();
    }
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "SQLite write worker crashed");
    failPending(error);
    worker?.terminate();
    worker = undefined;
  };
  worker.unref();
  return worker;
}

function enqueue(operation: WriteOperation): Promise<void> {
  const activeWorker = getWorker();
  activeWorker.ref();
  const id = nextId++;
  return new Promise<void>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    activeWorker.postMessage({ id, databasePath: config.databasePath, operation });
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
  if (pending.size === 0) return Promise.resolve();
  return new Promise<void>((resolve) => idleWaiters.add(resolve));
}

export async function closeDatabaseWriteQueue(): Promise<void> {
  if (!worker) return;
  await flushDatabaseWriteQueue();
  worker.terminate();
  worker = undefined;
}
