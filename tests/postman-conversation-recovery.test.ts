import { afterEach, describe, expect, test } from "bun:test";
import type { ChatMessage } from "../src/provider/base";
import {
  recoverPostmanConversation,
  selectPostmanConversationCandidate,
  shouldAttemptPostmanConversationRecovery,
  type PostmanConversationDetail,
} from "../src/provider/postman-conversation-recovery";
import {
  clearConversations,
  getConversationId,
  restoreConversationId,
} from "../src/provider/conversation-store";

const assistantContent =
  "I verified the release patch and will now update the documentation before the final validation.";
const reasoningContent =
  "The current tree matches the expected parent, so the next safe step is to record the evidence.";
const toolCall = {
  id: "call_restore_exact",
  type: "function",
  function: {
    name: "exec_command",
    arguments: JSON.stringify({ cmd: "bun test && bunx tsc --noEmit" }),
  },
};

afterEach(() => clearConversations());

function localToolContinuation(): ChatMessage[] {
  return [
    { role: "user", content: "continue the release" },
    {
      role: "assistant",
      content: assistantContent,
      reasoning_content: reasoningContent,
      tool_calls: [toolCall],
    } as any,
    {
      role: "tool",
      tool_call_id: toolCall.id,
      content: "140 pass, 0 fail",
    },
  ];
}

function matchingConversation(id = "conversation-exact"): PostmanConversationDetail {
  return {
    id,
    modelKey: "GPT_56_SOL",
    state: "WAITING_FOR_TOOL",
    interactions: [
      {
        role: "USER",
        type: "MESSAGE_USERQUERY",
        content: "continue",
      },
      {
        role: "ASSISTANT",
        type: "MESSAGE_ASSISTANTRESPONSE",
        content: assistantContent,
        thinkingContent: reasoningContent,
      },
      {
        role: "ASSISTANT",
        type: "MESSAGE_MULTIPLE_TOOLCALLS",
        toolCalls: [{
          id: toolCall.id,
          name: toolCall.function.name,
          args: toolCall.function.arguments,
        }],
      },
    ],
  };
}

describe("Postman cloud conversation recovery", () => {
  test("selects the unique conversation whose assistant and pending tool call match", () => {
    const selected = selectPostmanConversationCandidate(
      localToolContinuation(),
      [
        {
          id: "empty-retry",
          modelKey: "GPT_56_SOL",
          state: "WAITING_FOR_AGENT",
          interactions: [{
            role: "USER",
            content: "Process the latest seeded tool results and continue.",
          }],
        },
        matchingConversation(),
        {
          ...matchingConversation("different-tool"),
          interactions: [{
            role: "ASSISTANT",
            content: "A different session response that must not be selected.",
            toolCalls: [{
              id: "call_other",
              name: "exec_command",
              args: "{\"cmd\":\"pwd\"}",
            }],
          }],
        },
      ],
      "GPT_56_SOL",
    );

    expect(selected.reason).toBe("recovered");
    expect(selected.candidate?.conversationId).toBe("conversation-exact");
    expect(selected.candidate?.toolIdMatches).toBe(1);
    expect(selected.candidate?.toolSignatureMatches).toBe(1);
    expect(selected.candidate?.assistantMatches).toBe(1);
  });

  test("refuses to bind when two high-confidence cloud candidates are indistinguishable", () => {
    const selected = selectPostmanConversationCandidate(
      localToolContinuation(),
      [
        matchingConversation("duplicate-a"),
        matchingConversation("duplicate-b"),
      ],
      "GPT_56_SOL",
    );

    expect(selected.candidate).toBeNull();
    expect(selected.reason).toBe("ambiguous");
  });

  test("never restores a conversation created with a different explicit model", () => {
    const selected = selectPostmanConversationCandidate(
      localToolContinuation(),
      [matchingConversation()],
      "CLAUDE_46_SONNET_BEDROCK",
    );

    expect(selected.candidate).toBeNull();
    expect(selected.reason).toBe("no_compatible_candidate");
  });

  test("queries only compatible cloud details and recovers through the history API", async () => {
    const requestedUrls: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/conversation?")) {
        return new Response(JSON.stringify({
          meta: { nextCursor: null },
          data: [
            {
              id: "waiting-user",
              modelKey: "GPT_56_SOL",
              state: "WAITING_FOR_USER",
            },
            {
              id: "conversation-exact",
              modelKey: "GPT_56_SOL",
              state: "WAITING_FOR_TOOL",
            },
            {
              id: "wrong-model",
              modelKey: "CLAUDE_46_SONNET_BEDROCK",
              state: "WAITING_FOR_TOOL",
            },
          ],
        }), { status: 200 });
      }
      if (url.endsWith("/conversation/conversation-exact")) {
        return new Response(JSON.stringify({
          data: matchingConversation(),
        }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await recoverPostmanConversation({
      tokens: {
        postman_sid: "secret",
        workspace_subdomain: "workspace",
      },
      messages: localToolContinuation(),
      expectedModelKey: "GPT_56_SOL",
      headers: { Cookie: "postman.sid=secret" },
      fetcher,
    });

    expect(result).toMatchObject({
      recovered: true,
      conversationId: "conversation-exact",
      reason: "recovered",
      scanned: 1,
    });
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls.some((url) => url.includes("waiting-user"))).toBe(false);
    expect(requestedUrls.some((url) => url.includes("wrong-model"))).toBe(false);
  });

  test("only auto-probes histories for tool continuations; oversized bootstrap is checked separately", () => {
    expect(shouldAttemptPostmanConversationRecovery([
      { role: "user", content: "new conversation" },
    ])).toBe(false);
    expect(shouldAttemptPostmanConversationRecovery(localToolContinuation())).toBe(true);
  });

  test("restores a durable SQLite conversation even after the in-memory cache TTL", () => {
    const restored = restoreConversationId(
      602,
      "codex:old-session",
      "durable-cloud-conversation",
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    );

    expect(restored).toBe(true);
    expect(getConversationId(602, "codex:old-session")).toBe("durable-cloud-conversation");
  });
});
