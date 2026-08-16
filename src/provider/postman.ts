import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
  type StreamChunk,
  type StreamFailure,
  type TokenUsage,
  type TokenUsageSource,
  normalizeReasoningEffort,
} from "./base";
import type { Account } from "../db/schema";
import { config } from "../config";
import {
  POSTMAN_MODEL_MAP,
  POSTMAN_MODELS,
  normalizePostmanModelId,
  resolvePostmanModel,
} from "./models";
import {
  isPostmanQuotaExceeded,
  PostmanStreamReader,
  type PostmanDelta,
} from "./sse-stream";
import type { PostmanTokens } from "./transcript";
import { extractTextFromMessage, isAnthropicToolResult } from "./transcript";
import { getConversationId, setConversationId } from "./conversation-store";

const DEFAULT_APP_VERSION = "12.15.4-260616-1202";
const CHAT_ENDPOINT = "/_gw/chat";

const TRANSIENT_ERROR_PATTERNS = [
  "too much data",
  "too large",
  "input too large",
  "context length exceeded",
  "rate limit",
];

interface PostmanMCPTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface NormalizedPostmanTool extends PostmanMCPTool {}

const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {},
};

/**
 * CC Switch normally converts Responses tools into Chat Completions
 * `{ type: "function", function: ... }` objects. Keep this boundary tolerant:
 * some versions preserve `input_schema`, top-level names, or namespace-shaped
 * tools. Postman's gateway only needs a stable MCP-like name/description/schema.
 */
export function normalizePostmanTools(tools?: unknown[]): NormalizedPostmanTool[] {
  if (!Array.isArray(tools) || tools.length === 0) return [];

  const normalized: NormalizedPostmanTool[] = [];
  const seenNames = new Set<string>();

  const visit = (tool: any, namespace?: string) => {
    if (!tool || typeof tool !== "object") return;

    const nested = Array.isArray(tool.tools)
      ? tool.tools
      : Array.isArray(tool.functions)
        ? tool.functions
        : undefined;
    if (nested) {
      const nestedNamespace = namespace
        ? `${namespace}.${safeToolName(tool.name)}`
        : safeToolName(tool.name);
      for (const child of nested) visit(child, nestedNamespace || namespace);
      return;
    }

    const functionDefinition = tool.function && typeof tool.function === "object"
      ? tool.function
      : tool;
    const rawName = firstNonEmptyString(
      functionDefinition.name,
      tool.name,
      tool.function_name,
    );
    if (!rawName) return;

    const name = namespace && !rawName.includes(".")
      ? `${namespace}.${rawName}`
      : rawName;
    if (seenNames.has(name)) return;

    const rawParameters =
      functionDefinition.parameters
      ?? functionDefinition.input_schema
      ?? functionDefinition.inputSchema
      ?? tool.parameters
      ?? tool.input_schema
      ?? tool.inputSchema;
    const parameters = normalizeToolParameters(rawParameters);
    const description = firstNonEmptyString(
      functionDefinition.description,
      tool.description,
      name,
    ) || name;

    seenNames.add(name);
    normalized.push({ name, description, parameters });
  };

  for (const tool of tools) visit(tool);
  return normalized;
}

export class PostmanProvider extends BaseProvider {
  name = "postman" as const;
  override nativeFormat: "openai" | "anthropic" = "openai";
  supportedModels: ModelInfo[] = POSTMAN_MODELS;

  override ownsModel(model: string): boolean {
    return normalizePostmanModelId(model) in POSTMAN_MODEL_MAP;
  }

  private resolveModel(model: string): string | null | undefined {
    return resolvePostmanModel(model);
  }

  private getTokens(account: Account): PostmanTokens | null {
    try {
      const tokens =
        typeof account.tokens === "string"
          ? JSON.parse(account.tokens)
          : account.tokens;
      if (!tokens || typeof tokens !== "object") return null;
      const { postman_sid, user_id, workspace_id, workspace_subdomain } = tokens;
      if (!postman_sid || !user_id || !workspace_id || !workspace_subdomain) return null;
      return {
        postman_sid: String(postman_sid),
        user_id: String(user_id),
        workspace_id: String(workspace_id),
        workspace_subdomain: String(workspace_subdomain),
        user_name: tokens.user_name ? String(tokens.user_name) : undefined,
      };
    } catch {
      return null;
    }
  }

  private buildHeaders(tokens: PostmanTokens): Record<string, string> {
    const subdomain = tokens.workspace_subdomain;
    return {
      Cookie: `postman.sid=${tokens.postman_sid}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "x-app-version": DEFAULT_APP_VERSION,
      "x-pstmn-req-service": "agent-mode-service",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Origin: `https://${subdomain}.postman.co`,
      Referer: `https://${subdomain}.postman.co/`,
    };
  }

  private buildUsageHeaders(tokens: PostmanTokens): Record<string, string> {
    const subdomain = tokens.workspace_subdomain;
    return {
      Cookie: `postman.sid=${tokens.postman_sid}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-app-version": DEFAULT_APP_VERSION,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Origin: `https://${subdomain}.postman.co`,
      Referer: `https://${subdomain}.postman.co/billing/add-ons/overview`,
    };
  }

  private buildThirdPartyTools(tools?: any[]): Record<string, { tools: PostmanMCPTool[] }> {
    const mcpTools = normalizePostmanTools(tools);
    if (mcpTools.length === 0) return {};
    return { "proxy-tools": { tools: mcpTools } };
  }

  private splitMessages(messages: ChatMessage[], conversationId: string | null): {
    query: string;
    seedingMessages: [{ role: "user"; content: string }, { role: "assistant"; content: string }] | null;
  } {
    const lastMsg = messages[messages.length - 1];
    const isToolResultTail = lastMsg?.role === "tool" || isAnthropicToolResult(lastMsg);
    const hasConversationId = Boolean(conversationId);

    let query: string;
    let queryMsgIdx: number;

    if (isToolResultTail) {
      const toolResultParts: string[] = [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]!;
        if (msg.role === "tool") {
          const text = extractTextFromMessage(msg.content);
          const tcId = msg.tool_call_id || "";
          const label = (msg as any).is_error || (msg as any).isError
            ? "Tool Error"
            : "Tool Result";
          toolResultParts.unshift(`[${label} id=${tcId}]\n${text}`);
          continue;
        }
        if (isAnthropicToolResult(msg)) {
          const content = msg.content;
          if (Array.isArray(content)) {
            const messageToolResults: string[] = [];
            for (const block of content) {
              if (block?.type === "tool_result") {
                const toolId = block.tool_use_id || "";
                const resultContent = typeof block.content === "string"
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n")
                    : "";
                const label = block.is_error || block.isError
                  ? "Tool Error"
                  : "Tool Result";
                messageToolResults.push(`[${label} id=${toolId}]\n${resultContent}`);
              }
            }
            toolResultParts.unshift(...messageToolResults);
          }
          continue;
        }
        break;
      }
      const resultsBlock = toolResultParts.join("\n\n");

      if (hasConversationId) {
        query = `${resultsBlock}\n\nProcess these tool results and continue.`;
      } else {
        query = "Continue the conversation.";
      }
      queryMsgIdx = -1;
    } else {
      const idx = findLastIndex(messages, (m) => m.role === "user");
      queryMsgIdx = idx;
      query = idx >= 0 ? extractTextFromMessage(messages[idx]!.content) : "";
    }

    if (hasConversationId) {
      return { query, seedingMessages: null };
    }

    const contextParts: string[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (i === queryMsgIdx) continue;
      const text = extractTextFromMessage(msg.content);

      if (msg.role === "system") {
        if (text) contextParts.push(`[System]\n${text}`);
      } else if (msg.role === "user") {
        if (text) contextParts.push(`[User]\n${text}`);
      } else if (msg.role === "assistant") {
        let block = text ? `[Assistant]\n${text}` : "[Assistant]";
        if (msg.tool_calls?.length) {
          const tcSummary = msg.tool_calls
            .map((tc: any) => {
              const name = tc.function?.name || tc.name || "unknown";
              const args = stringifyToolArguments(tc.function?.arguments ?? tc.arguments) || "{}";
              return `Tool call: ${name}(${args}) [id=${tc.id || "unknown"}]`;
            })
            .join("\n");
          block += "\n" + tcSummary;
        }
        contextParts.push(block);
      } else if (msg.role === "tool") {
        const tcId = msg.tool_call_id || "unknown";
        contextParts.push(`Tool result for id=${tcId}:\n${text}`);
      }
    }

    const context = contextParts.join("\n\n");
    if (!context) return { query, seedingMessages: null };

    return {
      query,
      seedingMessages: [
        { role: "user" as const, content: context },
        { role: "assistant" as const, content: "I have the full conversation history above and will continue from where we left off." },
      ],
    };
  }

  private buildRequestBody(
    request: ChatCompletionRequest,
    tokens: PostmanTokens,
    postmanModel: string | null,
    accountId: string,
  ): any {
    const conversationId = getConversationId(accountId, request._sessionId);
    const { query, seedingMessages } = this.splitMessages(request.messages, conversationId);
    const thirdParty = this.buildThirdPartyTools(request.tools);
    const hasTools = Object.keys(thirdParty).length > 0;

    const input: any = {
      chatType: "USER_QUERY",
      query,
      toolResponse: "",
      useCase: null,
      conversationId,
      agent: null,
      product: "workspace_v12",
      startedFrom: "CHAT_INPUT",
    };

    if (!conversationId && seedingMessages) {
      input.seedingMessages = seedingMessages;
    }

    const body: any = {
      input,
      platform: "WEB",
      clientTools: {
        nativeToolsHash: `clienttools-workspace_v12-browser-${DEFAULT_APP_VERSION}-d5808662718f`,
        excludedTools: [
          "listDatasets", "createDataset", "previewDataset", "queryDatasetView",
          "deleteDataset", "getDatasetSchema", "createDatasetView", "deleteDatasetView",
          "runQuery", "insertDatasetRows", "modifyDatasetView", "refreshDatasource",
          "addDatasetSource", "editDatasetSource", "removeDatasetSource",
          "testDatasourceConnection", "listCloudMocks", "getCloudMock",
          "getCloudMockLogs", "renameCloudMock", "deleteCloudMock",
          "checkMockSlugAvailability", "createCloudMock", "listWorkspaceDocs",
          "getWorkspaceDoc", "createWorkspaceDoc", "updateWorkspaceDoc",
          "deleteWorkspaceDoc", "askUser",
        ],
        thirdParty,
      },
      clientKBTerms: {
        nativeTermsHash: `kbterms-workspace_v12-browser-${DEFAULT_APP_VERSION}-4755650f241c`,
        excludedKBTerms: ["DATASETS"],
      },
      mandatoryContext: {
        workspaceId: tokens.workspace_id,
      },
      selectedContext: [],
      backgroundContext: [],
      availableSkills: [],
      devModeOptions: {
        selectedModel: postmanModel,
        isParallelToolCallingSupported: request.parallel_tool_calls !== false,
        autoRun: hasTools && !isToolChoiceNone(request.tool_choice),
        supportsAskUser: false,
        supportsActionRecommendations: true,
        useThinkingModeIfAvailable: true,
        thinkingLevel: normalizeReasoningEffort(request),
      },
    };

    return body;
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const postmanModel = this.resolveModel(request.model);
    if (postmanModel === undefined) return { success: false, error: `Invalid model: ${request.model}` };

    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, error: "Invalid or missing Postman tokens" };

    const completionId = this.generateId();
    const body = this.buildRequestBody(request, tokens, postmanModel, String(account.id));

    try {
      const response = await this.fetchWithTimeout(
        `https://${tokens.workspace_subdomain}.postman.co${CHAT_ENDPOINT}`,
        { method: "POST", headers: this.buildHeaders(tokens), body: JSON.stringify(body) },
        config.providerRequestTimeoutMs, config.ttfbTimeoutMs, request.signal,
        { verbose: config.postmanFetchVerbose, context: "Postman chat" },
      );

      const statusResult = this.checkResponseStatus(response);
      if (statusResult) return statusResult;

      const responseText = await response.text();
      const reader = new PostmanStreamReader({
        requestedModel: request.model,
        selectedModel: postmanModel,
      });
      const deltas: PostmanDelta[] = [];

      for (const line of responseText.split("\n")) {
        if (!line.trim()) continue;
        deltas.push(...reader.feed(line));
      }

      if (reader.quotaExceeded) {
        return {
          success: false,
          error: reader.error || "Postman AI quota exceeded",
          quotaExhausted: true,
        };
      }
      if (reader.error) {
        return {
          success: false,
          error: reader.error,
          ...(reader.modelMismatch ? { modelMismatch: true } : {}),
          ...(reader.retryableError ? { retryable: true } : {}),
        };
      }
      if (reader.conversationId) {
        setConversationId(account.id, request._sessionId, reader.conversationId);
      }

      deltas.push(...reader.finish());

      let content = "";
      let reasoningContent = "";
      const toolCallAccum = new Map<string, { id: string; name: string; args: string }>();

      for (const delta of deltas) {
        if (delta.content) content += delta.content;
        if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const key = String(tc.index);
            if (tc.id && !toolCallAccum.has(key)) toolCallAccum.set(key, { id: tc.id, name: "", args: "" });
            const entry = toolCallAccum.get(key);
            if (entry) {
              if (tc.function?.name) entry.name = tc.function.name;
              if (tc.function?.arguments) entry.args += tc.function.arguments;
            }
          }
        }
      }

      const toolCalls = Array.from(toolCallAccum.values()).map((tc) => ({
        id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.args },
      }));

      if (!content && !reasoningContent && toolCalls.length === 0) {
        return {
          success: false,
          retryable: true,
          error: "Postman returned an empty response without text, reasoning, or tool calls",
        };
      }

      const message: any = { role: "assistant", content: content || null };
      if (reasoningContent) message.reasoning_content = reasoningContent;
      if (toolCalls.length > 0) message.tool_calls = toolCalls;

      const usage = resolveTokenUsage(
        reader.tokenUsage,
        this.estimateMessagesTokens(request.messages),
        this.estimateTokens(content + reasoningContent),
      );

      const completionResponse: ChatCompletionResponse = {
        id: completionId, object: "chat.completion", created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? "tool_calls" : content ? "stop" : null }],
        usage: {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.totalTokens,
        },
      };

      return {
        success: true,
        response: completionResponse,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        tokensUsed: usage.totalTokens,
        tokenSource: usage.source,
        creditSource: "fixed",
        creditsUsed: 0,
      };
    } catch (error) {
      return { success: false, error: `Postman request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const postmanModel = this.resolveModel(request.model);
    if (postmanModel === undefined) return { success: false, error: `Invalid model: ${request.model}` };

    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, error: "Invalid or missing Postman tokens" };

    const body = this.buildRequestBody(request, tokens, postmanModel, String(account.id));

    try {
      const response = await this.fetchWithTimeout(
        `https://${tokens.workspace_subdomain}.postman.co${CHAT_ENDPOINT}`,
        { method: "POST", headers: this.buildHeaders(tokens), body: JSON.stringify(body) },
        config.providerRequestTimeoutMs, config.ttfbTimeoutMs, request.signal,
        { verbose: config.postmanFetchVerbose, context: "Postman chat" },
      );

      const statusResult = this.checkResponseStatus(response);
      if (statusResult) return statusResult;
      if (!response.body) return { success: false, error: "Postman returned no response body" };

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const text = await response.text();
        const error = extractUpstreamError(text);
        return {
          success: false,
          error,
          ...(isPostmanQuotaExceeded(text) || isPostmanQuotaExceeded(error)
            ? { quotaExhausted: true }
            : {}),
        };
      }

      const completionId = this.generateId();
      const pmReader = new PostmanStreamReader({
        requestedModel: request.model,
        selectedModel: postmanModel,
      });
      const upstreamReader = response.body.getReader();
      const decoder = new TextDecoder();
      let ndjsonBuffer = "";
      let rawPrefix = "";
      let upstreamDone = false;
      const initialDeltas: PostmanDelta[] = [];

      const feedLines = (lines: string[], output: PostmanDelta[]) => {
        for (const line of lines) {
          if (!line.trim()) continue;
          output.push(...pmReader.feed(line));
        }
      };

      while (!upstreamDone && !initialDeltas.some(isMeaningfulDelta)) {
        const { done, value } = await upstreamReader.read();
        if (done) {
          upstreamDone = true;
          ndjsonBuffer += decoder.decode(new Uint8Array(0), { stream: false });
          feedLines(ndjsonBuffer.split("\n"), initialDeltas);
          break;
        }

        const decoded = decoder.decode(value, { stream: true });
        rawPrefix = (rawPrefix + decoded).slice(-65_536);
        ndjsonBuffer += decoded;
        const lines = ndjsonBuffer.split("\n");
        ndjsonBuffer = lines.pop() || "";
        feedLines(lines, initialDeltas);

        if (pmReader.quotaExceeded || pmReader.error) break;
      }

      if (pmReader.quotaExceeded) {
        await cancelReader(upstreamReader, "quota exhausted");
        return {
          success: false,
          error: pmReader.error || "Postman AI quota exceeded",
          quotaExhausted: true,
        };
      }
      if (pmReader.error) {
        await cancelReader(upstreamReader, pmReader.error);
        return {
          success: false,
          error: pmReader.error,
          ...(pmReader.modelMismatch ? { modelMismatch: true } : {}),
          ...(pmReader.retryableError ? { retryable: true } : {}),
        };
      }
      if (upstreamDone && !pmReader.sawEvent) {
        upstreamReader.releaseLock();
        return { success: false, error: extractUpstreamError(rawPrefix || ndjsonBuffer) };
      }
      if (upstreamDone && !initialDeltas.some(isMeaningfulDelta)) {
        upstreamReader.releaseLock();
        return {
          success: false,
          retryable: true,
          error: "Postman returned an empty response without text, reasoning, or tool calls",
        };
      }
      if (pmReader.conversationId) {
        setConversationId(account.id, request._sessionId, pmReader.conversationId);
      }

      let cancelled = false;
      let closed = false;
      let released = false;
      let streamFailureHandler: ((failure: StreamFailure) => void | Promise<void>) | undefined;
      let pendingStreamFailure: StreamFailure | undefined;
      let lastStreamFailure: StreamFailure | undefined;
      let streamFailureReported = false;
      let streamContent = "";
      let streamReasoningContent = "";
      const streamToolCalls = new Map<string, { id: string; name: string; args: string }>();

      const captureDelta = (delta: PostmanDelta) => {
        if (delta.content) streamContent += delta.content;
        if (delta.reasoning_content) streamReasoningContent += delta.reasoning_content;
        for (const toolCall of delta.tool_calls || []) {
          const key = String(toolCall.index);
          if (toolCall.id && !streamToolCalls.has(key)) {
            streamToolCalls.set(key, { id: toolCall.id, name: "", args: "" });
          }
          const entry = streamToolCalls.get(key);
          if (!entry) continue;
          if (toolCall.function?.name) entry.name = toolCall.function.name;
          if (toolCall.function?.arguments) entry.args += toolCall.function.arguments;
        }
      };

      const getStreamMessage = (): ChatMessage | undefined => {
        const toolCalls = Array.from(streamToolCalls.values()).map((toolCall) => ({
          id: toolCall.id,
          type: "function" as const,
          function: { name: toolCall.name, arguments: toolCall.args },
        }));
        if (!streamContent && !streamReasoningContent && toolCalls.length === 0) return undefined;
        const message: any = { role: "assistant", content: streamContent || null };
        if (streamReasoningContent) message.reasoning_content = streamReasoningContent;
        if (toolCalls.length > 0) message.tool_calls = toolCalls;
        return message;
      };

      const getStreamTokenUsage = () => {
        const toolArguments = Array.from(streamToolCalls.values())
          .map((toolCall) => toolCall.args)
          .join("");
        return resolveTokenUsage(
          pmReader.tokenUsage,
          this.estimateMessagesTokens(request.messages),
          this.estimateTokens(streamContent + streamReasoningContent + toolArguments),
        );
      };

      const failStream = async (kind: StreamFailure["kind"], message: string): Promise<Error> => {
        const error = new Error(message);
        const failure = { kind, error };
        lastStreamFailure = failure;
        streamFailureReported = true;
        if (streamFailureHandler) {
          await streamFailureHandler(failure);
        } else {
          pendingStreamFailure = failure;
        }
        return error;
      };

      const releaseUpstreamReader = () => {
        if (released) return;
        try {
          upstreamReader.releaseLock();
          released = true;
        } catch {
          // A pending read may retain the lock; retry after cancellation settles.
        }
      };

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          const emit = (delta: PostmanDelta) => {
            if (!cancelled && !closed) {
              captureDelta(delta);
              controller.enqueue(encoder.encode(buildSSEChunk(delta, completionId, request.model)));
            }
          };
          try {
            for (const delta of initialDeltas) emit(delta);

            if (upstreamDone) {
              for (const delta of pmReader.finish()) emit(delta);
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              closed = true;
              controller.close();
              return;
            }

            while (!cancelled && !closed) {
              const { done, value } = await upstreamReader.read();
              if (cancelled || closed) break;
              if (done) {
                ndjsonBuffer += decoder.decode(new Uint8Array(0), { stream: false });
                for (const line of ndjsonBuffer.split("\n")) {
                  if (!line.trim()) continue;
                  for (const delta of pmReader.feed(line)) emit(delta);
                }
                if (pmReader.quotaExceeded) {
                  throw await failStream(
                    "quota_exhausted",
                    pmReader.error || "Postman AI quota exceeded",
                  );
                }
                if (pmReader.error) {
                  throw await failStream("upstream_error", pmReader.error);
                }
                if (pmReader.conversationId) {
                  setConversationId(account.id, request._sessionId, pmReader.conversationId);
                }
                for (const delta of pmReader.finish()) emit(delta);
                if (!cancelled) {
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  closed = true;
                  controller.close();
                }
                break;
              }
              ndjsonBuffer += decoder.decode(value, { stream: true });
              const lines = ndjsonBuffer.split("\n");
              ndjsonBuffer = lines.pop() || "";
              for (const line of lines) {
                if (!line.trim()) continue;
                for (const delta of pmReader.feed(line)) emit(delta);
              }
              if (pmReader.quotaExceeded) {
                throw await failStream(
                  "quota_exhausted",
                  pmReader.error || "Postman AI quota exceeded",
                );
              }
              if (pmReader.error) {
                throw await failStream("upstream_error", pmReader.error);
              }
              if (pmReader.conversationId) {
                setConversationId(account.id, request._sessionId, pmReader.conversationId);
              }
            }
          } catch (error) {
            if (!cancelled && !closed) {
              if (!streamFailureReported) {
                const message = error instanceof Error ? error.message : String(error);
                await failStream("upstream_error", message);
              }
              closed = true;
              controller.error(error);
            }
          } finally {
            releaseUpstreamReader();
          }
        },
        async cancel(reason) {
          if (cancelled || closed) return;
          cancelled = true;
          try {
            await upstreamReader.cancel(reason);
          } catch {
            // Cancellation is best-effort; never leave a rejected promise unhandled.
          } finally {
            releaseUpstreamReader();
          }
        },
      });

      return {
        success: true,
        stream,
        getStreamMessage,
        getStreamTokenUsage,
        getStreamFailure: () => lastStreamFailure,
        setStreamFailureHandler: (handler) => {
          streamFailureHandler = handler;
          if (pendingStreamFailure) {
            const failure = pendingStreamFailure;
            pendingStreamFailure = undefined;
            return handler(failure);
          }
        },
      };
    } catch (error) {
      return { success: false, error: `Postman stream failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private checkResponseStatus(response: Response): ProviderResult | null {
    if (response.status === 401 || response.status === 403) return { success: false, error: `Postman auth failed (${response.status})` };
    if (response.status === 429) {
      return {
        success: false,
        error: "Postman rate limited",
        rateLimited: true,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      };
    }
    if (response.status >= 500) return { success: false, error: `Postman server error (${response.status})` };
    if (!response.ok) return { success: false, error: `Postman API error (${response.status})` };
    return null;
  }

  async refreshToken(_account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: false, error: "Postman sessions require manual re-login in the browser." };
  }

  async validateAccount(account: Account): Promise<boolean> {
    return this.getTokens(account) !== null;
  }

  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: {
      limit: number;
      remaining: number;
      used: number;
      resetAt?: Date | string | null;
      overageAllowed?: boolean;
    };
    error?: string;
  }> {
    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, error: "Missing tokens" };

    try {
      const body = JSON.stringify({
        service: "usage",
        method: "get",
        path: `/teams/${tokens.workspace_id}/operations/ai_millicredits/usage`,
      });

      const response = await fetch(
        `https://${tokens.workspace_subdomain}.postman.co/_api/ws/proxy`,
        {
          method: "POST",
          // The usage proxy rejects the chat-only x-pstmn-req-service header.
          headers: this.buildUsageHeaders(tokens),
          body,
          signal: AbortSignal.timeout(15000),
        },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return {
          success: false,
          error: `Quota API error: ${response.status}${extractQuotaApiError(text) ? ` - ${extractQuotaApiError(text)}` : ""}`,
        };
      }

      const data = (await response.json()) as any;
      const blocks = Array.isArray(data?.data) ? data.data : [];
      const teamBlock = blocks.find((block: any) => block?.entity_type === "team");
      const entity = teamBlock?.entities?.[0] ?? data?.data?.entity ?? data?.data;
      if (!entity) return { success: false, error: "No team quota entity found" };

      const rawLimit = firstFiniteNumber(
        entity.limit,
        entity.quota,
        entity.total_limit,
        entity.credit_limit,
      );
      const rawUsage = firstFiniteNumber(
        entity.usage,
        entity.used,
        entity.consumed,
        entity.total_usage,
      );
      const rawSpillage = firstFiniteNumber(
        entity.spillage,
        entity.overage_usage,
        entity.excess_usage,
      ) ?? 0;
      const rawRemaining = firstFiniteNumber(
        entity.remaining,
        entity.remaining_credits,
        entity.credits_remaining,
        entity.quota_remaining,
      );
      const unitDivisor = String(entity.name || "").toLowerCase() === "ai_millicredits" ? 1000 : 1;
      const limitValue = rawLimit === undefined ? undefined : rawLimit / unitDivisor;
      const usageValue = rawUsage === undefined ? undefined : rawUsage / unitDivisor;
      const spillageValue = rawSpillage / unitDivisor;
      const remainingValue = rawRemaining === undefined ? undefined : rawRemaining / unitDivisor;
      const effectiveUsage = usageValue === undefined ? undefined : usageValue + spillageValue;
      const remaining = remainingValue ?? (
        limitValue !== undefined && effectiveUsage !== undefined
          ? Math.max(0, limitValue - effectiveUsage)
          : undefined
      );
      if (remaining === undefined) {
        return { success: false, error: "Quota response did not contain a remaining balance" };
      }

      const used = effectiveUsage ?? Math.max(0, (limitValue ?? remaining) - remaining);
      const limit = limitValue ?? used + remaining;
      const overageAllowed = firstBoolean(
        entity.allowOverage,
        entity.overage_allowed,
        entity.overages_enabled,
        entity.overage_enabled,
        entity.payg_enabled,
        entity.pay_as_you_go_enabled,
        entity.allow_overage,
      ) ?? false;

      return {
        success: true,
        quota: {
          limit,
          remaining: Math.max(0, remaining),
          used,
          overageAllowed,
          resetAt: entity.reset_at ?? entity.resetAt ?? entity.billing_period_end ?? null,
        },
      };
    } catch (error) {
      return { success: false, error: `Quota fetch failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const valid = await this.validateAccount(account);
    if (!valid) return { kind: "missing_tokens", success: false, error: "Postman token blob incomplete or invalid" };

    const quotaResult = await this.fetchQuota(account);
    if (!quotaResult.success || !quotaResult.quota) {
      return {
        kind: "transient_error",
        success: false,
        retryable: true,
        error: quotaResult.error || "Postman quota is temporarily unavailable",
      };
    }

    const q = quotaResult.quota;
    return {
      kind: q.remaining <= 0 && !q.overageAllowed ? "exhausted" : "healthy",
      success: true,
      quota: { ...q, source: "postman.dynamic" } as any,
    };
  }
}

function buildSSEChunk(delta: PostmanDelta, completionId: string, model: string): string {
  const chunk: StreamChunk = {
    id: completionId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta: delta as any, finish_reason: delta.finish_reason ?? null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i]!)) return i;
  }
  return -1;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "yes", "enabled", "1"].includes(normalized)) return true;
      if (["false", "no", "disabled", "0"].includes(normalized)) return false;
    }
  }
  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function safeToolName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeToolParameters(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...EMPTY_TOOL_PARAMETERS };
  }

  const schema = { ...(parsed as Record<string, unknown>) };
  if (!schema.type) schema.type = "object";
  if (schema.type === "object" && (!schema.properties || typeof schema.properties !== "object")) {
    schema.properties = {};
  }
  return schema;
}

function stringifyToolArguments(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) || "";
  } catch {
    return String(value);
  }
}

function isToolChoiceNone(value: unknown): boolean {
  if (value === "none") return true;
  return Boolean(
    value
    && typeof value === "object"
    && String((value as Record<string, unknown>).type || "").toLowerCase() === "none",
  );
}

function extractQuotaApiError(text: string): string {
  if (!text.trim()) return "";
  try {
    const data = JSON.parse(text) as any;
    return String(data?.error?.message || data?.error?.details || data?.message || "").trim();
  } catch {
    return text.trim().slice(0, 300);
  }
}

function resolveTokenUsage(
  upstream: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  } | null,
  estimatedPromptTokens: number,
  estimatedCompletionTokens: number,
): TokenUsage {
  const hasPrompt = upstream?.promptTokens !== undefined;
  const hasCompletion = upstream?.completionTokens !== undefined;
  const hasTotal = upstream?.totalTokens !== undefined;
  const promptTokens = hasPrompt ? upstream!.promptTokens! : estimatedPromptTokens;
  const completionTokens = hasCompletion ? upstream!.completionTokens! : estimatedCompletionTokens;
  const totalTokens = hasTotal ? upstream!.totalTokens! : promptTokens + completionTokens;
  const upstreamFields = Number(hasPrompt) + Number(hasCompletion) + Number(hasTotal);
  const source: TokenUsageSource = upstreamFields === 3
    ? "upstream"
    : upstreamFields === 0
      ? "estimated"
      : "mixed";

  return { promptTokens, completionTokens, totalTokens, source };
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) return 30_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1_000, seconds * 1000);
  const retryAt = Date.parse(value);
  if (Number.isFinite(retryAt)) return Math.max(1_000, retryAt - Date.now());
  return 30_000;
}

function isMeaningfulDelta(delta: PostmanDelta): boolean {
  return Boolean(delta.content || delta.reasoning_content || delta.tool_calls?.length);
}

async function cancelReader(
  reader: {
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  },
  reason: string,
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch {
    // Best-effort cancellation.
  }
  try {
    reader.releaseLock();
  } catch {
    // The stream may already have released its lock.
  }
}

function extractUpstreamError(text: string): string {
  const fallback = "Postman returned an invalid streaming response";
  const trimmed = text.trim();
  if (!trimmed) return fallback;
  try {
    const parsed = JSON.parse(trimmed);
    return String(
      parsed?.error?.message ||
      parsed?.error ||
      parsed?.message ||
      parsed?.detail ||
      fallback,
    );
  } catch {
    return trimmed.length <= 500 ? trimmed : fallback;
  }
}
