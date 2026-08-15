import type { ModelInfo } from "./base";

export const POSTMAN_MODEL_MAP: Record<string, string | null> = {
  "gpt-5.6-sol": "GPT_56_SOL",
  "gpt-5.6-terra": "GPT_56_TERRA",
  "gpt-5.6-luna": "GPT_56_LUNA",
  "gpt-5.5": "GPT_55",
  "gpt-5.4": "GPT_54",
  "claude-opus-4-8": "CLAUDE_OPUS_48_BEDROCK",
  "claude-opus-4-7": "CLAUDE_OPUS_47_BEDROCK",
  "claude-opus-4-5": "CLAUDE_OPUS_45_BEDROCK",
  "claude-sonnet-4-6": "CLAUDE_46_SONNET_BEDROCK",
  "claude-sonnet-4-5": "CLAUDE_45_SONNET_BEDROCK",
  "claude-haiku-4-5": "CLAUDE_45_HAIKU_BEDROCK",
  "auto": null,
};

/**
 * Normalize only the spelling of a model ID. This deliberately does not map
 * one model family/version to another model. A compatibility alias that would
 * change the requested model is a hidden downgrade/upgrade, so it must be
 * rejected instead of silently rewritten.
 */
export function normalizePostmanModelId(model: string): string {
  return model.trim().toLowerCase();
}

export function resolvePostmanModel(model: string): string | null | undefined {
  return POSTMAN_MODEL_MAP[normalizePostmanModelId(model)];
}

/**
 * Convert an upstream model label to a known Postman model ID for comparison.
 * This is validation-only; the returned value is never sent upstream as a
 * replacement model.
 */
export function canonicalPostmanModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizePostmanModelId(value);
  if (!normalized) return undefined;

  for (const [modelId, selectedModel] of Object.entries(POSTMAN_MODEL_MAP)) {
    if (normalized === modelId || (selectedModel && normalized === normalizePostmanModelId(selectedModel))) {
      return modelId;
    }

    // Accept harmless punctuation/casing differences such as GPT-5.5 vs
    // GPT_55, but do not use this to create an alias for a different model.
    if (compactModelId(normalized) === compactModelId(modelId)) return modelId;
  }

  return undefined;
}

/**
 * `auto` is an explicit caller choice: Postman may choose the concrete model
 * for that request. For every other request, an observed upstream model must
 * be the exact requested model (or its exact selected Postman identifier).
 */
export function postmanModelMatches(
  requestedModel: string,
  selectedModel: string | null | undefined,
  actualModel: string,
): boolean {
  const requested = normalizePostmanModelId(requestedModel);
  if (requested === "auto") return true;

  const actual = canonicalPostmanModelId(actualModel);
  if (!actual) return false;

  return actual === requested
    || (selectedModel !== null
      && selectedModel !== undefined
      && normalizePostmanModelId(actualModel) === normalizePostmanModelId(selectedModel));
}

export function postmanModelMismatchError(
  requestedModel: string,
  actualModel: string,
): string {
  return `Postman changed requested model from "${requestedModel}" to "${actualModel}"; automatic model downgrade or replacement is disabled`;
}

function compactModelId(value: string): string {
  return value.replace(/[^a-z0-9]/g, "");
}

function pm(id: string, ctx: number, maxOut?: number, thinking?: boolean): ModelInfo {
  return {
    id,
    object: "model",
    created: 1700000000,
    owned_by: "postman",
    context_window: ctx,
    max_output: maxOut,
    thinking,
  };
}

export const POSTMAN_MODELS: ModelInfo[] = [
  pm("gpt-5.6-sol", 128000, 32000, true),
  pm("gpt-5.6-terra", 128000, 32000, true),
  pm("gpt-5.6-luna", 128000, 32000, true),
  pm("gpt-5.5", 128000, 32000, true),
  pm("gpt-5.4", 128000, 32000, true),
  pm("claude-opus-4-8", 200000, 64000, true),
  pm("claude-opus-4-7", 200000, 64000, true),
  pm("claude-opus-4-5", 200000, 64000),
  pm("claude-sonnet-4-6", 200000, 64000, true),
  pm("claude-sonnet-4-5", 200000, 64000),
  pm("claude-haiku-4-5", 200000, 64000),
  pm("auto", 200000, 64000),
];
