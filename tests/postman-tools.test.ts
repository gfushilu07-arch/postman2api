import { afterEach, describe, expect, test } from "bun:test";
import {
  POSTMAN_QUERY_SAFE_CHARS,
  PostmanProvider,
  buildSeedingMessages,
  inspectPostmanBootstrapPayload,
  isPostmanRequestRejected,
  normalizePostmanTools,
  rejectOversizedPostmanBootstrap,
} from "../src/provider/postman";
import { PostmanStreamReader } from "../src/provider/sse-stream";
import { config } from "../src/config";
import {
  clearConversations,
  getConversationId,
  setConversationId,
} from "../src/provider/conversation-store";

afterEach(() => {
  clearConversations();
});

describe("Postman tool compatibility", () => {
  const account = {
    id: 7,
    email: "mcp-test@example.com",
    password: "unused",
    status: "active",
    enabled: true,
    tokens: JSON.stringify({
      postman_sid: "sid",
      user_id: "user",
      workspace_id: "workspace",
      workspace_subdomain: "team",
    }),
  } as any;

  test("normalizes Chat Completions, custom, and namespace-shaped tools", () => {
    const tools = normalizePostmanTools([
      {
        type: "function",
        function: {
          name: "shell",
          description: "Run a shell command",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      },
      {
        type: "custom",
        name: "apply_patch",
        input_schema: { type: "object", properties: { patch: { type: "string" } } },
      },
      {
        type: "namespace",
        name: "filesystem",
        tools: [
          {
            type: "function",
            function: { name: "read_file", parameters: null },
          },
        ],
      },
      {
        type: "function",
        function: { name: "shell", parameters: {} },
      },
    ]);

    expect(tools).toEqual([
      {
        name: "shell",
        description: "Run a shell command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
        },
      },
      {
        name: "apply_patch",
        description: "apply_patch",
        parameters: {
          type: "object",
          properties: { patch: { type: "string" } },
        },
      },
      {
        name: "filesystem.read_file",
        description: "filesystem.read_file",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });

  test("preserves the camelCase inputSchema used by a real MCP tools/list response", () => {
    const tools = normalizePostmanTools([{
      name: "execute_electerm_command",
      description: "Execute a shell command",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeoutMs: { type: "number" },
        },
        required: ["command"],
      },
    }]);

    expect(tools).toEqual([{
      name: "execute_electerm_command",
      description: "Execute a shell command",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeoutMs: { type: "number" },
        },
        required: ["command"],
      },
    }]);
  });

  test("keeps a stable tool call id when Postman omits the upstream id", () => {
    const reader = new PostmanStreamReader();
    const first = reader.feed(`data: ${JSON.stringify({
      eventType: "toolCallChunk",
      data: {
        toolCalls: [{
          index: 0,
          function: { arguments: "{\"command\":\"" },
        }],
      },
    })}`);
    const second = reader.feed(`data: ${JSON.stringify({
      eventType: "toolCallChunk",
      data: {
        tool_calls: [{
          index: 0,
          name: "shell",
          arguments: "pwd\"}",
        }],
      },
    })}`);

    const firstCall = first[0]?.tool_calls?.[0];
    const secondCall = second[0]?.tool_calls?.[0];
    expect(firstCall?.id).toMatch(/^call_postman_0_/);
    expect(firstCall?.function?.name).toBeUndefined();
    expect(secondCall).toMatchObject({
      index: 0,
      function: {
        name: "shell",
        arguments: "pwd\"}",
      },
    });
    expect(secondCall?.id).toBeUndefined();
    expect(reader.finish()[0]?.finish_reason).toBe("tool_calls");
  });

  test("passes normalized tools to Postman's proxy-tools and honors tool_choice none", () => {
    const provider = new PostmanProvider() as any;
    const body = provider.buildRequestBody(
      {
        model: "auto",
        messages: [{ role: "user", content: "run pwd" }],
        tool_choice: "none",
        tools: [{
          type: "function",
          function: { name: "shell", parameters: { type: "object", properties: {} } },
        }],
      },
      {
        postman_sid: "sid",
        user_id: "user",
        workspace_id: "workspace",
        workspace_subdomain: "team",
      },
      null,
      "7",
    );

    expect(body.clientTools.thirdParty["proxy-tools"].tools).toHaveLength(1);
    expect(body.devModeOptions.autoRun).toBe(false);
  });

  test("bridges a Postman tool-call response to a non-streaming Chat Completions response", async () => {
    const provider = new PostmanProvider() as any;
    provider.fetchWithTimeout = async () => new Response([
      `data: ${JSON.stringify({
        eventType: "conversation",
        data: { id: "postman-conversation-1" },
      })}`,
      `data: ${JSON.stringify({
        eventType: "toolCallChunk",
        data: {
          toolCalls: [{
            index: 0,
            id: "postman-tool-call-1",
            function: {
              name: "exec_command",
              arguments: "{\"cmd\":\"pwd\"}",
            },
          }],
        },
      })}`,
    ].join("\n") + "\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const result = await provider.chatCompletion(account, {
      model: "gpt-5.6-sol",
      _sessionId: "codex:mcp-session",
      messages: [{ role: "user", content: "run pwd" }],
      tools: [{
        type: "function",
        function: {
          name: "exec_command",
          description: "Run a command",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
      }],
    });

    expect(result.success).toBe(true);
    expect(result.response?.choices[0]?.finish_reason).toBe("tool_calls");
    expect(result.response?.choices[0]?.message.tool_calls).toEqual([{
      id: "postman-tool-call-1",
      type: "function",
      function: {
        name: "exec_command",
        arguments: "{\"cmd\":\"pwd\"}",
      },
    }]);
    expect(getConversationId(account.id, "codex:mcp-session")).toBe("postman-conversation-1");
  });

  test("bridges a Postman tool-call stream and emits the Chat Completions tool_calls finish reason", async () => {
    const provider = new PostmanProvider() as any;
    provider.fetchWithTimeout = async () => new Response([
      `data: ${JSON.stringify({
        eventType: "conversation",
        data: { id: "postman-conversation-2" },
      })}`,
      `data: ${JSON.stringify({
        eventType: "toolCallChunk",
        data: {
          toolCalls: [{
            index: 0,
            id: "postman-tool-call-2",
            function: {
              name: "exec_command",
              arguments: "{\"cmd\":\"",
            },
          }],
        },
      })}`,
      `data: ${JSON.stringify({
        eventType: "toolCallChunk",
        data: {
          toolCalls: [{
            index: 0,
            function: { arguments: "pwd\"}" },
          }],
        },
      })}`,
    ].join("\n") + "\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const result = await provider.chatCompletionStream(account, {
      model: "gpt-5.6-sol",
      _sessionId: "codex:mcp-stream",
      stream: true,
      messages: [{ role: "user", content: "run pwd" }],
      tools: [{
        type: "function",
        function: {
          name: "exec_command",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
      }],
    });

    expect(result.success).toBe(true);
    const output = await new Response(result.stream).text();
    const chunks = output
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length))
      .filter((line) => line !== "[DONE]")
      .map((line) => JSON.parse(line));
    const toolChunks = chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || []);

    expect(toolChunks[0]).toMatchObject({
      id: "postman-tool-call-2",
      type: "function",
      function: { name: "exec_command", arguments: "{\"cmd\":\"" },
    });
    expect(toolChunks[1]).toMatchObject({
      function: { arguments: "pwd\"}" },
    });
    expect(chunks.at(-1)?.choices?.[0]?.finish_reason).toBe("tool_calls");
    expect(result.getStreamMessage?.()).toMatchObject({
      role: "assistant",
      tool_calls: [{
        id: "postman-tool-call-2",
        type: "function",
        function: {
          name: "exec_command",
          arguments: "{\"cmd\":\"pwd\"}",
        },
      }],
    });
  });

  test("sends Chat Completions tool results back through the bound Postman conversation", () => {
    const provider = new PostmanProvider() as any;
    setConversationId(account.id, "codex:mcp-session", "postman-conversation-1");
    const body = provider.buildRequestBody(
      {
        model: "auto",
        _sessionId: "codex:mcp-session",
        messages: [
          { role: "user", content: "run pwd" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "postman-tool-call-1",
              type: "function",
              function: { name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
            }],
          },
          {
            role: "tool",
            tool_call_id: "postman-tool-call-1",
            content: "/workspace/project",
          },
        ],
      },
      {
        postman_sid: "sid",
        user_id: "user",
        workspace_id: "workspace",
        workspace_subdomain: "team",
      },
      null,
      String(account.id),
    );

    expect(body.input.conversationId).toBe("postman-conversation-1");
    expect(body.input.chatType).toBe("TOOL_RESPONSE");
    expect(body.input.query).toBe("");
    expect(body.input.toolCallId).toBe("postman-tool-call-1");
    expect(body.input.toolResponse).toBe("/workspace/project");
    expect(body.input.toolResponseSummary).toBe("Tool call completed");
  });

  test("preserves parallel Anthropic tool-result order and marks failed tool calls", () => {
    const provider = new PostmanProvider() as any;
    setConversationId(account.id, "claude-code:mcp-session", "postman-conversation-2");
    const body = provider.buildRequestBody(
      {
        model: "auto",
        _sessionId: "claude-code:mcp-session",
        messages: [
          { role: "user", content: "inspect both resources" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "tool-call-a",
                type: "function",
                function: { name: "read_resource", arguments: "{\"uri\":\"a\"}" },
              },
              {
                id: "tool-call-b",
                type: "function",
                function: { name: "read_resource", arguments: "{\"uri\":\"b\"}" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-call-a",
                content: "resource a",
              },
              {
                type: "tool_result",
                tool_use_id: "tool-call-b",
                content: [{ type: "text", text: "permission denied" }],
                is_error: true,
              },
            ],
          },
        ],
      },
      {
        postman_sid: "sid",
        user_id: "user",
        workspace_id: "workspace",
        workspace_subdomain: "team",
      },
      null,
      String(account.id),
    );

    expect(body.input.chatType).toBe("TOOL_RESPONSE");
    expect(body.input.query).toBe("");
    expect(body.input.toolResponses).toEqual([
      {
        toolCallId: "tool-call-a",
        content: "resource a",
        toolResponseSummary: "Tool call completed",
        toolResponseStatus: "SUCCESS",
      },
      {
        toolCallId: "tool-call-b",
        content: JSON.stringify([{ type: "text", text: "permission denied" }]),
        toolResponseSummary: "Tool call failed",
        toolResponseStatus: "FAILED",
        toolResponseFailureType: "HANDLED_ERROR",
      },
    ]);
  });

  test("recognizes the standard MCP isError flag on a Chat Completions tool result", () => {
    const provider = new PostmanProvider() as any;
    setConversationId(account.id, "codex:mcp-error", "postman-conversation-error");
    const body = provider.buildRequestBody(
      {
        model: "auto",
        _sessionId: "codex:mcp-error",
        messages: [
          { role: "user", content: "run command" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "tool-call-error",
              type: "function",
              function: { name: "execute_electerm_command", arguments: "{}" },
            }],
          },
          {
            role: "tool",
            tool_call_id: "tool-call-error",
            content: "No command provided",
            isError: true,
          } as any,
        ],
      },
      {
        postman_sid: "sid",
        user_id: "user",
        workspace_id: "workspace",
        workspace_subdomain: "team",
      },
      null,
      String(account.id),
    );

    expect(body.input.chatType).toBe("TOOL_RESPONSE");
    expect(body.input.query).toBe("");
    expect(body.input.toolCallId).toBe("tool-call-error");
    expect(body.input.toolResponse).toBe("No command provided");
    expect(body.input.toolResponseSummary).toBe("Tool call failed");
  });

  test("honors a client that disables parallel tool calls", () => {
    const provider = new PostmanProvider() as any;
    const body = provider.buildRequestBody(
      {
        model: "auto",
        messages: [{ role: "user", content: "run tools serially" }],
        parallel_tool_calls: false,
        tools: [{
          type: "function",
          function: { name: "shell", parameters: { type: "object", properties: {} } },
        }],
      },
      {
        postman_sid: "sid",
        user_id: "user",
        workspace_id: "workspace",
        workspace_subdomain: "team",
      },
      null,
      String(account.id),
    );

    expect(body.devModeOptions.isParallelToolCallingSupported).toBe(false);
  });


  test("uses configured request and response-header timeouts for both request paths", async () => {
    const provider = new PostmanProvider() as any;
    const calls: Array<{ requestTimeoutMs: number; ttfbTimeoutMs: number }> = [];
    provider.fetchWithTimeout = async (
      _url: string,
      _init: RequestInit,
      requestTimeoutMs: number,
      ttfbTimeoutMs: number,
    ) => {
      calls.push({ requestTimeoutMs, ttfbTimeoutMs });
      return new Response(
        `data: ${JSON.stringify({
          eventType: "textChunk",
          data: { metadata: { model: "GPT_56_SOL" }, textContent: "ok" },
        })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    const account = {
      id: 7,
      tokens: JSON.stringify({
        postman_sid: "sid",
        user_id: "user",
        workspace_id: "workspace",
        workspace_subdomain: "team",
      }),
    } as any;
    const request = {
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hello" }],
    } as any;

    const nonStreaming = await provider.chatCompletion(account, request);
    const streaming = await provider.chatCompletionStream(account, { ...request, stream: true });

    expect(nonStreaming.success).toBe(true);
    expect(streaming.success).toBe(true);
    expect(calls).toEqual([
      {
        requestTimeoutMs: config.providerRequestTimeoutMs,
        ttfbTimeoutMs: config.ttfbTimeoutMs,
      },
      {
        requestTimeoutMs: config.providerRequestTimeoutMs,
        ttfbTimeoutMs: config.ttfbTimeoutMs,
      },
    ]);
    await streaming.stream?.cancel();
  });

  test("keeps MCP tools and Postman conversations isolated between Codex sessions", () => {
    const provider = new PostmanProvider() as any;
    const tokens = {
      postman_sid: "sid",
      user_id: "user",
      workspace_id: "workspace",
      workspace_subdomain: "team",
    };
    const accountId = "7";

    setConversationId(accountId, "codex:session-a", "conversation-a");
    setConversationId(accountId, "codex:session-b", "conversation-b");

    const sessionA = provider.buildRequestBody(
      {
        model: "auto",
        _sessionId: "codex:session-a",
        messages: [{ role: "user", content: "deploy with MCP" }],
        tools: [{
          type: "function",
          function: {
            name: "exec_command",
            description: "Run a command",
            parameters: { type: "object", properties: { cmd: { type: "string" } } },
          },
        }],
      },
      tokens,
      null,
      accountId,
    );
    const sessionB = provider.buildRequestBody(
      {
        model: "auto",
        _sessionId: "codex:session-b",
        messages: [{ role: "user", content: "continue without MCP" }],
      },
      tokens,
      null,
      accountId,
    );

    expect(sessionA.input.conversationId).toBe("conversation-a");
    expect(sessionA.clientTools.thirdParty["proxy-tools"].tools).toHaveLength(1);
    expect(sessionB.input.conversationId).toBe("conversation-b");
    expect(sessionB.clientTools.thirdParty).toEqual({});
    expect(JSON.stringify(sessionB)).not.toContain("exec_command");
    expect(JSON.stringify(sessionB)).not.toContain("conversation-a");
  });

  test("seeds long history as Postman's required lossless two-message pair", () => {
    const provider = new PostmanProvider() as any;
    const systemText = "system-history-".repeat(1_500);
    const oldQuestion = "old-question-".repeat(1_300);
    const oldAnswer = "old-answer-".repeat(1_400);
    const toolArguments = JSON.stringify({ payload: "tool-argument-".repeat(900) });
    const body = provider.buildRequestBody(
      {
        model: "auto",
        _sessionId: "codex:long-history",
        messages: [
          { role: "system", content: systemText },
          { role: "user", content: oldQuestion },
          {
            role: "assistant",
            content: oldAnswer,
            tool_calls: [{
              id: "call-long",
              type: "function",
              function: { name: "long_tool", arguments: toolArguments },
            }],
          },
          { role: "user", content: "latest short question" },
        ],
      },
      {
        postman_sid: "sid",
        user_id: "user",
        workspace_id: "workspace",
        workspace_subdomain: "team",
      },
      null,
      String(account.id),
    );

    const seeds = body.input.seedingMessages;
    const seededText = seeds[0].content;
    expect(body.input.query).toBe("latest short question");
    expect(body.input.conversationId).toBeNull();
    expect(seeds).toHaveLength(2);
    expect(seeds.map((seed: any) => seed.role)).toEqual(["user", "assistant"]);
    expect(seededText).toContain(systemText);
    expect(seededText).toContain(oldQuestion);
    expect(seededText).toContain(oldAnswer);
    const serializedToolCalls = seededText.split("[Assistant Tool Calls]\n")[1];
    expect(serializedToolCalls).toBeDefined();
    expect(JSON.parse(serializedToolCalls!)[0].function.arguments).toBe(toolArguments);
    expect(seededText).not.toContain("latest short question");
  });

  test("moves an oversized latest question into lossless seeds even with an existing conversation", () => {
    const provider = new PostmanProvider() as any;
    const prefix = "x".repeat(POSTMAN_QUERY_SAFE_CHARS - 1);
    const latestQuestion = `${prefix}😀${"y".repeat(POSTMAN_QUERY_SAFE_CHARS + 50)}`;
    setConversationId(account.id, "codex:oversized-current", "old-conversation");

    const body = provider.buildRequestBody(
      {
        model: "auto",
        _sessionId: "codex:oversized-current",
        messages: [
          { role: "user", content: "earlier question" },
          { role: "assistant", content: "earlier answer" },
          { role: "user", content: latestQuestion },
        ],
      },
      {
        postman_sid: "sid",
        user_id: "user",
        workspace_id: "workspace",
        workspace_subdomain: "team",
      },
      null,
      String(account.id),
    );

    const seeds = body.input.seedingMessages;
    expect(body.input.conversationId).toBeNull();
    expect(body.input.query).toBe("Respond to the latest seeded user message.");
    expect(seeds).toHaveLength(2);
    expect(seeds[0].content).toContain(latestQuestion);
    expect(body.input.query.length).toBeLessThanOrEqual(POSTMAN_QUERY_SAFE_CHARS);
  });

  test("keeps the existing Postman conversation after local-only history trimming", () => {
    const provider = new PostmanProvider() as any;
    setConversationId(account.id, "codex:trimmed-context-preserved", "full-upstream-conversation");

    const body = provider.buildRequestBody(
      {
        model: "auto",
        _sessionId: "codex:trimmed-context-preserved",
        messages: [
          { role: "system", content: "Keep the system instruction." },
          { role: "user", content: "Only the retained recent context." },
        ],
      },
      {
        postman_sid: "sid",
        user_id: "user",
        workspace_id: "workspace",
        workspace_subdomain: "team",
      },
      null,
      String(account.id),
    );

    expect(body.input.conversationId).toBe("full-upstream-conversation");
    expect(body.input.seedingMessages).toBeUndefined();
    expect(body.input.query).toBe("Only the retained recent context.");
    expect(getConversationId(account.id, "codex:trimmed-context-preserved"))
      .toBe("full-upstream-conversation");
  });

  test("starts a fresh Postman conversation after an explicit reset", () => {
    const provider = new PostmanProvider() as any;
    setConversationId(account.id, "codex:trimmed-context", "stale-full-conversation");

    const body = provider.buildRequestBody(
      {
        model: "auto",
        _sessionId: "codex:trimmed-context",
        _resetConversation: true,
        messages: [
          { role: "system", content: "Keep the system instruction." },
          { role: "user", content: "Only the retained recent context." },
        ],
      },
      {
        postman_sid: "sid",
        user_id: "user",
        workspace_id: "workspace",
        workspace_subdomain: "team",
      },
      null,
      String(account.id),
    );

    expect(body.input.conversationId).toBeNull();
    expect(body.input.seedingMessages).toHaveLength(2);
    expect(body.input.query).toBe("Only the retained recent context.");
    expect(body.input.seedingMessages[0].content).toContain("Keep the system instruction.");
    expect(getConversationId(account.id, "codex:trimmed-context")).toBeNull();
  });

  test("rejects an oversized new-conversation bootstrap before calling Postman", () => {
    const provider = new PostmanProvider() as any;
    const body = provider.buildRequestBody(
      {
        model: "auto",
        _sessionId: "codex:oversized-bootstrap",
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "large-history-".repeat(1_000) },
          { role: "assistant", content: "large-answer-".repeat(1_000) },
          { role: "user", content: "continue" },
        ],
        tools: [{
          type: "function",
          function: {
            name: "shell",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        }],
      },
      {
        postman_sid: "sid",
        user_id: "user",
        workspace_id: "workspace",
        workspace_subdomain: "team",
      },
      null,
      String(account.id),
    );
    const serialized = JSON.stringify(body);
    const stats = inspectPostmanBootstrapPayload(body, serialized);
    const result = rejectOversizedPostmanBootstrap(body, serialized, 1_024);

    expect(stats.restoredConversation).toBe(false);
    expect(stats.seedCount).toBe(2);
    expect(stats.seedBytes).toBeGreaterThan(1_024);
    expect(stats.toolCount).toBe(1);
    expect(result).toMatchObject({
      success: false,
      requestRejected: true,
      contextBootstrapTooLarge: true,
      httpStatus: 413,
    });
    expect(result?.error).toContain("no request was sent upstream");
    expect(result?.error).toContain("MCP tools and the requested model were not changed");
  });

  test("also guards a new conversation when MCP schemas alone exceed the bootstrap budget", () => {
    const body = {
      input: {
        query: "hello",
        conversationId: null,
      },
      clientTools: {
        thirdParty: {
          "proxy-tools": {
            tools: [{
              name: "oversized_tool",
              description: "large schema",
              parameters: {
                type: "object",
                description: "x".repeat(4_096),
              },
            }],
          },
        },
      },
    };
    const serialized = JSON.stringify(body);
    const stats = inspectPostmanBootstrapPayload(body, serialized);
    const result = rejectOversizedPostmanBootstrap(body, serialized, 1_024);

    expect(stats.seedCount).toBe(0);
    expect(stats.toolCount).toBe(1);
    expect(result?.contextBootstrapTooLarge).toBe(true);
    expect(result?.httpStatus).toBe(413);
  });

  test("keeps tool results when no Postman conversation can be restored", () => {
    const provider = new PostmanProvider() as any;
    const toolResult = "tool-result-".repeat(1_100);
    const body = provider.buildRequestBody(
      {
        model: "auto",
        _sessionId: "codex:tool-result-after-restart",
        messages: [
          { role: "user", content: "run the tool" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call-after-restart",
              type: "function",
              function: { name: "shell", arguments: "{\"cmd\":\"pwd\"}" },
            }],
          },
          {
            role: "tool",
            tool_call_id: "call-after-restart",
            content: toolResult,
          },
        ],
      },
      {
        postman_sid: "sid",
        user_id: "user",
        workspace_id: "workspace",
        workspace_subdomain: "team",
      },
      null,
      String(account.id),
    );

    const seededText = body.input.seedingMessages
      .map((seed: any) => seed.content)
      .join("");
    expect(body.input.query).toBe("Process the latest seeded tool results and continue.");
    expect(seededText).toContain("[Tool Result id=call-after-restart]");
    expect(seededText).toContain(toolResult);
  });

  test("sends oversized tool output through Postman's native tool-response fields", () => {
    const provider = new PostmanProvider() as any;
    const sessionId = "codex:large-native-tool-response";
    const toolResult = "large-tool-output-".repeat(1_000_000);
    setConversationId(account.id, sessionId, "restored-cloud-conversation");

    const body = provider.buildRequestBody(
      {
        model: "gpt-5.6-sol",
        _sessionId: sessionId,
        messages: [
          { role: "user", content: "run the large tool" },
          {
            role: "assistant",
            content: "I will run it now.",
            tool_calls: [{
              id: "call-large-output",
              type: "function",
              function: { name: "exec_command", arguments: "{\"cmd\":\"large\"}" },
            }],
          },
          {
            role: "tool",
            tool_call_id: "call-large-output",
            content: toolResult,
          },
        ],
      },
      {
        postman_sid: "sid",
        user_id: "user",
        workspace_id: "workspace",
        workspace_subdomain: "team",
      },
      "GPT_56_SOL",
      String(account.id),
    );
    const serialized = JSON.stringify(body);

    expect(body.input.chatType).toBe("TOOL_RESPONSE");
    expect(body.input.conversationId).toBe("restored-cloud-conversation");
    expect(body.input.query).toBe("");
    expect(body.input.toolCallId).toBe("call-large-output");
    expect(body.input.toolResponse).toBe(toolResult);
    expect(body.input.seedingMessages).toBeUndefined();
    expect(inspectPostmanBootstrapPayload(body, serialized).payloadBytes)
      .toBeGreaterThan(config.postmanBootstrapMaxBytes);
    expect(rejectOversizedPostmanBootstrap(
      body,
      serialized,
      config.postmanBootstrapMaxBytes,
    )).toBeNull();
  });

  test("rebuilds an oversized bootstrap after cloud conversation recovery", async () => {
    const provider = new PostmanProvider() as any;
    const sessionId = "codex:auto-cloud-recovery";
    const toolResult = "restored-tool-output-".repeat(80_000);
    provider.recoverConversation = async () => {
      setConversationId(account.id, sessionId, "cloud-history-conversation");
      return {
        recovered: true,
        conversationId: "cloud-history-conversation",
        reason: "recovered",
        score: 1_500,
        scanned: 10,
        compatible: 1,
      };
    };
    const request = {
      model: "gpt-5.6-sol",
      _sessionId: sessionId,
      messages: [
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: "Running the requested command.",
          tool_calls: [{
            id: "call-recovered",
            type: "function",
            function: { name: "exec_command", arguments: "{\"cmd\":\"test\"}" },
          }],
        },
        {
          role: "tool",
          tool_call_id: "call-recovered",
          content: toolResult,
        },
      ],
    };

    const prepared = await provider.preparePostmanRequest(
      account,
      request,
      {
        postman_sid: "sid",
        user_id: "user",
        workspace_id: "workspace",
        workspace_subdomain: "team",
      },
      "GPT_56_SOL",
    );

    expect(prepared.bootstrapRejection).toBeNull();
    expect(prepared.body.input.conversationId).toBe("cloud-history-conversation");
    expect(prepared.body.input.chatType).toBe("TOOL_RESPONSE");
    expect(prepared.body.input.toolResponse).toBe(toolResult);
  });

  test("always emits exactly two seed messages without dropping source content", () => {
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "question" },
      { role: "assistant" as const, content: "answer" },
      { role: "tool" as const, tool_call_id: "call-1", content: "tool output" },
    ];
    const seeds = buildSeedingMessages(messages);
    expect(seeds).toHaveLength(2);
    expect(seeds.map((seed) => seed.role)).toEqual(["user", "assistant"]);
    for (const message of messages) {
      expect(seeds[0]!.content).toContain(String(message.content));
    }
  });

  test("classifies Agent Mode and MCP payload failures as request-level errors", async () => {
    expect(isPostmanRequestRejected(
      "Agent Mode accepts upto 10000 characters as input.",
    )).toBe(true);
    expect(isPostmanRequestRejected(
      "That was unexpected :(. Try starting a new chat, or remove any configured MCP servers.",
    )).toBe(true);

    const provider = new PostmanProvider() as any;
    provider.fetchWithTimeout = async () => new Response(
      `data: ${JSON.stringify({
        eventType: "failure",
        data: {
          userMessage: "That was unexpected :(. Try starting a new chat, or remove any configured MCP servers.",
        },
      })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

    const result = await provider.chatCompletionStream(account, {
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "use a tool" }],
      stream: true,
    });
    expect(result.success).toBe(false);
    expect(result.requestRejected).toBe(true);
  });
});

describe("strict model compatibility", () => {
  const account = {
    id: 7,
    email: "model-test@example.com",
    password: "unused",
    status: "active",
    enabled: true,
    tokens: JSON.stringify({
      postman_sid: "sid",
      user_id: "user",
      workspace_id: "workspace",
      workspace_subdomain: "team",
    }),
  } as any;

  test("does not turn an unsupported Anthropic model into a supported model", async () => {
    const provider = new PostmanProvider();
    const result = await provider.chatCompletion(account, {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Invalid model: claude-sonnet-4-20250514");
  });

  test("accepts Postman's selected model identifier when it represents the requested model", () => {
    const reader = new PostmanStreamReader({
      requestedModel: "gpt-5.6-sol",
      selectedModel: "GPT_56_SOL",
    });
    reader.feed(`data: ${JSON.stringify({
      eventType: "textChunk",
      data: { metadata: { model: "GPT_56_SOL" }, textContent: "hello" },
    })}`);

    expect(reader.error).toBeNull();
    expect(reader.actualModel).toBe("GPT_56_SOL");
  });

  test("fails closed when Postman reports a different model", () => {
    const reader = new PostmanStreamReader({
      requestedModel: "gpt-5.6-sol",
      selectedModel: "GPT_56_SOL",
    });
    const deltas = reader.feed(`data: ${JSON.stringify({
      eventType: "textChunk",
      data: { metadata: { model: "GPT_55" }, textContent: "must not leak" },
    })}`);

    expect(deltas).toEqual([]);
    expect(reader.modelMismatch).toBe(true);
    expect(reader.error).toContain("gpt-5.6-sol");
    expect(reader.error).toContain("GPT_55");
    expect(reader.error).toContain("automatic model downgrade or replacement is disabled");
  });

  test("rejects a mismatched model before exposing a non-streaming completion", async () => {
    const provider = new PostmanProvider() as any;
    provider.fetchWithTimeout = async () => new Response(
      `data: ${JSON.stringify({
        eventType: "textChunk",
        data: { metadata: { model: "GPT_55" }, textContent: "must not leak" },
      })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

    const result = await provider.chatCompletion(account, {
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });

    expect(result.success).toBe(false);
    expect(result.modelMismatch).toBe(true);
    expect(result.response).toBeUndefined();
  });

  test("rejects a mismatched model before exposing a streaming completion", async () => {
    const provider = new PostmanProvider() as any;
    provider.fetchWithTimeout = async () => new Response(
      `data: ${JSON.stringify({
        eventType: "textChunk",
        data: { metadata: { model: "GPT_55" }, textContent: "must not leak" },
      })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

    const result = await provider.chatCompletionStream(account, {
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });

    expect(result.success).toBe(false);
    expect(result.modelMismatch).toBe(true);
    expect(result.stream).toBeUndefined();
  });
});
