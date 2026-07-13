/**
 * Cleanup primitives for tearing down an agent's external (Letta) resources.
 *
 * Extracted so the delete paths (per-agent tRPC delete + app-level deletion
 * job) share one correct, unit-testable implementation. Every deletion is
 * attempted and NONE throws out of this function: a dead or slow Letta server
 * must never wedge the caller's authoritative DB row deletion. Failures are
 * reported in the returned summary (and logged via the optional logger) so the
 * caller can surface them without aborting.
 */

export interface LettaCleanupClient {
  deleteAgent(agentId: string): Promise<void>;
  deleteBlock(blockId: string): Promise<void>;
}

export interface AgentCleanupInput {
  /** The Letta agent id stored on the agent config row, if any. */
  lettaAgentId?: string | null;
  /** lettaBlockId values of every user memory block owned by this agent. */
  userBlockIds: string[];
}

export interface AgentCleanupResult {
  agentDeleted: boolean;
  agentFailed: boolean;
  blocksDeleted: number;
  blockFailures: number;
}

type WarnFn = (message: string, meta?: Record<string, unknown>) => void;

export async function cleanupLettaForAgent(
  letta: LettaCleanupClient,
  input: AgentCleanupInput,
  logWarn: WarnFn = () => {},
): Promise<AgentCleanupResult> {
  let blocksDeleted = 0;
  let blockFailures = 0;

  // Delete per-user memory blocks first — they belong to the agent and would
  // otherwise dangle on the Letta server with no owning row.
  for (const blockId of input.userBlockIds) {
    if (!blockId) continue;
    try {
      await letta.deleteBlock(blockId);
      blocksDeleted++;
    } catch (err) {
      blockFailures++;
      logWarn("Failed to delete Letta user block", { blockId, error: String(err) });
    }
  }

  let agentDeleted = false;
  let agentFailed = false;
  if (input.lettaAgentId) {
    try {
      await letta.deleteAgent(input.lettaAgentId);
      agentDeleted = true;
    } catch (err) {
      agentFailed = true;
      logWarn("Failed to delete Letta agent", {
        lettaAgentId: input.lettaAgentId,
        error: String(err),
      });
    }
  }

  return { agentDeleted, agentFailed, blocksDeleted, blockFailures };
}
