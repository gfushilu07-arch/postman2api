import { describe, expect, test } from "bun:test";
import {
  estimateMessagesTokens,
  estimateToolsTokens,
  trimContextMessages,
} from "../src/provider/context-trimmer";
import type { ChatMessage } from "../src/provider/base";

describe("context trimming", () => {
  test("drops the oldest complete turns while retaining system instructions", () => {
    const system = { role: "system", content: "Keep this instruction." } as ChatMessage;
    const oldTurn = [
      { role: "user", content: "old question ".repeat(80) },
      { role: "assistant", content: "old answer ".repeat(80) },
    ] as ChatMessage[];
    const middleTurn = [
      { role: "user", content: "middle question ".repeat(30) },
      { role: "assistant", content: "middle answer ".repeat(30) },
    ] as ChatMessage[];
    const latestTurn = [
      { role: "user", content: "latest question" },
    ] as ChatMessage[];
    const expected = [system, ...middleTurn, ...latestTurn];
    const result = trimContextMessages(
      [system, ...oldTurn, ...middleTurn, ...latestTurn],
      estimateMessagesTokens(expected),
    );

    expect(result.trimmed).toBe(true);
    expect(result.messages).toEqual(expected);
    expect(result.droppedMessages).toBe(2);
    expect(result.droppedTurns).toBe(1);
    expect(result.estimatedTokensAfter).toBeLessThanOrEqual(result.maxTokens);
  });

  test("keeps a tool call and all trailing tool results in the newest turn", () => {
    const tools = [{
      type: "function",
      function: {
        name: "shell",
        description: "Run a shell command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
        },
      },
    }];
    const oldTurn = [
      { role: "user", content: "old question ".repeat(100) },
      { role: "assistant", content: "old answer ".repeat(100) },
    ] as ChatMessage[];
    const currentTurn = [
      { role: "user", content: "run pwd" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "shell", arguments: "{\"command\":\"pwd\"}" },
        }],
      },
      { role: "tool", tool_call_id: "call-1", content: "/workspace" },
    ] as ChatMessage[];
    const maxTokens = estimateMessagesTokens(currentTurn) + estimateToolsTokens(tools);
    const result = trimContextMessages([...oldTurn, ...currentTurn], maxTokens, tools);

    expect(result.trimmed).toBe(true);
    expect(result.messages).toEqual(currentTurn);
    expect(result.messages.at(-1)?.role).toBe("tool");
    expect(result.estimatedTokensAfter).toBeLessThanOrEqual(maxTokens);
  });

  test("preserves an indivisible latest turn even when it exceeds the budget", () => {
    const latest = { role: "user", content: "very large latest input ".repeat(100) } as ChatMessage;
    const result = trimContextMessages([
      { role: "user", content: "discard this old turn" },
      { role: "assistant", content: "old response" },
      latest,
    ], 20);

    expect(result.trimmed).toBe(true);
    expect(result.messages).toEqual([latest]);
    expect(result.mandatoryTokensExceeded).toBe(true);
  });

  test("allows local trimming to be disabled with zero", () => {
    const messages = [
      { role: "user", content: "x".repeat(10_000) },
    ] as ChatMessage[];
    const result = trimContextMessages(messages, 0);

    expect(result.trimmed).toBe(false);
    expect(result.messages).toEqual(messages);
  });
});
