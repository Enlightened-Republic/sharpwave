// packages/core/src/procedures.ts — learning that becomes a step-by-step skill.
//
// When a plan the agent executed is marked done, sleep compiles its ordered
// steps into a `procedural` node ("Procedure: <title>", numbered steps) and
// keeps a ledger of how often that procedure succeeded or failed. After
// `procedureVerifyAfter` successful runs (default 2) with no more failures than
// successes, the procedure is VERIFIED (`nodes.verified_at`) and enters the
// always-on operational-rules block ("verified on THIS machine, follow them
// over your priors"). A later abandoned plan that matches a procedure counts as
// a failure; when failures catch up with successes the procedure is demoted
// (still recalled normally, no longer injected as a rule).
//
// This is the hippocampus → striatum handoff: episodic experience of doing a
// thing, repeated with success, becomes a procedure that runs without
// re-deriving it. Verification means "observed to work", never a regex match.
//
// Tables (schema v27, additive): `procedures` (one per procedural node) and
// `procedure_runs` (one per plan, so a plan is counted once).

import type Database from "better-sqlite3";
import { getDb, bumpWriteCounter } from "./db.js";
import { writeNode, getNode } from "./nodes.js";
import { writeEdge } from "./edges.js";
import { tokenSet } from "./decisions.js";
import type { BrainConfig } from "./types.js";

export const PROCEDURE_SOURCE = "sws:procedure";
const MIN_STEPS = 2;
const MATCH_SIM = 0.6;
type Log = { info: (m: string) => void; warn: (m: string) => void };

export interface ProcedureRow {
  node_id: string; title: string; steps_json: string; successes: number; failures: number;
  last_success_at: number | null; last_failure_at: number | null; verified_at: number | null; created_at: number; updated_at: number;
}
export interface ProcedureView extends ProcedureRow { steps: string[]; label: string }
export interface ProcedurePassResult { compiled: number; reinforced: number; failed: number; verified: number; demoted: number; ids: string[] }

export function proceduresEnabled(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'procedures'").get();
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
}
const normTitle = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function renderContent(title: string, steps: string[], successes: number, failures: number, verified: boolean): string {
  const head = `Procedure: ${title}. ${verified ? "Verified: " : "Unverified: "}worked ${successes} time${successes === 1 ? "" : "s"}${failures ? `, failed ${failures}` : ""}.`;
  return `${head}\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`.slice(0, 4000);
}

function matchProcedure(db: Database.Database, title: string, steps: string[]): ProcedureRow | null {
  const rows = db.prepare("SELECT p.* FROM procedures p JOIN nodes n ON n.id = p.node_id WHERE n.status = 'active' ORDER BY p.updated_at DESC LIMIT 500").all() as ProcedureRow[];
  const nt = normTitle(title);
  const mine = tokenSet(`${title} ${steps.join(" ")}`);
  let best: { row: ProcedureRow; sim: number } | null = null;
  for (const r of rows) {
    if (normTitle(r.title) === nt) return r;
    let theirs: string[] = [];
    try { theirs = JSON.parse(r.steps_json) as string[]; } catch { theirs = []; }
    const sim = jaccard(mine, tokenSet(`${r.title} ${theirs.join(" ")}`));
    if (sim >= MATCH_SIM && (!best || sim > best.sim)) best = { row: r, sim };
  }
  return best?.row ?? null;
}

/** Plans that finished (done) or were given up (abandoned) and have not been counted yet. */
function uncountedPlans(db: Database.Database): Array<{ node_id: string; title: string; status: string; updated_at: number; steps: string[] }> {
  const plans = db.prepare(`
    SELECT p.node_id, p.title, p.status, p.updated_at FROM plans p
    WHERE p.status IN ('done', 'abandoned')
      AND NOT EXISTS (SELECT 1 FROM procedure_runs r WHERE r.plan_id = p.node_id)
    ORDER BY p.updated_at ASC LIMIT 200
  `).all() as Array<{ node_id: string; title: string; status: string; updated_at: number }>;
  return plans.map((p) => ({
    ...p,
    steps: (db.prepare("SELECT text FROM plan_steps WHERE plan_id = ? AND status = 'done' ORDER BY idx").all(p.node_id) as Array<{ text: string }>).map((s) => s.text),
  }));
}

/**
 * The sleep pass. Idempotent: every plan is counted once (procedure_runs.plan_id).
 */
export function runProcedurePass(agentId: string, config: Partial<BrainConfig>, log?: Log, now = Date.now()): ProcedurePassResult {
  const res: ProcedurePassResult = { compiled: 0, reinforced: 0, failed: 0, verified: 0, demoted: 0, ids: [] };
  if (config.procedures === false) return res;
  const db = getDb(agentId);
  if (!proceduresEnabled(db)) return res;
  const verifyAfter = Math.max(1, Math.floor(config.procedureVerifyAfter ?? 2));
  const run = db.prepare("INSERT OR IGNORE INTO procedure_runs (procedure_id, plan_id, outcome, at) VALUES (?, ?, ?, ?)");
  const touched = new Set<string>();

  for (const plan of uncountedPlans(db)) {
    const steps = plan.steps.slice(0, 40);
    if (plan.status === "done") {
      if (steps.length < MIN_STEPS) { run.run(null, plan.node_id, "skipped", now); continue; } // one step is a fact, not a procedure
      const existing = matchProcedure(db, plan.title, steps);
      if (existing) {
        db.transaction(() => {
          db.prepare("UPDATE procedures SET successes = successes + 1, last_success_at = ?, steps_json = ?, updated_at = ? WHERE node_id = ?").run(plan.updated_at, JSON.stringify(steps), now, existing.node_id);
          run.run(existing.node_id, plan.node_id, "success", plan.updated_at);
        })();
        writeEdge(agentId, existing.node_id, plan.node_id, "derived_from", { writerAgentId: "system:sleep", meta: { procedure_run: "success" } });
        res.reinforced++; touched.add(existing.node_id);
        continue;
      }
      const id = writeNode(agentId, "procedural", `Procedure: ${plan.title.slice(0, 80)}`, renderContent(plan.title, steps, 1, 0, false), {
        importance: 0.8, source: PROCEDURE_SOURCE, writerAgentId: "system:sleep", sourceType: "self_observation", confidence: 0.7, deduplicate: false,
      });
      db.transaction(() => {
        db.prepare("INSERT INTO procedures (node_id, title, steps_json, successes, failures, last_success_at, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?, ?)")
          .run(id, plan.title, JSON.stringify(steps), plan.updated_at, now, now);
        run.run(id, plan.node_id, "success", plan.updated_at);
      })();
      writeEdge(agentId, id, plan.node_id, "derived_from", { writerAgentId: "system:sleep", meta: { procedure_run: "success" } });
      res.compiled++; res.ids.push(id); touched.add(id);
    } else {
      // abandoned: evidence against a procedure we already trust, never a new one
      const existing = steps.length ? matchProcedure(db, plan.title, steps) : null;
      if (!existing) { run.run(null, plan.node_id, "unmatched", now); continue; }
      db.transaction(() => {
        db.prepare("UPDATE procedures SET failures = failures + 1, last_failure_at = ?, updated_at = ? WHERE node_id = ?").run(plan.updated_at, now, existing.node_id);
        run.run(existing.node_id, plan.node_id, "failure", plan.updated_at);
      })();
      writeEdge(agentId, existing.node_id, plan.node_id, "derived_from", { writerAgentId: "system:sleep", meta: { procedure_run: "failure" } });
      res.failed++; touched.add(existing.node_id);
    }
  }

  // promotion / demotion + content refresh for everything touched
  for (const id of touched) {
    const p = db.prepare("SELECT * FROM procedures WHERE node_id = ?").get(id) as ProcedureRow | undefined;
    if (!p) continue;
    let steps: string[] = [];
    try { steps = JSON.parse(p.steps_json) as string[]; } catch { steps = []; }
    const shouldVerify = p.successes >= verifyAfter && p.successes > p.failures;
    const wasVerified = p.verified_at !== null;
    const verifiedAt = shouldVerify ? (p.verified_at ?? now) : null;
    db.transaction(() => {
      db.prepare("UPDATE procedures SET verified_at = ?, updated_at = ? WHERE node_id = ?").run(verifiedAt, now, id);
      db.prepare("UPDATE nodes SET content = ?, verified_at = ?, importance = MAX(importance, ?), updated_at = ? WHERE id = ?")
        .run(renderContent(p.title, steps, p.successes, p.failures, shouldVerify), verifiedAt, shouldVerify ? 0.9 : 0.8, now, id);
    })();
    if (shouldVerify && !wasVerified) { res.verified++; log?.info(`[xanima] procedure verified after ${p.successes} successful run(s): ${p.title}`); }
    if (!shouldVerify && wasVerified) { res.demoted++; log?.warn(`[xanima] procedure demoted (${p.failures} failure(s) vs ${p.successes} success(es)): ${p.title}`); }
  }
  if (touched.size) bumpWriteCounter(db);
  return res;
}

export function getProcedure(agentId: string, nodeIdOrPrefix: string): ProcedureView | null {
  const db = getDb(agentId);
  if (!proceduresEnabled(db)) return null;
  const r = (db.prepare("SELECT * FROM procedures WHERE node_id = ?").get(nodeIdOrPrefix)
    ?? (nodeIdOrPrefix.length >= 6 ? db.prepare("SELECT * FROM procedures WHERE node_id LIKE ? LIMIT 2").all(`${nodeIdOrPrefix}%`).length === 1 ? db.prepare("SELECT * FROM procedures WHERE node_id LIKE ?").get(`${nodeIdOrPrefix}%`) : undefined : undefined)) as ProcedureRow | undefined;
  if (!r) return null;
  let steps: string[] = [];
  try { steps = JSON.parse(r.steps_json) as string[]; } catch { steps = []; }
  return { ...r, steps, label: getNode(agentId, r.node_id)?.label ?? `Procedure: ${r.title}` };
}

export function listProcedures(agentId: string, o: { verified?: boolean; limit?: number } = {}): ProcedureView[] {
  const db = getDb(agentId);
  if (!proceduresEnabled(db)) return [];
  const rows = db.prepare(`SELECT p.* FROM procedures p JOIN nodes n ON n.id = p.node_id WHERE n.status = 'active'${o.verified === true ? " AND p.verified_at IS NOT NULL" : o.verified === false ? " AND p.verified_at IS NULL" : ""} ORDER BY p.verified_at IS NULL, p.successes DESC, p.updated_at DESC LIMIT ?`).all(o.limit ?? 50) as ProcedureRow[];
  return rows.map((r) => { let steps: string[] = []; try { steps = JSON.parse(r.steps_json) as string[]; } catch { /* */ } return { ...r, steps, label: `Procedure: ${r.title}` }; });
}

export function procedureCounts(db: Database.Database): { total: number; verified: number } {
  if (!proceduresEnabled(db)) return { total: 0, verified: 0 };
  const r = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN p.verified_at IS NOT NULL THEN 1 ELSE 0 END) AS verified FROM procedures p JOIN nodes n ON n.id = p.node_id WHERE n.status = 'active'").get() as { total: number; verified: number | null };
  return { total: r.total, verified: r.verified ?? 0 };
}

export function formatProcedure(p: ProcedureView, now = Date.now()): string {
  const ago = (t: number | null) => (t ? `${Math.max(0, Math.round((now - t) / 86_400_000))}d ago` : "never");
  return [`${p.node_id} ${p.label}  (${p.verified_at ? "VERIFIED" : "unverified"}: worked ${p.successes}×, failed ${p.failures}×; last success ${ago(p.last_success_at)})`, ...p.steps.map((s, i) => `  ${i + 1}. ${s}`)].join("\n");
}
