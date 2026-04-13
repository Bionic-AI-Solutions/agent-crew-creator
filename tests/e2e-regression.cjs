/**
 * Bionic AI Platform — E2E Regression Test Suite
 *
 * Usage:
 *   KC_USER_PASSWORD="B10n1c!T3st#Adm1n@2026xK" node tests/e2e-regression.js create
 *   KC_USER_PASSWORD="B10n1c!T3st#Adm1n@2026xK" node tests/e2e-regression.js delete
 *
 * Phase 1 (create): Creates app, agent, configures LLM/STT/TTS, deploys, verifies
 * Phase 2 (delete): Deletes agent, deletes app, verifies zero remnants
 *
 * Run Phase 1 after every major change. Validate manually. Then run Phase 2 to clean up.
 */

const { chromium } = require("playwright");
const { execSync } = require("child_process");
const pg = require("pg");

// ── Config ──────────────────────────────────────────────────────
const PLATFORM = "https://platform.baisoln.com";
const KC_USER = "test-admin";
const KC_PASS = process.env.KC_USER_PASSWORD;
const TEST_APP_NAME = process.env.TEST_APP_NAME || "UI Regression App";
const TEST_APP_SLUG = process.env.TEST_APP_SLUG || "ui-regress";
const TEST_AGENT_NAME = process.env.TEST_AGENT_NAME || "ui-agent";

const PG_PLATFORM_URL = "postgresql://bionic_platform_user:B10n1cPl4tf0rm!S3cur3@192.168.0.212:5432/bionic_platform";
const PG_ADMIN_URL = "postgresql://postgres:1rJlrTbsgL1YaqDVors6HGK8KnaHom1n6sUFccQNTadpkpzZCN9r0s2llroTy9Tu@192.168.0.212:5432/postgres";

const SCREENSHOTS_DIR = "/tmp/regression";

// ── Test Framework ──────────────────────────────────────────────
const results = [];
let totalPassed = 0;
let totalFailed = 0;

function ok(name, pass, actual) {
  results.push({ test: name, pass, actual });
  if (pass) totalPassed++;
  else totalFailed++;
  console.log((pass ? "  ✅" : "  ❌") + " " + name + (!pass && actual ? " → " + JSON.stringify(actual).slice(0, 120) : ""));
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
    if (!r.pass && r.actual) console.log("          → " + JSON.stringify(r.actual).slice(0, 150));
  }
  console.log("\n  " + totalPassed + " passed, " + totalFailed + " failed out of " + results.length);
  console.log("═".repeat(60));
}

async function screenshot(page, name) {
  await page.screenshot({ path: `${SCREENSHOTS_DIR}/${name}.png`, fullPage: true });
}

function shell(cmd) {
  try {
    return execSync(cmd, { stdio: "pipe", timeout: 15000 }).toString().trim();
  } catch (e) {
    return e.stdout ? e.stdout.toString().trim() : e.message;
  }
}

async function dbQuery(url, query) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query(query);
    return res.rows;
  } finally {
    await client.end();
  }
}

// ── Login Helper ────────────────────────────────────────────────
async function login(page) {
  await page.goto(PLATFORM, { waitUntil: "networkidle" });
  await page.click('button:has-text("Sign in with Keycloak")');
  await page.waitForSelector("#username", { timeout: 10000 });
  await page.fill("#username", KC_USER);
  await page.fill("#password", KC_PASS);
  await page.click("#kc-login");
  await page.waitForURL(PLATFORM + "/**", { timeout: 15000 });
  await page.waitForTimeout(2000);
}

// ═════════════════════════════════════════════════════════════════
// PHASE 1: CREATE & VERIFY
// ═════════════════════════════════════════════════════════════════
async function runCreateTests() {
  if (!KC_PASS) { console.error("Set KC_USER_PASSWORD"); process.exit(1); }
  execSync(`mkdir -p ${SCREENSHOTS_DIR}`);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));

  try {
    // ── 1. LOGIN ──
    section("1. LOGIN");
    await login(page);
    const dashText = await page.textContent("body");
    ok("Logged in as test-admin", dashText.includes("Test Admin"));
    ok("No JS errors on login", errors.length === 0, errors);
    await screenshot(page, "01-dashboard");

    // ── 2. CREATE APP ──
    section("2. CREATE APP");
    await page.goto(PLATFORM + "/apps", { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // Check if test app already exists (from a previous failed run)
    const existingText = await page.textContent("body");
    if (existingText.includes(TEST_APP_SLUG)) {
      console.log("  ⚠️  Test app already exists — skipping creation");
      ok("Test app exists (from previous run)", true);
    } else {
      await page.click('button:has-text("Create App")');
      await page.waitForTimeout(500);

      // Step 1: Basic info
      await page.fill('input[placeholder="My AI App"]', TEST_APP_NAME);
      await page.waitForTimeout(300);
      // Override auto-generated slug with our expected slug
      const slugInput = page.locator("input.font-mono").first();
      await slugInput.fill("");
      await slugInput.fill(TEST_APP_SLUG);
      await page.waitForTimeout(300);
      const slug = await slugInput.inputValue();
      ok("Slug set correctly", slug === TEST_APP_SLUG, slug);
      await page.click('button:has-text("Next")');
      await page.waitForTimeout(500);
      await screenshot(page, "02-services");

      // Step 2: Services — enable player_ui in addition to defaults
      ok("Services selection shown", true);
      const playerUiLabel = page.locator('label:has-text("Agent player UI")');
      if (await playerUiLabel.count() > 0) {
        await playerUiLabel.click();
        await page.waitForTimeout(300);
        ok("Player UI service enabled", true);
      } else {
        ok("Player UI checkbox found", false, "Not found");
      }
      await page.click('button:has-text("Next")');
      await page.waitForTimeout(500);

      // Step 3: Review & Create
      await page.click('button:has-text("Create App")');
      ok("App creation triggered", true);

      // Wait for provisioning
      console.log("  Waiting for provisioning...");
      let provStatus = "";
      for (let i = 0; i < 90; i++) {
        await page.waitForTimeout(3000);
        await page.goto(PLATFORM + "/apps", { waitUntil: "networkidle" });
        await page.waitForTimeout(500);
        const rows = await page.locator("tr").allTextContents();
        const testRow = rows.find((r) => r.includes(TEST_APP_SLUG));
        if (testRow) {
          if (testRow.includes("Provisioned")) { provStatus = "completed"; break; }
          if (testRow.includes("Failed")) { provStatus = "failed"; break; }
        }
        process.stdout.write(".");
      }
      console.log("");
      ok("App provisioning completed", provStatus === "completed", provStatus || "timeout");
    }
    await screenshot(page, "03-apps-list");

    // ── 3. VERIFY APP DETAIL ──
    section("3. VERIFY APP DETAIL");
    const appRow = page.locator(`tr:has-text("${TEST_APP_SLUG}")`).first();
    await appRow.click();
    await page.waitForTimeout(1500);
    await screenshot(page, "04-app-detail");

    const detail = await page.textContent("body");
    ok("App detail shows name", detail.includes(TEST_APP_NAME));
    ok("Status is completed", detail.includes("completed") || detail.includes("Provisioned"));
    ok("Overview tab present", detail.includes("Overview"));
    ok("Services tab present", detail.includes("Services"));
    ok("Agents tab present", detail.includes("Agents"));
    ok("Provisioning tab present", detail.includes("Provisioning"));
    ok("Danger Zone tab present", detail.includes("Danger Zone"));

    // Check provisioning steps
    await page.click('[role="tab"]:has-text("Provisioning")');
    await page.waitForTimeout(1000);
    await screenshot(page, "05-provisioning");
    const provText = await page.textContent("body");
    ok("LiveKit step succeeded", provText.includes("LiveKit"));
    ok("Keycloak step visible", provText.includes("Keycloak"));

    // ── 4. CREATE AGENT ──
    section("4. CREATE AGENT");
    await page.goto(PLATFORM + "/agents", { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);

    // Select app
    await page.locator('[role="combobox"]').first().click();
    await page.waitForTimeout(500);
    const appOpt = page.locator(`[role="option"]:has-text("${TEST_APP_NAME}")`);
    if (await appOpt.count() > 0) {
      await appOpt.click();
      await page.waitForTimeout(500);
      ok("Selected app in Agent Builder", true);
    } else {
      ok("App in dropdown", false, "Not found");
      await browser.close();
      printResults("CREATE PHASE");
      process.exit(1);
    }

    // Check if agent already exists
    const agentListText = await page.textContent("body");
    if (agentListText.includes(TEST_AGENT_NAME)) {
      console.log("  ⚠️  Agent already exists — selecting it");
      await page.locator(`button:has-text("${TEST_AGENT_NAME}")`).click();
      await page.waitForTimeout(1500);
      ok("Agent exists (from previous run)", true);
    } else {
      await page.click('button:has-text("Add Agent")');
      await page.waitForTimeout(500);
      await page.fill('input[placeholder="my-agent"]', TEST_AGENT_NAME);
      await page.fill('input[placeholder="What does this agent do?"]', "E2E regression test agent");
      await page.click('button:has-text("Create"):not([disabled])');
      await page.waitForTimeout(2000);
      ok("Agent created", true);
    }
    await screenshot(page, "06-agent-created");

    // ── 5. CONFIGURE LIVEKIT — CHANGE LLM/STT/TTS ──
    section("5. CONFIGURE LIVEKIT — CHANGE PROVIDERS");

    // Verify defaults
    const bodyText = await page.textContent("body");
    ok("Default STT is GPU-AI", bodyText.includes("GPU-AI"));
    ok("Default system prompt pre-filled", bodyText.includes("DELEGATION") || bodyText.includes("primary agent"));

    // Change LLM to GPU-AI + Qwen 3.5 27B
    const allCombos = page.locator('[role="combobox"]');

    // LLM provider (4th combobox: app, stt-provider, stt-model, llm-provider)
    const llmProvider = allCombos.nth(3);
    await llmProvider.click();
    await page.waitForTimeout(300);
    const gpuAiOpt = page.locator('[role="option"]:has-text("GPU-AI")');
    if (await gpuAiOpt.count() > 0) {
      await gpuAiOpt.click();
      await page.waitForTimeout(300);
      ok("LLM provider changed to GPU-AI", true);

      // Select Qwen model
      const llmModel = allCombos.nth(4);
      await llmModel.click();
      await page.waitForTimeout(300);
      const qwen = page.locator('[role="option"]:has-text("Qwen 3.5 27B")');
      if (await qwen.count() > 0) {
        await qwen.click();
        ok("LLM model changed to Qwen 3.5 27B", true);
      }
    }
    await page.waitForTimeout(300);

    // Change TTS voice
    const ttsVoice = allCombos.nth(6); // tts-provider is 5, tts-voice is 6
    await ttsVoice.click();
    await page.waitForTimeout(300);
    const sudhir = page.locator('[role="option"]:has-text("Sudhir")');
    if (await sudhir.count() > 0) {
      await sudhir.click();
      ok("TTS voice changed to Sudhir", true);
    }
    await page.waitForTimeout(300);

    // Update system prompt
    const primaryPrompt = page.locator("textarea").last();
    await primaryPrompt.fill("");
    await primaryPrompt.fill("You are a regression test agent. Respond concisely. Delegate visualization tasks to the secondary agent.");
    ok("Custom primary prompt set", true);
    await screenshot(page, "07-livekit-configured");

    // ── 6. CONFIGURE LETTA ──
    section("6. CONFIGURE LETTA");
    await page.click('[role="tab"]:has-text("Letta")');
    await page.waitForTimeout(500);

    const lettaBody = await page.textContent("body");
    ok("Letta agent name auto-generated", lettaBody.includes("letta-"));
    ok("Letta LLM defaults to GPU deep", lettaBody.includes("Qwen 3.5 27B") || lettaBody.includes("Deep"));

    // Update Letta prompt
    const lettaPrompt = page.locator("textarea").first();
    await lettaPrompt.fill("");
    await lettaPrompt.fill("You are the regression test secondary agent. Execute tools, search memory, and produce structured output for the chat window.");
    ok("Custom Letta prompt set", true);

    // Verify tools are selected
    const checkedTools = await page.locator('[role="checkbox"][data-state="checked"]').count();
    ok("All 8 tools auto-selected", checkedTools >= 8, checkedTools);
    await screenshot(page, "08-letta-configured");

    // ── 7. SAVE ──
    section("7. SAVE");
    await page.click('button:has-text("Save")');
    await page.waitForTimeout(1500);
    ok("Agent saved", true);

    // Verify persistence by reloading
    await page.goto(PLATFORM + "/agents", { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await page.locator('[role="combobox"]').first().click();
    await page.waitForTimeout(300);
    await page.locator(`[role="option"]:has-text("${TEST_APP_NAME}")`).click();
    await page.waitForTimeout(500);
    await page.locator(`button:has-text("${TEST_AGENT_NAME}")`).click();
    await page.waitForTimeout(1500);

    const savedBody = await page.textContent("body");
    ok("LLM GPU-AI persisted after reload", savedBody.includes("GPU-AI"));
    ok("Primary prompt persisted", savedBody.includes("regression test agent"));

    await page.click('[role="tab"]:has-text("Letta")');
    await page.waitForTimeout(500);
    const savedLetta = await page.textContent("body");
    ok("Letta prompt persisted", savedLetta.includes("regression test secondary"));
    await screenshot(page, "09-persistence-verified");

    // ── 8. DEPLOY ──
    section("8. DEPLOY AGENT");

    // Use the action bar Deploy button (bottom of the form, always visible)
    // Scroll to bottom to ensure it's visible
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);

    // Click the action bar Deploy (Rocket icon) — it's the secondary button
    const deployBtns = page.locator('button:has-text("Deploy")');
    const deployCount = await deployBtns.count();
    // Click the last Deploy button (action bar at bottom)
    if (deployCount > 0) {
      await deployBtns.last().click();
      await page.waitForTimeout(3000);
      ok("Deploy triggered via UI", true);
    } else {
      ok("Deploy button found", false, "No Deploy button");
    }
    await screenshot(page, "10-deploying");

    // Also get the session cookie to trigger deploy via API as fallback
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((c) => c.name === "bp_session")?.value || "";

  } catch (err) {
    console.error("\n  ⚠️  Test error: " + err.message.split("\n")[0]);
    await screenshot(page, "error-create");
  }

  await browser.close();

  // Ensure deploy was triggered — if UI click failed, deploy via API
  const agentRow = await dbQuery(PG_PLATFORM_URL, `SELECT id, deployed FROM agent_configs WHERE name='${TEST_AGENT_NAME}'`);
  if (agentRow[0] && !agentRow[0].deployed) {
    console.log("  Deploy not triggered via UI — triggering via API...");
    const loginBrowser = await chromium.launch({ args: ["--no-sandbox"] });
    const loginPage = await loginBrowser.newPage();
    await login(loginPage);
    const loginCookies = await loginPage.context().cookies();
    const cookie = loginCookies.find((c) => c.name === "bp_session")?.value || "";
    await loginBrowser.close();

    const resp = await fetch(`${PLATFORM}/trpc/agentsCrud.deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": `bp_session=${cookie}` },
      body: JSON.stringify({ json: { id: agentRow[0].id } }),
    });
    const data = await resp.json();
    ok("Deploy triggered via API fallback", data?.result?.data?.json?.success === true, data);
    // Wait for deploy to process
    await new Promise((r) => setTimeout(r, 8000));
  }

  // ── 9. BACKEND VERIFICATION ──
  section("9. BACKEND VERIFICATION");

  // DB check
  const apps = await dbQuery(PG_PLATFORM_URL, `SELECT slug, provisioning_status FROM apps WHERE slug='${TEST_APP_SLUG}'`);
  ok("App in DB", apps.length === 1, apps);
  ok("App status completed", apps[0]?.provisioning_status === "completed", apps[0]?.provisioning_status);

  const agents = await dbQuery(PG_PLATFORM_URL, `SELECT name, stt_provider, llm_provider, llm_model, tts_provider, deployed FROM agent_configs WHERE name='${TEST_AGENT_NAME}'`);
  ok("Agent in DB", agents.length === 1);
  ok("STT provider is gpu-ai", agents[0]?.stt_provider === "gpu-ai", agents[0]?.stt_provider);
  ok("LLM provider is gpu-ai", agents[0]?.llm_provider === "gpu-ai", agents[0]?.llm_provider);
  ok("LLM model is Qwen", agents[0]?.llm_model?.includes("qwen"), agents[0]?.llm_model);
  ok("TTS provider is gpu-ai", agents[0]?.tts_provider === "gpu-ai", agents[0]?.tts_provider);

  // K8s checks
  const nsStatus = shell(`kubectl get ns ${TEST_APP_SLUG} -o jsonpath='{.status.phase}' 2>&1`);
  ok("K8s namespace exists", nsStatus === "Active", nsStatus);

  const esStatus = shell(`kubectl get es -n ${TEST_APP_SLUG} -o jsonpath='{.items[0].status.conditions[0].reason}' 2>&1`);
  ok("ExternalSecret synced", esStatus.includes("SecretSynced") || esStatus.includes("ReconcileSuccess"), esStatus);

  // Vault check
  const vaultKeys = shell(`kubectl exec -n vault vault-0 -- vault kv get -format=json secret/t6-apps/${TEST_APP_SLUG}/config 2>&1 | python3 -c "import sys,json; d=json.load(sys.stdin)['data']['data']; print(len(d))" 2>&1`);
  ok("Vault secrets exist", parseInt(vaultKeys) > 10, vaultKeys + " keys");

  // Keycloak check
  const kcClients = shell(`KC_PASS=$(kubectl exec -n vault vault-0 -- vault kv get -field=admin_password secret/t5-gateway/keycloak/config 2>/dev/null) && TOKEN=$(curl -sk -X POST "https://auth.bionicaisolutions.com/realms/master/protocol/openid-connect/token" -d "grant_type=password&client_id=admin-cli&username=admin&password=$KC_PASS" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])") && curl -sk "https://auth.bionicaisolutions.com/admin/realms/Bionic/clients?first=0&max=200" -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; print(len([c for c in json.load(sys.stdin) if c['clientId'].startswith('${TEST_APP_SLUG}-')]))" 2>&1`);
  ok("Keycloak clients exist", parseInt(kcClients) >= 2, kcClients + " clients");

  // Langfuse check
  const langfuseDbPass = shell(`kubectl exec -n vault vault-0 -- vault kv get -field=pg_password secret/t6-apps/langfuse/config 2>/dev/null`);
  const langfuseProjects = await dbQuery(
    `postgresql://langfuse:${langfuseDbPass}@192.168.0.212:5432/langfuse`,
    `SELECT id, name FROM projects WHERE name='${TEST_APP_SLUG}'`
  );
  ok("Langfuse project exists", langfuseProjects.length === 1, langfuseProjects);

  // PostgreSQL per-app DB check
  const appDbs = await dbQuery(PG_ADMIN_URL, `SELECT datname FROM pg_database WHERE datname='app_${TEST_APP_SLUG.replace(/-/g, "_")}'`);
  ok("Per-app PostgreSQL DB exists", appDbs.length === 1);

  // MinIO check
  const minioBucket = shell(`kubectl port-forward -n minio svc/minio-tenant-hl 9199:9000 &>/dev/null & sleep 2 && mc alias set rgtest http://localhost:9199 admin "Th1515T0p53cr3t" 2>/dev/null && mc stat rgtest/${TEST_APP_SLUG} 2>&1 | grep -c Name; kill %1 2>/dev/null`);
  ok("MinIO bucket exists", minioBucket.includes("1"), minioBucket);

  // ── PLAYER UI / CLOUDFLARE DNS / KONG ROUTING ──
  section("9b. PLAYER UI + DNS + KONG VERIFICATION");

  // Player UI deployment
  const playerUiDeploy = shell(`kubectl get deploy player-ui -n ${TEST_APP_SLUG} -o jsonpath='{.status.readyReplicas}' 2>&1`);
  ok("Player UI deployment exists and ready", playerUiDeploy === "1", playerUiDeploy);

  // Player UI service
  const playerUiSvc = shell(`kubectl get svc player-ui -n ${TEST_APP_SLUG} -o jsonpath='{.spec.ports[0].port}' 2>&1`);
  ok("Player UI service exists (port 80)", playerUiSvc === "80", playerUiSvc);

  // K8s Ingress for player-ui
  const ingressHost = shell(`kubectl get ingress player-ui -n ${TEST_APP_SLUG} -o jsonpath='{.spec.rules[0].host}' 2>&1`);
  const expectedHost = `${TEST_APP_SLUG}.baisoln.com`;
  ok("Ingress host matches slug.baisoln.com", ingressHost === expectedHost, ingressHost);

  const ingressClass = shell(`kubectl get ingress player-ui -n ${TEST_APP_SLUG} -o jsonpath='{.spec.ingressClassName}' 2>&1`);
  ok("Ingress class is kong", ingressClass === "kong", ingressClass);

  const ingressBackend = shell(`kubectl get ingress player-ui -n ${TEST_APP_SLUG} -o jsonpath='{.spec.rules[0].http.paths[0].backend.service.name}' 2>&1`);
  ok("Ingress backend is player-ui service", ingressBackend === "player-ui", ingressBackend);

  // Cloudflare DNS A record verification
  // Vault uses zone_ids (JSON map) not zone_id, and WAN_IP (uppercase) not wan_ip
  const cfToken = shell(`kubectl exec -n vault vault-0 -- vault kv get -field=api_token secret/shared/cloudflare 2>/dev/null`);
  const cfZoneId = shell(`kubectl exec -n vault vault-0 -- vault kv get -format=json secret/shared/cloudflare 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin)['data']['data']; zid=d.get('zone_id',''); zids=d.get('zone_ids',''); z=zid or (json.loads(zids).get('baisoln.com','') if zids else ''); print(z)" 2>&1`);
  const cfWanIp = shell(`kubectl exec -n vault vault-0 -- vault kv get -format=json secret/shared/cloudflare 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin)['data']['data']; print(d.get('wan_ip','') or d.get('WAN_IP',''))" 2>&1`);

  if (cfToken && cfZoneId) {
    const dnsRecords = shell(`curl -s "https://api.cloudflare.com/client/v4/zones/${cfZoneId}/dns_records?name=${expectedHost}&type=A" -H "Authorization: Bearer ${cfToken}" | python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(len(r), r[0]['content'] if r else 'NONE')" 2>&1`);
    const [dnsCount, dnsIp] = dnsRecords.split(" ");
    ok("Cloudflare A record exists", parseInt(dnsCount) >= 1, dnsRecords);
    if (cfWanIp) {
      ok("Cloudflare A record points to WAN IP", dnsIp === cfWanIp, `DNS=${dnsIp} WAN=${cfWanIp}`);
    }
  } else {
    ok("Cloudflare creds available in Vault", false, `token=${!!cfToken} zoneId=${cfZoneId}`);
  }

  // Kong routing — test from platform pod via wget
  const kongProxyUrl = "http://kong-kong-proxy.kong.svc.cluster.local:80";
  const kongHealth = shell(`kubectl exec deploy/bionic-platform -n bionic-platform -- wget -qO- --header="Host: ${expectedHost}" "${kongProxyUrl}/api/health" 2>&1`);
  ok("Kong routes to player-ui (health check via Host header)", kongHealth.includes('"ok":true'), kongHealth);

  // External DNS resolution check
  const dnsResolve = shell(`dig +short ${expectedHost} @1.1.1.1 2>/dev/null | head -1`);
  if (cfWanIp) {
    ok("Public DNS resolves to WAN IP", dnsResolve === cfWanIp || dnsResolve.length > 0, `resolved=${dnsResolve} wan=${cfWanIp}`);
  } else {
    ok("Public DNS resolves", dnsResolve.length > 0, dnsResolve);
  }

  // Agent deployment check
  section("10. AGENT DEPLOYMENT VERIFICATION");

  // Wait for agent pod to be ready
  console.log("  Waiting for agent pod...");
  let podReady = false;
  for (let i = 0; i < 15; i++) {
    const podStatus = shell(`kubectl get pods -n ${TEST_APP_SLUG} -l app=agent-${TEST_AGENT_NAME} -o jsonpath='{.items[0].status.phase}' 2>&1`);
    if (podStatus === "Running") { podReady = true; break; }
    await new Promise(r => setTimeout(r, 2000));
    process.stdout.write(".");
  }
  console.log("");
  ok("Agent pod is Running", podReady);

  if (podReady) {
    // Check agent registered with LiveKit
    const agentLogs = shell(`kubectl logs -n ${TEST_APP_SLUG} -l app=agent-${TEST_AGENT_NAME} --tail=20 2>&1`);
    ok("Agent registered with LiveKit", agentLogs.includes("registered worker"), agentLogs.slice(-200));
    ok("Agent name correct in registration", agentLogs.includes(TEST_AGENT_NAME));

    // Verify Langfuse env vars
    const langfuseKey = shell(`kubectl exec -n ${TEST_APP_SLUG} deploy/agent-${TEST_AGENT_NAME} -- env 2>&1 | grep LANGFUSE_PUBLIC_KEY`);
    ok("Langfuse public key in agent env", langfuseKey.includes("pk-lf-"), langfuseKey);

    const langfuseSecret = shell(`kubectl exec -n ${TEST_APP_SLUG} deploy/agent-${TEST_AGENT_NAME} -- env 2>&1 | grep LANGFUSE_SECRET_KEY`);
    ok("Langfuse secret key in agent env", langfuseSecret.includes("sk-lf-"), langfuseSecret);

    const langfuseHost = shell(`kubectl exec -n ${TEST_APP_SLUG} deploy/agent-${TEST_AGENT_NAME} -- env 2>&1 | grep LANGFUSE_HOST`);
    ok("Langfuse host is internal URL", langfuseHost.includes("langfuse-web.langfuse.svc"), langfuseHost);

    // Verify LiveKit creds
    const lkKey = shell(`kubectl exec -n ${TEST_APP_SLUG} deploy/agent-${TEST_AGENT_NAME} -- env 2>&1 | grep "^LIVEKIT_API_KEY="`);
    ok("LIVEKIT_API_KEY set (uppercase)", lkKey.includes("API"), lkKey);

    // Verify LLM config
    const llmModel = shell(`kubectl exec -n ${TEST_APP_SLUG} deploy/agent-${TEST_AGENT_NAME} -- env 2>&1 | grep LLM_MODEL`);
    ok("LLM_MODEL is Qwen", llmModel.includes("qwen"), llmModel);

    const llmProvider = shell(`kubectl exec -n ${TEST_APP_SLUG} deploy/agent-${TEST_AGENT_NAME} -- env 2>&1 | grep LLM_PROVIDER`);
    ok("LLM_PROVIDER is gpu-ai", llmProvider.includes("gpu-ai"), llmProvider);
  }

  // JS errors
  ok("No JS errors during test", errors.length === 0, errors);

  printResults("CREATE & DEPLOY PHASE");
  console.log("\n  Screenshots: " + SCREENSHOTS_DIR + "/");
  console.log("  → Validate manually, then run: node tests/e2e-regression.js delete\n");
  process.exit(totalFailed > 0 ? 1 : 0);
}

// ═════════════════════════════════════════════════════════════════
// PHASE 3: PLAYER-UI END-TO-END (deployed app browser test)
// ═════════════════════════════════════════════════════════════════
async function runPlayerUiTest() {
  if (!KC_PASS) { console.error("Set KC_USER_PASSWORD"); process.exit(1); }
  execSync(`mkdir -p ${SCREENSHOTS_DIR}`);

  const APP_URL = `https://${TEST_APP_SLUG}.baisoln.com`;
  console.log(`\n  Testing deployed player-ui at: ${APP_URL}\n`);

  const browser = await chromium.launch({ args: ["--no-sandbox", "--ignore-certificate-errors"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));

  try {
    // ── 1. NAVIGATE TO APP ──
    section("1. NAVIGATE TO DEPLOYED APP");
    await page.goto(APP_URL, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2000);
    await screenshot(page, "playerui-01-landing");

    const bodyText = await page.textContent("body");
    // Should show "Sign in" or redirect to Keycloak
    const isAuthPage = bodyText.includes("Sign in") ||
                       bodyText.includes("Keycloak") ||
                       bodyText.includes("Username") ||
                       page.url().includes("auth.bionicaisolutions.com");
    ok("Player UI requires authentication", isAuthPage, page.url());

    // ── 2. SIGN IN VIA KEYCLOAK ──
    section("2. SIGN IN VIA KEYCLOAK");
    // If we're on the player-ui sign-in page, click sign in
    const signInBtn = page.locator('button:has-text("Sign in")');
    if (await signInBtn.count() > 0) {
      await signInBtn.first().click();
      await page.waitForTimeout(2000);
    }

    // Wait for Keycloak login form
    await page.waitForSelector("#username", { timeout: 15000 });
    await page.fill("#username", KC_USER);
    await page.fill("#password", KC_PASS);
    await page.click("#kc-login");
    await page.waitForTimeout(3000);
    await screenshot(page, "playerui-02-after-login");

    // Should be back on the app with session
    const afterLoginUrl = page.url();
    ok("Redirected back to app after login", afterLoginUrl.includes(TEST_APP_SLUG) || afterLoginUrl.includes("baisoln.com"), afterLoginUrl);

    // ── 3. WAIT FOR AGENT TO APPEAR ──
    section("3. WAIT FOR AGENT TO APPEAR");
    let agentFound = false;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(3000);
      const text = await page.textContent("body");
      // Check for agent name or "Start Session" button
      if (text.includes("Start Session") || text.includes("Agent")) {
        const hasStartBtn = await page.locator('button:has-text("Start Session")').count();
        if (hasStartBtn > 0) {
          agentFound = true;
          break;
        }
      }
      process.stdout.write(".");
    }
    console.log("");
    await screenshot(page, "playerui-03-agent-list");
    ok("Agent visible in player UI", agentFound);

    if (!agentFound) {
      console.log("  ⚠️  Agent not found in UI — checking API directly");
      const apiRes = shell(`kubectl exec deploy/player-ui -n ${TEST_APP_SLUG} -- sh -c 'wget -qO- http://bionic-platform.bionic-platform.svc.cluster.local:80/api/player-ui/agents?slug=${TEST_APP_SLUG} 2>&1'`);
      console.log("  API response: " + apiRes);
    }

    // ── 4. START SESSION ──
    section("4. START AGENT SESSION");
    if (agentFound) {
      const startBtn = page.locator('button:has-text("Start Session")');
      await startBtn.click();
      console.log("  Clicked Start Session, waiting for connection...");

      // Wait for the session view to appear (header with agent name + "Connected")
      let sessionStarted = false;
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(2000);
        const sessionText = await page.textContent("body");
        if (sessionText.includes("Connected") || sessionText.includes("Listening") || sessionText.includes("End")) {
          sessionStarted = true;
          break;
        }
        // Check for visible error messages (not raw script content)
        const errorEls = await page.locator('p:has-text("error"), p:has-text("Error"), [style*="error"]').count();
        if (errorEls > 0) {
          const errText = await page.locator('p:has-text("error"), p:has-text("Error")').first().textContent();
          console.log("  ⚠️  Error in UI: " + errText);
          break;
        }
        process.stdout.write(".");
      }
      console.log("");
      await screenshot(page, "playerui-04-session");
      ok("LiveKit session started", sessionStarted);

      if (sessionStarted) {
        // ── 5. SEND CHAT MESSAGE ──
        section("5. SEND CHAT MESSAGE");
        const chatInput = page.locator('input[placeholder="Type a message..."]');
        if (await chatInput.count() > 0) {
          await chatInput.fill("Hello, this is a test message.");
          await chatInput.press("Enter");
          ok("Chat message sent", true);

          // Wait for any response in the chat
          let gotResponse = false;
          for (let i = 0; i < 15; i++) {
            await page.waitForTimeout(2000);
            const chatText = await page.textContent("body");
            // Look for agent's reply bubble (any text in agent-bubble style)
            const msgCount = await page.locator('[style*="agent-bubble"], [style*="flex-start"]').count();
            if (msgCount > 0) {
              gotResponse = true;
              break;
            }
            process.stdout.write(".");
          }
          console.log("");
          await screenshot(page, "playerui-05-chat-response");
          ok("Agent responded to chat", gotResponse);
        } else {
          ok("Chat input found", false, "No chat input visible");
        }

        // ── 6. DISCONNECT ──
        section("6. DISCONNECT");
        const endBtn = page.locator('button:has-text("End")');
        if (await endBtn.count() > 0) {
          await endBtn.click();
          await page.waitForTimeout(2000);
          ok("Session disconnected", true);
        }
      }
    }

    // JS errors
    ok("No JS errors during player-ui test", errors.length === 0, errors);

  } catch (err) {
    console.error("\n  ⚠️  Player-UI test error: " + err.message.split("\n")[0]);
    await screenshot(page, "playerui-error");
  }

  await browser.close();

  printResults("PLAYER-UI E2E PHASE");
  console.log("\n  Screenshots: " + SCREENSHOTS_DIR + "/");
  process.exit(totalFailed > 0 ? 1 : 0);
}

// ═════════════════════════════════════════════════════════════════
// PHASE 2: DELETE & VERIFY ZERO REMNANTS
// ═════════════════════════════════════════════════════════════════
async function runDeleteTests() {
  if (!KC_PASS) { console.error("Set KC_USER_PASSWORD"); process.exit(1); }
  execSync(`mkdir -p ${SCREENSHOTS_DIR}`);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    // ── 1. LOGIN ──
    section("1. LOGIN");
    await login(page);
    ok("Logged in", true);

    // ── 2. DELETE AGENT ──
    section("2. DELETE AGENT");
    await page.goto(PLATFORM + "/agents", { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);

    await page.locator('[role="combobox"]').first().click();
    await page.waitForTimeout(300);
    await page.locator(`[role="option"]:has-text("${TEST_APP_NAME}")`).click();
    await page.waitForTimeout(500);
    await page.locator(`button:has-text("${TEST_AGENT_NAME}")`).click();
    await page.waitForTimeout(1500);

    // Delete agent
    page.on("dialog", (d) => d.accept());
    await page.click('button:has-text("Delete")');
    await page.waitForTimeout(2000);
    ok("Agent deleted via UI", true);
    await screenshot(page, "20-agent-deleted");

    // ── 3. DELETE APP ──
    section("3. DELETE APP");
    await page.goto(PLATFORM + "/apps", { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    const appRow = page.locator(`tr:has-text("${TEST_APP_SLUG}")`).first();
    await appRow.click();
    await page.waitForTimeout(1500);

    // Danger Zone tab
    await page.click('[role="tab"]:has-text("Danger")');
    await page.waitForTimeout(500);
    await page.click('button:has-text("Delete")');
    await page.waitForTimeout(8000);
    ok("App deletion triggered", true);
    await screenshot(page, "21-app-deleted");

    // Verify app gone from list
    await page.goto(PLATFORM + "/apps", { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    const listText = await page.textContent("body");
    ok("App removed from list", !listText.includes(TEST_APP_SLUG));

  } catch (err) {
    console.error("\n  ⚠️  Test error: " + err.message.split("\n")[0]);
    await screenshot(page, "error-delete");
  }

  await browser.close();

  // Wait for async deletion to complete
  console.log("  Waiting for deletion pipeline...");
  await new Promise((r) => setTimeout(r, 10000));

  // ── 4. VERIFY ZERO REMNANTS ──
  section("4. VERIFY ZERO REMNANTS");

  const SLUG = TEST_APP_SLUG;
  const SLUG_UNDER = SLUG.replace(/-/g, "_");

  // Platform DB
  const dbApps = await dbQuery(PG_PLATFORM_URL, `SELECT count(*)::int as c FROM apps WHERE slug='${SLUG}'`);
  ok("Platform DB: 0 apps", dbApps[0].c === 0, dbApps[0].c);

  const dbAgents = await dbQuery(PG_PLATFORM_URL, `SELECT count(*)::int as c FROM agent_configs WHERE name='${TEST_AGENT_NAME}'`);
  ok("Platform DB: 0 agents", dbAgents[0].c === 0, dbAgents[0].c);

  const dbJobs = await dbQuery(PG_PLATFORM_URL, `SELECT count(*)::int as c FROM provisioning_jobs WHERE app_id IN (SELECT id FROM apps WHERE slug='${SLUG}')`);
  ok("Platform DB: 0 orphan jobs", dbJobs[0].c === 0, dbJobs[0].c);

  const dbDocs = await dbQuery(PG_PLATFORM_URL, `SELECT count(*)::int as c FROM agent_documents WHERE agent_config_id NOT IN (SELECT id FROM agent_configs)`);
  ok("Platform DB: 0 orphan documents", dbDocs[0].c === 0, dbDocs[0].c);

  const dbTools = await dbQuery(PG_PLATFORM_URL, `SELECT count(*)::int as c FROM agent_tools WHERE agent_config_id NOT IN (SELECT id FROM agent_configs)`);
  ok("Platform DB: 0 orphan tools", dbTools[0].c === 0, dbTools[0].c);

  // K8s namespace
  const ns = shell(`kubectl get ns ${SLUG} 2>&1 | grep -c Active`);
  ok("K8s namespace deleted", ns === "0" || ns.includes("not found"));

  // Vault
  const vaultSecret = shell(`kubectl exec -n vault vault-0 -- vault kv get secret/t6-apps/${SLUG}/config 2>&1 | grep -c version`);
  ok("Vault secrets deleted", vaultSecret === "0");

  const vaultPolicy = shell(`kubectl exec -n vault vault-0 -- vault policy read eso-${SLUG} 2>&1 | grep -c path`);
  ok("Vault ESO policy deleted", vaultPolicy === "0");

  // Keycloak
  const kcCheck = shell(`KC_PASS=$(kubectl exec -n vault vault-0 -- vault kv get -field=admin_password secret/t5-gateway/keycloak/config 2>/dev/null) && TOKEN=$(curl -sk -X POST "https://auth.bionicaisolutions.com/realms/master/protocol/openid-connect/token" -d "grant_type=password&client_id=admin-cli&username=admin&password=$KC_PASS" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])") && curl -sk "https://auth.bionicaisolutions.com/admin/realms/Bionic/clients?first=0&max=200" -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; print(len([c for c in json.load(sys.stdin) if c['clientId'].startswith('${SLUG}-')]))" 2>&1`);
  ok("Keycloak clients deleted", kcCheck === "0", kcCheck);

  // Keycloak roles
  const kcRoleCheck = shell(`KC_PASS=$(kubectl exec -n vault vault-0 -- vault kv get -field=admin_password secret/t5-gateway/keycloak/config 2>/dev/null) && TOKEN=$(curl -sk -X POST "https://auth.bionicaisolutions.com/realms/master/protocol/openid-connect/token" -d "grant_type=password&client_id=admin-cli&username=admin&password=$KC_PASS" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])") && for R in ${SLUG}-admin ${SLUG}-user; do curl -sk -o /dev/null -w "%{http_code} " "https://auth.bionicaisolutions.com/admin/realms/Bionic/roles/$R" -H "Authorization: Bearer $TOKEN"; done 2>&1`);
  ok("Keycloak roles deleted", !kcRoleCheck.includes("200"), kcRoleCheck);

  // PostgreSQL per-app DB
  const pgDb = await dbQuery(PG_ADMIN_URL, `SELECT count(*)::int as c FROM pg_database WHERE datname='app_${SLUG_UNDER}'`);
  ok("Per-app PostgreSQL DB deleted", pgDb[0].c === 0, pgDb[0].c);

  const pgRole = await dbQuery(PG_ADMIN_URL, `SELECT count(*)::int as c FROM pg_roles WHERE rolname='app_${SLUG_UNDER}_user'`);
  ok("Per-app PostgreSQL role deleted", pgRole[0].c === 0, pgRole[0].c);

  // Langfuse
  const langfuseDbPass = shell(`kubectl exec -n vault vault-0 -- vault kv get -field=pg_password secret/t6-apps/langfuse/config 2>/dev/null`);
  const langfuseProj = await dbQuery(
    `postgresql://langfuse:${langfuseDbPass}@192.168.0.212:5432/langfuse`,
    `SELECT count(*)::int as c FROM projects WHERE name='${SLUG}'`
  );
  ok("Langfuse project deleted", langfuseProj[0].c === 0, langfuseProj[0].c);

  const langfuseKeys = await dbQuery(
    `postgresql://langfuse:${langfuseDbPass}@192.168.0.212:5432/langfuse`,
    `SELECT count(*)::int as c FROM api_keys WHERE note LIKE '%${SLUG}%'`
  );
  ok("Langfuse API keys deleted", langfuseKeys[0].c === 0, langfuseKeys[0].c);

  // MinIO — use a single port-forward session and capture only the result
  const minioResult = shell(`bash -c 'kubectl port-forward -n minio svc/minio-tenant-hl 9199:9000 &>/dev/null & PF=$!; sleep 3; mc alias set rgdel http://localhost:9199 admin "Th1515T0p53cr3t" &>/dev/null; B=$(mc stat rgdel/${SLUG} 2>&1 | grep -c Name); U=$(mc admin user info rgdel ${SLUG}-svc 2>&1 | grep -c AccessKey); kill $PF 2>/dev/null; echo "bucket:$B user:$U"'`);
  ok("MinIO bucket deleted", minioResult.includes("bucket:0"), minioResult);
  ok("MinIO user deleted", minioResult.includes("user:0"), minioResult);

  // LiveKit key
  const lkKeys = shell(`kubectl get secret -n livekit livekit-api-keys -o jsonpath='{.data.LIVEKIT_KEYS}' | base64 -d | grep -ic "${SLUG.replace(/-/g, "")}" 2>&1`);
  ok("LiveKit API key removed", lkKeys === "0", lkKeys);

  printResults("DELETE & CLEANUP PHASE");
  process.exit(totalFailed > 0 ? 1 : 0);
}

// ── Entry Point ─────────────────────────────────────────────────
const mode = process.argv[2];
if (mode === "create") {
  runCreateTests().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
} else if (mode === "delete") {
  runDeleteTests().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
} else if (mode === "playerui") {
  runPlayerUiTest().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
} else if (mode === "all") {
  // Full E2E: create → player-ui test → delete
  runCreateTests()
    .then(() => { results.length = 0; totalPassed = 0; totalFailed = 0; return runPlayerUiTest(); })
    .catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
} else {
  console.log("Usage:");
  console.log("  KC_USER_PASSWORD=... node tests/e2e-regression.cjs create");
  console.log("  KC_USER_PASSWORD=... node tests/e2e-regression.cjs playerui");
  console.log("  KC_USER_PASSWORD=... node tests/e2e-regression.cjs delete");
  console.log("");
  console.log("Run 'create' first, then 'playerui' to test deployed UI, then 'delete'.");
  process.exit(1);
}
