import { eq, sql } from "drizzle-orm";
import { db } from "../db/index";
import { sessionStates } from "../db/schema";
import type { ChatMessage } from "./base";
import { broadcast } from "../ws/index";

const MAX_SESSION_MESSAGES_CHARS = 800_000;

export interface PreparedSession {
  messages: ChatMessage[];
  revision: number;
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

function trimMessages(messages: ChatMessage[]): ChatMessage[] {
  if (JSON.stringify(messages).length <= MAX_SESSION_MESSAGES_CHARS) return messages;

  const leadingSystem = messages.filter((message) => message.role === "system");
  const kept: ChatMessage[] = [];
  let size = JSON.stringify(leadingSystem).length;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "system") continue;
    const messageSize = messageKey(message).length;
    if (kept.length > 0 && size + messageSize > MAX_SESSION_MESSAGES_CHARS) break;
    kept.unshift(message);
    size += messageSize;
  }
  return [...leadingSystem, ...kept];
}

export async function prepareSession(
  sessionId: string | undefined,
  incomingMessages: ChatMessage[],
): Promise<PreparedSession> {
  if (!sessionId) return { messages: cloneMessages(incomingMessages), revision: 0 };

  const [row] = await db.select().from(sessionStates)
    .where(eq(sessionStates.sessionId, sessionId)).limit(1);
  if (!row) return { messages: cloneMessages(incomingMessages), revision: 0 };

  try {
    const stored = JSON.parse(row.messages) as ChatMessage[];
    return {
      messages: trimMessages(mergeSessionMessages(stored, incomingMessages)),
      revision: row.revision,
    };
  } catch {
    return { messages: cloneMessages(incomingMessages), revision: row.revision };
  }
}

export async function commitSession(
  sessionId: string | undefined,
  requestMessages: ChatMessage[],
  assistantMessage: ChatMessage,
  accountId: number,
): Promise<void> {
  if (!sessionId) return;
  const now = new Date();
  const messages = JSON.stringify(trimMessages([
    ...cloneMessages(requestMessages),
    ...cloneMessages([assistantMessage]),
  ]));

  await db.insert(sessionStates).values({
    sessionId,
    accountId,
    messages,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: sessionStates.sessionId,
    set: {
      accountId,
      messages,
      revision: sql`${sessionStates.revision} + 1`,
      updatedAt: now,
    },
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
