import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { sessionStates } from "../db/schema";
import type { ChatMessage } from "./base";
import { broadcast } from "../ws/index";
import { writeSessionState } from "../db/write-queue";
import { getConversationSnapshot } from "./conversation-store";
import { estimateMessagesTokens } from "./context-trimmer";

export interface PreparedSession {
  messages: ChatMessage[];
  revision: number;
  accountId: number | null;
}

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return JSON.parse(JSON.stringify(messages || [])) as ChatMessage[];
}

function messageKey(message: ChatMessage): string {
  return JSON.stringify(message);
}

function messagesEqual(left: ChatMessage, right: ChatMessage): boolean {
  return messageKey(left) === messageKey(right);
}

function isPrefix(prefix: ChatMessage[], messages: ChatMessage[]): boolean {
  return prefix.length <= messages.length
    && prefix.every((message, index) => messagesEqual(message, messages[index]!));
}

function serializedMessages(messages: ChatMessage[]): string {
  return JSON.stringify(messages);
}

export function estimateSessionTokens(messages: ChatMessage[]): number {
  return estimateMessagesTokens(messages);
}

export function sessionMessageChars(messages: ChatMessage[]): number {
  return serializedMessages(messages).length;
}

export function mergeSessionMessages(
  storedMessages: ChatMessage[],
  incomingMessages: ChatMessage[],
): ChatMessage[] {
  const stored = cloneMessages(storedMessages);
  const incoming = cloneMessages(incomingMessages);
  if (stored.length === 0) return incoming;
  if (incoming.length === 0) return stored;
  if (isPrefix(stored, incoming)) return incoming;
  if (isPrefix(incoming, stored)) return stored;

  let commonPrefix = 0;
  while (
    commonPrefix < stored.length
    && commonPrefix < incoming.length
    && messagesEqual(stored[commonPrefix]!, incoming[commonPrefix]!)
  ) {
    commonPrefix++;
  }
  if (commonPrefix > 0) {
    const incomingRemainder = incoming.slice(commonPrefix);
    return incomingRemainder.length <= 1
      ? [...stored, ...incomingRemainder]
      : incoming;
  }

  const maxOverlap = Math.min(stored.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    let matches = true;
    for (let index = 0; index < overlap; index++) {
      if (!messagesEqual(stored[stored.length - overlap + index]!, incoming[index]!)) {
        matches = false;
        break;
      }
    }
    if (matches) return [...stored, ...incoming.slice(overlap)];
  }

  return incoming.length === 1 ? [...stored, ...incoming] : incoming;
}

export function countUserTurns(messages: ChatMessage[]): number {
  return messages.reduce((count, message) => count + (message.role === "user" ? 1 : 0), 0);
}

export async function prepareSession(
  sessionId: string | undefined,
  incomingMessages: ChatMessage[],
): Promise<PreparedSession> {
  if (!sessionId) {
    return {
      messages: cloneMessages(incomingMessages),
      revision: 0,
      accountId: null,
    };
  }

  const [row] = await db.select().from(sessionStates)
    .where(eq(sessionStates.sessionId, sessionId)).limit(1);
  if (!row) {
    return {
      messages: cloneMessages(incomingMessages),
      revision: 0,
      accountId: null,
    };
  }

  try {
    const stored = JSON.parse(row.messages) as ChatMessage[];
    return {
      messages: mergeSessionMessages(stored, incomingMessages),
      revision: row.revision,
      accountId: row.accountId,
    };
  } catch {
    return {
      messages: cloneMessages(incomingMessages),
      revision: row.revision,
      accountId: row.accountId,
    };
  }
}

export async function commitSession(
  sessionId: string | undefined,
  requestMessages: ChatMessage[],
  assistantMessage: ChatMessage,
  accountId: number,
  // The provider may receive a trimmed copy of the request. Keep the complete
  // locally merged transcript so a later request can be trimmed again without
  // permanently deleting the older Codex-side history from SQLite.
  sessionHistoryMessages: ChatMessage[] = requestMessages,
): Promise<void> {
  if (!sessionId) return;
  const sessionMessages = [
    ...cloneMessages(sessionHistoryMessages),
    ...cloneMessages([assistantMessage]),
  ];
  const messages = serializedMessages(sessionMessages);
  const turnCount = countUserTurns(sessionMessages);
  const estimatedTokens = estimateSessionTokens(sessionMessages);
  const messageChars = messages.length;
  const conversation = getConversationSnapshot(accountId, sessionId);

  await writeSessionState({
    sessionId,
    accountId,
    conversationId: conversation?.id ?? null,
    conversationUpdatedAt: conversation
      ? Math.floor(conversation.updatedAt / 1000)
      : null,
    messages,
    turnCount,
    estimatedTokens,
    messageChars,
  });
  broadcast({ type: "session_updated", data: { sessionId, accountId } });
}

export async function getSessionMessages(sessionId: string): Promise<ChatMessage[]> {
  const [row] = await db.select().from(sessionStates)
    .where(eq(sessionStates.sessionId, sessionId)).limit(1);
  if (!row) return [];
  try {
    return JSON.parse(row.messages) as ChatMessage[];
  } catch {
    return [];
  }
}

export async function deleteSessionState(sessionId: string): Promise<void> {
  await db.delete(sessionStates).where(eq(sessionStates.sessionId, sessionId));
}

export async function clearSessionStates(): Promise<void> {
  await db.delete(sessionStates);
}
