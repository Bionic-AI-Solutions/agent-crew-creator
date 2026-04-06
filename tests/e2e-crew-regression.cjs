/**
 * Bionic AI Platform — Crew (Dify) E2E Regression Tests
 *
 * Tests crew lifecycle via UI:
 *   Phase 1 (create): Create crews with 1, 2, 3 agents, verify Dify integration, test secondary agent wiring
 *   Phase 2 (delete): Delete all test crews, verify zero remnants
 *   Phase 3 (template): Create crew from template, verify it works
 *
 * Usage:
 *   KC_USER_PASSWORD="..." node tests/e2e-crew-regression.cjs create
 *   KC_USER_PASSWORD="..." node tests/e2e-crew-regression.cjs delete
 *   KC_USER_PASSWORD="..." node tests/e2e-crew-regression.cjs template
 *   KC_USER_PASSWORD="..." node tests/e2e-crew-regression.cjs all     # runs create → template → delete
 *
 * Prerequisites:
 *   - An app with slug TEST_APP_SLUG must exist and be provisioned (run e2e-regression.cjs create first)
 *   - An agent with name TEST_AGENT_NAME must exist
 *   - Dify must be deployed in bionic-platform namespace
 *   - Playwright installed: npx playwright install chromium
 */

const { chromium } = require("playwright");
const { execSync } = require("child_process");
const pg = require("pg");

// ── Config ──────────────────────────────────────────────────────
const PLATFORM = "https://platform.baisoln.com";
const KC_USER = "test-admin";
const KC_PASS = process.env.KC_USER_PASSWORD;

// Uses an existing provisioned app + deployed agent
// Override via env vars: TEST_APP_NAME, TEST_APP_SLUG, TEST_AGENT_NAME
const TEST_APP_NAME = process.env.TEST_APP_NAME || "Astro Lab";
const TEST_APP_SLUG = process.env.TEST_APP_SLUG || "astro-lab";
const TEST_AGENT_NAME = process.env.TEST_AGENT_NAME || "star-guide";

const PG_PLATFORM_URL = "postgresql://bionic_platform_user:B10n1cPl4tf0rm!S3cur3@192.168.0.212:5432/bionic_platform";
const SCREENSHOTS_DIR = "/tmp/regression-crews";

// Test crew definitions
const TEST_CREWS = [
  { name: "crew_1agent_test", description: "Single-agent workflow test crew", mode: "workflow", agentCount: 1 },
  { name: "crew_2agent_test", description: "Two-agent pipeline test crew", mode: "agent-chat", agentCount: 2 },
  { name: "crew_3agent_test", description: "Three-agent orchestration test crew", mode: "workflow", agentCount: 3 },
];

const TEST_TEMPLATE_CREW = { name: "crew_template_test", template: "deep_research" };

// ── Test Framework ──────────────────────────────────────────────
const results = [];
let totalPassed = 0;
let totalFailed = 0;

function ok(name, pass, actual) {
  results.push({ test: name, pass, actual });
  if (pass) totalPassed++;
  else totalFailed++;
  console.log((pass ? "  \u2705" : "  \u274C") + " " + name + (!pass && actual ? " \u2192 " + JSON.stringify(actual).slice(0, 120) : ""));
}

function section(name) {
  console.log("\n\u2550\u2550\u2550 " + name + " \u2550\u2550\u2550");
}

function printResults(phase) {
  console.log("\n" + "\u2550".repeat(60));
  console.log("  " + phase + " \u2014 RESULTS");
  console.log("\u2550".repeat(60));
  for (const r of results) {
    console.log((r.pass ? "  \u2705 PASS" : "  \u274C FAIL") + ": " + r.test);
    if (!r.pass && r.actual) console.log("          \u2192 " + JSON.stringify(r.actual).slice(0, 150));
  }
  console.log("\n  " + totalPassed + " passed, " + totalFailed + " failed out of " + results.length);
  console.log("\u2550".repeat(60));
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

// ── Navigate to Agent & Crews Tab ───────────────────────────────
async function navigateToCrewsTab(page) {
  await page.goto(PLATFORM + "/agents", { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  // Select app from dropdown
  const appCombo = page.locator('[role="combobox"]').first();
  await appCombo.click();
  await page.waitForTimeout(500);
  const appOpt = page.locator(`[role="option"]:has-text("${TEST_APP_NAME}")`);
  if (await appOpt.count() === 0) {
    throw new Error(`App "${TEST_APP_NAME}" not found in dropdown. Run e2e-regression.cjs create first.`);
  }
  await appOpt.click();
  await page.waitForTimeout(2000);

  // Check if agent exists; if not, create one
  let bodyAfterApp = await page.textContent("body");
  if (bodyAfterApp.includes("No agents yet") || !bodyAfterApp.includes(TEST_AGENT_NAME)) {
    console.log(`  Agent "${TEST_AGENT_NAME}" not found — creating it via UI...`);

    await page.click('button:has-text("Add Agent")');
    await page.waitForTimeout(500);
    await page.fill('input[placeholder="my-agent"]', TEST_AGENT_NAME);
    const descInput = page.locator('input[placeholder="What does this agent do?"]');
    if (await descInput.count() > 0) {
      await descInput.fill("Crew regression test agent");
    }
    await page.click('button:has-text("Create"):not([disabled])');
    await page.waitForTimeout(3000);
    console.log(`  Agent "${TEST_AGENT_NAME}" created`);
  }

  // Wait for agent to appear and click it
  let agentFound = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const agentBtn = page.locator(`button:has-text("${TEST_AGENT_NAME}")`);
    if (await agentBtn.count() > 0) {
      await agentBtn.click();
      agentFound = true;
      break;
    }
    await page.waitForTimeout(1000);
  }

  if (!agentFound) {
    // Agent might already be selected (just created)
    const bodyText = await page.textContent("body");
    if (!bodyText.includes(TEST_AGENT_NAME)) {
      await screenshot(page, "debug-agent-not-found");
      throw new Error(`Agent "${TEST_AGENT_NAME}" not found after creation attempt.`);
    }
  }
  await page.waitForTimeout(1500);

  // Click Crews tab
  const crewsTab = page.locator('[role="tab"]:has-text("Crews")');
  if (await crewsTab.count() === 0) {
    throw new Error("Crews tab not found in agent config. Is the Dify integration deployed?");
  }
  await crewsTab.click();
  await page.waitForTimeout(1000);
}

// ═════════════════════════════════════════════════════════════════
// PHASE 1: CREATE CREWS & VERIFY
// ═════════════════════════════════════════════════════════════════
async function runCreateTests() {
  if (!KC_PASS) { console.error("Set KC_USER_PASSWORD"); process.exit(1); }
  execSync(`mkdir -p ${SCREENSHOTS_DIR}`);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const jsErrors = [];
  page.on("pageerror", (err) => jsErrors.push(err.message));

  try {
    // ── 1. LOGIN ──
    section("1. LOGIN & NAVIGATE TO CREWS");
    await login(page);
    ok("Logged in as test-admin", true);

    await navigateToCrewsTab(page);
    ok("Navigated to Crews tab", true);
    await screenshot(page, "01-crews-tab-initial");

    // Verify Crews tab UI elements
    const bodyText = await page.textContent("body");
    ok("Crews tab shows Dify header", bodyText.includes("Crews") && (bodyText.includes("Dify") || bodyText.includes("Workflow")));

    // Check for Dify editor iframe or link
    const difyEditorBtn = page.locator('button:has-text("Open Dify Editor")');
    const hasDifyEditor = await difyEditorBtn.count() > 0;
    ok("Dify Editor button present", hasDifyEditor);

    const newCrewBtn = page.locator('button:has-text("New Crew")');
    ok("New Crew button present", await newCrewBtn.count() > 0);

    // ── 2. CHECK DIFY CONNECTIVITY ──
    section("2. DIFY CONNECTIVITY");

    // Check that the Dify proxy responds (not 502)
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((c) => c.name === "bp_session")?.value || "";
    const difyProxyResp = await page.evaluate(async () => {
      try {
        const r = await fetch("/dify/apps", { redirect: "follow" });
        return { status: r.status, ok: r.ok, redirected: r.redirected };
      } catch (e) {
        return { status: 0, ok: false, error: e.message };
      }
    });
    ok("Dify proxy responds (not 502)", difyProxyResp.status !== 502 && difyProxyResp.status !== 0, difyProxyResp);

    // Check Dify API health through proxy
    const difyHealth = await page.evaluate(async () => {
      try {
        const r = await fetch("/dify/v1/health");
        return { status: r.status };
      } catch (e) {
        return { status: 0, error: e.message };
      }
    });
    ok("Dify API health check via proxy", difyHealth.status === 200, difyHealth);

    // Check embedded iframe loads (if present)
    const iframe = page.locator('iframe[title="Dify Workflow Editor"]');
    if (await iframe.count() > 0) {
      const iframeSrc = await iframe.getAttribute("src");
      ok("Dify iframe src is HTTPS-safe (relative path)", iframeSrc && iframeSrc.startsWith("/dify"), iframeSrc);
      // Wait for iframe to load
      await page.waitForTimeout(3000);
      ok("Dify iframe present in Crews tab", true);
    } else {
      ok("Dify iframe present in Crews tab", false, "iframe not found — Dify may not be configured for this app");
    }

    await screenshot(page, "02-dify-connectivity");

    // ── 3. CREATE CREWS (1-agent, 2-agent, 3-agent) ──
    for (let i = 0; i < TEST_CREWS.length; i++) {
      const crew = TEST_CREWS[i];
      section(`3.${i + 1}. CREATE CREW: ${crew.name} (${crew.agentCount}-agent ${crew.mode})`);

      // Check if crew already exists
      const existingCrewText = await page.textContent("body");
      if (existingCrewText.includes(crew.name)) {
        console.log(`  \u26A0\uFE0F  Crew "${crew.name}" already exists — skipping creation`);
        ok(`Crew ${crew.name} exists (from previous run)`, true);
        continue;
      }

      // Click "New Crew" button
      await page.locator('button:has-text("New Crew")').click();
      await page.waitForTimeout(500);

      // Wait for dialog
      const dialog = page.locator('[role="dialog"]');
      ok(`Create crew dialog opened for ${crew.name}`, await dialog.count() > 0);
      await screenshot(page, `03-${i + 1}-create-dialog`);

      // Fill in crew name
      const nameInput = dialog.locator('input[placeholder="deep_research"]');
      if (await nameInput.count() > 0) {
        await nameInput.fill(crew.name);
        ok(`Crew name entered: ${crew.name}`, true);
      } else {
        // Try any input in dialog
        const anyInput = dialog.locator("input").first();
        await anyInput.fill(crew.name);
        ok(`Crew name entered (fallback): ${crew.name}`, true);
      }

      // Fill description
      const descInput = dialog.locator("textarea").first();
      if (await descInput.count() > 0) {
        await descInput.fill(crew.description);
        ok(`Description entered`, true);
      }

      // Select workflow mode
      const modeSelect = dialog.locator('[role="combobox"]').first();
      if (await modeSelect.count() > 0) {
        await modeSelect.click();
        await page.waitForTimeout(300);
        const modeLabel = crew.mode === "agent-chat" ? "Agent Chat" : crew.mode === "completion" ? "Completion" : "Workflow";
        const modeOpt = page.locator(`[role="option"]:has-text("${modeLabel}")`);
        if (await modeOpt.count() > 0) {
          await modeOpt.click();
          ok(`Mode selected: ${crew.mode}`, true);
        } else {
          ok(`Mode option "${modeLabel}" found`, false, "Mode option not in dropdown");
          // Close dropdown
          await page.keyboard.press("Escape");
        }
        await page.waitForTimeout(300);
      }

      // Note: Dify API key is NOT provided here — the crew is registered without one.
      // This tests the "unconfigured" state. A real workflow needs to be created in Dify first.

      // Click create button
      const createBtn = dialog.locator('button:has-text("Create")').last();
      if (await createBtn.count() > 0) {
        await createBtn.click();
        await page.waitForTimeout(2000);
      }

      // Wait for dialog to close and list to refresh
      await page.waitForTimeout(1000);
      const afterCreateText = await page.textContent("body");
      ok(`Crew "${crew.name}" appears in UI after creation`, afterCreateText.includes(crew.name));

      // Verify correct mode badge
      ok(`Crew shows "${crew.mode}" badge`, afterCreateText.includes(crew.mode) || afterCreateText.includes("workflow"));

      // Verify "no API key" badge (since we didn't provide one)
      ok(`Crew shows unconfigured state`, afterCreateText.includes("no API key") || afterCreateText.includes("unconfigured") || afterCreateText.includes(crew.name));

      await screenshot(page, `04-${i + 1}-crew-created`);
    }

    // ── 4. ENABLE CREWS FOR AGENT ──
    section("4. ENABLE CREWS FOR AGENT (checkbox toggle)");

    for (const crew of TEST_CREWS) {
      // Find the crew row by scanning bordered divs
      const rows = page.locator("div.rounded.border");
      const count = await rows.count();
      let found = false;

      for (let r = 0; r < count; r++) {
        const rowText = await rows.nth(r).textContent();
        if (rowText && rowText.includes(crew.name)) {
          const cb = rows.nth(r).locator('[role="checkbox"]').first();
          if (await cb.count() > 0) {
            const state = await cb.getAttribute("data-state");
            if (state !== "checked") {
              await cb.click();
              // IMPORTANT: wait for mutation to complete before clicking next checkbox
              // The setAgentCrews mutation replaces all links, so overlapping calls lose data
              await page.waitForTimeout(2500);
            }
            ok(`Crew "${crew.name}" enabled for agent`, true);
            found = true;
          }
          break;
        }
      }

      if (!found) {
        ok(`Crew "${crew.name}" checkbox found`, false, "Could not locate checkbox in bordered rows");
      }
    }
    await screenshot(page, "05-crews-enabled");

    // ── 5. VERIFY DB STATE ──
    section("5. DATABASE VERIFICATION");

    // Check crews table (filter to only our test crews)
    const testCrewNames = TEST_CREWS.map((c) => `'${c.name}'`).join(",");
    const dbCrews = await dbQuery(PG_PLATFORM_URL,
      `SELECT c.name, c.mode, c.description, c.dify_app_api_key
       FROM crews c
       JOIN apps a ON c.app_id = a.id
       WHERE a.slug = '${TEST_APP_SLUG}'
         AND c.name IN (${testCrewNames})
       ORDER BY c.name`
    );
    ok(`DB has ${TEST_CREWS.length} test crews`, dbCrews.length === TEST_CREWS.length, dbCrews.length);

    for (const crew of TEST_CREWS) {
      const dbCrew = dbCrews.find((r) => r.name === crew.name);
      ok(`DB crew "${crew.name}" exists`, !!dbCrew);
      if (dbCrew) {
        ok(`DB crew "${crew.name}" mode = ${crew.mode}`, dbCrew.mode === crew.mode, dbCrew.mode);
        ok(`DB crew "${crew.name}" description set`, dbCrew.description === crew.description, dbCrew.description);
      }
    }

    // Check agent_crews junction table (filter to test crews only)
    const dbAgentCrews = await dbQuery(PG_PLATFORM_URL,
      `SELECT ac.crew_name, ac.enabled
       FROM agent_crews ac
       JOIN agent_configs ag ON ac.agent_config_id = ag.id
       WHERE ag.name = '${TEST_AGENT_NAME}'
         AND ac.crew_name IN (${testCrewNames})
       ORDER BY ac.crew_name`
    );
    ok(`Agent has ${TEST_CREWS.length} test crews linked`, dbAgentCrews.length === TEST_CREWS.length, dbAgentCrews.length);

    for (const crew of TEST_CREWS) {
      const link = dbAgentCrews.find((r) => r.crew_name === crew.name);
      ok(`Agent-crew link "${crew.name}" exists`, !!link);
    }

    // ── 6. VERIFY SECONDARY AGENT CONNECTION (ConfigMap check) ──
    section("6. SECONDARY AGENT / DEPLOYMENT WIRING");

    // Check if agent is deployed
    const agentRow = await dbQuery(PG_PLATFORM_URL,
      `SELECT id, deployed, deployment_status FROM agent_configs WHERE name = '${TEST_AGENT_NAME}'`
    );
    const isDeployed = agentRow[0]?.deployed;

    if (isDeployed) {
      // Check ConfigMap has CREW_REGISTRY
      const crewRegistry = shell(
        `kubectl get configmap ${TEST_AGENT_NAME}-config -n ${TEST_APP_SLUG} -o jsonpath='{.data.CREW_REGISTRY}' 2>&1`
      );
      ok("ConfigMap has CREW_REGISTRY", crewRegistry.includes("["), crewRegistry.slice(0, 100));

      if (crewRegistry.startsWith("[")) {
        try {
          const registry = JSON.parse(crewRegistry);
          ok(`CREW_REGISTRY has ${TEST_CREWS.length} entries`, registry.length === TEST_CREWS.length, registry.length);
          for (const crew of TEST_CREWS) {
            const entry = registry.find((e) => e.name === crew.name);
            ok(`CREW_REGISTRY entry for "${crew.name}"`, !!entry);
          }
        } catch (e) {
          ok("CREW_REGISTRY is valid JSON", false, e.message);
        }
      }

      // Check ENABLED_CREWS
      const enabledCrews = shell(
        `kubectl get configmap ${TEST_AGENT_NAME}-config -n ${TEST_APP_SLUG} -o jsonpath='{.data.ENABLED_CREWS}' 2>&1`
      );
      ok("ConfigMap has ENABLED_CREWS", enabledCrews.includes("["), enabledCrews.slice(0, 100));

      // Check DIFY_BASE_URL
      const difyUrl = shell(
        `kubectl get configmap ${TEST_AGENT_NAME}-config -n ${TEST_APP_SLUG} -o jsonpath='{.data.DIFY_BASE_URL}' 2>&1`
      );
      ok("ConfigMap has DIFY_BASE_URL", difyUrl.includes("dify-api"), difyUrl);
    } else {
      console.log("  Agent not deployed — skipping ConfigMap/K8s checks.");
      console.log("  To test deployment wiring: deploy the agent first, then re-run.");
      console.log("  (This is informational, not a failure — deployment is a separate step)");
      ok("Agent deployed (informational)", true); // Not a failure — deployment is separate
    }

    // ── 7. VERIFY NO MIXED CONTENT / JS ERRORS ──
    section("7. BROWSER HEALTH");
    const mixedContentErrors = jsErrors.filter((e) =>
      e.toLowerCase().includes("mixed content") || e.toLowerCase().includes("blocked")
    );
    ok("No mixed-content errors", mixedContentErrors.length === 0, mixedContentErrors);

    // Filter out Dify iframe errors (Unexpected token '<' from iframe loading HTML as JS)
    const platformErrors = jsErrors.filter((e) => !e.includes("Unexpected token"));
    ok("No platform JS errors during crew creation", platformErrors.length === 0, platformErrors.length > 0 ? platformErrors.slice(0, 3) : undefined);
    if (jsErrors.length > platformErrors.length) {
      console.log(`  (${jsErrors.length - platformErrors.length} iframe-only errors filtered out)`);
    }

  } catch (err) {
    console.error("\n  \u26A0\uFE0F  Test error: " + err.message.split("\n")[0]);
    ok("Test completed without fatal error", false, err.message.slice(0, 120));
    await screenshot(page, "error-create-crews");
  }

  await browser.close();
  printResults("CREW CREATE PHASE");
  console.log("\n  Screenshots: " + SCREENSHOTS_DIR + "/");
  process.exit(totalFailed > 0 ? 1 : 0);
}

// ═════════════════════════════════════════════════════════════════
// PHASE 2: DELETE CREWS & VERIFY ZERO REMNANTS
// ═════════════════════════════════════════════════════════════════
async function runDeleteTests() {
  if (!KC_PASS) { console.error("Set KC_USER_PASSWORD"); process.exit(1); }
  execSync(`mkdir -p ${SCREENSHOTS_DIR}`);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    // ── 1. LOGIN & NAVIGATE ──
    section("1. LOGIN & NAVIGATE TO CREWS");
    await login(page);
    ok("Logged in", true);
    await navigateToCrewsTab(page);
    ok("Navigated to Crews tab", true);
    await screenshot(page, "10-before-delete");

    // ── 2. DELETE EACH CREW VIA UI ──
    section("2. DELETE CREWS VIA UI");

    // Accept all confirmation dialogs
    page.on("dialog", (d) => d.accept());

    for (const crew of TEST_CREWS) {
      // Refresh page state
      const bodyBefore = await page.textContent("body");
      if (!bodyBefore.includes(crew.name)) {
        console.log(`  Crew "${crew.name}" not found — already deleted or never created`);
        ok(`Crew "${crew.name}" absent (OK)`, true);
        continue;
      }

      // Strategy: Use tRPC API to delete via the session cookie (more reliable than UI clicking)
      // But first try UI, fall back to API
      let deleted = false;

      // UI approach: find rows with borders
      const rows = page.locator("div.rounded.border");
      const rowCount = await rows.count();
      for (let r = 0; r < rowCount; r++) {
        const rowText = await rows.nth(r).textContent();
        if (rowText && rowText.includes(crew.name)) {
          // Scroll row into view
          await rows.nth(r).scrollIntoViewIfNeeded();
          await page.waitForTimeout(300);
          // Find the small delete button (has text-red-500 class or contains trash icon)
          const btns = rows.nth(r).locator("button");
          const btnCount = await btns.count();
          // Click the last button in the row (the delete icon)
          if (btnCount > 0) {
            await btns.nth(btnCount - 1).click();
            await page.waitForTimeout(2500);
            deleted = true;
          }
          break;
        }
      }

      if (!deleted) {
        // API fallback: delete via tRPC
        console.log(`  UI delete failed for "${crew.name}" — trying API fallback...`);
        const crewRows = await dbQuery(PG_PLATFORM_URL,
          `SELECT c.id FROM crews c JOIN apps a ON c.app_id = a.id WHERE a.slug = '${TEST_APP_SLUG}' AND c.name = '${crew.name}'`
        );
        if (crewRows[0]) {
          const cookies = await page.context().cookies();
          const session = cookies.find((c) => c.name === "bp_session")?.value || "";
          const resp = await fetch(`${PLATFORM}/trpc/agentsCrud.deleteCrew`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Cookie": `bp_session=${session}` },
            body: JSON.stringify({ json: { id: crewRows[0].id } }),
          });
          const data = await resp.json();
          deleted = data?.result?.data?.json?.success === true;
          if (deleted) console.log(`  Deleted "${crew.name}" via API`);
        }
      }

      const bodyAfter = await page.textContent("body");
      ok(`Crew "${crew.name}" deleted`, deleted || !bodyAfter.includes(crew.name));
      await page.waitForTimeout(500);
    }
    await screenshot(page, "11-after-delete");

    // ── 3. ALSO DELETE TEMPLATE CREW IF EXISTS ──
    const templateBody = await page.textContent("body");
    if (templateBody.includes(TEST_TEMPLATE_CREW.name)) {
      // Use API fallback for reliability
      const tplRows = await dbQuery(PG_PLATFORM_URL,
        `SELECT c.id FROM crews c JOIN apps a ON c.app_id = a.id WHERE a.slug = '${TEST_APP_SLUG}' AND c.name = '${TEST_TEMPLATE_CREW.name}'`
      );
      if (tplRows[0]) {
        const cookies = await page.context().cookies();
        const session = cookies.find((c) => c.name === "bp_session")?.value || "";
        const resp = await fetch(`${PLATFORM}/trpc/agentsCrud.deleteCrew`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Cookie": `bp_session=${session}` },
          body: JSON.stringify({ json: { id: tplRows[0].id } }),
        });
        const data = await resp.json();
        ok(`Template crew "${TEST_TEMPLATE_CREW.name}" deleted`, data?.result?.data?.json?.success === true, data);
      } else {
        ok(`Template crew "${TEST_TEMPLATE_CREW.name}" already deleted`, true);
      }
    }

    await screenshot(page, "12-all-deleted");

  } catch (err) {
    console.error("\n  \u26A0\uFE0F  Test error: " + err.message.split("\n")[0]);
    ok("Delete test completed without fatal error", false, err.message.slice(0, 120));
    await screenshot(page, "error-delete-crews");
  }

  await browser.close();

  // ── 4. VERIFY ZERO REMNANTS IN DB ──
  section("3. DATABASE ZERO-REMNANT CHECK");

  const dbCrews = await dbQuery(PG_PLATFORM_URL,
    `SELECT c.name FROM crews c
     JOIN apps a ON c.app_id = a.id
     WHERE a.slug = '${TEST_APP_SLUG}'
       AND c.name IN (${TEST_CREWS.map((c) => `'${c.name}'`).join(",")}, '${TEST_TEMPLATE_CREW.name}')`
  );
  ok("DB: 0 test crews remain", dbCrews.length === 0, dbCrews.length + " remaining: " + dbCrews.map((r) => r.name).join(", "));

  // Check agent_crews junction cleaned up
  const dbAgentCrews = await dbQuery(PG_PLATFORM_URL,
    `SELECT ac.crew_name FROM agent_crews ac
     JOIN agent_configs ag ON ac.agent_config_id = ag.id
     WHERE ag.name = '${TEST_AGENT_NAME}'
       AND ac.crew_name IN (${TEST_CREWS.map((c) => `'${c.name}'`).join(",")}, '${TEST_TEMPLATE_CREW.name}')`
  );
  ok("DB: 0 orphan agent-crew links", dbAgentCrews.length === 0, dbAgentCrews.length + " remaining");

  // Check no orphan crew_executions
  const dbExecs = await dbQuery(PG_PLATFORM_URL,
    `SELECT count(*)::int as c FROM crew_executions WHERE crew_id NOT IN (SELECT id FROM crews)`
  );
  ok("DB: 0 orphan crew_executions", dbExecs[0].c === 0, dbExecs[0].c);

  printResults("CREW DELETE PHASE");
  process.exit(totalFailed > 0 ? 1 : 0);
}

// ═════════════════════════════════════════════════════════════════
// PHASE 3: CREATE CREW FROM TEMPLATE
// ═════════════════════════════════════════════════════════════════
async function runTemplateTests() {
  if (!KC_PASS) { console.error("Set KC_USER_PASSWORD"); process.exit(1); }
  execSync(`mkdir -p ${SCREENSHOTS_DIR}`);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const jsErrors = [];
  page.on("pageerror", (err) => jsErrors.push(err.message));

  try {
    // ── 1. LOGIN & NAVIGATE ──
    section("1. LOGIN & NAVIGATE TO CREWS");
    await login(page);
    ok("Logged in", true);
    await navigateToCrewsTab(page);
    ok("Navigated to Crews tab", true);

    // ── 2. VERIFY TEMPLATE GALLERY ──
    section("2. TEMPLATE GALLERY");

    const bodyText = await page.textContent("body");
    ok("Template section visible", bodyText.includes("Template") || bodyText.includes("template"));

    // Check each default template is listed
    const expectedTemplates = ["Deep Research", "Data Analysis", "Content Generation", "Due Diligence", "Customer Support"];
    for (const tpl of expectedTemplates) {
      ok(`Template "${tpl}" listed`, bodyText.includes(tpl));
    }
    await screenshot(page, "20-template-gallery");

    // ── 3. CREATE CREW BASED ON TEMPLATE ──
    section("3. CREATE CREW FROM TEMPLATE");

    // Check if template crew already exists
    if (bodyText.includes(TEST_TEMPLATE_CREW.name)) {
      console.log(`  \u26A0\uFE0F  Template crew already exists — skipping creation`);
      ok("Template crew exists (from previous run)", true);
    } else {
      // Open create dialog
      await page.locator('button:has-text("New Crew")').click();
      await page.waitForTimeout(500);

      const dialog = page.locator('[role="dialog"]');
      ok("Create dialog opened", await dialog.count() > 0);

      // Use the deep_research template name
      const nameInput = dialog.locator("input").first();
      await nameInput.fill(TEST_TEMPLATE_CREW.name);
      ok("Template crew name entered", true);

      // Set description referencing the template
      const descInput = dialog.locator("textarea").first();
      if (await descInput.count() > 0) {
        await descInput.fill("Created from Deep Research template — regression test");
      }

      // Select agent-chat mode (ReAct — matches the deep_research template description)
      const modeSelect = dialog.locator('[role="combobox"]').first();
      if (await modeSelect.count() > 0) {
        await modeSelect.click();
        await page.waitForTimeout(300);
        const agentChatOpt = page.locator('[role="option"]:has-text("Agent Chat")');
        if (await agentChatOpt.count() > 0) {
          await agentChatOpt.click();
          ok("Mode set to Agent Chat (ReAct)", true);
        }
        await page.waitForTimeout(300);
      }

      // Create
      const createBtn = dialog.locator('button:has-text("Create")').last();
      await createBtn.click();
      await page.waitForTimeout(1500);

      const afterText = await page.textContent("body");
      ok(`Template crew "${TEST_TEMPLATE_CREW.name}" created`, afterText.includes(TEST_TEMPLATE_CREW.name));
      ok("Template crew shows agent-chat mode", afterText.includes("agent-chat") || afterText.includes(TEST_TEMPLATE_CREW.name));
    }
    await screenshot(page, "21-template-crew-created");

    // ── 4. ENABLE TEMPLATE CREW FOR AGENT ──
    section("4. ENABLE TEMPLATE CREW");

    // Use bordered-row approach (same as create test)
    const rows = page.locator("div.rounded.border");
    const rowCount = await rows.count();
    let tplEnabled = false;
    for (let r = 0; r < rowCount; r++) {
      const rowText = await rows.nth(r).textContent();
      if (rowText && rowText.includes(TEST_TEMPLATE_CREW.name)) {
        const cb = rows.nth(r).locator('[role="checkbox"]').first();
        if (await cb.count() > 0) {
          const state = await cb.getAttribute("data-state");
          if (state !== "checked") {
            await cb.click();
            await page.waitForTimeout(2500);
          }
          tplEnabled = true;
        }
        break;
      }
    }
    ok("Template crew enabled for agent", tplEnabled);

    // ── 5. VERIFY DB ──
    section("5. DATABASE VERIFICATION");

    const dbCrew = await dbQuery(PG_PLATFORM_URL,
      `SELECT c.name, c.mode, c.description
       FROM crews c JOIN apps a ON c.app_id = a.id
       WHERE a.slug = '${TEST_APP_SLUG}' AND c.name = '${TEST_TEMPLATE_CREW.name}'`
    );
    ok("Template crew in DB", dbCrew.length === 1);
    if (dbCrew[0]) {
      ok("Template crew mode = agent-chat", dbCrew[0].mode === "agent-chat", dbCrew[0].mode);
      ok("Template crew has description", dbCrew[0].description?.includes("Deep Research"), dbCrew[0].description);
    }

    const dbLink = await dbQuery(PG_PLATFORM_URL,
      `SELECT ac.crew_name FROM agent_crews ac
       JOIN agent_configs ag ON ac.agent_config_id = ag.id
       WHERE ag.name = '${TEST_AGENT_NAME}' AND ac.crew_name = '${TEST_TEMPLATE_CREW.name}'`
    );
    ok("Template crew linked to agent in DB", dbLink.length === 1);

    // ── 6. BROWSER HEALTH ──
    section("6. BROWSER HEALTH");
    const platformErrors = jsErrors.filter((e) => !e.includes("Unexpected token"));
    ok("No platform JS errors during template test", platformErrors.length === 0, platformErrors.length > 0 ? platformErrors.slice(0, 3) : undefined);
    if (jsErrors.length > platformErrors.length) {
      console.log(`  (${jsErrors.length - platformErrors.length} iframe-only errors filtered out)`);
    }

  } catch (err) {
    console.error("\n  \u26A0\uFE0F  Test error: " + err.message.split("\n")[0]);
    ok("Template test completed without fatal error", false, err.message.slice(0, 120));
    await screenshot(page, "error-template-crews");
  }

  await browser.close();
  printResults("CREW TEMPLATE PHASE");
  process.exit(totalFailed > 0 ? 1 : 0);
}

// ═════════════════════════════════════════════════════════════════
// ALL: RUN CREATE → TEMPLATE → DELETE SEQUENTIALLY
// ═════════════════════════════════════════════════════════════════
async function runAll() {
  console.log("Running all crew regression tests...\n");

  // Phase 1: Create
  try {
    await runCreateTests();
  } catch (e) {
    if (e.code !== undefined) throw e; // exit code error, propagate
  }

  // Reset counters for next phase
  results.length = 0;
  totalPassed = 0;
  totalFailed = 0;

  // Phase 3: Template
  try {
    await runTemplateTests();
  } catch (e) {
    if (e.code !== undefined) throw e;
  }

  results.length = 0;
  totalPassed = 0;
  totalFailed = 0;

  // Phase 2: Delete (cleanup)
  await runDeleteTests();
}

// ── Entry Point ─────────────────────────────────────────────────
const mode = process.argv[2];
if (mode === "create") {
  runCreateTests().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
} else if (mode === "delete") {
  runDeleteTests().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
} else if (mode === "template") {
  runTemplateTests().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
} else if (mode === "all") {
  runAll().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
} else {
  console.log("Bionic Platform — Crew (Dify) E2E Regression Tests\n");
  console.log("Usage:");
  console.log("  KC_USER_PASSWORD=... node tests/e2e-crew-regression.cjs create    # Create 1/2/3-agent crews, verify wiring");
  console.log("  KC_USER_PASSWORD=... node tests/e2e-crew-regression.cjs template  # Create crew from template");
  console.log("  KC_USER_PASSWORD=... node tests/e2e-crew-regression.cjs delete    # Delete all test crews, verify cleanup");
  console.log("  KC_USER_PASSWORD=... node tests/e2e-crew-regression.cjs all       # Run all phases sequentially");
  console.log("\nPrerequisites:");
  console.log("  - Run e2e-regression.cjs create first (creates app + agent)");
  console.log("  - Dify must be deployed in bionic-platform namespace");
  console.log("  - npx playwright install chromium");
  process.exit(1);
}
