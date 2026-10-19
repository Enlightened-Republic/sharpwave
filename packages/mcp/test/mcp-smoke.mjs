#!/usr/bin/env node
// End-to-end MCP smoke test against the local build (dist/index.js).
//
// Simulates a stranger's environment, which is where every bug found in this
// package so far has lived: no Ollama (embedding host points at a dead port),
// no OpenRouter key, isolated data dir. Run it before publishing:
//
//   npm run build && npm run test:mcp
//
// Covers the three shipped regressions:
//   0.1.0  FTS exact-phrase search made natural-language recall return nothing
//          without a local embedding provider.
//   0.1.1  Working memory was a single global bucket shared across processes.
//   0.2.1  workingMemoryBoost INSERTED nodes the query never surfaced, so within
//          one long-lived MCP session every query polluted the next.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "dist", "index.js");
const DATA = mkdtempSync(join(tmpdir(), "xanima-smoke-"));

let lastStderr = "";
function client(envOverride = { XANIMA_AGENT_ID: "smoke" }) {
  const proc = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      XANIMA_DATA_DIR: DATA,
      SHARPWAVE_DATA_DIR: "",
      OLLAMA_BASE_URL: "http://127.0.0.1:59999",
      OPENROUTER_API_KEY: "",
      XANIMA_OPENROUTER_API_KEY: "",
      SHARPWAVE_OPENROUTER_API_KEY: "",
      XANIMA_AGENT_ID: "",
      SHARPWAVE_AGENT_ID: "",
      XANIMA_NO_UPDATE_CHECK: "1",
      ...envOverride,
    },
  });
  let buf = ""; const pending = new Map(); let id = 1;
  proc.stdout.on("data", (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  proc.stderr.on("data", (d) => { lastStderr += d.toString(); });
  const rpc = (method, params) => {
    const rid = id++;
    return new Promise((res) => {
      const t = setTimeout(() => { pending.delete(rid); res({ __timeout: true }); }, 30000);
      pending.set(rid, (m) => { clearTimeout(t); res(m); });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
    });
  };
  const notify = (m, p) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n");
  return { proc, rpc, notify };
}

const text = (r) => { try { return r.result.content.map((c) => c.text).join("\n"); } catch { return JSON.stringify(r); } };
const call = (c, name, args) => c.rpc("tools/call", { name, arguments: args });
let failures = 0;
const check = (name, pass, detail) => {
  if (!pass) failures++;
  console.log(`${pass ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const ONTOPIC = "what database do we use in production?";
const UNRELATED = "how do I bake sourdough bread at high altitude?";
const leaked = (t) => /postgres|jwt|thursday/i.test(t);

(async () => {
  const a = client();
  const init = await a.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  check("initialize", !!init.result, `v${init?.result?.serverInfo?.version}`);
  a.notify("notifications/initialized", {});

  const tools = await a.rpc("tools/list", {});
  check("tools/list", (tools?.result?.tools?.length ?? 0) > 0, `${tools?.result?.tools?.length} tools`);

  for (const [label, content] of [
    ["Postgres is the primary datastore", "The production database is PostgreSQL 16 running on RDS in us-east-1."],
    ["Deploys go out on Thursdays", "The team ships to production every Thursday afternoon after staging soak."],
    ["Auth uses short-lived JWTs", "Authentication issues JWT access tokens with a fifteen minute expiry."],
  ]) {
    await call(a, "brain_write", { type: "semantic", label, content });
  }
  check("brain_write x3 without an embedding provider", true);

  // 0.1.0 regression — NL recall must work on FTS alone.
  const hit = text(await call(a, "brain_query", { query: ONTOPIC }));
  check("NL query hits via FTS fallback", /postgres/i.test(hit), /postgres/i.test(hit) ? "" : hit.slice(0, 120));

  // 0.2.1 regression — a warm session must not leak the prior answer.
  const after = text(await call(a, "brain_query", { query: UNRELATED }));
  check("unrelated query misses with WARM working memory", !leaked(after), leaked(after) ? `LEAKED: ${after.slice(0, 120)}` : "");

  // Xanima 0.1.0 belief tools over MCP: retract, supersede with reason, as_of, status.
  const toolNames = (tools?.result?.tools ?? []).map((t) => t.name);
  check("tools/list has brain_retract + brain_status", toolNames.includes("brain_retract") && toolNames.includes("brain_status"), toolNames.join(","));
  const w1 = text(await call(a, "brain_write", { type: "semantic", label: "Office city", content: "The team office is in Lisbon near the river.", confidence: "low", source_type: "user" }));
  const oid = /node (\S+)/.exec(w1)?.[1] ?? "";
  const lowHit = text(await call(a, "brain_query", { query: "where is the team office" }));
  check("brain_query shows confidence + source + relative time", /conf=low src=user \(just now\)/.test(lowHit), lowHit.slice(0, 200));
  const tBefore = Date.now();
  await new Promise((r) => setTimeout(r, 20));
  const sup = text(await call(a, "brain_supersede", { old_node_id: oid, new_content: "The team office moved to Porto in 2026.", reason: "user said the office moved" }));
  check("brain_supersede with reason", /Superseded:/.test(sup) && /Reason: user said the office moved/.test(sup), sup.slice(0, 160));
  const now = text(await call(a, "brain_query", { query: "team office" }));
  check("superseded version no longer recalled", /Porto/.test(now) && !/Lisbon/.test(now), now.slice(0, 200));
  const then = text(await call(a, "brain_query", { query: "team office", as_of: tBefore }));
  check("as_of finds what was believed then", /Lisbon/.test(then) && /since then: superseded/.test(then), then.slice(0, 240));
  const newId = /new node (\S+)/.exec(sup)?.[1] ?? "";
  const q2 = text(await call(a, "brain_query", { query: "Porto office" }));
  const fullNew = /\[([0-9a-f]{8})\]/.exec(q2)?.[1];
  check("superseded node id prefix present", !!fullNew && newId.startsWith(fullNew), `${newId} vs ${fullNew}`);
  const statusTxt = text(await call(a, "brain_status", {}));
  check("brain_status reports superseded + injection estimate", /superseded 1/.test(statusTxt) && /injection: ~\d+ tokens/.test(statusTxt), statusTxt.slice(0, 240));
  // Xanima 0.2.0: decision ledger + goals over MCP
  check("tools/list has the 0.2.0 decision + goal tools", ["brain_record_decision", "brain_update_decision_outcome", "brain_query_decisions", "brain_set_goal", "brain_update_goal", "brain_list_goals"].every((n) => toolNames.includes(n)), toolNames.join(","));
  const goalTxt = text(await call(a, "brain_set_goal", { title: "Ship the smoke test", priority: "high" }));
  const goalId = /Goal set: (\S+)/.exec(goalTxt)?.[1] ?? "";
  check("brain_set_goal", /P2 \[active\] Ship the smoke test/.test(goalTxt), goalTxt.slice(0, 160));
  const decTxt = text(await call(a, "brain_record_decision", { context: "smoke runner", chosen: "node --test", options: ["vitest"], goal_id: goalId }));
  const decId = /decision ([0-9a-f-]{36})/.exec(decTxt)?.[1] ?? "";
  check("brain_record_decision linked to the goal", !!decId && /advances goal "Ship the smoke test"/.test(decTxt), decTxt.slice(0, 160));
  const outTxt = text(await call(a, "brain_update_decision_outcome", { decision_id: decId, outcome: "ran in 2s", outcome_status: "matched", lesson: "keep smoke tests dependency-free" }));
  check("brain_update_decision_outcome logs goal progress", /Progress logged on goal/.test(outTxt), outTxt.slice(0, 160));
  const supTxt = text(await call(a, "brain_update_goal", { goal_id: goalId, action: "supersede", title: "Ship the smoke test v2", reason: "scope grew" }));
  check("brain_update_goal supersede keeps history", /v1 → v2/.test(supTxt), supTxt.slice(0, 160));
  const qd = text(await call(a, "brain_query_decisions", { query: "smoke" }));
  check("brain_query_decisions", /chose: node --test/.test(qd) && /lesson: keep smoke tests dependency-free/.test(qd), qd.slice(0, 200));
  // Xanima 0.3.0 over MCP: reflection, replay, open items, commitments, plans, meta-tools
  check("tools/list has the 0.3.0 tools", ["brain_reflect", "brain_replay", "brain_hypothesis", "brain_question", "brain_list_open", "brain_commit", "brain_commitments", "brain_plan", "brain_changes", "brain_conflicts", "brain_briefing", "brain_forget_impact"].every((n) => toolNames.includes(n)), toolNames.join(","));
  const refl = text(await call(a, "brain_reflect", { goal_id: goalId }));
  check("brain_reflect (goal) stores what worked", /What worked:[\s\S]*node --test/.test(refl) && /stored as/.test(refl), refl.slice(0, 200));
  const rp = text(await call(a, "brain_replay", { goal_id: goalId, k: 2 }));
  check("brain_replay for the goal", /Replay for goal/.test(rp) && /MATCHED/.test(rp), rp.slice(0, 200));
  const hy = text(await call(a, "brain_hypothesis", { action: "create", statement: "the smoke runner is flaky on cold start", evidence: "one timeout" }));
  const hyId = /hypothesis ([0-9a-f-]{36})/.exec(hy)?.[1] ?? "";
  const hyR = text(await call(a, "brain_hypothesis", { action: "refute", id: hyId, evidence: "50 cold starts, no timeouts" }));
  check("brain_hypothesis create → refute", /refuted/.test(hyR), hyR.slice(0, 160));
  const qq = text(await call(a, "brain_question", { action: "ask", question: "Should the smoke test run on Windows too?" }));
  const lo = text(await call(a, "brain_list_open", {}));
  check("brain_question + brain_list_open", /Question/.test(qq) && /Windows too/.test(lo), lo.slice(0, 160));
  const cm = text(await call(a, "brain_commit", { action: "create", title: "send the smoke report", due: "1 day ago" }));
  const cms = text(await call(a, "brain_commitments", { status: "overdue" }));
  check("brain_commit + brain_commitments (overdue)", /Commitment recorded/.test(cm) && /OVERDUE/.test(cms), cms.slice(0, 160));
  const pl = text(await call(a, "brain_plan", { action: "create", title: "smoke rollout", steps: ["write", "run"], goal_id: goalId }));
  const plId = /^([0-9a-f-]{36}) Plan/m.exec(pl)?.[1] ?? "";
  await call(a, "brain_plan", { action: "park", plan_id: plId, note: "waiting" });
  const res = text(await call(a, "brain_plan", { action: "resume", plan_id: plId }));
  check("brain_plan park → resume briefing", /Plan resumed/.test(res) && /Still open: 2 of 2 steps/.test(res), res.slice(0, 200));
  const chg = text(await call(a, "brain_changes", { goal_id: goalId, days: 1 }));
  const cfl = text(await call(a, "brain_conflicts", { topic: "smoke runner flaky" }));
  const brf = text(await call(a, "brain_briefing", { goal_id: goalId }));
  const fi = text(await call(a, "brain_forget_impact", { query: "smoke" }));
  check("meta-tools: changes / conflicts / briefing / forget_impact", /Changes about goal/.test(chg) && /Refuted hypotheses/.test(cfl) && /^Briefing/.test(brf) && /dry run — nothing changed/.test(fi), [chg, cfl, brf, fi].map((x) => x.slice(0, 60)).join(" | "));
  const badRetract = text(await call(a, "brain_retract", { node_id: "nope", reason: "x" }));
  check("brain_retract unknown id errors", /not found/.test(badRetract), badRetract.slice(0, 80));

  // brain_reset — refuses without the exact agent id, then wipes everything.
  const refused = text(await call(a, "brain_reset", { confirm: "wrong" }));
  check("brain_reset refuses a bad confirm", /refused/i.test(refused), refused.slice(0, 80));
  const still = text(await call(a, "brain_query", { query: ONTOPIC }));
  check("brain still intact after a refused reset", /postgres/i.test(still), still.slice(0, 80));

  const wiped = text(await call(a, "brain_reset", { confirm: "smoke" }));
  check("brain_reset succeeds with the right confirm", /Brain reset/i.test(wiped) && /Backup:/.test(wiped), wiped.slice(0, 120));
  const stats = text(await call(a, "brain_stats", {}));
  check("brain has 0 nodes after reset", /\b0\b/.test(stats) && !/postgres/i.test(text(await call(a, "brain_query", { query: ONTOPIC }))), stats.slice(0, 120));

  // Writing works again after a reset (embedding path untouched).
  await call(a, "brain_write", { type: "semantic", label: "post-reset write", content: "The cache layer is Redis 7 on ElastiCache." });
  const postReset = text(await call(a, "brain_query", { query: "what cache do we use?" }));
  check("brain_write + recall work after a reset", /redis/i.test(postReset), postReset.slice(0, 120));

  a.proc.kill();
  await new Promise((r) => setTimeout(r, 500));

  // 0.1.1 regression — a brand new process must start clean.
  const b = client();
  await b.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  b.notify("notifications/initialized", {});
  const fresh = text(await call(b, "brain_query", { query: UNRELATED }));
  check("unrelated query misses in a fresh process", !leaked(fresh), leaked(fresh) ? `LEAKED: ${fresh.slice(0, 120)}` : "");
  b.proc.kill();

  // ── Deprecated alias: SHARPWAVE_AGENT_ID still pins the agent (0.1.x), with a warning ──
  lastStderr = "";
  const legacy = client({ XANIMA_AGENT_ID: "", SHARPWAVE_AGENT_ID: "legacy-alias" });
  await legacy.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  legacy.notify("notifications/initialized", {});
  const lw = text(await call(legacy, "brain_write", { type: "semantic", label: "alias", content: "Written through the deprecated SHARPWAVE_AGENT_ID alias." }));
  check("alias: SHARPWAVE_AGENT_ID pins the agent", /writer=legacy-alias/.test(lw), lw.slice(0, 120));
  check("alias: deprecation warning on stderr", /DEPRECATED: SHARPWAVE_AGENT_ID/.test(lastStderr), lastStderr.slice(0, 160));
  legacy.proc.kill();

  // ── Multi-agent mode: XANIMA_AGENT_ID unset, `agent` arg routes per call ──
  const m = client({ XANIMA_AGENT_ID: "" });
  const mi = await m.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  check("multi: initialize", !!mi.result, `agentId=${mi?.result?.serverInfo?.name}`);
  m.notify("notifications/initialized", {});

  const mtools = await m.rpc("tools/list", {});
  const writeReq = (mtools?.result?.tools ?? []).find((t) => t.name === "brain_write");
  check("multi: every tool gains a required `agent`", (writeReq?.inputSchema?.required ?? []).includes("agent"),
    JSON.stringify(writeReq?.inputSchema?.required));

  const noAgent = text(await call(m, "brain_write", { type: "semantic", label: "x", content: "y" }));
  check("multi: brain_write without `agent` is refused", /pass "agent"|agent.*argument/i.test(noAgent), noAgent.slice(0, 100));

  await call(m, "brain_write", { agent: "alpha", type: "semantic", label: "alpha db", content: "The production database for alpha is PostgreSQL." });
  await call(m, "brain_write", { agent: "beta", type: "semantic", label: "beta db", content: "The production database for beta is MySQL." });
  const alphaQ = text(await call(m, "brain_query", { agent: "alpha", query: "what production database do we use?" }));
  check("multi: alpha recalls its own node", /postgres/i.test(alphaQ), alphaQ.slice(0, 120));
  check("multi: alpha does NOT see beta's node", !/mysql/i.test(alphaQ), alphaQ.slice(0, 120));

  const mBadConfirm = text(await call(m, "brain_reset", { agent: "alpha", confirm: "beta" }));
  check("multi: brain_reset confirm must equal `agent`", /refused/i.test(mBadConfirm), mBadConfirm.slice(0, 100));
  const mWiped = text(await call(m, "brain_reset", { agent: "alpha", confirm: "alpha" }));
  check("multi: brain_reset wipes only the named agent", /Brain reset for "alpha"/.test(mWiped), mWiped.slice(0, 100));
  const betaStill = text(await call(m, "brain_query", { agent: "beta", query: "what production database do we use?" }));
  check("multi: beta's brain survived alpha's reset", /mysql/i.test(betaStill), betaStill.slice(0, 120));
  m.proc.kill();

  // ── Lifecycle: when the client closes stdin the server must exit on its own ──
  // (the 30 s embedding-drain interval used to keep the process alive forever,
  // leaving an orphan holding the brain file open after every client disconnect).
  {
    const o = client();
    await o.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
    o.notify("notifications/initialized", {});
    await call(o, "brain_write", { type: "semantic", label: "orphan check", content: "written before the client disconnects" });
    const exited = new Promise((res) => o.proc.on("exit", (code, sig) => res({ code, sig })));
    o.proc.stdin.end();
    const outcome = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 8000))]);
    check("server exits by itself when the client closes stdin", !!outcome, outcome ? `exit=${outcome.code ?? outcome.sig}` : "still running after 8 s");
    if (!outcome) o.proc.kill();
  }

  // ── Multi-agent + XANIMA_DB_PATH would route EVERY agent into one file: refused at startup ──
  {
    const bad = client({ XANIMA_AGENT_ID: "", XANIMA_DB_PATH: join(DATA, "one-file.db") });
    const code = await Promise.race([
      new Promise((res) => bad.proc.on("exit", (c) => res(c))),
      new Promise((r) => setTimeout(() => r("timeout"), 8000)),
    ]);
    check("multi: XANIMA_DB_PATH without XANIMA_AGENT_ID is refused (exit 2)", code === 2, `exit=${code}`);
    check("multi: the refusal says how to fix it", /refusing to start: XANIMA_DB_PATH/.test(lastStderr), lastStderr.slice(-160).trim());
    if (code === "timeout") bad.proc.kill();
    // ...while a pinned agent may still use a single explicit db file.
    const one = client({ XANIMA_AGENT_ID: "pinned", XANIMA_DB_PATH: join(DATA, "pinned-one-file.db") });
    const oi = await one.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
    check("pinned agent + XANIMA_DB_PATH still starts", !!oi.result, oi?.result ? "" : JSON.stringify(oi).slice(0, 120));
    one.notify("notifications/initialized", {});
    await call(one, "brain_write", { type: "semantic", label: "single file", content: "stored in the explicit db file" });
    check("pinned agent writes into the explicit db file", existsSync(join(DATA, "pinned-one-file.db")));
    one.proc.kill();
  }

  try { rmSync(DATA, { recursive: true, force: true }); } catch {}
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
