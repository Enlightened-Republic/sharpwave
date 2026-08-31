import type { BrainConfig } from "./types.js";

// Stub: skill evolution is a host-agent-specific feature (writes skills to the
// workspace skills directory and hooks into the agent's prompt pipeline).
// Not applicable in the standalone MCP server context.
export function detectSkillCandidates(_agentId: string, _config: BrainConfig): unknown[] {
  return [];
}

export function generateSkill(
  _agentId: string,
  _candidate: unknown,
  _config: BrainConfig,
  _log: { info: (msg: string) => void; warn: (msg: string) => void },
): null {
  return null;
}
