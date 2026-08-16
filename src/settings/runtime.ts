import { eq } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db/index";
import { settings } from "../db/schema";

export const CONTEXT_MAX_TOKENS_KEY = "context_max_tokens";
export const MAX_CONFIGURABLE_CONTEXT_TOKENS = 10_000_000;

let cachedContextMaxTokens: number | undefined;

export function parseContextMaxTokens(
  value: unknown,
  fallback = config.contextMaxTokens,
): number {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed)
    || !Number.isInteger(parsed)
    || parsed < 0
    || parsed > MAX_CONFIGURABLE_CONTEXT_TOKENS
  ) {
    return fallback;
  }
  return parsed;
}

export async function getContextMaxTokens(): Promise<number> {
  if (cachedContextMaxTokens !== undefined) return cachedContextMaxTokens;
  const [row] = await db.select({ value: settings.value }).from(settings)
    .where(eq(settings.key, CONTEXT_MAX_TOKENS_KEY)).limit(1);
  cachedContextMaxTokens = parseContextMaxTokens(row?.value);
  return cachedContextMaxTokens;
}

export function setCachedContextMaxTokens(value: number): void {
  cachedContextMaxTokens = value;
}

export function clearRuntimeSettingsCache(): void {
  cachedContextMaxTokens = undefined;
}
