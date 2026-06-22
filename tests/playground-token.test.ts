/**
 * Unit tests for playgroundRouter token mint logic.
 *
 * Run with: npx tsx --test tests/playground-token.test.ts
 *
 * We don't spin up a real tRPC server. We exercise the same code path
 * directly: build a fake AccessToken from a fake Vault payload using the
 * exact constructor + grants the router uses, then assert the issued JWT
 * contains the right room, identity, agent dispatch and TTL.
 *
 * Side benefit: this verifies our LiveKit SDK pinning + RoomConfiguration
 * shape so a future SDK upgrade that breaks the agent dispatch path is
 * caught at test time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AccessToken, TokenVerifier } from "livekit-server-sdk";
import { RoomAgentDispatch, RoomConfiguration } from "@livekit/protocol";

const FAKE_KEY = "APItestkey1234";
const FAKE_SECRET = "test-secret-must-be-long-enough-for-hs256-32b";

async function mintPlaygroundToken(opts: {
  apiKey: string;
  apiSecret: string;
  roomName: string;
  identity: string;
  displayName: string;
  agentName: string;
  ttlSeconds: number;
}) {
  const at = new AccessToken(opts.apiKey, opts.apiSecret, {
    identity: opts.identity,
    name: opts.displayName,
    ttl: opts.ttlSeconds,
  });
  at.addGrant({
    roomJoin: true,
    room: opts.roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    roomCreate: true,
  });
  at.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName: opts.agentName })],
  });
  return at.toJwt();
}

test("playground token: round-trips through TokenVerifier with correct grants", async () => {
  const token = await mintPlaygroundToken({
    apiKey: FAKE_KEY,
    apiSecret: FAKE_SECRET,
    roomName: "pg-astro-lab-11-abcd1234-deadbeef",
    identity: "kc-sub-uuid",
    displayName: "Test Analyst",
    agentName: "star-guide",
    ttlSeconds: 3600,
  });
  const verifier = new TokenVerifier(FAKE_KEY, FAKE_SECRET);
  const claims = await verifier.verify(token);
  assert.equal((claims as any).sub, "kc-sub-uuid");
  assert.equal((claims as any).name, "Test Analyst");
  const video = (claims as any).video;
  assert.equal(video.roomJoin, true);
  assert.equal(video.room, "pg-astro-lab-11-abcd1234-deadbeef");
  assert.equal(video.canPublish, true);
  assert.equal(video.canSubscribe, true);
  assert.equal(video.canPublishData, true);
  assert.equal(video.roomCreate, true);
  // RoomConfiguration is encoded into the JWT under "roomConfig" or
  // "roomConfiguration" depending on protocol version. Check both.
  const rc = (claims as any).roomConfig || (claims as any).roomConfiguration;
  assert.ok(rc, "roomConfig should be present in claims");
  assert.ok(rc.agents && rc.agents.length === 1, "expected exactly one agent dispatch");
  // The dispatch field name is `agent_name` (snake) in the protocol JSON form
  // and `agentName` in the JS object form — accept either.
  const dispatched = rc.agents[0].agentName ?? rc.agents[0].agent_name;
  assert.equal(dispatched, "star-guide");
});

test("playground token: rejects join without identity (sanity)", async () => {
  const at = new AccessToken(FAKE_KEY, FAKE_SECRET, { ttl: 60 });
  at.addGrant({ roomJoin: true, room: "x" });
  await assert.rejects(() => at.toJwt(), /identity is required/);
});

test("playground token: TTL clamps to roughly the requested window", async () => {
  const ttl = 1800; // 30 min
  const before = Math.floor(Date.now() / 1000);
  const token = await mintPlaygroundToken({
    apiKey: FAKE_KEY,
    apiSecret: FAKE_SECRET,
    roomName: "r",
    identity: "u",
    displayName: "U",
    agentName: "a",
    ttlSeconds: ttl,
  });
  const verifier = new TokenVerifier(FAKE_KEY, FAKE_SECRET);
  const claims = await verifier.verify(token);
  const exp = (claims as any).exp as number;
  // Allow a generous +/- 30s window for clock skew + test latency.
  assert.ok(exp >= before + ttl - 30 && exp <= before + ttl + 30, `exp ${exp} not within ttl window`);
});
