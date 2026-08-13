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

export function resolvePostmanModel(model: string): string | null | undefined {
  return POSTMAN_MODEL_MAP[model.toLowerCase()];
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
