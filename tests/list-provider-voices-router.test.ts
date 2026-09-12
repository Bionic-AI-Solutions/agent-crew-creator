/**
 * Drives the REAL agentsCrud.listProviderVoices procedure — real router, real
 * Drizzle schema pushed into an in-memory Postgres (pglite), real
 * voiceProviders.ts — with only the network stubbed to the in-cluster
 * gateway's captured responses (tests/fixtures/, 2026-09-12).
 *
 * Why this exists: the STT picker for gpu-ai showed the TTS voice list. The
 * service-level tests in voice-providers.test.ts pass even if the router
 * drops `pipeline` from its lookups again — which is exactly where the bug
 * lived. This test fails if it is dropped from isSupportedVoiceProvider or
 * listVoicesForProvider. Dropping it from voiceProviderNeedsKey is NOT
 * caught: both gpu-ai entries are keyless, so the answer is the same either
 * way today.
 *
 * Run: npx tsx --test --test-force-exit tests/list-provider-voices-router.test.ts
 * (--test-force-exit is required: importing server/_core/trpc.js leaves a
 * timer open, see app-membership.test.ts.)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createRequire } from "node:module";
import * as schema from "../drizzle/schema.js";
import * as platform from "../drizzle/platformSchema.js";

// drizzle-kit's ESM build does a dynamic require("fs") that Node's ESM loader
// rejects; the CJS build works through createRequire.
const { pushSchema } = createRequire(import.meta.url)("drizzle-kit/api");

const MODELS = JSON.parse(readFileSync(new URL("./fixtures/gpu-ai-v1-models.json", import.meta.url), "utf8"));
const VOICES = JSON.parse(readFileSync(new URL("./fixtures/gpu-ai-v1-audio-voices.json", import.meta.url), "utf8"));

let pg: PGlite;
let caller: any;
let agentId: number;
const calls: string[] = [];
const realFetch = globalThis.fetch;
/** What the stubbed /v1/models answers; tests may swap it to model a degraded gateway. */
let modelsBody: any = MODELS;

before(async () => {
  pg = new PGlite();
  const db = drizzle(pg, { schema: { ...schema, ...platform } });
  const { apply } = await pushSchema({ ...schema, ...platform }, db as any);
  await apply();
  const [app] = await db.insert(platform.apps).values({ name: "A", slug: "a", livekitUrl: "wss://x" } as any).returning();
  const [agent] = await db.insert(platform.agentConfigs).values({ appId: app.id, name: "main" } as any).returning();
  agentId = agent.id;
  const { agentRouter } = await import("../server/agentRouter.js");
  caller = agentRouter.createCaller({
    req: {} as any, res: {} as any, db: db as any,
    user: { sub: "u1", email: "u1@example.com", name: "U", role: "admin", platformRole: "admin", realmRoles: [] },
  });
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    const body = url.endsWith("/v1/models") ? modelsBody : url.endsWith("/v1/audio/voices") ? VOICES : null;
    if (!body) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await pg.close();
});

test("router: gpu-ai + pipeline=stt answers with STT models from /v1/models, live", async () => {
  calls.length = 0;
  const r = await caller.listProviderVoices({ agentId, provider: "gpu-ai", pipeline: "stt" });
  assert.equal(r.source, "live");
  assert.deepEqual(calls.map((u) => u.replace(/^.*\/v1\//, "/v1/")), ["/v1/models"]);
  assert.deepEqual(r.voices.map((v: any) => v.id).sort(), ["faster-whisper"]);
});

test("router: gpu-ai + pipeline=tts still answers with the voice list", async () => {
  calls.length = 0;
  const r = await caller.listProviderVoices({ agentId, provider: "gpu-ai", pipeline: "tts" });
  assert.equal(r.source, "live");
  assert.deepEqual(calls.map((u) => u.replace(/^.*\/v1\//, "/v1/")), ["/v1/audio/voices"]);
  assert.equal(r.voices.length, VOICES.data.voices.length);
});

test("router: gpu-ai with no pipeline keeps the TTS default", async () => {
  calls.length = 0;
  const r = await caller.listProviderVoices({ agentId, provider: "gpu-ai" });
  assert.match(calls[0], /\/v1\/audio\/voices$/);
  assert.equal(r.voices.length, VOICES.data.voices.length);
});

test("router: a TTS-only provider asked for stt is unsupported AND its voices are not served", async () => {
  calls.length = 0;
  const r = await caller.listProviderVoices({ agentId, provider: "elevenlabs", pipeline: "stt" });
  assert.equal(r.supported, false);
  assert.equal(r.source, "fallback");
  assert.deepEqual(r.voices, [], "the client does not read `supported`; the list itself must be empty");
  assert.equal(calls.length, 0, "no network call for an unsupported pipeline");
});

test("router: a /v1/models answer without capability tags is a discovery failure, not an empty catalogue", async () => {
  modelsBody = { object: "list", data: MODELS.data.map(({ capabilities, ...m }: any) => m) };
  try {
    const r = await caller.listProviderVoices({ agentId, provider: "gpu-ai", pipeline: "stt" });
    assert.equal(r.source, "fallback");
    assert.ok(r.voices.length > 0);
    assert.equal(r.voices.some((v: any) => v.id === "Severus"), false);
  } finally {
    modelsBody = MODELS;
  }
});

test("router: saving a TTS voice name as the gpu-ai STT model is rejected; STT models and gateway aliases are accepted", async () => {
  await assert.rejects(
    () => caller.update({ id: agentId, sttProvider: "gpu-ai", sttModel: "Severus" }),
    (err: any) => err.code === "BAD_REQUEST" && /Severus/.test(err.message) && /faster-whisper/.test(err.message),
  );
  const a = await caller.update({ id: agentId, sttProvider: "gpu-ai", sttModel: "faster-whisper" });
  assert.equal(a.sttModel, "faster-whisper");
  // Not on /v1/models, but an alias the transcription endpoint accepts
  // (mcp-api-server audio_service._WHISPER_ALIASES). Must not be rejected.
  const b = await caller.update({ id: agentId, sttProvider: "gpu-ai", sttModel: "whisper-large-v3-turbo-ct2" });
  assert.equal(b.sttModel, "whisper-large-v3-turbo-ct2");
  // faster-whisper shares gpu-ai's runtime endpoint, so it gets the same gate.
  await assert.rejects(
    () => caller.update({ id: agentId, sttProvider: "faster-whisper", sttModel: "Severus" }),
    (err: any) => err.code === "BAD_REQUEST",
  );
});

test("router: the gate matches voice names the way the gateway does -- case and whitespace do not bypass it", async () => {
  for (const v of ["severus", " Severus", "SEVERUS "]) {
    await assert.rejects(
      () => caller.update({ id: agentId, sttProvider: "gpu-ai", sttModel: v }),
      (err: any) => err.code === "BAD_REQUEST",
      JSON.stringify(v),
    );
  }
  // ...and neither does a padded or differently-cased provider name.
  for (const p of ["GPU-AI", "gpu-ai ", " Faster-Whisper"]) {
    await assert.rejects(
      () => caller.update({ id: agentId, sttProvider: p, sttModel: "Severus" }),
      (err: any) => err.code === "BAD_REQUEST",
      JSON.stringify(p),
    );
  }
  // Restore a valid provider spelling for the tests that follow.
  await caller.update({ id: agentId, sttProvider: "gpu-ai", sttModel: "faster-whisper" });
});

test("router: a withheld model (sensevoice) is rejected on save, not only hidden from the picker", async () => {
  await assert.rejects(
    () => caller.update({ id: agentId, sttProvider: "gpu-ai", sttModel: "sensevoice" }),
    (err: any) => err.code === "BAD_REQUEST" && /not deployed/.test(err.message),
  );
});

test("router: Deploy on a row already holding a TTS voice name is refused before anything is written", async () => {
  // Poison the row directly, as the bug did (the save gate did not exist then).
  const { drizzle: mk } = await import("drizzle-orm/pglite");
  const { eq } = await import("drizzle-orm");
  const db = mk(pg);
  await db.update(platform.agentConfigs).set({ sttModel: "Severus", deployed: false, deploymentStatus: "draft" } as any).where(eq(platform.agentConfigs.id, agentId));
  await assert.rejects(
    () => caller.deploy({ id: agentId }),
    (err: any) => err.code === "BAD_REQUEST" && /Cannot deploy/.test(err.message) && /TTS voice/.test(err.message),
  );
  const [row] = await db.select().from(platform.agentConfigs).where(eq(platform.agentConfigs.id, agentId));
  assert.equal(row.deployed, false, "the refused deploy must not mark the agent deployed");
  assert.equal(row.deploymentStatus, "draft");
  await db.update(platform.agentConfigs).set({ sttModel: "faster-whisper" } as any).where(eq(platform.agentConfigs.id, agentId));
});

test("router: an empty gpu-ai voice list is a skipped check, not a pass (fails open, logged as skipped)", async () => {
  const stubbed = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: { voices: [] } }), { status: 200 })) as typeof fetch;
  const warns: string[] = [];
  const infos: string[] = [];
  const realWarn = console.warn, realInfo = console.info;
  console.warn = (...a: any[]) => { warns.push(a.join(" ")); };
  console.info = (...a: any[]) => { infos.push(a.join(" ")); };
  try {
    const r = await caller.update({ id: agentId, sttProvider: "gpu-ai", sttModel: "faster-whisper" });
    assert.equal(r.sttModel, "faster-whisper", "the save proceeds");
    assert.ok(warns.some((w) => /STT model validation skipped/.test(w)), "the skipped check is logged as a warning");
    assert.equal(infos.some((i) => /Validated stt_model/.test(i)), false, "an empty list must not be logged as a pass");
  } finally {
    console.warn = realWarn; console.info = realInfo;
    globalThis.fetch = stubbed;
  }
});

test("router: a gateway outage does not block a save (the STT check fails open)", async () => {
  const stubbed = globalThis.fetch;
  globalThis.fetch = (async () => new Response("upstream down", { status: 503 })) as typeof fetch;
  try {
    const r = await caller.update({ id: agentId, sttProvider: "gpu-ai", sttModel: "faster-whisper" });
    assert.equal(r.sttModel, "faster-whisper");
  } finally {
    globalThis.fetch = stubbed;
  }
});
