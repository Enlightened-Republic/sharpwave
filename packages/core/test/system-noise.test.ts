import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { classifySystemTurn, isSystemNoiseEpisode, isSystemNoiseTurn, RETIRED_NODE_META_PREFIX } from "../src/system-noise.js";
import { appendEpisode } from "../src/episodes.js";
import { writeNode } from "../src/nodes.js";
import { getDb, setMeta, closeDb } from "../src/db.js";
import { runConsolidation } from "../src/consolidation.js";
import { queueEpisodeForExtraction, drainExtractionQueue } from "../src/extraction.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import * as core from "../src/index.js";
import { KEEP, NOISE } from "./fixtures/system-noise-fixtures.js";

const log = { info: () => {}, warn: () => {}, error: () => {} };
const fresh = () => `noise-${randomUUID().slice(0, 8)}`;

describe("system-noise classifier (mirror of openwave)", () => {
  it.each(NOISE)("skips: %s", (_n, t, reason) => {
    const v = classifySystemTurn(t);
    expect(v.skip).toBe(true);
    if (v.skip) expect(v.reason).toBe(reason);
  });
  it.each(KEEP)("keeps: %s", (_n, t) => expect(isSystemNoiseTurn(t)).toBe(false));
  it("isSystemNoiseEpisode uses role/content/session_id only", () => {
    expect(isSystemNoiseEpisode({ role: "assistant", content: "NO_REPLY — nothing urgent in scope", session_id: "agent:main:main" })).toBe(true);
    expect(isSystemNoiseEpisode({ role: "user", content: "[OpenClaw heartbeat poll]", session_id: "agent:main:main" })).toBe(true);
    expect(isSystemNoiseEpisode({ role: "tool", content: "[session start: agent:main:main:heartbeat]", session_id: "agent:main:main:heartbeat" })).toBe(true);
    expect(isSystemNoiseEpisode({ role: "user", content: "Your heartbeat config looks wrong, can you check it?", session_id: "agent:main:main" })).toBe(false);
  });
  it("is exported from the barrel", () => {
    for (const n of ["isSystemNoiseTurn", "isSystemNoiseEpisode", "classifySystemTurn", "RETIRED_NODE_META_PREFIX", "RETIRED_EPISODE_META_PREFIX"]) expect(core).toHaveProperty(n);
  });
});

describe("sleep guard: SWS never mints nodes from system-noise episodes", () => {
  const TRIAGE = "NO_REPLY — 3:12 PM, daytime but no owner-blocked work, nothing urgent in scope, she was active 40m ago. Next scheduled tick ~15:42.";
  it("noise episodes are consumed without producing nodes; real ones still extract", async () => {
    const id = fresh();
    const noiseIds = [
      appendEpisode(id, "agent:main:main", "assistant", TRIAGE, 0.5),
      appendEpisode(id, "agent:main:main", "user", "[OpenClaw exec completion]\nDisable automatic completion turns with tools.exec.notifyOnExit=false; check per-agent overrides. Background exec and process poll remain available.", 0.5),
      appendEpisode(id, "agent:main:main", "user", "Follow the heartbeat monitor scratch context when provided. Recurring tasks are automations; create or change their schedules with the automations tool, not heartbeat scratch. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply NO_REPLY.", 0.5),
    ];
    appendEpisode(id, "agent:main:telegram:1", "user", "The staging database is hosted on the blue cluster in Frankfurt.", 0.85);
    await runConsolidation(id, DEFAULT_CONFIG, log);
    const db = getDb(id);
    const nodes = db.prepare("SELECT content, episode_ids FROM nodes WHERE source = 'sws'").all() as Array<{ content: string; episode_ids: string }>;
    expect(nodes.some((n) => /blue cluster/.test(n.content))).toBe(true);
    for (const n of nodes) for (const e of noiseIds) expect(n.episode_ids ?? "").not.toContain(e);
    expect(nodes.some((n) => /NO_REPLY|OpenClaw|heartbeat monitor/.test(n.content))).toBe(false);
    const flags = db.prepare(`SELECT llm_extracted FROM episodes WHERE id IN (${noiseIds.map(() => "?").join(",")})`).all(...noiseIds) as Array<{ llm_extracted: number }>;
    expect(flags.every((f) => f.llm_extracted === 1)).toBe(true); // consumed, never re-picked
    closeDb(id);
  });

  it("control: without the guard's patterns the same triage text would be extracted", async () => {
    // Same sentence minus the NO_REPLY token: SWS extracts it, proving the guard (not the
    // heuristics) is what keeps triage text out.
    const id = fresh();
    appendEpisode(id, "agent:main:main", "assistant", TRIAGE.replace(/^NO_REPLY — /, ""), 0.5);
    await runConsolidation(id, DEFAULT_CONFIG, log);
    const n = getDb(id).prepare("SELECT COUNT(*) AS n FROM nodes WHERE source = 'sws'").get() as { n: number };
    expect(n.n).toBeGreaterThan(0);
    closeDb(id);
  });

  it("drainExtractionQueue drops noise episodes before extraction", async () => {
    const id = fresh();
    const mk = (role: "user" | "assistant", content: string) => ({ id: randomUUID(), session_id: "s", role, content, importance: 0.9, tokens: 10, ripple_count: 0, created_at: Date.now(), meta: null });
    const real = mk("user", "The quarterly report is due on the fifteenth of every month.");
    queueEpisodeForExtraction(id, mk("assistant", TRIAGE) as never);
    queueEpisodeForExtraction(id, mk("user", "[OpenClaw heartbeat poll]") as never);
    queueEpisodeForExtraction(id, real as never);
    const r = await drainExtractionQueue(id, { ...DEFAULT_CONFIG, llmExtractionEnabled: true, llmExtractionMinImportance: 0.4 }, log);
    expect(r.episodeIds).toEqual([real.id]);
    expect(JSON.stringify(r)).not.toMatch(/NO_REPLY|OpenClaw/);
  });
});

describe("retire registry: sleep never prunes or downscales a retired node", () => {
  it("Deep prune skips retired nodes; unregistered twins are pruned", async () => {
    const id = fresh();
    const keep = writeNode(id, "semantic", "retired twin", "A retired node with near-zero retrievability.", { importance: 0.5 });
    const gone = writeNode(id, "semantic", "plain twin", "An ordinary node with near-zero retrievability.", { importance: 0.5 });
    const db = getDb(id);
    const old = Date.now() - 3 * 86_400_000;
    db.prepare("UPDATE nodes SET retrievability = 0.001, stability = 0.5, created_at = ?, valid_until = ? WHERE id IN (?, ?)").run(old, Date.now(), keep, gone);
    setMeta(id, `${RETIRED_NODE_META_PREFIX}${keep}`, JSON.stringify({ retiredAt: Date.now() }));
    await runConsolidation(id, DEFAULT_CONFIG, log);
    const ids = (db.prepare("SELECT id, stability FROM nodes").all() as Array<{ id: string; stability: number }>);
    expect(ids.find((r) => r.id === keep)?.stability).toBe(0.5); // not downscaled either
    expect(ids.some((r) => r.id === gone)).toBe(false);
    closeDb(id);
  });
});
