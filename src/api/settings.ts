import { Hono } from "hono";
import { db } from "../db/index";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { config } from "../config";
import {
  CONTEXT_MAX_TOKENS_KEY,
  MAX_CONFIGURABLE_CONTEXT_TOKENS,
  parseContextMaxTokens,
  setCachedContextMaxTokens,
} from "../settings/runtime";

export const settingsRouter = new Hono();

settingsRouter.get("/", async (c) => {
  const rows = await db.select().from(settings);
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (row.key && row.value) result[row.key] = row.value;
  }
  result[CONTEXT_MAX_TOKENS_KEY] ??= String(config.contextMaxTokens);
  return c.json({ data: result });
});

settingsRouter.put("/", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== "string") {
      return c.json({ error: `${key} must be a string` }, 400);
    }
    if (key === CONTEXT_MAX_TOKENS_KEY) {
      const parsed = parseContextMaxTokens(value, -1);
      if (parsed < 0) {
        return c.json({
          error: `上下文上限必须是 0 到 ${MAX_CONFIGURABLE_CONTEXT_TOKENS} 之间的整数`,
        }, 400);
      }
      setCachedContextMaxTokens(parsed);
    }
    await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, key));
    // Insert if not exists
    await db.insert(settings).values({ key, value, updatedAt: new Date() }).onConflictDoNothing();
  }
  return c.json({ success: true });
});
