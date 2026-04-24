/**
 * Dify admin credentials — sourced from the platform's Vault-backed
 * ExternalSecret, never from code defaults.
 *
 * Keys live at: secret/t6-apps/bionic-platform/config
 *   - dify_admin_email
 *   - dify_admin_password
 *
 * These are wired into the platform pod as env vars via the
 * bionic-platform-secrets K8s Secret (see
 * deploy/k8s-infrastructure/deploy/vault/apps/bionic-platform/external-secret.yaml
 * and the Deployment manifest).
 */

type DifyCreds = { email: string; password: string };

let warned = false;

export function getDifyAdminCredentials(): DifyCreds {
  const email = process.env.DIFY_ADMIN_EMAIL;
  const password = process.env.DIFY_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "Dify admin credentials missing. Set secret/t6-apps/bionic-platform/config " +
        "dify_admin_email and dify_admin_password in Vault, then let ESO sync " +
        "the bionic-platform-secrets Secret. Do not hardcode defaults.",
    );
  }

  if (!warned && email === "admin@bionic.local") {
    // Historical default — flag once if someone seeded it literally in Vault.
    // eslint-disable-next-line no-console
    console.warn(
      "[difyAuth] Dify admin email is the historical default (admin@bionic.local); " +
        "rotate to a real account via the Dify console.",
    );
    warned = true;
  }

  return { email, password };
}
