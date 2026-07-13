/**
 * Headed Playwright verification of the two behavioral fixes that CDP/agent-browser
 * could not drive through Radix Select portals:
 *   #9  — provider-key UI gates on requiresKey (letta = no key input; openai = key input)
 *   #10 — editing a field is NOT clobbered when getById refetches (form-reseed fix)
 *
 * Logs in as qa.uber via the real Keycloak PKCE flow. Read-only: never clicks
 * Save/Deploy, so no production state is mutated (unsaved edits are discarded).
 *
 * Run: QA_USER=... QA_PASS=... xvfb-run -a node tests/qa-caveats.spec.mjs
 */
import { chromium } from "playwright";

const BASE = "https://platform.baisoln.com";
const QA_USER = process.env.QA_USER;
const QA_PASS = process.env.QA_PASS;
const SHOT = "/tmp/claude-1000/-workspaces/16be035c-6911-4f51-b77b-9a552c3e518b/scratchpad";

const results = [];
const ok = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const browser = await chromium.launch({ headless: false });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();

try {
  // ── Login (Keycloak PKCE) ──────────────────────────────────────
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Sign in with Keycloak/i }).click();
  await page.waitForSelector("#username", { timeout: 20000 });
  await page.fill("#username", QA_USER);
  await page.fill("#password", QA_PASS);
  await page.click("#kc-login");
  await page.waitForURL(/platform\.baisoln\.com/, { timeout: 25000 });
  await page.waitForLoadState("networkidle");
  ok("Login as qa.uber via Keycloak PKCE", /platform\.baisoln\.com/.test(page.url()) && !/auth\./.test(page.url()));

  // ── Navigate: Agent Builder → Guruji → physics ─────────────────
  await page.goto(`${BASE}/agents`, { waitUntil: "networkidle" });
  const appSelect = page.getByRole("combobox").first();
  await appSelect.click();
  await page.getByRole("option", { name: "Guruji" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^physics/i }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("tab", { name: "LiveKit" }).click();
  await page.waitForTimeout(1000);
  ok("Opened Guruji → physics agent config (LiveKit tab)", await page.getByRole("tab", { name: "LiveKit" }).isVisible());

  // Helper: count the LLM/STT/TTS API-key inputs (ProviderKeyInput → placeholder "sk-...")
  const keyInputs = () => page.locator('input[placeholder="sk-..."]').count();
  const baseline = await keyInputs();

  // ── #9: LLM provider = Letta → NO key input ────────────────────
  const llmSelect = page.getByRole("combobox").filter({ hasText: "GPU-AI (Local)" }).first();
  await llmSelect.click();
  await page.getByRole("option", { name: "Letta (Recommended)" }).click();
  await page.waitForTimeout(800);
  const afterLetta = await keyInputs();
  ok("#9 Letta (keyless) shows NO API-key input", afterLetta === 0, `key inputs=${afterLetta} (baseline ${baseline})`);

  // ── #9: LLM provider = OpenAI → key input APPEARS ──────────────
  const llmSelect2 = page.getByRole("combobox").filter({ hasText: "Letta" }).first();
  await llmSelect2.click();
  await page.getByRole("option", { name: "OpenAI", exact: true }).click();
  await page.waitForTimeout(800);
  const afterOpenAI = await keyInputs();
  const hasTestSave = await page.getByRole("button", { name: /Test & Save/i }).count();
  ok("#9 OpenAI (key-required) shows the API-key input + Test&Save", afterOpenAI >= 1 && hasTestSave >= 1,
     `key inputs=${afterOpenAI}, Test&Save buttons=${hasTestSave}`);

  // Reset provider back to GPU-AI (still unsaved — discarded on reload) so #10
  // runs from a clean keyless state.
  const llmSelect3 = page.getByRole("combobox").filter({ hasText: "OpenAI" }).first();
  await llmSelect3.click();
  await page.getByRole("option", { name: "GPU-AI (Local)" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOT}/qa-9-openai.png` });

  // ── #10: edit persona, force a getById refetch, assert NOT clobbered ──
  const persona = page.getByPlaceholder(/friendly physics tutor/i);
  await persona.waitFor({ state: "visible", timeout: 10000 });
  const marker = `__QA_CLOBBER_${Date.now()}__`;
  const before = await persona.inputValue();
  await persona.focus();
  await persona.fill(before + "\n" + marker);
  ok("#10 typed marker into persona field", (await persona.inputValue()).includes(marker));

  // Let getById go stale (staleTime 5s), then trigger the exact refetch a sibling
  // panel's invalidate would cause — via React Query's focus manager — and WAIT
  // for the getById request to actually fire (guards against a false pass).
  await page.waitForTimeout(6000);
  const refetch = page.waitForResponse(
    (r) => /\/trpc\//.test(r.url()) && /getById/.test(decodeURIComponent(r.url())),
    { timeout: 10000 },
  ).then(() => true).catch(() => false);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  const refetched = await refetch;
  await page.waitForTimeout(1500);
  const after = await persona.inputValue();
  ok("#10 getById actually refetched (test is meaningful)", refetched, `refetch observed=${refetched}`);
  ok("#10 persona edit SURVIVES the refetch (no clobber)", after.includes(marker),
     refetched ? "marker retained after refetch" : "WARNING: refetch not observed — inconclusive");
  await page.screenshot({ path: `${SHOT}/qa-10-clobber.png` });

  // Discard everything (never saved).
  await page.goto(`${BASE}/agents`, { waitUntil: "networkidle" });
} catch (err) {
  ok("Execution completed without fatal error", false, String(err).split("\n")[0]);
  await page.screenshot({ path: `${SHOT}/qa-error.png` }).catch(() => {});
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n===== ${results.length - failed}/${results.length} checks passed =====`);
  process.exit(failed > 0 ? 1 : 0);
}
