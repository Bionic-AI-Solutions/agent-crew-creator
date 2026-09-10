/**
 * Turn an agent's slug into something to show a person.
 *
 * `agentConfigs.name` is a slug, not a label: it is constrained by
 * AGENT_NAME_REGEX because it becomes part of the LiveKit dispatch name and
 * the k8s deployment name. So it reads `jarvis-test-2`, and putting that
 * straight in front of a visitor is only marginally better than the raw
 * dispatch identity it replaced.
 *
 * player-ui already did this transform inline and the other two surfaces did
 * not, so the same agent appeared as "Jarvis Test 2" in one place and
 * "jarvis-test-2" in another. One function, every surface.
 */
export function agentDisplayName(slug: string | null | undefined): string {
  const trimmed = (slug ?? "").trim();
  if (!trimmed) return "Agent";
  return trimmed.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
