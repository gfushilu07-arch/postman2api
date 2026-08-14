import { describe, expect, test } from "bun:test";
import { PostmanProvider, normalizePostmanTools } from "../src/provider/postman";
import { PostmanStreamReader } from "../src/provider/sse-stream";

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
});
