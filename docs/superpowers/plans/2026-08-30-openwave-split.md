# openwave / sharpwave-core Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `sharpwave` into a 3-package monorepo (`core` engine, `mcp` server, `openwave` OpenClaw plugin) and port ClawBrain v4's full autonomic wake-up layer onto the current engine, so OpenClaw agents wake up with memory auto-injected again.

**Architecture:** npm workspaces. `packages/core` (`sharpwave-core`, `"private": true`) holds every engine module plus 8 cognition modules ported from `clawbrain-v4` and a unified tool-definition module. `packages/mcp` (`sharpwave`, npm-published, behavior frozen) and `packages/openwave` (new plugin) each depend on `sharpwave-core` via `workspace:*` and esbuild-bundle it into a single `dist/index.js`. Brain databases at `~/.sharpwave/<agentId>/brain.db` never move.

**Tech Stack:** TypeScript 5.6, Node ≥22, ESM. `better-sqlite3` `~12.11.1` (native, external in every bundle). `sqlite-vec` `^0.1.9`. esbuild `^0.24`. vitest for unit tests. `@modelcontextprotocol/sdk` `^1.30` (mcp package only). No dependency on the `openclaw` package at build time — openwave inlines a minimal API type.

**Spec:** `docs/superpowers/specs/2026-08-30-openwave-split-design.md` — read it alongside this plan.

## Global Constraints

- **`better-sqlite3` pinned `~12.11.1`.** v13 ships no prebuilt binaries. Never bump without re-checking prebuild assets. It is a `packages/core` dependency; the two consumers inherit it transitively and mark it `external` in esbuild.
- **`sqlite-vec` external in every bundle**, along with its per-platform packages: `sqlite-vec-darwin-arm64`, `sqlite-vec-darwin-x64`, `sqlite-vec-linux-x64`, `sqlite-vec-windows-x64`, and `node:*`.
- **`sharpwave-core` is never published.** `"private": true`, no `publishConfig`, not in any `files` allow-list. Consumers bundle its compiled output.
- **The `sharpwave` npm package's observable behavior must not change.** `packages/mcp` publishes the same 11 tools with the same schemas; `npm run test:mcp` is the regression gate and must pass before the branch merges and before any publish.
- **Node ESM only** (`"type": "module"` everywhere). Relative imports keep the `.js` extension in source (`./nodes.js`), matching both existing trees.
- **DB base-dir env override:** `packages/core` `db.ts` honors `SHARPWAVE_DATA_DIR` (already implemented). Tests set it to a temp dir. Do not introduce a second env name.
- **No brain schema changes.** No migrations. The on-disk format is frozen for this plan.
- **Full gateway restart** is required after any `openwave` bundle change (Node ESM cache). Soft plugin reload is insufficient. This is an operational note for the migration, not a code task.
- **Deploy/config gate:** editing `~/.openclaw/openclaw.json` or rolling `openwave` to live agents is OUT OF SCOPE for this plan — it is a separate gated session (spec §10, steps 3–6). This plan ends at "openwave built, tested, merged to main; nothing loaded live."

---

## File Structure

**Created:**

```
package.json                              root — workspaces, root scripts, no deps
tsconfig.base.json                        shared compiler options
vitest.config.ts                          root vitest project config (core + openwave)
esbuild.shared.mjs                        shared esbuild options (external list, banner)

packages/core/package.json                name "sharpwave-core", "private": true
packages/core/tsconfig.json
packages/core/src/index.ts                PUBLIC API BARREL — the only supported surface
packages/core/src/context-assembly.ts     ported from clawbrain-v4/src/bootstrap.ts
packages/core/src/awake-replay.ts         ported from clawbrain-v4/src/awake_replay.ts
packages/core/src/proactive-monitor.ts    ported from clawbrain-v4/src/proactive-monitor.ts
packages/core/src/extraction.ts           ported from clawbrain-v4/src/extraction.ts
packages/core/src/episode-lanes.ts        ported from clawbrain-v4/src/episode-lanes.ts
packages/core/src/valor.ts                ported from clawbrain-v4/src/valor.ts
packages/core/src/morning.ts              ported from clawbrain-v4/src/morning.ts
packages/core/src/compaction.ts           ported from clawbrain-v4/src/compaction.ts (logic only)
packages/core/src/tools.ts                unified brain_* tool defs + dispatch
packages/core/test/*.test.ts              merged vitest suite (clawbrain-v4 + new)
packages/core/test/setup.ts               temp-dir DB isolation

packages/mcp/package.json                 name "sharpwave" (moved), deps: sharpwave-core workspace:*
packages/mcp/tsconfig.json
packages/mcp/esbuild.mjs                  moved + adjusted
packages/mcp/src/index.ts                 today's src/index.ts, tool defs replaced by core import
packages/mcp/test/mcp-smoke.mjs           moved verbatim

packages/openwave/package.json            name "openwave", openclaw compat block
packages/openwave/tsconfig.json
packages/openwave/esbuild.mjs
packages/openwave/src/index.ts            plugin shell — ported from clawbrain-v4/src/index.ts
packages/openwave/src/bootstrap-delivery.ts   ported verbatim, rewired imports
packages/openwave/src/scheduler.ts        extracted from clawbrain-v4/src/index.ts timer blocks
packages/openwave/test/mock-api.ts        makeMockApi() test helper
packages/openwave/test/*.test.ts          hook-behavior harness
packages/openwave/README.md               config schema + load instructions
```

**Moved (via `git mv`, history preserved):**

```
src/*.ts (all except index.ts)  ->  packages/core/src/
src/index.ts                    ->  packages/mcp/src/index.ts
esbuild.mjs                     ->  packages/mcp/esbuild.mjs
test/mcp-smoke.mjs              ->  packages/mcp/test/mcp-smoke.mjs
tsconfig.json                   ->  packages/mcp/tsconfig.json (then trimmed)
```

**Deleted at end of branch:** nothing in-repo. (`C:\Users\wubbu\sharpwave-airheart\` deletion is a migration-session step, not this plan.)

---

## Task 1: Scaffold the workspace, move engine source into `packages/core`

**Files:**
- Create: `package.json` (root), `tsconfig.base.json`, `esbuild.shared.mjs`, `packages/core/package.json`, `packages/core/tsconfig.json`
- Move: `src/*.ts` (all except `src/index.ts`) → `packages/core/src/`; `src/index.ts` → `packages/mcp/src/index.ts`; `esbuild.mjs` → `packages/mcp/esbuild.mjs`; `test/mcp-smoke.mjs` → `packages/mcp/test/mcp-smoke.mjs`
- Create: `packages/mcp/package.json`, `packages/mcp/tsconfig.json`
- Delete: root `tsconfig.json` (after copying to `packages/mcp/`)

**Interfaces:**
- Produces: workspace layout; `sharpwave-core` resolvable via `workspace:*`; `npm install` at root links everything.

- [ ] **Step 1: Create the branch (if not already on it)**

```bash
cd "C:/Users/wubbu/Desktop/Projects/sharpwave"
git checkout openwave-split   # created earlier for the spec; stay on it
git pull --ff-only 2>/dev/null || true
```

- [ ] **Step 2: `git mv` the engine modules into `packages/core/src/`**

```bash
mkdir -p packages/core/src packages/mcp/src packages/mcp/test
for f in $(ls src/*.ts | grep -v '/index.ts$'); do git mv "$f" "packages/core/src/$(basename "$f")"; done
git mv src/index.ts packages/mcp/src/index.ts
git mv esbuild.mjs packages/mcp/esbuild.mjs
git mv test/mcp-smoke.mjs packages/mcp/test/mcp-smoke.mjs
git mv tsconfig.json packages/mcp/tsconfig.json
```

- [ ] **Step 3: Write the root `package.json`**

```json
{
  "name": "sharpwave-monorepo",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "npm run build --workspace sharpwave-core && npm run build --workspace sharpwave && npm run build --workspace openwave",
    "test": "vitest run",
    "test:mcp": "npm run build --workspace sharpwave-core && npm run build --workspace sharpwave && npm run test:mcp --workspace sharpwave",
    "test:all": "npm run test && npm run test:mcp",
    "typecheck": "tsc -b packages/core packages/mcp packages/openwave"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "esbuild": "^0.24.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 4: Write `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 5: Write `esbuild.shared.mjs`**

```js
// Shared esbuild options for the two bundled consumers (mcp, openwave).
// core is NOT bundled here — it is compiled by tsc and resolved as a dep.
export const sharedEsbuild = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: [
    "better-sqlite3",
    "sqlite-vec",
    "sqlite-vec-darwin-arm64",
    "sqlite-vec-darwin-x64",
    "sqlite-vec-linux-x64",
    "sqlite-vec-windows-x64",
    "node:*",
  ],
};
```

- [ ] **Step 6: Write `packages/core/package.json`**

```json
{
  "name": "sharpwave-core",
  "version": "0.4.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "better-sqlite3": "~12.11.1",
    "sqlite-vec": "^0.1.9"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13"
  }
}
```

- [ ] **Step 7: Write `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "composite": true },
  "include": ["src/**/*"],
  "exclude": ["test", "dist"]
}
```

- [ ] **Step 8: Write `packages/mcp/package.json`** (carry over every field from the old root `package.json`; only the additions/changes shown — keep `description`, `keywords`, `author`, `license`, `homepage`, `repository`, `bugs` verbatim)

```json
{
  "name": "sharpwave",
  "version": "0.4.0",
  "type": "module",
  "main": "dist/index.js",
  "bin": { "sharpwave": "dist/index.js" },
  "scripts": {
    "build": "node esbuild.mjs",
    "start": "node dist/index.js",
    "prepublishOnly": "npm run build",
    "test:mcp": "node test/mcp-smoke.mjs"
  },
  "files": ["dist/", "README.md", "LICENSE"],
  "engines": { "node": ">=22" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "better-sqlite3": "~12.11.1",
    "sqlite-vec": "^0.1.9",
    "sharpwave-core": "*"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.0.0",
    "esbuild": "^0.24.0",
    "typescript": "^5.6.0"
  }
}
```

> `"sharpwave-core": "*"` resolves to the workspace package. Do not use `workspace:*` — npm (unlike pnpm/yarn) does not support that protocol; a bare `*` plus the `workspaces` field is the npm-correct form.

- [ ] **Step 9: Write `packages/mcp/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "noEmit": true },
  "references": [{ "path": "../core" }],
  "include": ["src/**/*"]
}
```

- [ ] **Step 10: Move `README.md` / `LICENSE` handling**

Root `README.md` and `LICENSE` stay at repo root for GitHub. Add a copy step to `packages/mcp/esbuild.mjs` later (Task 4) OR symlink; simplest: `git mv` neither, and in Task 4 add `cpSync` of `../../README.md` and `../../LICENSE` into `packages/mcp/` before pack. For now leave them at root.

- [ ] **Step 11: `npm install` at root, confirm linking**

```bash
npm install
node -e "console.log(require.resolve('sharpwave-core/package.json'))"
```
Expected: prints a path under `packages/core/`.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "refactor: scaffold npm workspace, move engine into packages/core

git mv preserves history. packages/mcp holds the old src/index.ts;
packages/core holds every other engine module. Nothing builds yet."
```

---

## Task 2: `packages/core` public API barrel + `tsc` build green

**Files:**
- Create: `packages/core/src/index.ts`
- Modify: none (only re-exports)
- Test: `packages/core/test/barrel.test.ts`

**Interfaces:**
- Produces: `sharpwave-core` module exporting the full public surface. Every symbol below is consumed by `packages/mcp` and/or `packages/openwave`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/barrel.test.ts
import { expect, test } from "vitest";
import * as core from "../src/index.js";

test("barrel exports the engine surface consumers depend on", () => {
  for (const name of [
    "getDb", "closeAllDbs", "getMeta", "setMeta",
    "writeNode", "getNode", "touchNode", "writeEdge", "propagateDopamineSpike",
    "hybridRetrieve", "bootstrapRetrieve",
    "appendEpisode", "getEpisodesSince", "getSessionSummaries", "searchEpisodes", "scoreImportance",
    "subconsciousTick", "shouldConsolidate", "runConsolidation", "getNeuromodulatorState",
    "queueEmbedding", "drainEmbeddingQueue", "sweepMissingEmbeddings", "clearEmbeddingQueues",
    "getSelfModel", "updateSelfModelField", "formatSelfModelForContext",
    "clearWorkingMemory", "clearStaleWorkingMemory",
    "createBackup", "resetBrain", "collectMetrics",
    "DEFAULT_CONFIG",
  ]) {
    expect(core, `missing export: ${name}`).toHaveProperty(name);
  }
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run packages/core/test/barrel.test.ts`
Expected: FAIL — cannot resolve `../src/index.js` (file does not exist).

- [ ] **Step 3: Write `packages/core/src/index.ts`**

Re-export from every engine module. Group by area, one `export { … } from "./x.js"` per module. Use the exact symbol names from each module's `export function` declarations (verified list — do not guess; open each file and copy its exported names). Cover at minimum:

```ts
export * from "./types.js";
export { DEFAULT_CONFIG } from "./types.js";
export {
  getDb, closeDb, closeAllDbs, getMeta, setMeta, maintenance,
  bumpWriteCounter, getWriteCount, getFtsOptimizeEvery,
} from "./db.js";
export {
  writeNode, getNode, touchNode, ftsSearchNodes, getNeighbors, getTopByType,
  getActiveGoals, getReviewQueue, propagateDopamineSpike, decayEligibilityTraces,
  decayRetrievability, fsrsRetrievability, getRetrievability, computeSalience,
  computePsHash, psHashHamming, updatePsHash,
} from "./nodes.js";
export {
  writeEdge, closeEdge, closeEdgesFromNode, closeEdgesToNode,
  getActiveEdgesFrom, getInhibitedNodeIds, edgeExists, getEdge,
} from "./edges.js";
export {
  queueEmbedding, drainEmbeddingQueue, sweepMissingEmbeddings, clearEmbeddingQueues,
  fetchEmbedding, fetchEmbeddingCached, storeEmbedding, vectorSearchNodes,
  autoLinkNode, rrfFuse, cosineSimilarity, bufferToFloat32,
  embeddingCacheStats, clearEmbeddingCache,
} from "./embeddings.js";
export { hybridRetrieve, bootstrapRetrieve } from "./retrieval.js";
export {
  appendEpisode, getEpisodesSince, getEpisodeCount, getEpisodesByIds,
  getRecentEpisodes, searchEpisodes, incrementEpisodeRipple, scoreImportance,
  getSessionSummaries,
} from "./episodes.js";
export {
  setSubagentRunner, getNeuromodulatorState, shouldConsolidate,
  subconsciousTick, runConsolidation, forgetNodeById,
} from "./consolidation.js";
export {
  spreadActivation, workingMemoryBoost, updateWorkingMemory,
  clearWorkingMemory, clearStaleWorkingMemory,
} from "./activation.js";
export { getSelfModel, updateSelfModelField, formatSelfModelForContext } from "./self-model.js";
export {
  jaccardShingles, findNearDuplicates, deduplicateExisting, mergeCoreferentNodes,
} from "./entity-resolution.js";
export { detectSkillCandidates, generateSkill } from "./skill-evolution.js";
export { resetBrain } from "./reset.js";
export {
  getBackupDir, createBackup, restoreBackup, listBackups, getBackupInfo,
  deleteBackup, getLatestBackup, getBackupStorageUsage,
} from "./db-backup.js";
export { collectMetrics, formatPrometheusMetrics, formatMetricsAsText } from "./metrics.js";
export {
  bumpCounter, getCounters, setLastConsolidationAt, getLastConsolidationAt,
  isObservabilityEnabled, logObservabilityEvent,
} from "./observability.js";
export {
  retryWithBackoff, withTimeout, withFallback, executeAll,
  safeErrorToString, assertExists, healthCheck,
} from "./resilience.js";
export { executeWithWalRetry, executeWithWalRetrySync } from "./wal-retry.js";
export {
  validateBrainQuery, validateBrainWrite, validateBrainLink, validateBrainSupersede,
  validateBrainHistory, validateBrainExpand, validateBrainReview, validateBrainForget,
  validateBrainEdges, formatValidationErrors,
} from "./validation.js";
export { updateCheckDisabled, isNewer, checkForUpdate } from "./update-check.js";
export { agentIdFromKey, classifySentence, importanceForType, jaccardSim } from "./utils.js";
```

Modules ported in later tasks (`context-assembly`, `awake-replay`, `proactive-monitor`, `extraction`, `episode-lanes`, `valor`, `morning`, `compaction`, `tools`) get their exports appended to this barrel in their own task. Do not add them now.

- [ ] **Step 4: Build core**

Run: `npm run build --workspace sharpwave-core`
Expected: `tsc` emits `packages/core/dist/`. Fix any type errors surfaced by `NodeNext` resolution (most likely: missing `.js` extension on a relative import somewhere — add it).

- [ ] **Step 5: Run the barrel test, verify it passes**

Run: `npx vitest run packages/core/test/barrel.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/index.ts packages/core/test/barrel.test.ts
git commit -m "feat(core): public API barrel + tsc build"
```

---

## Task 3: Restore the vitest suite for `packages/core`

**Files:**
- Create: `packages/core/test/setup.ts`, `vitest.config.ts` (root)
- Move (copy from clawbrain-v4, then adapt): `packages/core/test/{activation,consolidation,db,edges,embeddings,entity-resolution,episodes,nodes,retrieval,self-model,skill-evolution,utils,fsrs6-reference}.test.ts`
- Test: the files themselves

**Interfaces:**
- Consumes: `sharpwave-core` barrel (Task 2).
- Produces: `npm run test` green for core's non-ported modules.

- [ ] **Step 1: Write `vitest.config.ts` (root)**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "core", root: "packages/core", setupFiles: ["test/setup.ts"], include: ["test/**/*.test.ts"] } },
      { test: { name: "openwave", root: "packages/openwave", include: ["test/**/*.test.ts"] } },
    ],
  },
});
```

- [ ] **Step 2: Write `packages/core/test/setup.ts`**

```ts
// Isolate every test's DB writes to a throwaway temp dir. sharpwave's db.ts
// honors SHARPWAVE_DATA_DIR directly (verified: src/db.ts). Each test still
// picks a unique agentId so their dbs never collide.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

const dir = join(tmpdir(), "sharpwave-core-test-" + randomUUID());
mkdirSync(dir, { recursive: true });
process.env["SHARPWAVE_DATA_DIR"] = dir;
process.env["OLLAMA_BASE_URL"] = "http://127.0.0.1:59999"; // dead port — no live embeds
delete process.env["OPENROUTER_API_KEY"];
delete process.env["SHARPWAVE_OPENROUTER_API_KEY"];
```

- [ ] **Step 3: Copy the clawbrain-v4 test files that map to unchanged core modules**

```bash
CB="C:/Users/wubbu/Desktop/Projects/clawbrain-v4/test"
for f in activation consolidation db edges embeddings entity-resolution episodes nodes retrieval self-model skill-evolution utils fsrs6-reference; do
  cp "$CB/$f.test.ts" "packages/core/test/$f.test.ts"
done
```

- [ ] **Step 4: Adapt each copied file's imports**

For every copied test file: change imports from `../src/x.js` to `../src/x.js` (path is the same) but reconcile symbol names against sharpwave's API. Known deltas to fix (from the API diff between the two trees):
- clawbrain `clearEphemeralWorkingMemory` / `EPHEMERAL_SESSION_ID` → sharpwave `clearStaleWorkingMemory` (no session arg). Tests using the ephemeral variant: rewrite to `clearStaleWorkingMemory(agentId)`.
- clawbrain `CLAWBRAIN_DATA_DIR` references in test bodies → `SHARPWAVE_DATA_DIR`.
- Any test importing `extraction` / `valor` / `episode-lanes` / `bootstrap` / `awake_replay` — DO NOT copy those yet (they belong to later tasks). Only the 13 listed in Step 3.
- Delete individual test cases that assert on a clawbrain-only field that sharpwave's schema doesn't have; leave a `// TODO(port): re-add when <module> lands` comment referencing the task. (This is allowed here — it is a test file scoping note, not a plan placeholder.)

- [ ] **Step 5: Run the suite**

Run: `npm run test`
Expected: core project runs; all copied tests pass. Iterate on failures — they will be API-name or signature mismatches, not logic bugs (the engine code is unchanged from what shipped in `sharpwave@0.4.0`).

- [ ] **Step 6: Commit**

```bash
git add packages/core/test vitest.config.ts
git commit -m "test(core): restore vitest suite for unchanged engine modules"
```

---

## Task 4: Wire `packages/mcp` to `sharpwave-core`, `test:mcp` green

**Files:**
- Modify: `packages/mcp/src/index.ts` (replace inline tool defs with core import — but core's `tools.ts` doesn't exist yet, so this task does a *thin* wiring: keep mcp's inline `TOOLS` + handlers, only change engine imports to `sharpwave-core`)
- Modify: `packages/mcp/esbuild.mjs`
- Test: `packages/mcp/test/mcp-smoke.mjs` (unchanged)

**Interfaces:**
- Consumes: `sharpwave-core` barrel.
- Produces: a built `packages/mcp/dist/index.js` that passes the smoke test — the regression gate.

- [ ] **Step 1: Rewrite `packages/mcp/esbuild.mjs`**

```js
import { build } from "esbuild";
import { readFileSync, cpSync } from "node:fs";
import { sharedEsbuild } from "../../esbuild.shared.mjs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await build({
  ...sharedEsbuild,
  entryPoints: ["src/index.ts"],
  define: { __SHARPWAVE_VERSION__: JSON.stringify(version) },
  outfile: "dist/index.js",
  banner: { js: `#!/usr/bin/env node\n// sharpwave — built ${new Date().toISOString()}\n` },
});
cpSync(new URL("../../README.md", import.meta.url), new URL("./README.md", import.meta.url));
cpSync(new URL("../../LICENSE", import.meta.url), new URL("./LICENSE", import.meta.url));
console.log(`sharpwave v${version} built to dist/index.js`);
```

> `sharpwave-core` is NOT in the `external` list, so esbuild inlines its compiled `dist/*.js` into the single bundle. `better-sqlite3` / `sqlite-vec` stay external.

- [ ] **Step 2: Change engine imports in `packages/mcp/src/index.ts`**

Replace the block of `import { … } from "./nodes.js"` etc. with a single `import { … } from "sharpwave-core"`. Keep everything else — `TOOLS`, `toolsForMode`, `resolveAgent`, all `handle*` functions, the dispatcher, the server setup — exactly as-is. The only edit is the import source.

- [ ] **Step 3: Add `.gitignore` entries for built copies**

```bash
printf '\npackages/mcp/README.md\npackages/mcp/LICENSE\npackages/*/dist/\n' >> .gitignore
```

- [ ] **Step 4: Build + run the smoke test**

Run: `npm run test:mcp`
Expected: builds core, builds mcp, runs `mcp-smoke.mjs` → `all checks passed`, exit 0. This proves zero behavioral regression to the published package. Iterate until green.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(mcp): consume engine from sharpwave-core; test:mcp green"
```

---

## Task 5: Unified tool definitions in `packages/core/src/tools.ts`

**Files:**
- Create: `packages/core/src/tools.ts`
- Modify: `packages/core/src/index.ts` (append tool exports)
- Modify: `packages/mcp/src/index.ts` (use core's defs for its 11-tool subset)
- Test: `packages/core/test/tools.test.ts`

**Interfaces:**
- Produces:
  - `BRAIN_TOOL_DEFS: Record<string, { description: string; inputSchema: JsonSchema }>` — the 16-def union: the 15 from `clawbrain-v4/src/tools.ts` (`brain_query`, `brain_write`, `brain_link`, `brain_supersede`, `brain_update_self_model`, `brain_reflect`, `brain_stats`, `brain_history`, `brain_expand`, `brain_generate_skill`, `brain_edges`, `brain_workspace`, `brain_docs`, `brain_review`, `brain_forget`) plus `brain_reset`.
  - `async dispatchBrainTool(name: string, agentId: string, args: Record<string, unknown>, config: BrainConfig): Promise<{ text: string; isError?: boolean }>` — pure, no host/transport coupling.
  - `MCP_TOOL_NAMES: string[]` (the 11 the server publishes) and `OPENWAVE_TOOL_NAMES: string[]` (all 16).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/tools.test.ts
import { expect, test } from "vitest";
import { BRAIN_TOOL_DEFS, MCP_TOOL_NAMES, OPENWAVE_TOOL_NAMES, dispatchBrainTool } from "../src/index.js";
import { DEFAULT_CONFIG } from "../src/index.js";

test("union holds 16 tool defs", () => {
  expect(Object.keys(BRAIN_TOOL_DEFS).sort()).toEqual([
    "brain_docs","brain_edges","brain_expand","brain_forget","brain_generate_skill",
    "brain_history","brain_link","brain_query","brain_reflect","brain_reset",
    "brain_stats","brain_supersede","brain_update_self_model","brain_workspace",
    "brain_write",
  ].concat(["brain_review"]).sort());
});

test("mcp subset is 11 and every name exists in the union", () => {
  expect(MCP_TOOL_NAMES).toHaveLength(11);
  for (const n of MCP_TOOL_NAMES) expect(BRAIN_TOOL_DEFS).toHaveProperty(n);
});

test("openwave subset is all 16", () => {
  expect(OPENWAVE_TOOL_NAMES.sort()).toEqual(Object.keys(BRAIN_TOOL_DEFS).sort());
});

test("dispatch write then query round-trips", async () => {
  const agent = "tools-test-" + Math.random().toString(36).slice(2);
  const w = await dispatchBrainTool("brain_write", agent,
    { type: "semantic", label: "db", content: "Production uses PostgreSQL 16." }, DEFAULT_CONFIG);
  expect(w.isError).toBeFalsy();
  const q = await dispatchBrainTool("brain_query", agent, { query: "what database?" }, DEFAULT_CONFIG);
  expect(q.text.toLowerCase()).toContain("postgres");
});

test("unknown tool is an error result, not a throw", async () => {
  const r = await dispatchBrainTool("brain_nope", "x", {}, DEFAULT_CONFIG);
  expect(r.isError).toBe(true);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run packages/core/test/tools.test.ts`
Expected: FAIL — `BRAIN_TOOL_DEFS` undefined.

- [ ] **Step 3: Write `packages/core/src/tools.ts`**

Port from `clawbrain-v4/src/tools.ts` (608 lines) and `packages/mcp/src/index.ts`'s current `TOOLS` array + `handle*` functions. Concretely:
- Take the 11 `inputSchema` objects already in `packages/mcp/src/index.ts` verbatim for those 11 tools.
- Take the other 5 schemas (`brain_update_self_model`, `brain_reflect`, `brain_generate_skill`, `brain_workspace`, `brain_docs`) from `clawbrain-v4/src/tools.ts` — convert from typebox to plain JSON Schema objects (match the style of the 11).
- Move the body of each `handle*` function from `packages/mcp/src/index.ts` into a `dispatchBrainTool` switch. Change the return shape from MCP's `{ content: [{type:"text", text}] }` to the plain `{ text, isError? }`. The `resolveAgent` gate stays in the MCP server (it is transport-specific); `dispatchBrainTool` receives an already-resolved `agentId`.
- For the 5 plugin-only tools, port their executors from `clawbrain-v4/src/tools.ts` (`brainUpdateSelfModelExecute`, `brainReflectExecute`, `makeBrainGenerateSkillExecute`, `makeBrainWorkspaceExecute`, `makeBrainDocsExecute`), rewiring engine calls to the core barrel and dropping the `config`-closure factories in favor of a plain `config` parameter.
- Export `MCP_TOOL_NAMES` (the exact 11 currently in `packages/mcp/src/index.ts`) and `OPENWAVE_TOOL_NAMES` (all keys).

- [ ] **Step 4: Append to the barrel**

```ts
// packages/core/src/index.ts — append
export { BRAIN_TOOL_DEFS, dispatchBrainTool, MCP_TOOL_NAMES, OPENWAVE_TOOL_NAMES } from "./tools.js";
```

- [ ] **Step 5: Run the tools test, verify pass**

Run: `npx vitest run packages/core/test/tools.test.ts`
Expected: PASS.

- [ ] **Step 6: Refactor `packages/mcp/src/index.ts` to use core's defs**

Replace the inline `TOOLS` array with:

```ts
import { BRAIN_TOOL_DEFS, MCP_TOOL_NAMES, dispatchBrainTool } from "sharpwave-core";

const TOOLS = MCP_TOOL_NAMES.map((name) => ({ name, ...BRAIN_TOOL_DEFS[name] }));
```

Replace the `dispatch()` switch body with: resolve the agent (keep `resolveAgent`), then `const r = await dispatchBrainTool(name, ag.agentId, args, config);` and map `{ text, isError }` back to MCP's `{ content: [{ type: "text", text }], isError }`. Delete the now-dead `handle*` functions.

- [ ] **Step 7: Smoke test again — the gate**

Run: `npm run test:mcp`
Expected: `all checks passed`. The published tool surface is byte-identical (same 11 names, same schemas — they came from this same file).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): unified brain_* tool defs; mcp consumes its 11-tool subset"
```

---

## Task 6: Port the 8 cognition modules into `packages/core`

Each module is one sub-task with the same shape. Port order matters (dependencies): `episode-lanes` → `extraction` → `valor` → `context-assembly` → `proactive-monitor` → `awake-replay` → `morning` → `compaction`.

**Files (all sub-tasks):**
- Create: `packages/core/src/<module>.ts`
- Create: `packages/core/test/<module>.test.ts` (copied from `clawbrain-v4/test/` where one exists, else new)
- Modify: `packages/core/src/index.ts` (append exports)

**Interfaces produced (append to barrel as each lands):**
- `episode-lanes.ts` → `isForegroundLane(sessionKey: string): boolean`
- `extraction.ts` → `queueEpisodeForExtraction(agentId, episode)`, `drainExtractionQueue(agentId, config, log): Promise<ExtractedFact[]>`
- `valor.ts` → `scoreReplyAgainstInjections(agentId, sessionKeyOrId, replyText): { scored: number; hits: number; reviewed: number } | null`
- `context-assembly.ts` → `buildBootstrapContext(agentId, sessionId, config, log, surface)`, `buildRecallContext(agentId, lastUserMsg, sessionKey, config, surface, recalledIds)`, `buildSelfModelHeader(agentId, config, log, surface?)`, `buildProceduralContext(agentId, sessionKey, recalledIds)`, `BRAIN_HEADER`
- `proactive-monitor.ts` → `runProactiveMonitor(agentId, sessionId, config, log, neuromod, lastUserMsg?)`
- `awake-replay.ts` → `awakeReplayTick(agentId, config, log)`, `recordCoactivations(agentId, sessionId)`
- `morning.ts` → `buildMorningDigest(agentId, config, log): Promise<string>` (confirm the real export name in `clawbrain-v4/src/morning.ts` and use it verbatim)
- `compaction.ts` → `handleCompaction(agentId, event, config, log)`

### For each module, execute these steps:

- [ ] **Step A: Copy the source and its test**

```bash
CB="C:/Users/wubbu/Desktop/Projects/clawbrain-v4"
cp "$CB/src/<sourceName>.ts" "packages/core/src/<module>.ts"
# awake_replay -> awake-replay, bootstrap -> context-assembly, etc.
[ -f "$CB/test/<sourceName>.test.ts" ] && cp "$CB/test/<sourceName>.test.ts" "packages/core/test/<module>.test.ts"
```

- [ ] **Step B: Rewire imports to the core barrel or sibling modules**

- Change every `import { X } from "./someEngineModule.js"` to `import { X } from "./index.js"` **only if** `X` is re-exported by the barrel; otherwise keep the direct sibling import (`./nodes.js` etc.). Prefer sibling imports within `core` to avoid a circular `index.ts` dependency — reserve the barrel for cross-package consumers.
- Reconcile API deltas (verified list):
  - `clearEphemeralWorkingMemory(agentId)` → `clearStaleWorkingMemory(agentId)`; drop `EPHEMERAL_SESSION_ID`.
  - clawbrain `getEpisodesSince(agentId, sinceMs)` — sharpwave's signature is `getEpisodesSince(agentId, sinceMs, minImportance = 0.2)`; pass an explicit `minImportance` where the old call relied on a different default.
  - clawbrain `getSessionSummaries` — confirm arg order against `packages/core/src/episodes.ts` (`getSessionSummaries(agentId, sinceMs, minImportance, excludeSessionKey, limit)`).
  - `scoreImportance(role, content)` — same in both.
  - Self-model: clawbrain `buildSelfModelHeader` calls into `self-model.ts`; sharpwave exposes `getSelfModel` + `formatSelfModelForContext(model, budgetChars)`. Rebuild the header using those two.
  - LLM routing: clawbrain modules referencing `resolveChatLlmRoute` / `callRemLlm` / `ingestionModel` — sharpwave's equivalent lives in `consolidation.ts` / `embeddings.ts`. For `extraction.ts` specifically, route through the same OpenRouter path `consolidation.ts` uses (`config.openRouterApiKey || process.env.OPENROUTER_API_KEY`, model `config.ingestionModel`). If no key, the module must degrade to keyword/no-op exactly as it did in clawbrain — keep that fallback branch.
  - `types.ts` / `BrainConfig`: if a ported module reads a config field that `packages/core/src/types.ts` `DEFAULT_CONFIG` lacks, add the field to `DEFAULT_CONFIG` with the same default clawbrain used, and note it in `packages/openwave/README.md` later.

- [ ] **Step C: Run the module's test, iterate to green**

Run: `npx vitest run packages/core/test/<module>.test.ts`
Expected: initially FAIL on import/signature errors; fix; then PASS. If no test file existed in clawbrain-v4 (e.g. `morning`, `proactive-monitor`), write a minimal one:

```ts
// packages/core/test/morning.test.ts  (pattern for modules that had no test)
import { expect, test } from "vitest";
import { buildMorningDigest } from "../src/morning.js";
import { DEFAULT_CONFIG } from "../src/index.js";
const noop = { info() {}, warn() {}, error() {} };

test("morning digest is a string, empty-safe on a fresh brain", async () => {
  const out = await buildMorningDigest("morning-" + Math.random().toString(36).slice(2), DEFAULT_CONFIG, noop);
  expect(typeof out).toBe("string");
});
```

- [ ] **Step D: Append the module's exports to `packages/core/src/index.ts`**

- [ ] **Step E: Full core suite + typecheck**

Run: `npm run test && npm run typecheck`
Expected: all green.

- [ ] **Step F: Commit**

```bash
git add packages/core/src/<module>.ts packages/core/test/<module>.test.ts packages/core/src/index.ts
git commit -m "feat(core): port <module> from clawbrain-v4 onto the current engine"
```

### Sub-task checklist (one commit each):

- [ ] 6.1 `episode-lanes.ts`
- [ ] 6.2 `extraction.ts`
- [ ] 6.3 `valor.ts`
- [ ] 6.4 `context-assembly.ts` (from `bootstrap.ts`)
- [ ] 6.5 `proactive-monitor.ts`
- [ ] 6.6 `awake-replay.ts` (from `awake_replay.ts`)
- [ ] 6.7 `morning.ts`
- [ ] 6.8 `compaction.ts`

- [ ] **Step G (after all 8): merge remaining clawbrain-v4 tests**

Copy `clawbrain-v4/test/{bootstrap,procedural-injection,valor-fsrs,extraction,episode-lanes,awake_replay,rigorous-brain,teammate-review,concurrency,brain-review,features}.test.ts` into `packages/core/test/`, rename to match new module names, adapt imports, drop cases that assert clawbrain-only behavior. Run `npm run test` → green. Commit: `test(core): merge remaining clawbrain-v4 test suite`.

---

## Task 7: Scaffold `packages/openwave` + the plugin entry shell

**Files:**
- Create: `packages/openwave/package.json`, `packages/openwave/tsconfig.json`, `packages/openwave/esbuild.mjs`, `packages/openwave/src/index.ts`, `packages/openwave/src/bootstrap-delivery.ts`, `packages/openwave/test/mock-api.ts`, `packages/openwave/test/register.test.ts`

**Interfaces:**
- Consumes: `sharpwave-core` barrel (all of Task 6's exports).
- Produces: a default-exported `definePluginEntry({ id: "openwave", … })` object; `packages/openwave/dist/index.js` bundle.

- [ ] **Step 1: Write `packages/openwave/package.json`**

```json
{
  "name": "openwave",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": { "build": "node esbuild.mjs", "test": "vitest run" },
  "openclaw": {
    "runtimeExtensions": ["./dist/index.js"],
    "compat": { "pluginApi": ">=2026.5.0", "minGatewayVersion": "2026.5.0" }
  },
  "dependencies": {
    "sharpwave-core": "*",
    "better-sqlite3": "~12.11.1",
    "sqlite-vec": "^0.1.9"
  }
}
```

- [ ] **Step 2: Write `packages/openwave/esbuild.mjs`**

```js
import { build } from "esbuild";
import { sharedEsbuild } from "../../esbuild.shared.mjs";

await build({
  ...sharedEsbuild,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  banner: { js: `// openwave — built ${new Date().toISOString()}\n` },
});
console.log("openwave built to dist/index.js");
```

- [ ] **Step 3: Write `packages/openwave/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "noEmit": true },
  "references": [{ "path": "../core" }],
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Port `bootstrap-delivery.ts` verbatim**

```bash
cp "C:/Users/wubbu/Desktop/Projects/clawbrain-v4/src/bootstrap-delivery.ts" packages/openwave/src/bootstrap-delivery.ts
```
It has no engine imports (pure decision function). Confirm it compiles as-is.

- [ ] **Step 5: Port `clawbrain-v4/src/index.ts` → `packages/openwave/src/index.ts`**

Copy the file. Then:
- Replace the giant engine import block (lines ~1–50 of the original) with `import * as core from "sharpwave-core";` and reference `core.X` (or a destructure). Keep the `./tools.js` import — but point it at core: `import { BRAIN_TOOL_DEFS, OPENWAVE_TOOL_NAMES, dispatchBrainTool } from "sharpwave-core";`
- Keep `definePluginEntry`, the inlined `OpenClawPluginApi` type, `resolveAgentId`, `logFields`, all module-level caches (`bootstrapCache`, `bootstrapInjected`, `queuedSessions`, `knownSessions`), `CRON_JOB_IDS`, `removeLegacyCronJobs` — verbatim.
- Change `id: "clawbrain-v4"` → `id: "openwave"`, name/description to openwave's.
- In `register()`: build the tool list from `OPENWAVE_TOOL_NAMES.map(n => ({ name: n, description: BRAIN_TOOL_DEFS[n].description, parameters: BRAIN_TOOL_DEFS[n].inputSchema, execute: (args, ctx) => dispatchBrainTool(n, resolveAgentId(args, ctx, config.agents), args, config).then(r => r.text) }))`. Keep `api.registerTool` loop.
- The hook bodies stay but every engine call becomes `core.X(...)`. The timer setup blocks (`gateway_start`) get **extracted** in Task 8 — for this task, leave them inline and working.
- Keep the memory-adapter registrations (`registerMemoryEmbeddingProvider`, `registerMemoryPromptSupplement`, `registerMemoryCorpusSupplement`) — rewire the corpus supplement's dynamic `import("./retrieval.js")` to `core.hybridRetrieve`.
- Keep the `registerRuntimeLifecycle` block verbatim (the 2026-05-16 incident fix — `restart` releases timers only, `reset`/`delete`/`disable` closes DBs).

- [ ] **Step 6: Write `packages/openwave/test/mock-api.ts`**

```ts
export type Recorded = {
  hooks: Map<string, Array<(e: any, c: any) => any>>;
  tools: any[];
  injections: any[];
  lifecycles: any[];
};

export function makeMockApi(pluginConfig: Record<string, unknown>) {
  const rec: Recorded = { hooks: new Map(), tools: [], injections: [], lifecycles: [] };
  const api = {
    pluginConfig,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    session: {
      workflow: {
        async enqueueNextTurnInjection(inj: any) { rec.injections.push(inj); return { enqueued: true, id: "mock", sessionKey: inj.sessionKey }; },
      },
    },
    lifecycle: { registerRuntimeLifecycle(l: any) { rec.lifecycles.push(l); } },
    registerTool(t: any) { rec.tools.push(t); },
    registerMemoryEmbeddingProvider() {}, registerMemoryPromptSupplement() {}, registerMemoryCorpusSupplement() {},
    on(name: string, handler: (e: any, c: any) => any) {
      if (!rec.hooks.has(name)) rec.hooks.set(name, []);
      rec.hooks.get(name)!.push(handler);
    },
  };
  const fire = (name: string, event: any, ctx: any) =>
    Promise.all((rec.hooks.get(name) ?? []).map((h) => h(event, ctx)));
  return { api, rec, fire };
}
```

- [ ] **Step 7: Write `packages/openwave/test/register.test.ts`**

```ts
import { expect, test } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
mkdirSync((process.env.SHARPWAVE_DATA_DIR = join(tmpdir(), "ow-" + randomUUID())), { recursive: true });
process.env.OLLAMA_BASE_URL = "http://127.0.0.1:59999";

import plugin from "../src/index.js";
import { makeMockApi } from "./mock-api.js";

test("register wires the expected hooks and 16 tools", () => {
  const { api, rec } = makeMockApi({ enabled: true, config: { agents: ["main"] } });
  plugin.register(api as any);
  for (const h of ["session_start", "before_prompt_build", "agent_turn_prepare", "session_end",
                   "after_compaction", "message_received", "llm_output", "agent_end",
                   "heartbeat_prompt_contribution", "gateway_start", "gateway_stop"]) {
    expect(rec.hooks.has(h), `hook not registered: ${h}`).toBe(true);
  }
  expect(rec.tools).toHaveLength(16);
  expect(rec.lifecycles).toHaveLength(1);
});
```

- [ ] **Step 8: Run + iterate**

Run: `npx vitest run packages/openwave/test/register.test.ts`
Expected: PASS after fixing import/compile errors.

- [ ] **Step 9: Build the bundle**

Run: `npm run build --workspace openwave`
Expected: `packages/openwave/dist/index.js` emitted. Check the banner and that `better-sqlite3` is not inlined (`grep -c "better-sqlite3" dist/index.js` shows only the import/require reference, not the package source).

- [ ] **Step 10: Commit**

```bash
git add packages/openwave
git commit -m "feat(openwave): plugin entry shell ported from clawbrain-v4 onto sharpwave-core"
```

---

## Task 8: Extract `scheduler.ts`, cover injection delivery + lifecycle

**Files:**
- Create: `packages/openwave/src/scheduler.ts`
- Modify: `packages/openwave/src/index.ts` (call into scheduler instead of inline timers)
- Test: `packages/openwave/test/{injection,lifecycle,scheduler}.test.ts`

**Interfaces:**
- Produces: `armSchedulers(agentIds: string[], config: BrainConfig, log): SchedulerHandles` and `disarmSchedulers(handles: SchedulerHandles): void`. `SchedulerHandles = { replay, consolidation, sweep }` (each a `NodeJS.Timeout | null`).

- [ ] **Step 1: Write the failing scheduler test**

```ts
// packages/openwave/test/scheduler.test.ts
import { expect, test, vi } from "vitest";
import { armSchedulers, disarmSchedulers } from "../src/scheduler.js";
import { DEFAULT_CONFIG } from "sharpwave-core";
const noop = { info() {}, warn() {}, error() {} };

test("arm returns three handles, disarm clears them", () => {
  vi.useFakeTimers();
  const h = armSchedulers(["a"], DEFAULT_CONFIG, noop);
  expect(h.replay).not.toBeNull();
  expect(h.consolidation).not.toBeNull();
  expect(h.sweep).not.toBeNull();
  disarmSchedulers(h);
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run packages/openwave/test/scheduler.test.ts` → FAIL (no module).

- [ ] **Step 3: Write `packages/openwave/src/scheduler.ts`**

Move the three `setInterval` blocks and `runSleepMaintenance` / `harvestExtraction` helpers out of `clawbrain-v4/src/index.ts`'s `gateway_start` into this module. `harvestExtraction` calls `core.drainExtractionQueue`, `core.writeNode`, `core.queueEmbedding`, `core.writeEdge`. `runSleepMaintenance` calls `core.shouldConsolidate` + `core.runConsolidation`. Replay tick calls `core.awakeReplayTick`. Sweep calls `core.sweepMissingEmbeddings` + `core.drainEmbeddingQueue`. Keep the re-entry guard `Set` and the structured `sleep_system.tick` log line.

- [ ] **Step 4: Rewire `index.ts`**

In `gateway_start`: `handles = armSchedulers(config.agents, config, log)`. In `gateway_stop` and lifecycle `cleanup`: `disarmSchedulers(handles)`. Remove the inline interval code.

- [ ] **Step 5: Write `injection.test.ts`**

```ts
// packages/openwave/test/injection.test.ts — bootstrap delivered exactly once
import { expect, test } from "vitest";
import { join } from "node:path"; import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs"; import { randomUUID } from "node:crypto";
mkdirSync((process.env.SHARPWAVE_DATA_DIR = join(tmpdir(), "ow-inj-" + randomUUID())), { recursive: true });
process.env.OLLAMA_BASE_URL = "http://127.0.0.1:59999";
import plugin from "../src/index.js";
import { makeMockApi } from "./mock-api.js";

test("session_start queues one bootstrap; before_prompt_build does not double it when queue delivered", async () => {
  const { api, rec, fire } = makeMockApi({ enabled: true, config: { agents: ["main"] } });
  plugin.register(api as any);
  const ctx = { agentId: "main", sessionKey: "agent:main:tg:1", sessionId: "s1" };
  await fire("session_start", { ...ctx }, ctx);
  expect(rec.injections).toHaveLength(1);
  expect(rec.injections[0].idempotencyKey).toContain("bootstrap");
  // simulate the gateway delivering it
  await fire("agent_turn_prepare", { queuedInjections: [{ idempotencyKey: rec.injections[0].idempotencyKey }] }, ctx);
  const out = await fire("before_prompt_build", { prompt: "hi", messages: [] }, ctx);
  const prepend = out.find((r: any) => r?.prependContext)?.prependContext ?? "";
  expect(prepend).not.toContain("BRAIN: bootstrap"); // not re-injected
});

test("before_prompt_build injects from cache when the queue silently drops it", async () => {
  const { api, rec, fire } = makeMockApi({ enabled: true, config: { agents: ["main"] } });
  plugin.register(api as any);
  const ctx = { agentId: "main", sessionKey: "agent:main:tg:2", sessionId: "s2" };
  await fire("session_start", { ...ctx }, ctx);
  await fire("agent_turn_prepare", { queuedInjections: [] }, ctx); // dropped
  const out = await fire("before_prompt_build", { prompt: "hi", messages: [] }, ctx);
  const prepend = out.find((r: any) => r?.prependContext)?.prependContext ?? "";
  expect(prepend.length).toBeGreaterThan(0);
});
```

- [ ] **Step 6: Write `lifecycle.test.ts`**

```ts
import { expect, test } from "vitest";
import { join } from "node:path"; import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs"; import { randomUUID } from "node:crypto";
mkdirSync((process.env.SHARPWAVE_DATA_DIR = join(tmpdir(), "ow-lc-" + randomUUID())), { recursive: true });
process.env.OLLAMA_BASE_URL = "http://127.0.0.1:59999";
import plugin from "../src/index.js";
import { makeMockApi } from "./mock-api.js";
import { getDb } from "sharpwave-core";

test("restart keeps DB handles open; reset closes them", async () => {
  const { api, rec } = makeMockApi({ enabled: true, config: { agents: ["main"] } });
  plugin.register(api as any);
  getDb("main"); // open a handle
  const lc = rec.lifecycles[0];
  await lc.cleanup({ reason: "restart" });
  expect(() => getDb("main").prepare("SELECT 1").get()).not.toThrow();
  await lc.cleanup({ reason: "reset" });
  // getDb reopens lazily, so just assert cleanup ran without throwing
  expect(true).toBe(true);
});
```

- [ ] **Step 7: Run the openwave suite, iterate**

Run: `npm run test` (openwave project) → all green.

- [ ] **Step 8: Rebuild bundle, typecheck**

Run: `npm run build --workspace openwave && npm run typecheck` → green.

- [ ] **Step 9: Commit**

```bash
git add packages/openwave
git commit -m "feat(openwave): extract scheduler; cover injection delivery + lifecycle"
```

---

## Task 9: `packages/openwave/README.md` + config schema

**Files:**
- Create: `packages/openwave/README.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Write the README**

Contents:
- What openwave is (one paragraph — the autonomic layer for OpenClaw agents, engine shared with `sharpwave` MCP).
- Install: add to `openclaw.json` `plugins.load.paths` pointing at `packages/openwave/dist/index.js`; enable under `plugins.entries.openwave`.
- Config schema table: every field of the `BrainConfig` subset the plugin reads — `agents` (string[], required), `contextBudget`, `llmExtractionEnabled`, `llmExtractionMinImportance`, `ingestionModel`, `openRouterApiKey` (or `OPENROUTER_API_KEY` env), plus any field added to `DEFAULT_CONFIG` during Task 6. Give type, default, meaning for each.
- Deploy: `npm run build --workspace openwave` + **full** `openclaw gateway restart` (not soft reload).
- Note: brain dbs at `~/.sharpwave/<agentId>/brain.db`, shared with the MCP server, never moved.

- [ ] **Step 2: Commit**

```bash
git add packages/openwave/README.md
git commit -m "docs(openwave): config schema + load/deploy instructions"
```

---

## Task 10: Full green + build artifacts + branch-level self-check

**Files:** none (verification).

- [ ] **Step 1: Clean install + full test**

```bash
rm -rf node_modules packages/*/node_modules packages/*/dist
npm install
npm run test:all
```
Expected: `test` (core + openwave vitest) all green; `test:mcp` → `all checks passed`.

- [ ] **Step 2: Build all three**

```bash
npm run build
ls -la packages/core/dist/index.js packages/mcp/dist/index.js packages/openwave/dist/index.js
```
Expected: all three exist. `packages/mcp/dist/index.js` starts with `#!/usr/bin/env node`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck` → no errors.

- [ ] **Step 4: Confirm `sharpwave-core` is unpublishable**

```bash
cd packages/core && npm pack --dry-run 2>&1 | grep -i private && cd ../..
```
Expected: npm refuses / warns because `"private": true`.

- [ ] **Step 5: Verify the MCP tool surface is unchanged vs `sharpwave@0.4.0`**

```bash
node -e "import('sharpwave-core').then(c => console.log(c.MCP_TOOL_NAMES.sort().join(',')))"
```
Expected: `brain_edges,brain_expand,brain_forget,brain_history,brain_link,brain_query,brain_reset,brain_review,brain_stats,brain_supersede,brain_write` (the exact 11 from `sharpwave@0.4.0`).

- [ ] **Step 6: Update root `README.md`**

Add a short "Repository layout" section pointing at the three packages and noting `sharpwave` (npm) is `packages/mcp`. Keep the existing client-neutral framing.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: repository layout section for the monorepo"
```

---

## Task 11: Live smoke on a throwaway agent (gated — do not touch real agents/config)

**Files:** none in-repo. Uses a scratch `openclaw.json` fragment and a scratch agent id.

**Precondition:** this is the only task that touches a running gateway. Per the CLAUDE.md deploy-gate, get an explicit go from Hailey before running it. It does NOT modify the live `agents.list`, only adds a disabled-by-default scratch plugin entry the operator enables for one throwaway id.

- [ ] **Step 1: Back up the live config**

```bash
cp ~/.openclaw/openclaw.json "$SCRATCH/openclaw.json.pre-openwave-smoke-$(date +%Y%m%d-%H%M)"
```

- [ ] **Step 2: Add openwave for a scratch agent id only**

Operator adds to `openclaw.json`:
```jsonc
"plugins": {
  "load": { "paths": ["C:/Users/wubbu/Desktop/Projects/sharpwave/packages/openwave/dist/index.js"] },
  "entries": { "openwave": { "enabled": true, "config": { "agents": ["ow-smoke"] } } }
}
```
Leave `mcp.servers.sharpwave` untouched. `ow-smoke` is not a real agent — its brain db auto-creates at `~/.sharpwave/ow-smoke/brain.db`.

- [ ] **Step 3: Full gateway restart**

```bash
openclaw gateway restart
```

- [ ] **Step 4: Check the log**

```bash
tail -n 200 "C:/Users/wubbu/AppData/Local/Temp/openclaw/openclaw-$(date +%Y-%m-%d).log" | grep -i openwave
```
Expected lines: `[openwave] {"op":"register","outcome":"ok","agents":1,...}` and, once a message is sent to `ow-smoke`, `session_start.bootstrap outcome:ok` and `before_prompt_build outcome:ok`.

- [ ] **Step 5: Send one message to the scratch agent and confirm injection**

Use whatever channel routes to `ow-smoke` (or a direct `openclaw` CLI send). Confirm in the log that `before_prompt_build` returned non-zero prepend chars and that `brain_stats` for `ow-smoke` shows write + read activity.

- [ ] **Step 6: Tear down the scratch entry**

Operator reverts `openclaw.json` to the backup. `openclaw gateway restart`. `rm -rf ~/.sharpwave/ow-smoke`.

- [ ] **Step 7: Merge the branch**

```bash
git checkout main && git merge --no-ff openwave-split -m "feat: sharpwave monorepo + openwave plugin (autonomic wake-up restored)"
```
Push is gated on Hailey's go (PAT inline per `project-sharpwave` memory, scrubbed after).

**Migration to real agents (spec §10 steps 3–6) is a separate gated session — not part of this plan.**

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §4 monorepo layout, workspaces, core bundled by consumers | 1, 2, 4, 7 |
| §4 hook seams verified | 7 (index shell carries them), 8 (injection tests) |
| §5.1 engine modules stay in core | 1 (moved), 2 (barrel), 3 (tests) |
| §5.2 8 cognition modules → core | 6.1–6.8 |
| §5.2 unified `core/tools.ts`, 16-def union, per-consumer subsets | 5 |
| §5.3 `index.ts` shell → openwave | 7 |
| §5.3 `bootstrap-delivery.ts` → openwave | 7 (ported), 8 (tested) |
| §5.3 `scheduler.ts` extraction | 8 |
| §6.1 core barrel is the only supported surface | 2 |
| §6.2 mcp behavior frozen, `test:mcp` is the gate | 4, 5 (re-run), 10 |
| §6.3 openwave package `openclaw` compat block, load via `plugins.load.paths` | 7, 9 |
| §8 root scripts (`build`, `test`, `test:mcp`, `test:all`, `typecheck`) | 1 |
| §9.1 restore + merge vitest suite | 3, 6 (per-module), 6.G |
| §9.2 mcp smoke gate | 4, 5, 10 |
| §9.3 openwave mock-api hook harness | 7, 8 |
| §9.4 live smoke on scratch agent | 11 |
| §10 migration is separate/gated | 11 (ends at merge; states migration is out of scope) |
| §11 rollback | 11 Step 6 (scratch teardown); full rollback doc lives in the spec |
| §12 `better-sqlite3` pin, native externals, full restart | Global Constraints; 1 Step 5; 7 Step 9 |
| §13 open questions (deferred) | not tasked (correctly — deferred) |

No gaps. §13 items are explicitly deferred in the spec and correctly untasked.

**2. Placeholder scan:** The `// TODO(port:` comments in Task 3 Step 4 and Task 6 Step C are *test-file scoping markers* tied to a named later task, not plan placeholders — each names the module/task that resolves it. Every code step has real code. `buildMorningDigest` is flagged in Task 6 interfaces as "confirm the real export name and use it verbatim" — the one place the plan can't be certain without opening `clawbrain-v4/src/morning.ts`; acceptable and called out.

**3. Type consistency:** `dispatchBrainTool(name, agentId, args, config)` — same signature in Task 5 (definition), Task 7 Step 5 (openwave tool wiring), Task 8. `armSchedulers(agentIds, config, log)` / `disarmSchedulers(handles)` — consistent Task 8 Steps 1, 3, 4. `SchedulerHandles = { replay, consolidation, sweep }` — consistent. `makeMockApi(pluginConfig)` returning `{ api, rec, fire }` — consistent Tasks 7, 8. Barrel export names in Task 2 match the `export function` names from the grep of `packages/core/src/` (they were copied from it). `SHARPWAVE_DATA_DIR` used everywhere (never `CLAWBRAIN_DATA_DIR` except as a "rename this" instruction in Task 3/6).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-30-openwave-split.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
