type Logger = { info: (msg: string) => void; warn: (msg: string) => void };

// Stub: entity resolution is not bundled in the MCP server to keep it dependency-free.
// Coreference merging via LLM is a host-agent-specific consolidation step.
export function mergeCoreferentNodes(_agentId: string, _log: Logger): number {
  return 0;
}
