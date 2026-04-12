/**
 * Optional NDJSON-style debug logging for playground / deploy flows.
 * Enable with DEBUG_BIONIC_SESSION=1. No-op in production by default.
 */
export function emitDebugLog(payload: {
  location: string;
  message: string;
  data?: Record<string, unknown>;
  hypothesisId?: string;
}): void {
  if (process.env.DEBUG_BIONIC_SESSION !== "1") return;
  console.log(`DEBUG_BIONIC_SESSION ${JSON.stringify({ ts: Date.now(), ...payload })}`);
}
