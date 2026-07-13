/**
 * Regression tests for Letta cleanup on agent deletion.
 *
 * Bug (adversarial review finding #1): deleting an agent never removed its
 * Letta agent or per-user memory blocks — they leaked on the Letta server
 * forever. `cleanupLettaForAgent` is the extracted, unit-testable cleanup
 * primitive wired into both the per-agent delete mutation and the app-level
 * deletion job. It MUST attempt every deletion and MUST NOT throw, so that a
 * dead/slow Letta server can never wedge the caller's DB row deletion.
 *
 * Run: npx tsx --test tests/letta-agent-delete.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupLettaForAgent } from "../server/services/agentCleanup.ts";

function makeSpyClient(opts: { failAgent?: boolean; failBlockId?: string } = {}) {
  const calls = { deleteAgent: [] as string[], deleteBlock: [] as string[] };
  return {
    calls,
    client: {
      async deleteAgent(id: string) {
        calls.deleteAgent.push(id);
        if (opts.failAgent) throw new Error("letta down");
      },
      async deleteBlock(id: string) {
        calls.deleteBlock.push(id);
        if (opts.failBlockId && id === opts.failBlockId) throw new Error("block gone");
      },
    },
  };
}

test("deletes the Letta agent and every user block", async () => {
  const { client, calls } = makeSpyClient();
  const result = await cleanupLettaForAgent(client, {
    lettaAgentId: "agent-123",
    userBlockIds: ["block-a", "block-b"],
  });
  assert.deepEqual(calls.deleteAgent, ["agent-123"]);
  assert.deepEqual(calls.deleteBlock, ["block-a", "block-b"]);
  assert.equal(result.agentDeleted, true);
  assert.equal(result.blocksDeleted, 2);
  assert.equal(result.agentFailed, false);
});

test("does not throw when Letta agent delete fails, and still attempts blocks first", async () => {
  const { client, calls } = makeSpyClient({ failAgent: true });
  const result = await cleanupLettaForAgent(client, {
    lettaAgentId: "agent-x",
    userBlockIds: ["block-1"],
  });
  // Blocks are attempted regardless; agent failure is captured, not thrown.
  assert.deepEqual(calls.deleteBlock, ["block-1"]);
  assert.deepEqual(calls.deleteAgent, ["agent-x"]);
  assert.equal(result.agentFailed, true);
  assert.equal(result.agentDeleted, false);
});

test("a failing block delete does not stop the remaining blocks or the agent delete", async () => {
  const { client, calls } = makeSpyClient({ failBlockId: "block-a" });
  const result = await cleanupLettaForAgent(client, {
    lettaAgentId: "agent-9",
    userBlockIds: ["block-a", "block-b"],
  });
  assert.deepEqual(calls.deleteBlock, ["block-a", "block-b"]);
  assert.deepEqual(calls.deleteAgent, ["agent-9"]);
  assert.equal(result.blocksDeleted, 1);
  assert.equal(result.blockFailures, 1);
  assert.equal(result.agentDeleted, true);
});

test("skips the agent delete when there is no lettaAgentId but still deletes blocks", async () => {
  const { client, calls } = makeSpyClient();
  const result = await cleanupLettaForAgent(client, {
    lettaAgentId: null,
    userBlockIds: ["block-only"],
  });
  assert.deepEqual(calls.deleteAgent, []);
  assert.deepEqual(calls.deleteBlock, ["block-only"]);
  assert.equal(result.agentDeleted, false);
  assert.equal(result.agentFailed, false);
  assert.equal(result.blocksDeleted, 1);
});
