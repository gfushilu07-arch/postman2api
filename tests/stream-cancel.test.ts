import { afterEach, describe, expect, test } from "bun:test";
import { createCancellableStream } from "../src/utils/cancellable-stream";
import { openAIStreamToAnthropic } from "../src/proxy/transforms/anthropic";

const servers: Bun.Server<unknown>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("cancellable stream", () => {
  test("cancels the locked reader safely and finalizes once", async () => {
    let sourceCancelCount = 0;
    let finalizeCount = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
      },
      cancel() {
        sourceCancelCount++;
        return Promise.reject(new Error("upstream cancel failed"));
      },
    });

    const wrapped = createCancellableStream(source, {
      onCancel: () => { finalizeCount++; },
      onComplete: () => { finalizeCount++; },
      onError: () => { finalizeCount++; },
    });
    const reader = wrapped.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");

    await expect(reader.cancel("client disconnected")).resolves.toBeUndefined();
    await expect(reader.cancel("again")).resolves.toBeUndefined();
    expect(sourceCancelCount).toBe(1);
    expect(finalizeCount).toBe(1);
    expect(source.locked).toBe(false);
  });

  test("does not time out a response that is idle for more than 10 seconds", async () => {
    const server = Bun.serve({
      port: 0,
      idleTimeout: 20,
      async fetch() {
        await Bun.sleep(10_500);
        return new Response("ok");
      },
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/delayed`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  }, 15_000);

  test("propagates Anthropic client cancellation to the OpenAI source stream", async () => {
    const encoder = new TextEncoder();
    let sourceCancelCount = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "hello" }, finish_reason: null }],
          })}\n\n`,
        ));
      },
      cancel() {
        sourceCancelCount++;
      },
    });
    const transformed = openAIStreamToAnthropic(source, {
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    const reader = transformed.getReader();

    expect(new TextDecoder().decode((await reader.read()).value)).toContain("message_start");
    await reader.cancel("client disconnected");
    await Bun.sleep(0);

    expect(sourceCancelCount).toBe(1);
    expect(source.locked).toBe(false);
  });
});
