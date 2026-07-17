/**
 * Headed Playwright verification of finding #5: /api/agents/:id/documents now
 * authorizes on APP MEMBERSHIP instead of global-admin role. Before the fix,
 * any non-global-admin (including legitimate app members/owners) got 401.
 *
 * Logs in as qa.user (platformRole "user" — NOT admin, so the admin bypass does
 * not apply), then drives the real endpoint via page.request (shares the session
 * cookie) to prove BOTH decisions:
 *   - member of an app  → upload accepted (HTTP 200)   [the fix]
 *   - non-member        → rejected (HTTP 403)          [gate still enforced]
 *
 * Read-only-ish: the one accepted upload is deleted afterward (docId printed).
 *
 * Run: QA_USER=... QA_PASS=... xvfb-run -a node tests/qa-doc-upload.spec.mjs
 */
import { chromium } from "playwright";

const BASE = "https://platform.baisoln.com";
const QA_USER = process.env.QA_USER;
const QA_PASS = process.env.QA_PASS;

// Ground truth from the platform DB (app_members / agent_configs).
const MEMBERS = {
  6: ["82aecbc6-e30a-4baf-8ccb-9ef5691c576c", "6e36c6cd-b9be-40be-8171-767a46f82327"], // guruji
  33: ["9ebcf9e8-de6b-45ef-989d-e128e5312931"], // tutor
  41: ["6e36c6cd-b9be-40be-8171-767a46f82327"], // jarvis
};
const AGENTS = { 6: [13, 30], 33: [27, 31, 32], 41: [34, 35, 36] };

const results = [];
const ok = (n, c, d = "") => { results.push({ n, c: !!c }); console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const info = (m) => console.log(`INFO  ${m}`);

const txt = () => ({ name: `qa-doc-upload-${Date.now()}.txt`, mimeType: "text/plain", buffer: Buffer.from("QA #5 membership-upload check.\n") });
let createdDocId = null;

const browser = await chromium.launch({ headless: false });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();

try {
  // ── Login as qa.user ───────────────────────────────────────────
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Sign in with Keycloak/i }).click();
  await page.waitForSelector("#username", { timeout: 20000 });
  await page.fill("#username", QA_USER);
  await page.fill("#password", QA_PASS);
  await page.click("#kc-login");
  await page.waitForURL(/platform\.baisoln\.com/, { timeout: 25000 });
  await page.waitForLoadState("networkidle");
  ok("Login as qa.user via Keycloak PKCE", /platform\.baisoln\.com/.test(page.url()) && !/auth\./.test(page.url()));

  // ── Identity + role ────────────────────────────────────────────
  const meResp = await page.request.get(`${BASE}/api/auth/me`);
  const me = (await meResp.json())?.user ?? {};
  const sub = me.sub;
  info(`qa.user sub=${sub} role=${me.role} platformRole=${me.platformRole}`);
  ok("qa.user resolves as NON-admin (exercises membership path, not admin bypass)", me.role !== "admin", `role=${me.role}`);

  // ── Classify apps for this sub ─────────────────────────────────
  const memberAppIds = Object.keys(MEMBERS).filter((a) => MEMBERS[a].includes(sub)).map(Number);
  const nonMemberAppIds = Object.keys(AGENTS).filter((a) => !MEMBERS[a]?.includes(sub)).map(Number);
  info(`member of apps: ${JSON.stringify(memberAppIds)} | non-member of: ${JSON.stringify(nonMemberAppIds)}`);

  // ── POSITIVE: member can upload (the fix) ──────────────────────
  if (memberAppIds.length) {
    const agentId = AGENTS[memberAppIds[0]][0];
    const r = await page.request.post(`${BASE}/api/agents/${agentId}/documents`, { multipart: { file: txt() } });
    const status = r.status();
    let bodyId = null;
    try { bodyId = (await r.json())?.id; } catch { /* */ }
    createdDocId = bodyId;
    info(`member upload → agent ${agentId} (app ${memberAppIds[0]}) → HTTP ${status}, docId=${bodyId}`);
    ok("#5 non-admin MEMBER upload is ACCEPTED (was 401 before the fix)", status >= 200 && status < 300, `HTTP ${status}`);
  } else {
    ok("qa.user is a member of at least one app (needed to prove the positive case)", false, `sub ${sub} not in any app_members — grant membership to verify positive path`);
  }

  // ── NEGATIVE: non-member is rejected ───────────────────────────
  if (nonMemberAppIds.length) {
    const agentId = AGENTS[nonMemberAppIds[0]][0];
    const r = await page.request.post(`${BASE}/api/agents/${agentId}/documents`, { multipart: { file: txt() } });
    const status = r.status();
    let body = ""; try { body = await r.text(); } catch { /* */ }
    info(`non-member upload → agent ${agentId} (app ${nonMemberAppIds[0]}) → HTTP ${status} body=${body}`);
    ok("#5 NON-member upload is REJECTED with 403", status === 403, `HTTP ${status}`);
    // Fingerprint of the DEPLOYED fix: old code returned 401 "Unauthorized" for
    // any non-admin; new code returns 403 "Not a member of this app".
    ok("#5 deployed endpoint uses the NEW membership gate (403 + member message)", status === 403 && /member of this app/i.test(body), body);
  } else {
    info("qa.user is a member of every app; skipping non-member check.");
  }
} catch (err) {
  ok("Execution completed without fatal error", false, String(err).split("\n")[0]);
} finally {
  await browser.close();
  if (createdDocId) console.log(`CLEANUP_DOC_ID=${createdDocId}`);
  const failed = results.filter((r) => !r.c).length;
  console.log(`\n===== ${results.length - failed}/${results.length} checks passed =====`);
  process.exit(failed > 0 ? 1 : 0);
}
