/**
 * One answer to "which API key should this agent use for <provider>?"
 *
 * Three sources, in priority order:
 *   1. a key supplied on the request — the validate-before-save flow, where
 *      nothing has been written to Vault yet;
 *   2. the per-agent override at secret/t6-apps/<slug>/config, field
 *      `agent_<id>_<provider>_api_key`;
 *   3. the org-wide shared key at secret/shared/api-keys.
 *
 * The deploy path has always had (3): resolveProviderSecretKey falls back to
 * `shared_<provider>_api_key` and the pod runs on it perfectly well. The
 * builder's model and voice pickers only ever looked at (2), so the form
 * asked for a key on every cloud provider — and showed an empty model list
 * until one was pasted — even where a shared key was configured and was
 * exactly what the agent would run with. Resolving both through here is what
 * stops the builder and the deployer disagreeing about which key applies.
 */

export type ProviderKeySource = "request" | "agent" | "shared" | "none";

export interface ResolvedProviderKey {
  apiKey?: string;
  source: ProviderKeySource;
}

/** Vault field holding the per-agent override. */
export function perAgentKeyField(agentId: number, provider: string): string {
  return `agent_${agentId}_${provider}_api_key`;
}

/**
 * Vault field holding a provider's shared key.
 *
 * `overrides` is k8sClient.ts's VAULT_PROPERTY_OVERRIDES, passed in rather
 * than restated, because that is the same map the ExternalSecret's
 * `remoteRef.property` is built from. Two independent lowercase-template
 * guesses is precisely how SARVAM_API_KEY's delivery broke on 2026-07-15.
 */
export function sharedKeyField(
  provider: string,
  overrides: Record<string, string>,
): string {
  return overrides[provider] ?? `${provider}_api_key`;
}

/**
 * The precedence decision on its own, with the Vault reads already done.
 * Split out from resolveProviderApiKey so the ordering — and the casing of
 * the shared field — can be tested without a live Vault.
 */
export function pickProviderKey(args: {
  agentId: number;
  provider: string;
  requestKey?: string;
  appSecrets: Record<string, string>;
  sharedKeys: Record<string, string>;
  overrides: Record<string, string>;
}): ResolvedProviderKey {
  const { agentId, provider, requestKey, appSecrets, sharedKeys, overrides } = args;

  const trimmed = requestKey?.trim();
  if (trimmed) return { apiKey: trimmed, source: "request" };

  const perAgent = appSecrets[perAgentKeyField(agentId, provider)];
  if (perAgent) return { apiKey: perAgent, source: "agent" };

  const shared = sharedKeys[sharedKeyField(provider, overrides)];
  if (shared) return { apiKey: shared, source: "shared" };

  return { source: "none" };
}

export async function resolveProviderApiKey(opts: {
  appSlug: string;
  agentId: number;
  provider: string;
  requestKey?: string;
}): Promise<ResolvedProviderKey> {
  const { appSlug, agentId, provider, requestKey } = opts;

  // A key on the request needs no Vault round trip at all.
  const trimmed = requestKey?.trim();
  if (trimmed) return { apiKey: trimmed, source: "request" };

  const { readAppSecret, readPlatformVaultPath } = await import("../vaultClient.js");
  const { VAULT_PROPERTY_OVERRIDES } = await import("../k8sClient.js");

  const appSecrets = (await readAppSecret(appSlug)) || {};
  // Only reached when there is no per-agent override, so the shared read is
  // not on the common path for agents that carry their own key.
  const sharedKeys = appSecrets[perAgentKeyField(agentId, provider)]
    ? {}
    : (await readPlatformVaultPath("shared/api-keys")) || {};

  return pickProviderKey({
    agentId,
    provider,
    appSecrets,
    sharedKeys,
    overrides: VAULT_PROPERTY_OVERRIDES,
  });
}
