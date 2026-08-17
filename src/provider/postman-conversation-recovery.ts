import type { ChatMessage } from "./base";

const DEFAULT_MAX_CONVERSATIONS = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DETAIL_CONCURRENCY = 6;
const MIN_UNIQUE_ASSISTANT_MATCH_CHARS = 40;

export interface PostmanConversationRecoveryTokens {
  postman_sid: string;
  workspace_subdomain: string;
}

interface PostmanConversationSummary {
  id: string;
  modelKey?: string | null;
  state?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface PostmanConversationInteraction {
  role?: string | null;
  type?: string | null;
  content?: string | null;
  thinkingContent?: string | null;
  toolCalls?: Array<{
    id?: string | null;
    name?: string | null;
    args?: unknown;
  }> | null;
}

export interface PostmanConversationDetail extends PostmanConversationSummary {
  interactions?: PostmanConversationInteraction[] | null;
}

export interface PostmanConversationCandidate {
  conversationId: string;
  score: number;
  state: string | null;
  modelKey: string | null;
  assistantMatches: number;
  reasoningMatches: number;
  toolIdMatches: number;
  toolSignatureMatches: number;
  matchedAssistantChars: number;
}

export interface PostmanConversationRecoveryResult {
  recovered: boolean;
  conversationId?: string;
  score?: number;
  reason:
    | "recovered"
    | "no_local_anchor"
    | "no_history"
    | "no_compatible_candidate"
    | "ambiguous"
    | "history_error";
  scanned: number;
  compatible: number;
  error?: string;
}

export interface RecoverPostmanConversationOptions {
  tokens: PostmanConversationRecoveryTokens;
  messages: ChatMessage[];
  expectedModelKey: string | null;
  headers: Record<string, string>;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  maxConversations?: number;
  requestTimeoutMs?: number;
}

interface LocalAssistantAnchor {
  content: string;
  reasoning: string;
  toolCalls: ToolAnchor[];
  recency: number;
}

interface ToolAnchor {
  id: string;
  signature: string;
}

interface LocalRecoveryContext {
  assistantAnchors: LocalAssistantAnchor[];
  toolResultIds: Set<string>;
  pendingToolCallIds: Set<string>;
  expectedState: "WAITING_FOR_TOOL" | "WAITING_FOR_USER";
}

interface ScoredCandidate extends PostmanConversationCandidate {
  highConfidence: boolean;
}

export function shouldAttemptPostmanConversationRecovery(messages: ChatMessage[]): boolean {
  const tail = messages[messages.length - 1];
  if (!tail) return false;
  if (tail.role === "tool") return true;
  if (containsToolResultBlock(tail)) return true;
  return tail.role === "assistant" && Array.isArray(tail.tool_calls) && tail.tool_calls.length > 0;
}

export function selectPostmanConversationCandidate(
  messages: ChatMessage[],
  conversations: PostmanConversationDetail[],
  expectedModelKey: string | null,
): {
  candidate: PostmanConversationCandidate | null;
  reason: PostmanConversationRecoveryResult["reason"];
  compatible: number;
} {
  const local = buildLocalRecoveryContext(messages);
  if (local.assistantAnchors.length === 0) {
    return { candidate: null, reason: "no_local_anchor", compatible: 0 };
  }

  const scored = conversations
    .map((conversation, index) => scoreConversation(local, conversation, expectedModelKey, index))
    .filter((candidate): candidate is ScoredCandidate => candidate !== null)
    .sort((left, right) => right.score - left.score);
  if (scored.length === 0) {
    return { candidate: null, reason: "no_compatible_candidate", compatible: 0 };
  }

  const top = scored[0]!;
  const second = scored[1];
  if (!top.highConfidence) {
    return { candidate: null, reason: "no_compatible_candidate", compatible: scored.length };
  }
  if (second && second.highConfidence && top.score - second.score < 150) {
    return { candidate: null, reason: "ambiguous", compatible: scored.length };
  }

  return { candidate: top, reason: "recovered", compatible: scored.length };
}

export async function recoverPostmanConversation(
  options: RecoverPostmanConversationOptions,
): Promise<PostmanConversationRecoveryResult> {
  const local = buildLocalRecoveryContext(options.messages);
  if (local.assistantAnchors.length === 0) {
    return {
      recovered: false,
      reason: "no_local_anchor",
      scanned: 0,
      compatible: 0,
    };
  }

  const fetcher = options.fetcher ?? globalThis.fetch;
  const maxConversations = Math.max(
    1,
    Math.floor(options.maxConversations ?? DEFAULT_MAX_CONVERSATIONS),
  );
  const requestTimeoutMs = Math.max(
    1,
    Math.floor(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
  );
  const baseUrl = `https://${options.tokens.workspace_subdomain}.postman.co/_gw`;

  try {
    const summaries = await fetchConversationSummaries({
      baseUrl,
      headers: options.headers,
      signal: options.signal,
      fetcher,
      maxConversations,
      requestTimeoutMs,
    });
    if (summaries.length === 0) {
      return {
        recovered: false,
        reason: "no_history",
        scanned: 0,
        compatible: 0,
      };
    }

    // Never inspect conversations that cannot accept the next local turn.
    // Besides improving accuracy, this keeps the recovery path from opening
    // every unrelated Postman conversation in the account.
    const compatibleSummaries = summaries.filter((summary) => (
      normalizeState(summary.state) === local.expectedState
      && modelMatches(summary.modelKey, options.expectedModelKey)
    ));
    const details = await mapWithConcurrency(
      compatibleSummaries,
      DETAIL_CONCURRENCY,
      async (summary) => fetchConversationDetail({
        baseUrl,
        headers: options.headers,
        signal: options.signal,
        fetcher,
        requestTimeoutMs,
        summary,
      }),
    );
    const validDetails = details.filter(
      (detail): detail is PostmanConversationDetail => detail !== null,
    );
    const selected = selectPostmanConversationCandidate(
      options.messages,
      validDetails,
      options.expectedModelKey,
    );
    if (!selected.candidate) {
      return {
        recovered: false,
        reason: selected.reason,
        scanned: validDetails.length,
        compatible: selected.compatible,
      };
    }

    return {
      recovered: true,
      conversationId: selected.candidate.conversationId,
      score: selected.candidate.score,
      reason: "recovered",
      scanned: validDetails.length,
      compatible: selected.compatible,
    };
  } catch (error) {
    return {
      recovered: false,
      reason: "history_error",
      scanned: 0,
      compatible: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildLocalRecoveryContext(messages: ChatMessage[]): LocalRecoveryContext {
  const assistantAnchors: LocalAssistantAnchor[] = [];
  const toolResultIds = collectTrailingToolResultIds(messages);
  const recentMessages = messages.slice(-80);

  for (let index = recentMessages.length - 1; index >= 0; index--) {
    const message = recentMessages[index]!;
    if (message.role !== "assistant") continue;

    const content = normalizeText(renderMessageContent(message.content));
    const reasoning = normalizeText(renderUnknownValue((message as any).reasoning_content));
    const toolCalls = normalizeLocalToolCalls(message.tool_calls);
    if (!content && !reasoning && toolCalls.length === 0) continue;
    assistantAnchors.push({
      content,
      reasoning,
      toolCalls,
      recency: assistantAnchors.length,
    });
    if (assistantAnchors.length >= 16) break;
  }

  const tail = messages[messages.length - 1];
  const tailHasToolResult = tail?.role === "tool" || (tail ? containsToolResultBlock(tail) : false);
  const tailHasToolCalls = tail?.role === "assistant"
    && Array.isArray(tail.tool_calls)
    && tail.tool_calls.length > 0;
  const pendingToolCallIds = new Set<string>();
  if (tailHasToolCalls) {
    for (const toolCall of tail!.tool_calls || []) {
      const id = normalizeText(toolCall?.id);
      if (id) pendingToolCallIds.add(id);
    }
  }

  return {
    assistantAnchors,
    toolResultIds,
    pendingToolCallIds,
    expectedState: tailHasToolResult || tailHasToolCalls
      ? "WAITING_FOR_TOOL"
      : "WAITING_FOR_USER",
  };
}

function collectTrailingToolResultIds(messages: ChatMessage[]): Set<string> {
  const result = new Set<string>();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "tool") {
      const id = normalizeText(message.tool_call_id);
      if (id) result.add(id);
      continue;
    }
    if (containsToolResultBlock(message)) {
      collectToolResultIds(message.content, result);
    }
    break;
  }
  return result;
}

function scoreConversation(
  local: LocalRecoveryContext,
  conversation: PostmanConversationDetail,
  expectedModelKey: string | null,
  listIndex: number,
): ScoredCandidate | null {
  const state = normalizeState(conversation.state);
  if (state !== local.expectedState) return null;
  if (!modelMatches(conversation.modelKey, expectedModelKey)) return null;

  const interactions = Array.isArray(conversation.interactions)
    ? conversation.interactions
    : [];
  const cloudContents = new Set<string>();
  const cloudReasoning = new Set<string>();
  const cloudTools: ToolAnchor[] = [];
  for (const interaction of interactions) {
    if (String(interaction?.role || "").toUpperCase() !== "ASSISTANT") continue;
    const content = normalizeText(interaction.content);
    const reasoning = normalizeText(interaction.thinkingContent);
    if (content) cloudContents.add(content);
    if (reasoning) cloudReasoning.add(reasoning);
    for (const toolCall of interaction.toolCalls || []) {
      const name = normalizeText(toolCall?.name);
      const args = normalizeToolArguments(toolCall?.args);
      cloudTools.push({
        id: normalizeText(toolCall?.id),
        signature: name ? `${name}\n${args}` : "",
      });
    }
  }
  if (cloudContents.size === 0 && cloudReasoning.size === 0 && cloudTools.length === 0) {
    return null;
  }

  let score = Math.max(0, 30 - listIndex);
  let assistantMatches = 0;
  let reasoningMatches = 0;
  let toolIdMatches = 0;
  let toolSignatureMatches = 0;
  let matchedAssistantChars = 0;
  const matchedCloudToolIndexes = new Set<number>();

  for (const anchor of local.assistantAnchors) {
    const recencyBonus = Math.max(0, 120 - anchor.recency * 12);
    if (anchor.content && cloudContents.has(anchor.content)) {
      assistantMatches++;
      matchedAssistantChars += anchor.content.length;
      score += 220 + Math.min(300, anchor.content.length * 2) + recencyBonus;
    }
    if (anchor.reasoning && cloudReasoning.has(anchor.reasoning)) {
      reasoningMatches++;
      score += 180 + Math.min(180, Math.floor(anchor.reasoning.length / 4)) + recencyBonus;
    }
    for (const localTool of anchor.toolCalls) {
      let bestIndex = -1;
      let bestKind: "id" | "signature" | null = null;
      for (let index = 0; index < cloudTools.length; index++) {
        if (matchedCloudToolIndexes.has(index)) continue;
        const cloudTool = cloudTools[index]!;
        if (localTool.id && cloudTool.id && localTool.id === cloudTool.id) {
          bestIndex = index;
          bestKind = "id";
          break;
        }
        if (
          bestKind === null
          && localTool.signature
          && cloudTool.signature
          && localTool.signature === cloudTool.signature
        ) {
          bestIndex = index;
          bestKind = "signature";
        }
      }
      if (bestIndex < 0 || !bestKind) continue;
      matchedCloudToolIndexes.add(bestIndex);
      if (bestKind === "id") {
        toolIdMatches++;
        score += 900 + recencyBonus;
        if (
          localTool.signature
          && localTool.signature === cloudTools[bestIndex]!.signature
        ) {
          toolSignatureMatches++;
          score += 260;
        }
      } else {
        toolSignatureMatches++;
        score += 620 + recencyBonus;
      }
    }
  }

  if (local.expectedState === "WAITING_FOR_TOOL") {
    const pendingIds = new Set(cloudTools.map((tool) => tool.id).filter(Boolean));
    const requiredIds = local.toolResultIds.size > 0
      ? local.toolResultIds
      : local.pendingToolCallIds;
    if (requiredIds.size > 0 && ![...requiredIds].every((id) => pendingIds.has(id))) {
      return null;
    }
    if (requiredIds.size > 0) score += 420;
  } else {
    score += 80;
  }

  const highConfidence = (
    toolIdMatches >= 1
    || (toolSignatureMatches >= 1 && assistantMatches >= 1)
    || assistantMatches >= 2
    || (assistantMatches >= 1 && reasoningMatches >= 1)
    || (
      assistantMatches === 1
      && matchedAssistantChars >= MIN_UNIQUE_ASSISTANT_MATCH_CHARS
    )
  );

  return {
    conversationId: conversation.id,
    score,
    state,
    modelKey: normalizeNullableText(conversation.modelKey),
    assistantMatches,
    reasoningMatches,
    toolIdMatches,
    toolSignatureMatches,
    matchedAssistantChars,
    highConfidence,
  };
}

async function fetchConversationSummaries(options: {
  baseUrl: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  fetcher: typeof fetch;
  maxConversations: number;
  requestTimeoutMs: number;
}): Promise<PostmanConversationSummary[]> {
  const summaries: PostmanConversationSummary[] = [];
  const seenIds = new Set<string>();
  let cursor: string | null = null;

  while (summaries.length < options.maxConversations) {
    const params = new URLSearchParams({ limit: "20" });
    if (cursor) params.set("cursor", cursor);
    const payload = await fetchJson(
      `${options.baseUrl}/conversation?${params}`,
      options.headers,
      options.fetcher,
      options.signal,
      options.requestTimeoutMs,
    );
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    for (const row of rows) {
      const id = normalizeText(row?.id);
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      summaries.push({
        id,
        modelKey: normalizeNullableText(row?.modelKey),
        state: normalizeNullableText(row?.state),
        createdAt: normalizeNullableText(row?.createdAt),
        updatedAt: normalizeNullableText(row?.updatedAt),
      });
      if (summaries.length >= options.maxConversations) break;
    }
    const nextCursor = normalizeText(payload?.meta?.nextCursor);
    if (!nextCursor || rows.length === 0 || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  return summaries;
}

async function fetchConversationDetail(options: {
  baseUrl: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  fetcher: typeof fetch;
  requestTimeoutMs: number;
  summary: PostmanConversationSummary;
}): Promise<PostmanConversationDetail | null> {
  const payload = await fetchJson(
    `${options.baseUrl}/conversation/${encodeURIComponent(options.summary.id)}`,
    options.headers,
    options.fetcher,
    options.signal,
    options.requestTimeoutMs,
  );
  if (!payload?.data || normalizeText(payload.data.id) !== options.summary.id) return null;
  return {
    ...options.summary,
    ...payload.data,
    id: options.summary.id,
    // GET /conversation/:id updates Postman's updatedAt metadata. Preserve the
    // list snapshot so opening candidates cannot influence ranking.
    updatedAt: options.summary.updatedAt,
  };
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  fetcher: typeof fetch,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<any> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) {
    controller.abort(externalSignal.reason);
  } else {
    externalSignal?.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new Error(`Postman conversation history timeout after ${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    const response = await fetcher(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Postman conversation history error (${response.status})`
        + (text.trim() ? `: ${text.slice(0, 240)}` : ""),
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Postman conversation history returned invalid JSON");
    }
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

function normalizeLocalToolCalls(toolCalls: unknown): ToolAnchor[] {
  if (!Array.isArray(toolCalls)) return [];
  const result: ToolAnchor[] = [];
  for (const toolCall of toolCalls) {
    const definition = toolCall?.function && typeof toolCall.function === "object"
      ? toolCall.function
      : toolCall;
    const name = normalizeText(definition?.name);
    const args = normalizeToolArguments(
      definition?.arguments ?? definition?.args ?? toolCall?.arguments ?? toolCall?.args,
    );
    result.push({
      id: normalizeText(toolCall?.id),
      signature: name ? `${name}\n${args}` : "",
    });
  }
  return result.filter((tool) => tool.id || tool.signature);
}

function normalizeToolArguments(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      return stableStringify(JSON.parse(trimmed));
    } catch {
      return trimmed.replace(/\r\n/g, "\n");
    }
  }
  return value === undefined || value === null ? "" : stableStringify(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(object[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function collectToolResultIds(value: unknown, target: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const block of value) {
    if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
    const id = normalizeText(block.tool_use_id ?? block.tool_call_id);
    if (id) target.add(id);
  }
}

function containsToolResultBlock(message: ChatMessage): boolean {
  return Array.isArray(message.content)
    && message.content.some((block) => (
      block
      && typeof block === "object"
      && block.type === "tool_result"
    ));
}

function renderMessageContent(content: ChatMessage["content"] | null | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return renderUnknownValue(content);
  return content.map((block) => {
    if (!block || typeof block !== "object") return renderUnknownValue(block);
    if (
      ["text", "input_text", "output_text"].includes(String(block.type))
      && typeof block.text === "string"
    ) {
      return block.text;
    }
    return renderUnknownValue(block);
  }).join("\n");
}

function renderUnknownValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function normalizeText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\r\n/g, "\n").trim()
    : "";
}

function normalizeNullableText(value: unknown): string | null {
  const normalized = normalizeText(value);
  return normalized || null;
}

function normalizeState(value: unknown): string | null {
  const normalized = normalizeText(value).toUpperCase();
  return normalized || null;
}

function modelMatches(actual: unknown, expected: string | null): boolean {
  if (!expected) return true;
  const normalizedActual = normalizeText(actual).toUpperCase();
  return !normalizedActual || normalizedActual === expected.toUpperCase();
}
