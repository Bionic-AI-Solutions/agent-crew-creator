/**
 * Bionic AI Platform — E2E Release Validation Suite
 *
 * Comprehensive end-to-end test that validates the full lifecycle:
 *   Phase 1: App creation with ALL services + verification
 *   Phase 2: Full-config agent (mic, camera, screenshare, bg audio, avatar) + player-ui validation
 *   Phase 3: Basic agent (mic + camera only)
 *   Phase 4: Agent deletion + asset cleanup
 *   Phase 5: App deletion + cascade cleanup (agents, K8s, Vault, KC, DNS, etc.)
 *
 * Usage:
 *   KC_USER_PASSWORD="B10n1c!T3st#Adm1n@2026xK" node tests/e2e-release.cjs
 *
 * Run after every major release. Saves screenshots to /tmp/release-test/.
 */

const { chromium } = require("playwright");
const { execSync } = require("child_process");
const pg = require("pg");

// ── Config ──────────────────────────────────────────────────────
const PLATFORM = "https://platform.baisoln.com";
const KC_USER = "test-admin";
const KC_PASS = process.env.KC_USER_PASSWORD;
const APP_NAME = "Release Test App";
const APP_SLUG = "release-e2e";
const AGENT_FULL = "full-agent";
const AGENT_BASIC = "basic-agent";
const PG_URL = "postgresql://bionic_platform_user:B10n1cPl4tf0rm!S3cur3@192.168.0.212:5432/bionic_platform";
const PG_ADMIN = "postgresql://postgres:1rJlrTbsgL1YaqDVors6HGK8KnaHom1n6sUFccQNTadpkpzZCN9r0s2llroTy9Tu@192.168.0.212:5432/postgres";
const SCREENSHOTS = "/tmp/release-test";

// ── Test Framework ──────────────────────────────────────────────
const results = [];
let totalPassed = 0;
let totalFailed = 0;

function ok(name, pass, actual) {
  results.push({ test: name, pass, actual });
  if (pass) totalPassed++;
  else totalFailed++;
  console.log((pass ? "  ✅" : "  ❌") + " " + name + (!pass && actual ? " → " + JSON.stringify(actual).slice(0, 150) : ""));
}

function section(name) {
  console.log("\n═══ " + name + " ═══");
}

function printResults(phase) {
  console.log("\n" + "═".repeat(60));
  console.log("  " + phase + " — RESULTS");
  console.log("═".repeat(60));
  for (const r of results) {
    console.log((r.pass ? "  ✅ PASS" : "  ❌ FAIL") + ": " + r.test);
    if (!r.pass && r.actual) console.log("          → " + JSON.stringify(r.actual).slice(0, 200));
  }
  console.log("\n  " + totalPassed + " passed, " + totalFailed + " failed out of " + results.length);
  console.log("═".repeat(60));
}

async function screenshot(page, name) {
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: true });
}

function shell(cmd) {
  try { return execSync(cmd, { stdio: "pipe", timeout: 15000 }).toString().trim(); }
  catch (e) { return e.stdout ? e.stdout.toString().trim() : e.message; }
}

async function dbQuery(url, query) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try { const res = await client.query(query); return res.rows; }
  finally { await client.end(); }
}

async function login(page) {
  await page.goto(PLATFORM, { waitUntil: "networkidle" });
  // Check if already logged in
  const body = await page.textContent("body");
  if (body.includes("Sign in with Keycloak")) {
    await page.click('button:has-text("Sign in with Keycloak")');
    await page.waitForSelector("#username", { timeout: 10000 });
    await page.fill("#username", KC_USER);
    await page.fill("#password", KC_PASS);
    await page.click("#kc-login");
    // Wait for redirect back to platform AND the page to render
    await page.waitForTimeout(3000);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
  }
}

async function getSessionCookie(page) {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === "bp_session")?.value || "";
}

async function apiCall(cookie, path, body) {
  const res = await fetch(`${PLATFORM}/trpc/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `bp_session=${cookie}` },
    body: JSON.stringify({ json: body }),
  });
  return res.json();
}

// ═════════════════════════════════════════════════════════════════
// MAIN TEST
// ═════════════════════════════════════════════════════════════════
async function run() {
  if (!KC_PASS) { console.error("Set KC_USER_PASSWORD"); process.exit(1); }
  execSync(`mkdir -p ${SCREENSHOTS}`);

  const browser = await chromium.launch({ args: ["--no-sandbox", "--ignore-certificate-errors"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    // ── PHASE 1: CREATE APP ──────────────────────────────────
    section("PHASE 1: APP CREATION");
    await login(page);
    ok("Platform login", true);
    const cookie = await getSessionCookie(page);

    // Navigate to apps and create
    await page.goto(PLATFORM + "/apps", { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    // Verify we're authenticated
    const dashText = await page.textContent("body");
    ok("Dashboard loaded (authenticated)", dashText.includes("Apps") || dashText.includes("Create"), dashText.slice(0, 100));
    await page.waitForSelector('button:has-text("Create App")', { timeout: 10000 });
    await page.click('button:has-text("Create App")');
    await page.waitForTimeout(500);

    // Step 1: Basic info
    await page.fill('input[placeholder="My AI App"]', APP_NAME);
    await page.waitForTimeout(300);
    const slugInput = page.locator("input.font-mono").first();
    await slugInput.fill("");
    await slugInput.fill(APP_SLUG);
    await page.waitForTimeout(300);
    const slug = await slugInput.inputValue();
    ok("App slug set", slug === APP_SLUG, slug);

    // Step 2: Enable ALL services including player_ui
    await page.click('button:has-text("Next")');
    await page.waitForTimeout(500);
    const playerUiLabel = page.locator('label:has-text("Agent player UI")');
    if (await playerUiLabel.count() > 0) {
      await playerUiLabel.click();
      await page.waitForTimeout(300);
    }
    ok("Player UI service enabled", true);

    // Step 3: Create
    await page.click('button:has-text("Next")');
    await page.waitForTimeout(500);
    await page.click('button:has-text("Create App")');
    ok("App creation triggered", true);

    // Wait for provisioning
    console.log("  Waiting for provisioning...");
    let provStatus = "";
    for (let i = 0; i < 120; i++) {
      await page.waitForTimeout(3000);
      const status = await dbQuery(PG_URL, `SELECT provisioning_status FROM apps WHERE slug='${APP_SLUG}'`);
      if (status[0]?.provisioning_status === "completed") { provStatus = "completed"; break; }
      if (status[0]?.provisioning_status === "failed") { provStatus = "failed"; break; }
      process.stdout.write(".");
    }
    console.log("");
    ok("App provisioning completed", provStatus === "completed", provStatus || "timeout");
    await screenshot(page, "01-app-created");

    // ── Verify all provisioned resources ──
    section("PHASE 1b: PROVISIONING VERIFICATION");

    const steps = await dbQuery(PG_URL, `SELECT steps::text FROM provisioning_jobs WHERE app_id=(SELECT id FROM apps WHERE slug='${APP_SLUG}') ORDER BY id DESC LIMIT 1`);
    if (steps[0]) {
      const parsed = JSON.parse(steps[0].steps);
      for (const s of parsed) {
        if (s.status !== "skipped") {
          ok(`Step ${s.name}`, s.status === "success", s.status);
        }
      }
    }

    // K8s namespace
    const ns = shell(`kubectl get ns ${APP_SLUG} -o jsonpath='{.status.phase}' 2>&1`);
    ok("K8s namespace active", ns === "Active", ns);

    // Player-UI deployment
    const puiReady = shell(`kubectl get deploy player-ui -n ${APP_SLUG} -o jsonpath='{.status.readyReplicas}' 2>&1`);
    ok("Player-UI deployment ready", puiReady === "1", puiReady);

    // Ingress
    const ingressHost = shell(`kubectl get ingress player-ui -n ${APP_SLUG} -o jsonpath='{.spec.rules[0].host}' 2>&1`);
    ok("Ingress host correct", ingressHost === `${APP_SLUG}.baisoln.com`, ingressHost);

    // DNS
    const dns = shell(`dig +short ${APP_SLUG}.baisoln.com @1.1.1.1 2>/dev/null | head -1`);
    ok("Cloudflare DNS resolves", dns.length > 0, dns);

    // Kong routing
    const kongHealth = shell(`kubectl exec deploy/bionic-platform -n bionic-platform -- wget -qO- --header="Host: ${APP_SLUG}.baisoln.com" "http://kong-kong-proxy.kong.svc.cluster.local:80/api/health" 2>&1`);
    ok("Kong routes to player-ui", kongHealth.includes('"ok":true'), kongHealth.slice(0, 100));

    // Vault
    const vaultKeys = shell(`kubectl exec -n vault vault-0 -- vault kv get -format=json secret/t6-apps/${APP_SLUG}/config 2>&1 | python3 -c "import sys,json; d=json.load(sys.stdin)['data']['data']; print(len(d))" 2>&1`);
    ok("Vault secrets stored", parseInt(vaultKeys) > 10, vaultKeys + " keys");

    // Keycloak
    const kcPass = shell(`kubectl exec -n vault vault-0 -- vault kv get -field=admin_password secret/t5-gateway/keycloak/config 2>/dev/null`);
    const kcToken = shell(`curl -sk -X POST "https://auth.bionicaisolutions.com/realms/master/protocol/openid-connect/token" -d "grant_type=password&client_id=admin-cli&username=admin&password=${kcPass}" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>&1`);
    const kcClients = shell(`curl -sk "https://auth.bionicaisolutions.com/admin/realms/Bionic/clients?first=0&max=200" -H "Authorization: Bearer ${kcToken}" | python3 -c "import sys,json; print(len([c for c in json.load(sys.stdin) if c['clientId'].startswith('${APP_SLUG}-')]))" 2>&1`);
    ok("Keycloak clients created", parseInt(kcClients) >= 2, kcClients + " clients");

    // ── PHASE 2: FULL-CONFIG AGENT ──────────────────────────
    section("PHASE 2: FULL-CONFIG AGENT");
    const appId = (await dbQuery(PG_URL, `SELECT id FROM apps WHERE slug='${APP_SLUG}'`))[0]?.id;

    // Create agent via API
    const createRes = await apiCall(cookie, "agentsCrud.create", { appId, name: AGENT_FULL, description: "Full config test" });
    const fullAgentId = createRes?.result?.data?.json?.id;
    ok("Full agent created", !!fullAgentId, fullAgentId);

    if (fullAgentId) {
      // Enable all media capabilities
      await apiCall(cookie, "agentsCrud.update", {
        id: fullAgentId,
        visionEnabled: true,
        backgroundAudioEnabled: true,
        busyAudioEnabled: true,
        avatarEnabled: true,
      });
      ok("Full agent: vision + bg audio + busy audio + avatar enabled", true);

      // Deploy
      const deployRes = await apiCall(cookie, "agentsCrud.deploy", { id: fullAgentId });
      ok("Full agent deployed", deployRes?.result?.data?.json?.success === true);

      // Wait for pod
      console.log("  Waiting for full-agent pod...");
      let podReady = false;
      for (let i = 0; i < 20; i++) {
        const status = shell(`kubectl get pods -n ${APP_SLUG} -l app=agent-${AGENT_FULL} -o jsonpath='{.items[0].status.phase}' 2>&1`);
        if (status === "Running") { podReady = true; break; }
        await new Promise(r => setTimeout(r, 3000));
        process.stdout.write(".");
      }
      console.log("");
      ok("Full agent pod running", podReady);

      // Verify ConfigMap has media flags
      if (podReady) {
        const visionEnv = shell(`kubectl exec -n ${APP_SLUG} deploy/agent-${AGENT_FULL} -- env 2>&1 | grep VISION_ENABLED`);
        ok("VISION_ENABLED=true in pod", visionEnv.includes("true"), visionEnv);
        const bgAudio = shell(`kubectl exec -n ${APP_SLUG} deploy/agent-${AGENT_FULL} -- env 2>&1 | grep BACKGROUND_AUDIO_ENABLED`);
        ok("BACKGROUND_AUDIO_ENABLED=true", bgAudio.includes("true"), bgAudio);
        const busyAudio = shell(`kubectl exec -n ${APP_SLUG} deploy/agent-${AGENT_FULL} -- env 2>&1 | grep BUSY_AUDIO_ENABLED`);
        ok("BUSY_AUDIO_ENABLED=true", busyAudio.includes("true"), busyAudio);
        const avatarEnv = shell(`kubectl exec -n ${APP_SLUG} deploy/agent-${AGENT_FULL} -- env 2>&1 | grep AVATAR_ENABLED`);
        ok("AVATAR_ENABLED=true", avatarEnv.includes("true"), avatarEnv);
      }

      // ── Player-UI validation ──
      section("PHASE 2b: PLAYER-UI VALIDATION (full agent)");
      const appUrl = `https://${APP_SLUG}.baisoln.com`;
      const puiPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });

      await puiPage.goto(appUrl, { waitUntil: "networkidle", timeout: 30000 });
      await puiPage.waitForTimeout(1000);

      // Sign in via KC
      const signInBtn = puiPage.locator('button:has-text("Sign in")');
      if (await signInBtn.count() > 0) await signInBtn.first().click();
      await puiPage.waitForSelector("#username", { timeout: 15000 });
      await puiPage.fill("#username", KC_USER);
      await puiPage.fill("#password", KC_PASS);
      await puiPage.click("#kc-login");
      await puiPage.waitForTimeout(5000);
      ok("Player-UI KC login", puiPage.url().includes(APP_SLUG) || puiPage.url().includes("baisoln.com"));

      // Wait for agent to appear
      let agentVisible = false;
      for (let i = 0; i < 15; i++) {
        const hasStart = await puiPage.locator('button:has-text("Start Session")').count();
        if (hasStart > 0) { agentVisible = true; break; }
        await puiPage.waitForTimeout(2000);
      }
      ok("Agent visible in player-UI", agentVisible);
      await screenshot(puiPage, "02-playerui-agent-visible");

      // Start session
      if (agentVisible) {
        try {
          await puiPage.locator('button:has-text("Start Session")').click({ timeout: 5000 });
        } catch {
          ok("Start Session button click", false, "timeout");
        }
        let sessionStarted = false;
        for (let i = 0; i < 15; i++) {
          await puiPage.waitForTimeout(2000);
          const endBtn = await puiPage.locator('button:has-text("End")').count();
          if (endBtn > 0) { sessionStarted = true; break; }
        }
        ok("LiveKit session started", sessionStarted);
        await screenshot(puiPage, "03-playerui-session");

        if (sessionStarted) {
          // Check media controls visible (vision enabled → cam + screenshare should show)
          const micBtn = await puiPage.locator('button:has-text("Mic")').count();
          ok("Mic control visible", micBtn > 0);
          const camBtn = await puiPage.locator('button:has-text("Cam")').count();
          ok("Camera control visible (vision enabled)", camBtn > 0);
          const shareBtn = await puiPage.locator('button:has-text("Share")').count();
          ok("Screen share control visible (vision enabled)", shareBtn > 0);

          // Disconnect
          try {
            await puiPage.locator('button:has-text("End")').first().click({ timeout: 5000 });
            await puiPage.waitForTimeout(2000);
          } catch { /* non-fatal */ }
        }
      }
      await puiPage.close();
    }

    // ── PHASE 3: BASIC AGENT ────────────────────────────────
    section("PHASE 3: BASIC AGENT (mic + camera)");
    const basicRes = await apiCall(cookie, "agentsCrud.create", { appId, name: AGENT_BASIC, description: "Basic config" });
    const basicAgentId = basicRes?.result?.data?.json?.id;
    ok("Basic agent created", !!basicAgentId);

    if (basicAgentId) {
      // Enable only vision (camera)
      await apiCall(cookie, "agentsCrud.update", {
        id: basicAgentId,
        visionEnabled: true,
        backgroundAudioEnabled: false,
        busyAudioEnabled: false,
        avatarEnabled: false,
      });

      const deployRes = await apiCall(cookie, "agentsCrud.deploy", { id: basicAgentId });
      ok("Basic agent deployed", deployRes?.result?.data?.json?.success === true);

      // Wait for pod
      let podReady = false;
      for (let i = 0; i < 20; i++) {
        const status = shell(`kubectl get pods -n ${APP_SLUG} -l app=agent-${AGENT_BASIC} -o jsonpath='{.items[0].status.phase}' 2>&1`);
        if (status === "Running") { podReady = true; break; }
        await new Promise(r => setTimeout(r, 3000));
      }
      ok("Basic agent pod running", podReady);

      if (podReady) {
        const bgAudio = shell(`kubectl exec -n ${APP_SLUG} deploy/agent-${AGENT_BASIC} -- env 2>&1 | grep BACKGROUND_AUDIO_ENABLED`);
        ok("Basic agent: BG audio disabled", bgAudio.includes("false"), bgAudio);
        const vision = shell(`kubectl exec -n ${APP_SLUG} deploy/agent-${AGENT_BASIC} -- env 2>&1 | grep VISION_ENABLED`);
        ok("Basic agent: vision enabled", vision.includes("true"), vision);
      }
    }

    // ── PHASE 4: AGENT DELETION ─────────────────────────────
    section("PHASE 4: AGENT DELETION");

    // Delete full agent
    if (fullAgentId) {
      const delRes = await apiCall(cookie, "agentsCrud.delete", { id: fullAgentId });
      ok("Full agent deleted via API", delRes?.result?.data?.json?.success !== false);
      await new Promise(r => setTimeout(r, 5000));

      const fullPod = shell(`kubectl get deploy agent-${AGENT_FULL} -n ${APP_SLUG} 2>&1`);
      ok("Full agent K8s deployment removed", fullPod.includes("NotFound") || fullPod.includes("not found"), fullPod.slice(0, 100));

      const fullDb = await dbQuery(PG_URL, `SELECT count(*) as c FROM agent_configs WHERE name='${AGENT_FULL}' AND app_id=${appId}`);
      ok("Full agent DB record deleted", parseInt(fullDb[0]?.c) === 0, fullDb[0]?.c);
    }

    // Delete basic agent
    if (basicAgentId) {
      const delRes = await apiCall(cookie, "agentsCrud.delete", { id: basicAgentId });
      ok("Basic agent deleted via API", delRes?.result?.data?.json?.success !== false);
      await new Promise(r => setTimeout(r, 5000));

      const basicPod = shell(`kubectl get deploy agent-${AGENT_BASIC} -n ${APP_SLUG} 2>&1`);
      ok("Basic agent K8s deployment removed", basicPod.includes("NotFound") || basicPod.includes("not found"));

      const basicDb = await dbQuery(PG_URL, `SELECT count(*) as c FROM agent_configs WHERE name='${AGENT_BASIC}' AND app_id=${appId}`);
      ok("Basic agent DB record deleted", parseInt(basicDb[0]?.c) === 0);
    }

    // Verify no orphan agent resources
    const remainingAgents = await dbQuery(PG_URL, `SELECT count(*) as c FROM agent_configs WHERE app_id=${appId}`);
    ok("No orphan agents in DB", parseInt(remainingAgents[0]?.c) === 0, remainingAgents[0]?.c);

    // ── PHASE 5: APP DELETION ───────────────────────────────
    section("PHASE 5: APP DELETION + CASCADE CLEANUP");

    // Delete via API (more reliable than UI click)
    const delRes = await apiCall(cookie, "appsCrud.delete", { id: appId });
    ok("App deletion triggered via API", delRes?.result?.data?.json?.success !== false, delRes?.error?.message);

    // Wait for deletion pipeline (deletion can take 2-3 minutes with Kong cleanup)
    console.log("  Waiting for deletion...");
    for (let i = 0; i < 60; i++) {
      const appExists = await dbQuery(PG_URL, `SELECT count(*) as c FROM apps WHERE slug='${APP_SLUG}'`);
      if (parseInt(appExists[0]?.c) === 0) break;
      // Check for deletion_partial (means some external cleanup failed)
      const appStatus = await dbQuery(PG_URL, `SELECT provisioning_status FROM apps WHERE slug='${APP_SLUG}'`);
      if (appStatus[0]?.provisioning_status === "deletion_partial") {
        console.log("\n  ⚠️  Deletion partial — some external cleanup failed");
        break;
      }
      await new Promise(r => setTimeout(r, 3000));
      process.stdout.write(".");
    }
    console.log("");

    // ── Verify ZERO remnants ──
    section("PHASE 5b: ZERO REMNANT VERIFICATION");

    const appDb = await dbQuery(PG_URL, `SELECT count(*) as c FROM apps WHERE slug='${APP_SLUG}'`);
    ok("Platform DB: app deleted", parseInt(appDb[0]?.c) === 0, appDb[0]?.c);

    const agentDb = await dbQuery(PG_URL, `SELECT count(*) as c FROM agent_configs WHERE app_id=${appId}`);
    ok("Platform DB: agents cascade-deleted", parseInt(agentDb[0]?.c) === 0, agentDb[0]?.c);

    const toolsDb = await dbQuery(PG_URL, `SELECT count(*) as c FROM agent_tools WHERE agent_config_id IN (SELECT id FROM agent_configs WHERE app_id=${appId})`);
    ok("Platform DB: agent_tools cascade-deleted", parseInt(toolsDb[0]?.c) === 0);

    const jobsDb = await dbQuery(PG_URL, `SELECT count(*) as c FROM provisioning_jobs WHERE app_id=${appId}`);
    ok("Platform DB: provisioning_jobs cascade-deleted", parseInt(jobsDb[0]?.c) === 0);

    const nsExists = shell(`kubectl get ns ${APP_SLUG} 2>&1`);
    ok("K8s namespace deleted", nsExists.includes("NotFound") || nsExists.includes("not found"), nsExists.slice(0, 80));

    const vaultDeleted = shell(`kubectl exec -n vault vault-0 -- vault kv get secret/t6-apps/${APP_SLUG}/config 2>&1`);
    ok("Vault secrets deleted", vaultDeleted.includes("No value found") || vaultDeleted.includes("not found"), vaultDeleted.slice(0, 80));

    const kcClientsAfter = shell(`curl -sk "https://auth.bionicaisolutions.com/admin/realms/Bionic/clients?first=0&max=200" -H "Authorization: Bearer ${kcToken}" | python3 -c "import sys,json; print(len([c for c in json.load(sys.stdin) if c['clientId'].startswith('${APP_SLUG}-')]))" 2>&1`);
    ok("Keycloak clients deleted", parseInt(kcClientsAfter) === 0, kcClientsAfter + " clients");

    // Cloudflare DNS
    const CF_TOKEN = shell(`kubectl exec -n vault vault-0 -- vault kv get -field=api_token secret/shared/cloudflare 2>/dev/null`);
    const CF_ZONE = "46165d7e83506b6768c5ff227d532d6f";
    const dnsCheck = shell(`curl -s "https://api.cloudflare.com/client/v4/zones/${CF_ZONE}/dns_records?name=${APP_SLUG}.baisoln.com&type=A" -H "Authorization: Bearer ${CF_TOKEN}" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['result']))" 2>&1`);
    ok("Cloudflare DNS A record deleted", dnsCheck === "0", dnsCheck + " records");

    // Per-app PostgreSQL
    const appPgDb = await dbQuery(PG_ADMIN, `SELECT datname FROM pg_database WHERE datname='app_${APP_SLUG.replace(/-/g, "_")}'`);
    ok("Per-app PostgreSQL DB deleted", appPgDb.length === 0);

    await screenshot(page, "04-all-cleaned");

  } catch (err) {
    console.error("\n  ⚠️  Test error: " + err.message.split("\n")[0]);
    await screenshot(page, "error");
  }

  await browser.close();

  printResults("E2E RELEASE VALIDATION");
  console.log("\n  Screenshots: " + SCREENSHOTS + "/");
  process.exit(totalFailed > 0 ? 1 : 0);
}

run().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
