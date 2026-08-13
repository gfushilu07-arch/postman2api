export interface CancellableStreamHooks {
  onComplete?: () => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  onCancel?: (reason: unknown) => void | Promise<void>;
}

/** Relays a byte stream while cancelling the reader that owns the source lock. */
export function createCancellableStream(
  source: ReadableStream<Uint8Array>,
  hooks: CancellableStreamHooks = {},
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let cancelled = false;
  let finalized = false;
  let released = false;

  const release = () => {
    if (released) return;
    try {
      reader.releaseLock();
      released = true;
    } catch {
      // A pending read can briefly retain the lock; retry after cancellation settles.
    }
  };

  const finalize = async (kind: "complete" | "error" | "cancel", value?: unknown) => {
    if (finalized) return;
    finalized = true;
    try {
      if (kind === "complete") await hooks.onComplete?.();
      else if (kind === "error") await hooks.onError?.(value);
      else await hooks.onCancel?.(value);
    } finally {
      release();
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (cancelled) break;
          if (done) {
            await finalize("complete");
            if (!cancelled) controller.close();
            return;
          }
          controller.enqueue(value);
        }
      } catch (error) {
        if (cancelled) return;
        await finalize("error", error);
        if (!cancelled) controller.error(error);
      } finally {
        if (cancelled) release();
      }
    },
    async cancel(reason) {
      if (cancelled) return;
      cancelled = true;
      try {
        await reader.cancel(reason);
      } catch {
        // Cancellation is best-effort and must never become an unhandled rejection.
      } finally {
        await finalize("cancel", reason);
      }
    },
  });
}
