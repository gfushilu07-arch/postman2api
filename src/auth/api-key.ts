export function acceptsApiKey(
  expected: string,
  authorization?: string,
  anthropicApiKey?: string,
): boolean {
  return authorization === `Bearer ${expected}` || anthropicApiKey === expected;
}
