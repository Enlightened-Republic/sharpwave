// Smoke test against a COPY of a real brain snapshot, mounted as one agent's
// private brain. The source snapshot is never opened — only copied — and its
// bytes are verified unchanged afterwards.
//
// Source: $SHARPWAVE_SNAPSHOT_DIR (dir with brain.db [+ brain.db-wal]),
// default /workspace/brain-snap/main. Skipped when absent (e.g. CI).
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { startService, tempRoot, tool } from "./helpers.js";

const SRC = process.env["SHARPWAVE_SNAPSHOT_DIR"] ?? "/workspace/brain-snap/main";
const has = existsSync(join(SRC, "brain.db"));

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe.skipIf(!has)("real-snapshot smoke (copy mounted as agent 'main')", () => {
  it("counts are intact and queries work", async () => {
    const files = ["brain.db", "brain.db-wal"].filter((f) => existsSync(join(SRC, f)));
    const before = Object.fromEntries(files.map((f) => [f, sha(join(SRC, f))]));

    const root = tempRoot("sw-snap-");
    // 1. Pristine copy for baseline counts (opened read/write so the WAL is applied to the COPY only).
    const baseDir = join(root, "baseline");
    mkdirSync(baseDir, { recursive: true });
    for (const f of files) copyFileSync(join(SRC, f), join(baseDir, f));
    const base = new Database(join(baseDir, "brain.db"));
    const count = (db: Database.Database, sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const expected = {
      nodes: count(base, "SELECT COUNT(*) AS n FROM nodes"),
      edges: count(base, "SELECT COUNT(*) AS n FROM edges"),
      episodes: count(base, "SELECT COUNT(*) AS n FROM episodes"),
      semantic: count(base, "SELECT COUNT(*) AS n FROM nodes WHERE type='semantic'"),
    };
    base.close();
    expect(expected.nodes).toBeGreaterThan(0);

    // 2. Mount a second copy as agent "main"'s private brain.
    const mount = join(root, "brains", "main");
    mkdirSync(mount, { recursive: true });
    for (const f of files) copyFileSync(join(SRC, f), join(mount, f));

    const h = await startService({}, root);
    try {
      const tok = h.mint("main", ["read"]);
      const other = h.mint("someone-else", ["read"]);
      const stats = JSON.parse((await tool(h.url, tok, "brain_stats", { visibility: "private", format: "json" })).text).brains[0];
      expect(stats.nodes).toBe(expected.nodes);
      expect(stats.episodes).toBe(expected.episodes);
      expect(stats.nodesByType.semantic).toBe(expected.semantic);
      const db = new Database(join(mount, "brain.db"), { readonly: true });
      expect(count(db, "SELECT COUNT(*) AS n FROM edges")).toBe(expected.edges);
      expect(count(db, "SELECT MAX(version) AS n FROM schema_version")).toBeGreaterThanOrEqual(18); // migrated on mount
      db.close();

      const q = await tool(h.url, tok, "brain_query", { query: "openclaw gateway", format: "json" });
      expect(q.isError).toBe(false);
      const hits = JSON.parse(q.text).results as Array<{ brain: string; id: string }>;
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((x) => x.brain === "private")).toBe(true);

      const ex = await tool(h.url, tok, "brain_expand", { node_id: hits[0]!.id });
      expect(ex.isError).toBe(false);

      // Another agent sees none of it.
      const oq = JSON.parse((await tool(h.url, other, "brain_query", { query: "openclaw gateway", format: "json" })).text);
      expect(oq.results).toEqual([]);
    } finally {
      await h.stop();
    }
    const after = Object.fromEntries(files.map((f) => [f, sha(join(SRC, f))]));
    expect(after).toEqual(before);
  });
});
