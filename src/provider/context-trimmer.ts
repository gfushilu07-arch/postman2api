import type { ChatMessage } from "./base";

export interface ContextTrimResult {
  messages: ChatMessage[];
  trimmed: boolean;
  maxTokens: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  droppedMessages: number;
  droppedTurns: number;
  mandatoryTokensExceeded: boolean;
}

interface MessageGroup {
  messages: ChatMessage[];
  estimatedTokens: number;
}

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return JSON.parse(JSON.stringify(messages || [])) as ChatMessage[];
}

function serializedValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value ?? "");
  }
}

/**
 * Postman does not expose the tokenizer used by its selected model. This
 * estimator is intentionally conservative for CJK and astral Unicode while
 * retaining the common four-ASCII-characters-per-token approximation.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let asciiChars = 0;
  let unicodeTokens = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      asciiChars++;
    } else {
      unicodeTokens += codePoint > 0xffff ? 2 : 1.5;
    }
  }
  return Math.max(1, Math.ceil(asciiChars / 4 + unicodeTokens));
}

export function estimateMessageTokens(message: ChatMessage): number {
  return estimateTextTokens(serializedValue(message)) + 4;
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export function estimateToolsTokens(tools: unknown[] | undefined): number {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  return estimateTextTokens(serializedValue(tools)) + tools.length * 4;
}

function groupConversationTurns(messages: ChatMessage[]): MessageGroup[] {
  const groups: ChatMessage[][] = [];
  let current: ChatMessage[] = [];

  for (const message of messages) {
    if (message.role === "user" && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group) => ({
    messages: group,
    estimatedTokens: estimateMessagesTokens(group),
  }));
}

/**
 * Keeps leading system instructions and the newest complete user turn, then
 * retains as many preceding complete turns as fit. Tool calls and their tool
 * results stay in the same user-led group and are never split individually.
 *
 * A single mandatory system/latest turn may itself exceed the configured
 * budget. It is preserved rather than silently corrupting the current request.
 */
export function trimContextMessages(
  inputMessages: ChatMessage[],
  maxTokens: number,
  tools?: unknown[],
): ContextTrimResult {
  const messages = cloneMessages(inputMessages);
  const normalizedMax = Number.isFinite(maxTokens) ? Math.max(0, Math.floor(maxTokens)) : 0;
  const toolTokens = estimateToolsTokens(tools);
  const estimatedTokensBefore = estimateMessagesTokens(messages) + toolTokens;

  if (normalizedMax === 0 || estimatedTokensBefore <= normalizedMax || messages.length === 0) {
    return {
      messages,
      trimmed: false,
      maxTokens: normalizedMax,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
      droppedMessages: 0,
      droppedTurns: 0,
      mandatoryTokensExceeded: normalizedMax > 0 && estimatedTokensBefore > normalizedMax,
    };
  }

  let leadingSystemCount = 0;
  while (messages[leadingSystemCount]?.role === "system") leadingSystemCount++;
  const leadingSystem = messages.slice(0, leadingSystemCount);
  const groups = groupConversationTurns(messages.slice(leadingSystemCount));

  // With only system messages there is no historical turn that can be removed
  // safely, so preserve the request and report that mandatory content is over.
  if (groups.length === 0) {
    return {
      messages,
      trimmed: false,
      maxTokens: normalizedMax,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
      droppedMessages: 0,
      droppedTurns: 0,
      mandatoryTokensExceeded: true,
    };
  }

  const fixedTokens = estimateMessagesTokens(leadingSystem) + toolTokens;
  let firstKeptGroup = groups.length - 1;
  let usedTokens = fixedTokens + groups[firstKeptGroup]!.estimatedTokens;

  for (let index = groups.length - 2; index >= 0; index--) {
    const nextTokens = usedTokens + groups[index]!.estimatedTokens;
    if (nextTokens > normalizedMax) break;
    usedTokens = nextTokens;
    firstKeptGroup = index;
  }

  const keptGroups = groups.slice(firstKeptGroup);
  const trimmedMessages = [
    ...leadingSystem,
    ...keptGroups.flatMap((group) => group.messages),
  ];
  const droppedTurns = firstKeptGroup;
  const droppedMessages = messages.length - trimmedMessages.length;
  const estimatedTokensAfter = estimateMessagesTokens(trimmedMessages) + toolTokens;

  return {
    messages: trimmedMessages,
    trimmed: droppedMessages > 0,
    maxTokens: normalizedMax,
    estimatedTokensBefore,
    estimatedTokensAfter,
    droppedMessages,
    droppedTurns,
    mandatoryTokensExceeded: estimatedTokensAfter > normalizedMax,
  };
}
