import { describe, expect, test } from "bun:test";
import { PostmanStreamReader } from "../src/provider/sse-stream";

describe("Postman stream token usage", () => {
  test("captures explicit token counts from an upstream usage event", () => {
    const reader = new PostmanStreamReader();

    reader.feed(`data: ${JSON.stringify({
      eventType: "usage",
      data: {
        limit: 100,
        usage: 2,
        prompt_tokens: 123,
        completion_tokens: 45,
        total_tokens: 168,
      },
    })}`);

    expect(reader.tokenUsage).toEqual({
      promptTokens: 123,
      completionTokens: 45,
      totalTokens: 168,
    });
  });

  test("does not treat Postman credit usage as a token count", () => {
    const reader = new PostmanStreamReader();

    reader.feed(`data: ${JSON.stringify({
      eventType: "usage",
      data: { limit: 100, usage: 2, usageState: "AVAILABLE" },
    })}`);

    expect(reader.usage?.usage).toBe(2);
    expect(reader.tokenUsage).toBeNull();
  });
});
