// packages/server/src/audit.ts
//
// Append-only JSONL audit log: one line per write attempt that reaches a brain
// (and per refused shared write). Fields: time, agentId, tool, brain, nodeId,
// plus optional edgeId / outcome / detail. Written synchronously so the log
// order matches the write order of the serialized write queue.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditRecord {
  time: string;
  agentId: string;
  tool: string;
  brain: string;
  nodeId: string | null;
  edgeId?: string;
  outcome: "ok" | "denied" | "error";
  detail?: string;
}

export class AuditLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(rec: Omit<AuditRecord, "time"> & { time?: string }): void {
    const line = JSON.stringify({ time: rec.time ?? new Date().toISOString(), ...rec }) + "\n";
    appendFileSync(this.path, line, { mode: 0o600 });
  }

  get file(): string {
    return this.path;
  }
}
