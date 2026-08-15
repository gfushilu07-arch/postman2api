import {
  postmanModelMatches,
  postmanModelMismatchError,
} from "./models";

export interface PostmanDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
  finish_reason?: string | null;
}

export interface PostmanUsage {
  limit: number;
  usage: number;
  overage: number;
  userType: string;
  usageState: string;
}

export interface PostmanTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface PostmanStreamReaderOptions {
  requestedModel?: string;
  selectedModel?: string | null;
}

const QUOTA_ERROR_PATTERNS = [
  "usage_limit_exceeded",
  "quota_exceeded",
  "monthly ai credit limit",
  "ai credit limit",
  "regain agent mode access",
  "enable pay-as-you-go",
  "enable pay as you go",
];

export function isPostmanQuotaExceeded(value: unknown): boolean {
  const text = typeof value === "string" ? value : safeStringify(value);
  const normalized = text.toLowerCase();
  return QUOTA_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export class PostmanStreamReader {
  private readonly requestedModel?: string;
  private readonly selectedModel?: string | null;
  private finished = false;
  private _quotaExceeded = false;
  private _usage: PostmanUsage | null = null;
  private _tokenUsage: PostmanTokenUsage | null = null;
  private _error: string | null = null;
  private _retryableError = false;
  private _model: string | null = null;
  private _conversationId: string | null = null;
  private _sawEvent = false;
  private _sawToolCall = false;
  private _modelMismatch = false;
  private _toolCallIndex = new Map<string, number>();
  private _generatedToolIds = new Map<number, string>();
  private _nextToolCallIndex = 0;

  constructor(options: PostmanStreamReaderOptions = {}) {
    this.requestedModel = options.requestedModel;
    this.selectedModel = options.selectedModel;
  }

  get quotaExceeded(): boolean { return this._quotaExceeded; }
  get usage(): PostmanUsage | null { return this._usage; }
  get tokenUsage(): PostmanTokenUsage | null { return this._tokenUsage; }
  get error(): string | null { return this._error; }
  get retryableError(): boolean { return this._retryableError; }
  get actualModel(): string | null { return this._model; }
  get modelMismatch(): boolean { return this._modelMismatch; }
  get conversationId(): string | null { return this._conversationId; }
  get sawEvent(): boolean { return this._sawEvent; }

  feed(line: string): PostmanDelta[] {
    const trimmed = line.trim();
    const match = /^data:\s*(.+)$/.exec(trimmed);
    if (!match) return [];

    let event: any;
    try {
      event = JSON.parse(match[1]!);
    } catch {
      return [];
    }

    if (!event || typeof event !== "object") return [];
    this._sawEvent = true;
    this.observeModel(event, event.data);
    if (this._modelMismatch) return [];

    const eventType = String(event.eventType || event.type || "");
    switch (eventType) {
      case "usage":
        return this.handleUsage(event.data);
      case "conversation":
        return this.handleConversation(event.data);
      case "textChunk":
        return this.handleTextChunk(event.data);
      case "thinkingChunk":
        return this.handleThinkingChunk(event.data);
      case "planningChunk":
      case "progressUpdate":
        return [];
      case "failure":
        return this.handleFailure(event.data);
      case "error":
        return this.handleFailure(event.data ?? event.error ?? event);
      case "toolCallChunk":
        return this.handleToolCallChunk(event.data);
      case "info":
      case "ping":
      case "streamingFormat":
      case "thinkingComplete":
        return [];
      default:
        if (/fail|error/i.test(eventType) || isPostmanQuotaExceeded(event)) {
          return this.handleFailure(event.data ?? event.error ?? event);
        }
        return [];
    }
  }

  finish(): PostmanDelta[] {
    if (this.finished) return [];
    this.finished = true;
    return [{ finish_reason: this._sawToolCall ? "tool_calls" : "stop" }];
  }

  private handleUsage(data: any): PostmanDelta[] {
    if (!data) return [];
    this._usage = {
      limit: data.limit ?? 0,
      usage: data.usage ?? 0,
      overage: data.overage ?? 0,
      userType: data.userType ?? "",
      usageState: data.usageState ?? "",
    };
    const promptTokens = firstFiniteNumber(
      data.prompt_tokens,
      data.promptTokens,
      data.input_tokens,
      data.inputTokens,
    );
    const completionTokens = firstFiniteNumber(
      data.completion_tokens,
      data.completionTokens,
      data.output_tokens,
      data.outputTokens,
    );
    const totalTokens = firstFiniteNumber(data.total_tokens, data.totalTokens);
    if (promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined) {
      this._tokenUsage = { promptTokens, completionTokens, totalTokens };
    }
    const usageState = String(data.usageState || "").toUpperCase();
    if (
      usageState === "EXCEEDED"
      || usageState === "UNAVAILABLE"
      || isPostmanQuotaExceeded(data)
    ) {
      this._quotaExceeded = true;
    }
    return [];
  }

  private handleConversation(data: any): PostmanDelta[] {
    if (!data) return [];
    if (typeof data.id === "string") {
      this._conversationId = data.id;
    }
    return [];
  }

  private handleTextChunk(data: any): PostmanDelta[] {
    if (!data) return [];
    const text = data.textContent;
    if (typeof text === "string" && text.length > 0) {
      return [{ content: text }];
    }
    return [];
  }

  private handleThinkingChunk(data: any): PostmanDelta[] {
    if (!data) return [];
    const text = data.thinkingContent;
    if (typeof text === "string" && text.length > 0) {
      return [{ reasoning_content: text }];
    }
    return [];
  }

  private handleToolCallChunk(data: any): PostmanDelta[] {
    const toolCalls = extractToolCallEntries(data);
    if (toolCalls.length === 0) return [];

    const out: PostmanDelta[] = [];
    for (const [position, tc] of toolCalls.entries()) {
      this._sawToolCall = true;

      const explicitIndex = firstFiniteInteger(tc.index, tc.toolCallIndex);
      const suppliedId = firstNonEmptyString(
        tc.id,
        tc.call_id,
        tc.callId,
        tc.tool_call_id,
        tc.toolCallId,
      );
      const positionKey = `position:${position}`;
      const idKey = suppliedId ? `id:${suppliedId}` : undefined;
      const sourceKey = explicitIndex === undefined
        ? idKey || positionKey
        : `index:${explicitIndex}`;

      let idx = this._toolCallIndex.get(sourceKey);
      if (idx === undefined && explicitIndex === undefined && suppliedId) {
        idx = this._toolCallIndex.get(positionKey);
      }
      const isFirst = idx === undefined;
      const toolCallIndex = idx === undefined ? this._nextToolCallIndex++ : idx;
      if (isFirst) {
        this._toolCallIndex.set(sourceKey, toolCallIndex);
      }
      this._toolCallIndex.set(positionKey, toolCallIndex);
      if (idKey) this._toolCallIndex.set(idKey, toolCallIndex);

      const stableId = suppliedId || this.getGeneratedToolId(toolCallIndex);
      const name = firstNonEmptyString(
        tc.function?.name,
        tc.name,
        tc.tool?.name,
      );
      const argumentsText = stringifyToolArguments(
        tc.function?.arguments
        ?? tc.arguments
        ?? tc.input
        ?? tc.input_json,
      );

      out.push({
        tool_calls: [{
          index: toolCallIndex,
          ...(isFirst ? { id: stableId, type: "function" as const } : {}),
          function: {
            ...(name ? { name } : {}),
            ...(argumentsText ? { arguments: argumentsText } : {}),
          },
        }],
      });
    }
    return out;
  }

  private getGeneratedToolId(index: number): string {
    const existing = this._generatedToolIds.get(index);
    if (existing) return existing;
    const generated = `call_postman_${index}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this._generatedToolIds.set(index, generated);
    return generated;
  }

  private handleFailure(data: any): PostmanDelta[] {
    if (this._modelMismatch) return [];
    this._error = extractFailureMessage(data);
    this._retryableError = this._error === "Unknown Postman error";
    if (this._retryableError) {
      this._error = "Postman AI access is not ready for this team yet. Confirm that organization AI access is enabled, then retry shortly.";
    }
    if (isPostmanQuotaExceeded(data) || isPostmanQuotaExceeded(this._error)) {
      this._quotaExceeded = true;
      this._retryableError = false;
    }
    return [];
  }

  private observeModel(...values: unknown[]): void {
    const actualModel = firstNonEmptyString(
      ...values.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const data = value as Record<string, any>;
        return [
          data.metadata?.model,
          data.metadata?.modelId,
          data.metadata?.selectedModel,
          data.model,
          data.modelId,
          data.selectedModel,
        ];
      }),
    );
    if (!actualModel) return;

    this._model = actualModel;
    if (
      this.requestedModel
      && !this._modelMismatch
      && !postmanModelMatches(this.requestedModel, this.selectedModel, actualModel)
    ) {
      this._modelMismatch = true;
      this._retryableError = false;
      this._error = postmanModelMismatchError(this.requestedModel, actualModel);
    }
  }
}

function extractToolCallEntries(data: any): any[] {
  if (Array.isArray(data)) return data;
  for (const key of ["toolCalls", "tool_calls", "calls"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  if (data?.toolCall && typeof data.toolCall === "object") return [data.toolCall];
  if (data?.tool_call && typeof data.tool_call === "object") return [data.tool_call];
  return [];
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function firstFiniteInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
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

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return undefined;
}

function extractFailureMessage(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return "Unknown Postman error";

  const data = value as Record<string, unknown>;
  for (const key of ["userMessage", "message", "detail", "reason"]) {
    const candidate = data[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  for (const key of ["error", "data", "cause"]) {
    const candidate = data[key];
    if (candidate && typeof candidate === "object") {
      const nested = extractFailureMessage(candidate);
      if (nested !== "Unknown Postman error") return nested;
    }
  }
  for (const key of ["errorType", "code"]) {
    const candidate = data[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "Unknown Postman error";
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) || "";
  } catch {
    return String(value ?? "");
  }
}
