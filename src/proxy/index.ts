import { db } from "../db/index";
import { requestLogs } from "../db/schema";
import type { NewRequestLog } from "../db/schema";
import type { ChatCompletionRequest, ChatMessage } from "../provider/base";
import { routeRequest, type RouteResult } from "./router";
import { pool } from "./pool";
import { broadcast } from "../ws/index";
import { commitSession, prepareSession } from "../provider/session-state";
import { deleteConversationId } from "../provider/conversation-store";
import { acquireSessionLock } from "./session-lock";
import { config } from "../config";

interface ByteStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

export async function handleChatCompletion(
  body: ChatCompletionRequest,
  signal?: AbortSignal,
): Promise<Response> {
  const stream = body.stream ?? false;
  const requestAbort = new AbortController();
  const detachClientAbort = forwardAbort(signal, requestAbort);
  body.signal = requestAbort.signal;
  const releaseSessionLock = await acquireSessionLock(body._sessionId);
  let releaseAfterReturn = true;
  let cleanupAfterReturn = true;

  try {
    const prepared = await prepareSession(body._sessionId, body.messages);
    body.messages = prepared.messages;
    const routed = await routeRequest(body, stream);
    const { result, account, durationMs } = routed;

    if (result.success && result.stream) {
      try {
        const response = wrapQuotaSafeStream(routed, {
          request: body,
          model: body.model,
          sessionId: body._sessionId,
          requestMessages: body.messages,
          requestAbort,
          detachClientAbort,
          releaseSessionLock,
        });
        releaseAfterReturn = false;
        cleanupAfterReturn = false;
        return response;
      } catch (error) {
        deleteConversationId(account.id, body._sessionId);
        pool.trackRequestEnd(account.id, routed.leaseId);
        throw error;
      }
    }

    if (result.success && result.response) {
      const assistantMessage = result.response.choices[0]?.message;
      if (assistantMessage) {
        await commitSession(body._sessionId, body.messages, assistantMessage, account.id);
      }
      await recordRequest({
        accountId: account.id,
        model: body.model,
        promptTokens: result.promptTokens || 0,
        completionTokens: result.completionTokens || 0,
        totalTokens: result.tokensUsed || 0,
        status: "success",
        durationMs,
      });

      return new Response(JSON.stringify(result.response), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Non-success
    await recordRequest({
      accountId: account.id,
      model: body.model,
      status: "error",
      durationMs,
      errorMessage: result.error || "Unknown error",
    });

    return errorResponse(result.error || "Unknown error", 503);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await recordRequest({
      model: body.model,
      status: "error",
      durationMs: 0,
      errorMessage: errMsg,
    });

    if (errMsg.includes("No active accounts") || errMsg.includes("All accounts failed")) {
      return errorResponse(errMsg, 503);
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
    requestAbort: AbortController;
    detachClientAbort: () => void;
    releaseSessionLock: () => void;
  },
): Response {
  const startedAt = Date.now();
  const encoder = new TextEncoder();
  let cancelled = false;
  let lifecycleFinalized = false;
  let activeReader: ByteStreamReader | undefined;
  let releaseActiveAttempt: (() => void) | undefined;
  let activeAttempt = initialAttempt;

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
              );
            }
            await recordRequest({
              accountId: attempt.account.id,
              model: ctx.model,
              promptTokens: tokenUsage?.promptTokens ?? attempt.result.promptTokens ?? 0,
              completionTokens: tokenUsage?.completionTokens ?? attempt.result.completionTokens ?? 0,
              totalTokens: tokenUsage?.totalTokens ?? attempt.result.tokensUsed ?? 0,
              status: "success",
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
          await recordRequest({
            accountId: attempt.account.id,
            model: ctx.model,
            status: "error",
            durationMs: Date.now() - startedAt,
            errorMessage,
          });

          const streamFailure = attempt.result.getStreamFailure?.();
          if (streamFailure?.kind !== "quota_exhausted" || cancelled) {
            throw attemptError;
          }

          activeAttempt = await routeRequest(ctx.request, true);
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
    await db.insert(requestLogs).values({
      ...entry,
      createdAt: new Date(),
    });
    broadcast({ type: "request_completed", data: { status: entry.status, model: entry.model } });
  } catch (err) {
    console.error("[proxy] Failed to log request:", err);
  }
}

function errorResponse(message: string, status: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: status === 503 ? "no_available_account" : "internal_error",
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

export { pool };
