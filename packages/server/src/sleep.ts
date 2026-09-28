// packages/server/src/sleep.ts
//
// In-process sleep/consolidation. One cycle walks every brain (round-robin
// from where the last cycle stopped), running core's runConsolidation on that
// brain's serialized write queue — so it never races tool writes. A single
// wall-clock budget covers the whole cycle: once it is spent, remaining brains
// wait for the next cycle. A running consolidation is never interrupted (core
// has no cancellation); the budget is checked between brains. Only one cycle
// runs at a time.

import { runConsolidation, shouldConsolidate } from "sharpwave-core";
import type { BrainConfig } from "sharpwave-core";

import type { BrainManager } from "./brains.js";
import type { AuditLog } from "./audit.js";
import type { Logger } from "./log.js";

export interface SleepReport {
  startedAt: string;
  ran: string[];
  skippedGate: string[];
  deferred: string[];
  failed: Array<{ brain: string; error: string }>;
  elapsedMs: number;
}

export class SleepRunner {
  private cursor = 0;
  private running: Promise<SleepReport> | null = null;

  constructor(
    private readonly brains: BrainManager,
    private readonly brainConfig: BrainConfig,
    private readonly budgetMs: number,
    private readonly respectGate: boolean,
    private readonly log: Logger,
    private readonly audit: AuditLog,
  ) {}

  runCycle(opts: { force?: boolean } = {}): Promise<SleepReport> {
    if (this.running) return this.running;
    this.running = this.cycle(opts).finally(() => { this.running = null; });
    return this.running;
  }

  private async cycle(opts: { force?: boolean }): Promise<SleepReport> {
    const t0 = Date.now();
    const report: SleepReport = { startedAt: new Date(t0).toISOString(), ran: [], skippedGate: [], deferred: [], failed: [], elapsedMs: 0 };
    const all = this.brains.listBrains();
    const n = all.length;
    const order = all.map((_, i) => all[(this.cursor + i) % n]!);
    let visited = 0;
    for (const brain of order) {
      if (Date.now() - t0 >= this.budgetMs) {
        report.deferred.push(brain);
        continue;
      }
      visited++;
      try {
        this.brains.open(brain);
        if (this.respectGate && !opts.force && !shouldConsolidate(brain, this.brainConfig)) {
          report.skippedGate.push(brain);
          continue;
        }
        await this.brains.write(brain, () => runConsolidation(brain, this.brainConfig, {
          info: (m) => this.log.info(m),
          warn: (m) => this.log.warn(m),
        }));
        report.ran.push(brain);
        this.audit.append({ agentId: "system:sleep", tool: "consolidation", brain, nodeId: null, outcome: "ok" });
      } catch (e) {
        const error = String(e instanceof Error ? e.message : e);
        report.failed.push({ brain, error });
        this.audit.append({ agentId: "system:sleep", tool: "consolidation", brain, nodeId: null, outcome: "error", detail: error });
        this.log.warn(`sleep: consolidation failed for brain ${brain}: ${error}`);
      }
    }
    this.cursor = n > 0 ? (this.cursor + visited) % n : 0;
    report.elapsedMs = Date.now() - t0;
    this.log.info(`sleep cycle: ran=${report.ran.length} gated=${report.skippedGate.length} deferred=${report.deferred.length} failed=${report.failed.length} in ${report.elapsedMs}ms`);
    return report;
  }
}
