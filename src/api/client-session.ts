const MAX_SESSION_ID_LENGTH = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CLAUDE_METADATA_SESSION = new RegExp(
  `(?:^|[_:/-])session(?:[_:/-])(${UUID})(?:$|[_:/-])`,
  "i",
);

type RequestBody = {
  metadata?: {
    user_id?: unknown;
    session_id?: unknown;
  };
};

export type ClientProtocol = "openai" | "anthropic";

function normalizeSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > MAX_SESSION_ID_LENGTH
    || CONTROL_CHARACTERS.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function scoped(source: "explicit" | "claude-code" | "codex", value: unknown): string | undefined {
  const normalized = normalizeSessionId(value);
  return normalized ? `${source}:${normalized}` : undefined;
}

function claudeSessionFromMetadata(body: RequestBody): string | undefined {
  const userId = normalizeSessionId(body.metadata?.user_id);
  if (!userId) return undefined;
  const match = CLAUDE_METADATA_SESSION.exec(userId);
  return match?.[1];
}

/**
 * Resolve a stable client conversation scope without guessing from request IDs
 * or message content. Explicit caller configuration wins over native agent IDs.
 */
export function resolveClientSessionId(
  headers: Headers,
  body: unknown,
  protocol: ClientProtocol,
): string | undefined {
  const explicit = scoped("explicit", headers.get("x-session-id"));
  if (explicit) return explicit;

  const claudeHeader = scoped(
    "claude-code",
    headers.get("x-claude-code-session-id") || headers.get("claude-code-session-id"),
  );
  if (claudeHeader) return claudeHeader;

  const codexHeader = scoped(
    "codex",
    headers.get("session_id")
      || headers.get("session-id")
      || headers.get("x-codex-session-id"),
  );
  if (codexHeader) return codexHeader;

  if (!body || typeof body !== "object") return undefined;
  const requestBody = body as RequestBody;

  const metadataSession = scoped(
    protocol === "anthropic" ? "claude-code" : "codex",
    requestBody.metadata?.session_id,
  );
  if (metadataSession) return metadataSession;

  if (protocol === "anthropic") {
    return scoped("claude-code", claudeSessionFromMetadata(requestBody));
  }

  return undefined;
}
