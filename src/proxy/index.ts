import type { NewRequestLog } from "../db/schema";
import type { ChatCompletionRequest, ChatMessage } from "../provider/base";
import { routeRequest, type RouteResult } from "./router";
import { pool } from "./pool";
import { broadcast } from "../ws/index";
import {
  commitSession,
  prepareSession,
} from "../provider/session-state";
import { deleteConversationId } from "../provider/conversation-store";
import { acquireSessionLock } from "./session-lock";
import { config } from "../config";
import { normalizeReasoningEffort } from "../provider/base";
import {
  clearPersistedSessionConversation,
  writeRequestLog,
} from "../db/write-queue";
import { trimContextMessages } from "../provider/context-trimmer";
import { getContextMaxTokens } from "../settings/runtime";

interface ByteStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

const MAX_REQUEST_SNAPSHOT_CHARS = 96_000;

export async function handleChatCompletion(
  body: ChatCompletionRequest,
  signal?: AbortSignal,
): Promise<Response> {
  const requestStartedAt = Date.now();
  const stream = body.stream ?? false;
  const requestAbort = new AbortController();
  const detachClientAbort = forwardAbort(signal, requestAbort);
  body.signal = requestAbort.signal;
  const releaseSessionLock = await acquireSessionLock(body._sessionId);
  let releaseAfterReturn = true;
  let cleanupAfterReturn = true;

  try {
    const prepared = await prepareSession(body._sessionId, body.messages);
    const contextMaxTokens = await getContextMaxTokens();
    const trimmedContext = trimContextMessages(
      prepared.messages,
      contextMaxTokens,
      body.tools,
    );
    body.messages = trimmedContext.messages;
    if (trimmedContext.trimmed) {
      body._resetConversation = true;
      if (prepared.accountId !== null) {
        deleteConversationId(prepared.accountId, body._sessionId);
        await clearPersistedSessionConversation(body._sessionId, prepared.accountId);
      }
      console.info("[context] Trimmed request history", {
        maxTokens: trimmedContext.maxTokens,
        estimatedTokensBefore: trimmedContext.estimatedTokensBefore,
        estimatedTokensAfter: trimmedContext.estimatedTokensAfter,
        droppedMessages: trimmedContext.droppedMessages,
        droppedTurns: trimmedContext.droppedTurns,
        mandatoryTokensExceeded: trimmedContext.mandatoryTokensExceeded,
      });
    }
    const routed = await routeRequest(body, stream);
    const { result, account, durationMs } = routed;
    const ttfbMs = Date.now() - requestStartedAt;

    if (result.success && result.stream) {
      try {
        const response = wrapQuotaSafeStream(routed, {
          request: body,
          model: body.model,
          sessionId: body._sessionId,
          requestMessages: body.messages,
          sessionHistoryMessages: prepared.messages,
          requestAbort,
          detachClientAbort,
          releaseSessionLock,
          requestStartedAt,
          initialTtfbMs: ttfbMs,
        });
        releaseAfterReturn = false;
        cleanupAfterReturn = false;
        return response;
      } catch (error) {
        deleteConversationId(account.id, body._sessionId);
        await clearPersistedSessionConversation(body._sessionId, account.id);
        pool.trackRequestEnd(account.id, routed.leaseId);
        throw error;
      }
    }

    if (result.success && result.response) {
      const assistantMessage = result.response.choices[0]?.message;
      if (assistantMessage) {
        await commitSession(
          body._sessionId,
          body.messages,
          assistantMessage,
          account.id,
          prepared.messages,
        );
        pool.touchSession(body._sessionId, account.id);
      }
      await recordRequest({
        ...requestLogContext(body),
        accountId: account.id,
        model: body.model,
        promptTokens: result.promptTokens || 0,
        completionTokens: result.completionTokens || 0,
        totalTokens: result.tokensUsed || 0,
        tokenSource: result.tokenSource,
        responseMessage: assistantMessage ? serializeSnapshot(assistantMessage) : undefined,
        status: "success",
        ttfbMs,
        durationMs,
      });

      return new Response(JSON.stringify(result.response), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Non-success
    await recordRequest({
      ...requestLogContext(body),
      accountId: account.id,
      model: body.model,
      status: "error",
      ttfbMs,
      durationMs,
      errorMessage: result.error || "Unknown error",
    });

    return errorResponse(
      result.error || "Unknown error",
      providerErrorStatus(result),
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await recordRequest({
      ...requestLogContext(body),
      model: body.model,
      status: "error",
      durationMs: 0,
      errorMessage: errMsg,
    });

    if (
      errMsg.includes("No active accounts")
      || errMsg.includes("All accounts failed")
      || errMsg.includes("reached the concurrency limit")
      || errMsg.includes("temporarily cooling down")
      || errMsg.startsWith("Invalid model:")
    ) {
      const status = errMsg.startsWith("Invalid model:") ? 400 : 503;
      return errorResponse(errMsg, status);
    }

    return errorResponse(errMsg, 500);
  } finally {
    if (releaseAfterReturn) releaseSessionLock();
    if (cleanupAfterReturn) detachClientAbort();
  }
}

function wrapQuotaSafeStream(
  initialAttempt: RouteResult,
  ctx: {
    request: ChatCompletionRequest;
    model: string;
    sessionId?: string;
    requestMessages: ChatMessage[];
    sessionHistoryMessages: ChatMessage[];
    requestAbort: AbortController;
    detachClientAbort: () => void;
    releaseSessionLock: () => void;
    requestStartedAt: number;
    initialTtfbMs: number;
  },
): Response {
  const startedAt = ctx.requestStartedAt;
  const encoder = new TextEncoder();
  let cancelled = false;
  let lifecycleFinalized = false;
  let activeReader: ByteStreamReader | undefined;
  let releaseActiveAttempt: (() => void) | undefined;
  let activeAttempt = initialAttempt;
  let activeTtfbMs = ctx.initialTtfbMs;

  const finalizeLifecycle = () => {
    if (lifecycleFinalized) return;
    lifecycleFinalized = true;
    ctx.detachClientAbort();
    ctx.releaseSessionLock();
  };

  const safeCancelActiveReader = async (reason: unknown) => {
    try {
      await activeReader?.cancel(reason);
    } catch {
      // Cancellation is best-effort.
    }
  };

  const wrappedStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const keepalive = setInterval(() => {
        if (cancelled || lifecycleFinalized) return;
        try {
          controller.enqueue(encoder.encode(": postman2api quota-safe keepalive\n\n"));
        } catch {
          // The client can disappear between the lifecycle check and enqueue.
        }
      }, config.streamKeepaliveIntervalMs);

      try {
        while (!cancelled) {
          if (!activeAttempt.result.success || !activeAttempt.result.stream) {
            throw new Error(activeAttempt.result.error || "Postman returned no stream");
          }

          const attempt = activeAttempt;
          let attemptReleased = false;
          const releaseAttempt = () => {
            if (attemptReleased) return;
            attemptReleased = true;
            pool.trackRequestEnd(attempt.account.id, attempt.leaseId);
          };
          releaseActiveAttempt = releaseAttempt;
          const chunks: Uint8Array[] = [];
          let bufferedBytes = 0;
          let attemptError: unknown;

          try {
            const attemptStream = attempt.result.stream;
            if (!attemptStream) throw new Error("Postman returned no stream");
            activeReader = attemptStream.getReader();
            while (!cancelled) {
              const { done, value } = await activeReader.read();
              if (done) break;
              if (!value) continue;
              bufferedBytes += value.byteLength;
              if (bufferedBytes > config.quotaSafeStreamBufferBytes) {
                throw new Error(
                  `Quota-safe stream buffer exceeded ${config.quotaSafeStreamBufferBytes} bytes`,
                );
              }
              chunks.push(value);
            }
            if (cancelled) throw new Error("Client disconnected");
          } catch (error) {
            attemptError = error;
          } finally {
            if (attemptError !== undefined) {
              try {
                await activeReader?.cancel(attemptError);
              } catch {
                // The source may already be errored or cancelled.
              }
            }
            try {
              activeReader?.releaseLock();
            } catch {
              // A failed read may retain the lock until cancellation settles.
            }
            activeReader = undefined;
            releaseAttempt();
            releaseActiveAttempt = undefined;
          }

          if (!attemptError) {
            const assistantMessage = attempt.result.getStreamMessage?.();
            const tokenUsage = attempt.result.getStreamTokenUsage?.();
            if (assistantMessage) {
              await commitSession(
                ctx.sessionId,
                ctx.requestMessages,
                assistantMessage,
                attempt.account.id,
                ctx.sessionHistoryMessages,
              );
              pool.touchSession(ctx.sessionId, attempt.account.id);
            }
            await recordRequest({
              ...requestLogContext(ctx.request),
              accountId: attempt.account.id,
              model: ctx.model,
              promptTokens: tokenUsage?.promptTokens ?? attempt.result.promptTokens ?? 0,
              completionTokens: tokenUsage?.completionTokens ?? attempt.result.completionTokens ?? 0,
              totalTokens: tokenUsage?.totalTokens ?? attempt.result.tokensUsed ?? 0,
              tokenSource: tokenUsage?.source ?? attempt.result.tokenSource,
              responseMessage: assistantMessage ? serializeSnapshot(assistantMessage) : undefined,
              status: "success",
              ttfbMs: activeTtfbMs,
              durationMs: Date.now() - startedAt,
            });
            clearInterval(keepalive);
            for (const chunk of chunks) {
              if (cancelled) break;
              controller.enqueue(chunk);
            }
            if (!cancelled) controller.close();
            return;
          }

          const errorMessage = attemptError instanceof Error
            ? attemptError.message
            : String(attemptError);
          deleteConversationId(attempt.account.id, ctx.sessionId);
          await clearPersistedSessionConversation(ctx.sessionId, attempt.account.id);
          await recordRequest({
            ...requestLogContext(ctx.request),
            accountId: attempt.account.id,
            model: ctx.model,
            status: "error",
            ttfbMs: activeTtfbMs,
            durationMs: Date.now() - startedAt,
            errorMessage,
          });

          const streamFailure = attempt.result.getStreamFailure?.();
          if (streamFailure?.kind !== "quota_exhausted" || cancelled) {
            throw attemptError;
          }

          activeAttempt = await routeRequest(ctx.request, true);
          activeTtfbMs = Date.now() - ctx.requestStartedAt;
        }
      } catch (error) {
        if (!cancelled) controller.error(error);
      } finally {
        clearInterval(keepalive);
        releaseActiveAttempt?.();
        finalizeLifecycle();
      }
    },
    async cancel(reason) {
      if (cancelled) return;
      cancelled = true;
      ctx.requestAbort.abort(reason instanceof Error ? reason : new Error(String(reason || "Client disconnected")));
      await safeCancelActiveReader(reason);
      releaseActiveAttempt?.();
      finalizeLifecycle();
    },
  });

  return new Response(wrappedStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {};
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const abort = () => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

async function recordRequest(entry: NewRequestLog): Promise<void> {
  try {
    await writeRequestLog(entry);
    broadcast({ type: "request_completed", data: { status: entry.status, model: entry.model } });
  } catch (err) {
    console.error("[proxy] Failed to log request:", err);
  }
}

function requestLogContext(request: ChatCompletionRequest): Pick<
  NewRequestLog,
  "sessionId" | "reasoningEffort" | "requestMessages"
> {
  return {
    sessionId: request._sessionId,
    reasoningEffort: normalizeReasoningEffort(request),
    // Request details are for search/debugging only. Keep the latest user
    // question instead of duplicating the full conversation in every row.
    requestMessages: serializeSnapshot(latestUserQuestion(request.messages)),
  };
}

function latestUserQuestion(messages: ChatMessage[]): ChatMessage[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "user") {
      return [{ role: "user", content: message.content }];
    }
  }
  return [];
}

function serializeSnapshot(value: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(value) ?? "null";
  } catch {
    raw = JSON.stringify({ unavailable: true, reason: "Unable to serialize snapshot" });
  }
  if (raw.length <= MAX_REQUEST_SNAPSHOT_CHARS) return raw;

  return JSON.stringify({
    truncated: true,
    originalChars: raw.length,
    preview: raw.slice(0, MAX_REQUEST_SNAPSHOT_CHARS - 200),
  });
}

function errorResponse(message: string, status: number): Response {
  const type = status >= 400 && status < 500
    ? "invalid_request_error"
    : status === 503
      ? "no_available_account"
      : "upstream_error";
  return new Response(
    JSON.stringify({
      error: {
        message,
        type,
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function providerErrorStatus(result: RouteResult["result"]): number {
  if (result.requestRejected) {
    return result.httpStatus === 400 ? 400 : 422;
  }
  if (result.modelMismatch) return 502;
  return 502;
}

export { pool };
