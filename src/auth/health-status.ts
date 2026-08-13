import type { ProviderHealthResult } from "../provider/base";

export function resolveWarmupStatus(
  previousStatus: string,
  health: ProviderHealthResult,
): "active" | "exhausted" {
  if (health.kind === "exhausted") return "exhausted";
  if (!health.quota && previousStatus === "exhausted") return "exhausted";
  return "active";
}
