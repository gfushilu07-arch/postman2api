import { afterEach, describe, expect, test } from "bun:test";
import { PostmanProvider, normalizePostmanTools } from "../src/provider/postman";
import { PostmanStreamReader } from "../src/provider/sse-stream";
import { config } from "../src/config";
import {
  clearConversations,
  setConversationId,
} from "../src/provider/conversation-store";

afterEach(() => {
  clearConversations();
});

describe("Postman tool compatibility", () => {
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
