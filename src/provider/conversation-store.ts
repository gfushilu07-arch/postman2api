const CONVERSATION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CONVERSATIONS = 10_000;
const MAX_SCOPED_SESSION_ID_LENGTH = 320;

export interface ConversationEntry {
  id: string;
  updatedAt: number;
}

const conversations = new Map<string, ConversationEntry>();

export function conversationKey(accountId: number | string, sessionId?: string): string | null {
  const normalized = sessionId?.trim();
  if (!normalized || normalized.length > MAX_SCOPED_SESSION_ID_LENGTH) return null;
  return `${accountId}:${normalized}`;
}

export function getConversationId(accountId: number | string, sessionId?: string): string | null {
  const key = conversationKey(accountId, sessionId);
  if (!key) return null;

  const entry = conversations.get(key);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > CONVERSATION_TTL_MS) {
    conversations.delete(key);
    return null;
  }

  entry.updatedAt = Date.now();
  return entry.id;
}

export function getConversationSnapshot(
  accountId: number | string,
  sessionId?: string,
): ConversationEntry | null {
  const key = conversationKey(accountId, sessionId);
  if (!key) return null;

  const entry = conversations.get(key);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > CONVERSATION_TTL_MS) {
    conversations.delete(key);
    return null;
  }
  return { ...entry };
}

export function setConversationId(
  accountId: number | string,
  sessionId: string | undefined,
  conversationId: string,
  updatedAt = Date.now(),
): void {
  const key = conversationKey(accountId, sessionId);
  if (!key || !conversationId) return;

  if (conversations.size >= MAX_CONVERSATIONS && !conversations.has(key)) {
    const oldestKey = conversations.keys().next().value;
    if (oldestKey) conversations.delete(oldestKey);
  }
  conversations.delete(key);
  conversations.set(key, { id: conversationId, updatedAt });
}

export function restoreConversationId(
  accountId: number | string,
  sessionId: string | undefined,
  conversationId: string | null | undefined,
  updatedAt: Date | number | null | undefined,
): boolean {
  if (!conversationId) return false;
  if (updatedAt !== null && updatedAt !== undefined) {
    const timestamp = updatedAt instanceof Date
      ? updatedAt.getTime()
      : updatedAt < 1_000_000_000_000
        ? updatedAt * 1000
        : updatedAt;
    if (!Number.isFinite(timestamp)) return false;
  }
  // The in-memory TTL is only a cache bound. A persisted Postman
  // conversation may remain valid after a long local idle period, so loading
  // it from SQLite refreshes the cache instead of discarding the durable ID.
  setConversationId(accountId, sessionId, conversationId, Date.now());
  return true;
}

export function deleteConversationId(
  accountId: number | string,
  sessionId?: string,
): void {
  const key = conversationKey(accountId, sessionId);
  if (key) conversations.delete(key);
}

export function clearAccountConversations(accountId: number | string): void {
  const prefix = `${accountId}:`;
  for (const key of conversations.keys()) {
    if (key.startsWith(prefix)) conversations.delete(key);
  }
}

export function clearConversations(): void {
  conversations.clear();
}
