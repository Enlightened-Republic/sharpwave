# Sharpwave Changelog

All notable changes to the Sharpwave TypeScript MCP server.

## 0.5.0 (Xanima) — unreleased

Shared rooms (the context bus), controllable injection and the poisoning quarantine (design: Xanima phase 4 "Rooms/bus and poisoning quarantine", released as 0.5.0). Stacks on 0.4.0. No LLM involved anywhere. Guides: [docs/rooms.md](docs/rooms.md), [docs/security-model.md](docs/security-model.md).

- **Schema v24 (additive):** `room_items` and `room_conflicts` tables (used by room brains, empty elsewhere) and `nodes.scope_tags` (project / category tags). Node/edge/episode counts never change on migration.
- **Rooms (xanima-server):** a registry (`<root>/rooms/registry.db`: rooms, members with read / write / admin, subscriptions, a room log) and one room brain per room (`brains/_room.<name>/brain.db`). Isolation is the default; the built-in `shared` brain is unchanged and documented as the implicit "everyone" room. Tools: `brain_room` (list / members / conflicts / create / invite / revoke {withdraw}), `brain_publish` (copies with provenance: original writer, source node id, original time, publish time, confidence, sensitivity; identity and sensitive items are refused unless `allow_sensitive`), `brain_unpublish` (retract the copy, history kept), `brain_room_query`, `brain_subscribe {room, filter{types, topics, writers}}`. Access = token scope AND live membership, checked on every call, so revocation is immediate. **Conflicts:** a different claim under the same subject by another writer keeps both, adds a `contradicts` edge, marks both disputed and records a `room_conflicts` row; shown by `brain_room conflicts`, `brain_room_query` (DISPUTED), `brain_conflicts` and `brain_status`. New token scope `room-admin` (create rooms). CLI `xanima-server room create | invite | revoke [--withdraw] | list | members | conflicts`. Backups include room brains and the registry.
- **Recall (remote mode):** the plugin's per-turn recall passes `inject: true`; the service then adds up to `roomRecallMax` (3) subscribed room items tagged `[type·room·writer]` and applies injection controls. Explicit `brain_query` calls are never shaped.
- **Controllable injection:** `brain_focus {suppress, boost, ttl: turns | "task", task, clear, show}` with `topic: / project: / room: / type:` entries; counts one turn per injected recall and restores itself (`focusDefaultTtl` 3). `injectionCategories` (`identity`, `goals`, `rules` for the always-on header; `recall`, `decisions`, `rooms` for selective recall; `sensitive: "relevant" | "never" | "always"`). Sensitive items are injected only when the turn names their topic (two label words or a tag); `confirm_before_acting` items keep their "(confirm before acting)" marker. Works in local mode too (`buildRecallContext`). `brain_write` takes `tags` for project focus.
- **Poisoning quarantine:** `quarantine: "off" | "log" | "enforce"` (default **log**). Writes that would change identity, values, goals or rules (`brain_write` identity / goal or value / rule / mission labels, `brain_supersede` of such nodes, `brain_set_goal` / `brain_update_goal` except progress / tracking, `brain_update_self_model` identity / goals) are quarantined when the source is untrusted: `source_type` tool / agent / import, or text that looks like an injection ("ignore previous instructions", "your new identity is", "you are now", "new system prompt", …). Log mode records a `logged` review item and applies the write; enforce holds a `pending` review item (kind `quarantine`) and changes nothing until an admin accepts (applied through the normal write path, history kept) or rejects. The agent's own trusted updates pass. `brain_review list {status, kind}`, `xanima-server soul review list --kind quarantine --status logged`. `brain_status` shows the counts and an attention line when something is held. Soul imports keep their 0.4.0 review (identity / values / goals always held) and share the injection patterns.
- **Library:** `openRoomRegistry`, `createRoom`, `setMember`, `revokeMember`, `publishNodes`, `unpublish`, `withdrawAll`, `roomQuery`, `roomConflicts`, `subscribe`, `setFocus`, `tickFocus`, `applyInjectionControls`, `gateWrite`, `classifyWrite`, `quarantineCounts`, `ROOM_TOOL_DEFS`, `FOCUS_TOOL_DEF` from `xanima-core`.
- **Flags:** `rooms` (true; no room exists until created), `roomRecallMax` (3), `injectionCategories` (all on, sensitive "relevant"), `focusDefaultTtl` (3), `quarantine` ("log").

## 0.4.0 (Xanima) — unreleased

Portable Soul Package: export / import / fork / three-way merge / review (design: Xanima phase 3 "Soul Package and fork/merge", released as 0.4.0). Stacks on 0.3.0. No LLM involved. Guide: [docs/portability.md](docs/portability.md).

- **Format `xanima-soul/1`:** deterministic, human-readable JSON (sorted keys, items sorted by origin id, no wall-clock fields) with identity, values, active goals with history, top skills, decision lessons, key facts above `soulMinFactConfidence`, optional open items / commitments / shared facts, per-item provenance, source agent, brain fingerprint, schema version, package id, parent id (forks), sha256 content hash + per-section manifest, optional ed25519 signature. JSON Schema: `packages/core/schema/xanima-soul-1.schema.json`; validator `validateSoul()`. Optional SQLite subset dump (`--sqlite`). Raw episodes are never exported; sensitive, retired / superseded / expired, draft, in-review and shared items are left out by default.
- **Schema v23 (additive, new tables only):** `review_items` (pending-review queue), `soul_id_map` (origin ↔ local ids), `soul_provenance` (original provenance of imported nodes), `soul_events`. New source type `import`, new edge type `imported_from`. Node/edge/episode counts never change on migration.
- **Import:** validates schema + hash (+ trusted signature), backup first, audit entry, refuses while the service runs (CLI). Imported memories are `source_type: import`, confidence capped at `soulImportConfidence` (0.5), linked `imported_from` an archived provenance anchor; ids are mapped. **Identity, values and goals always go to the review queue** (the first step of the poisoning protections; text that looks like an identity rewrite is flagged and shown in `brain_status`). Differences never overwrite: they become conflict review items.
- **Fork + three-way merge:** `soul fork` (full profile, fork flag), later exports carry `parent_id`; `soul diff A B`; `soul merge --base --theirs --into` per item: unchanged / ours-only (kept) / theirs-only (applied as supersede with history for skills, facts, lessons, open items; review for identity, values, goals; removals → review) / conflicts (review items with ours / base / theirs markers). `soul review list|show|accept|reject`.
- **Tools:** `brain_export_soul` (agent, own brain only, read scope; compact JSON or summary). `brain_review` gains a queue mode (`action: list | show | accept | reject`; accept / reject need admin) next to its FSRS form (`node_id` + `quality`). `brain_import_soul` (admin scope only, listed to admin tokens only, backup first). Library: `exportSoul`, `importSoul`, `mergeSoul`, `diffSoul`, `validateSoul`, `signSoul`, `listReviews`, `acceptReview`, `rejectReview`, … exported from `xanima-core`.
- **xanima-server CLI:** `soul export | fork | import | diff | merge | review | validate | keygen`.
- **Flags:** `soulExportProfile` ("compact"), `soulTokenBudget` (2000), `soulMinFactConfidence` (0.6), `soulImportConfidence` (0.5), `soulMergeApplyTheirs` (true), `soulPackageOnExport` (false: `backup now` also writes a compact package per private brain from the snapshot).
- The `SHARPWAVE_*` env aliases are still accepted in 0.4.0 (no breaking renames in this release); their removal moves to a later release.

## 0.3.0 (Xanima) — unreleased

Reflection, experience replay, open items, commitments + plans, meta-tools (design: Xanima phase 3). Stacks on 0.2.0. Everything works without an LLM; the only LLM path (`reflectionLlm`) is opt-in.

- **Schema v22 (additive, new tables only):** `reflections`, `open_items`, `commitments`, `plans`, `plan_steps`, `dependencies`; `alignment_notes` gains `kind` / `ref_id` (alignment note vs commitment nudge). Node/edge/episode counts never change. New node types `reflection`, `hypothesis`, `question`, `assumption`, `commitment`, `plan`; new edge types `reflects_on`, `about`, `blocked_by`, `evidence_for`, `evidence_against`. All new structured nodes are exempt from the Deep prune.
- **Reflection:** optional sleep phase (`reflection: "off" | "sleep"`, default off) over the last `reflectionWindowDays` (7): decisions with outcomes, repeated failures (counting decisions sleep already merged), over-confident misses, held lessons, refuted hypotheses, contradicted assumptions and slipped commitments → "what worked / what didn't / try next", stored as a `reflection` node linked (`reflects_on`) to its sources, per window and per active goal. Near-duplicate reflections merge (embedding cosine or lexical, same thresholds as lesson merging). `brain_reflect {topic? | goal_id? | since?, until?}` reflects on demand and stores the result (recallable later); `brain_reflect {}` keeps the old self-model view. `reflectionLlm: true` (and an API key) rephrases the sleep draft only.
- **Experience replay:** `brain_replay {goal_id | skill_id | query, k}` → up to k decision → outcome → lesson trajectories with nearby episodes, compressed and capped at `replayMaxChars` (1600).
- **Hypotheses / open questions / assumptions:** `brain_hypothesis` (create / update / evidence / support / refute / close / reopen / confirm; assumptions can be `load_bearing`), `brain_question` (ask / answer / close / reopen / update / confirm), `brain_list_open`. Status open / supported / refuted / closed, evidence for / against, confidence recomputed from evidence, links to plans / goals / decisions. Capture from the agent's own replies: "I think X because Y", "open question: …", "I'm assuming …" with the decision-draft guards (no conditionals, hedges, quotes, reported speech, questions); drafts expire after `openItemDraftTtlDays` (14). A relevant open question (≥ 2 topic words, stemmed, filler words ignored) can surface as one line in `[BRAIN: goals]` (`openItemSurfacing`, 6 h cooldown per item). `brain_status` shows hot questions and CONTRADICTED load-bearing assumptions.
- **Commitments and plans:** `brain_commit` (to user / self, due dates in plain words like "in 2 days" / "friday", blockers on commitments / decisions / plan steps / open items, cycle-checked), `brain_commitments`, `brain_plan` (create / list / show / update / add_steps / step / park / resume / done / abandon). Resume returns a primed briefing: the plan and steps, what is still open, linked open items and commitments, the last reflection, and what changed since it was parked. Overdue or blocked commitments show in `brain_status`; with `commitmentNudges` (default on) one overdue commitment becomes a one-line nudge consumed only by a real reply, like the alignment note (acked together: `ack_note_ids`).
- **Meta-tools (read-only, capped at `metaToolMaxChars` 2400):** `brain_changes {goal_id | plan_id | topic, days}`, `brain_conflicts {topic}` (contradictions, low-confidence / disputed, refuted hypotheses, contradicted assumptions), `brain_briefing {plan_id | goal_id | topic}`, `brain_forget_impact {cluster | query}` (what compaction / forgetting would lose; protected items; verdict — a dry run, nothing changes). A few ms each on a 600-node brain.
- **xanima-server:** all twelve tools on the caller's private brain; read scope for `brain_replay`, `brain_list_open`, `brain_commitments`, `brain_changes`, `brain_conflicts`, `brain_briefing`, `brain_forget_impact`; write scope for the rest. `brain_turn_context` returns the alignment note, commitment nudge and open-question line together (`noteIds`); `brain_episode_append` captures open-item drafts from assistant turns.
- **Flags (BrainConfig and service config.json `brain`):** `reflection` ("off"), `reflectionLlm` (false), `reflectionWindowDays` (7), `openItemCapture` (true), `openItemDraftTtlDays` (14), `openItemSurfacing` (true), `commitmentNudges` (true), `replayMaxChars` (1600), `metaToolMaxChars` (2400).
- `brain_query` can filter by the structured types (`decision`, `reflection`, `hypothesis`, `question`, `assumption`, `commitment`, `plan`).
- **0.1.0 compatibility:** the `SHARPWAVE_*` env aliases now "stop working in 0.4.0" (0.3.0 is the first release that would ship them).

## 0.2.0 (Xanima) — unreleased

Decision ledger + goals / drift (design: Xanima phase 2). Stacks on 0.1.0. Everything is heuristic; no LLM is needed.

- **Schema v20 (additive, new tables only):** `decisions`, `goals` (one row per goal version), `goal_events` (history), `goal_triggers`, `alignment_notes`. Node/edge/episode counts never change. Existing live `goal` nodes get a version-1 goals row with `tracked = 0` (still shown in the header, never drift-checked until tracked). New node type `decision`; new edge types `advances`, `conflicts_with_goal`.
- **Decision ledger tools:** `brain_record_decision` (context, options with predicted outcomes, chosen, rationale, prediction + confidence, goal / conflicting goals / skills / evidence links; uses the 0.1.0 belief metadata), `brain_update_decision_outcome` (matched / partial / missed + lesson; a non-missed outcome logs goal progress), `brain_query_decisions` (text or JSON, by query / goal / pending / resolved).
- **Auto-extraction:** first-person choices in the agent's own replies ("I'll go with X over Y because …", "I decided to use X because …") become low-confidence `self_observation` decision drafts. Quotes, code, questions and third-person text are ignored; max 2 per message; deduped per day. On xanima-server this runs on `brain_episode_append` for assistant turns in the private brain.
- **Sleep decision pass:** merges near-duplicate decisions (same choice, similar context; the duplicate is kept as superseded history), calibrates confidence once per outcome (matched +0.15, missed −0.2), and with `decisionLessonPromotion: true` promotes recurring / high-value lessons to `skill` nodes (`Lesson: …`, `derived_from` the decisions).
- **Recall:** decisions in the recall set get a light ×`decisionBoost` (1.2) activation boost (local and service recall).
- **Goals:** `brain_set_goal`, `brain_update_goal` (update / supersede → new node version via supersede, old kept for `as_of`; pause / resume / done / archive / progress / track / untrack, all in `goal_events`), `brain_list_goals` (with full history per goal). The header's active goals respect goal status and priority.
- **Drift pass** (`intentDriftCheck`: `sleep` default, `daily` at turn time at most once a day, `off`): progress = decisions advancing the goal, non-missed outcomes, explicit progress, or recent episodes mentioning its keywords. Flags "no progress on goal Y in N days" (`driftDays`, 7), "recent decisions advanced lower-priority X while Y stalled", and explicit `conflicts_with_goal` decisions. Writes `alignment_summary` and one alignment note, injected once on the next turn, capped by `alignmentNoteMaxTokens` (60), not repeated for the same drift within 24 h.
- **Triggers** (`goalTriggers`, default on): keyword triggers (word-boundary match, 6 h cooldown) and time triggers (`at` and/or `every_days`) surface a goal line in the same capped `[BRAIN: goals]` block.
- **brain_status:** decision counts, goals (active / tracked / paused / done), DRIFT lines, queued alignment note; sleep summary includes the decision and drift passes.
- **xanima-server:** the six tools work on the caller's private brain (read scope for list/query, write scope for the rest; `visibility: shared` is refused). New plumbing tool `brain_turn_context` (write scope) returns the alignment note + triggers for the plugin.
- **Flags (BrainConfig and service config.json `brain`):** `decisionLedger` (true), `decisionAutoExtract` (true), `decisionLessonPromotion` (false), `decisionBoost` (1.2), `intentDriftCheck` ("sleep"), `driftDays` (7), `goalTriggers` (true), `alignmentNoteMaxTokens` (60), `decisionDraftTtlDays` (14), `lessonMergeSimilarity` (0.86).
- **Hardening (from the sandbox run; schema v21, additive):**
  - *Talking about a goal is not progress.* Progress = a decision linked to the goal, a non-missed outcome, an explicit `brain_update_goal` progress note (shortcut `{goal_id, progress: "…"}`; a note is required), `done`/`resume`, or assistant/tool activity matching the goal's **success criteria minus its name**. Goal tool turns (`brain_set_goal` / `update_goal` / `list_goals` / `turn_context` / `status`), alignment-note text, questions and user turns never count. Re-wording / superseding a goal keeps the lineage's drift clock.
  - *Near-duplicate lessons merge.* Before promoting, a lesson is compared with existing skills and promoted lessons (embedding cosine ≥ `lessonMergeSimilarity` 0.86 when vectors exist, lexical Jaccard/containment ≥ 0.5 otherwise). A match merges into that skill: evidence union, confidence +0.05, provenance (source, source_type, writer) unchanged, history in `lesson_merges` + a `derived_from` edge with the similarity. Also fixes a lesson being promoted twice in one pass.
  - *Decision drafts expire.* Auto-extracted drafts carry `draft_status` (pending / confirmed / expired). Sleep soft-retires drafts still pending, low-confidence, outcome-less and unlinked after `decisionDraftTtlDays` (14; node status archived with an `expired:` reason, row kept). Confirm with `brain_update_decision_outcome {decision_id, confirm: true[, goal_id]}`. `brain_status` shows pending / expired drafts. Extraction now ignores conditionals and hedges (if / unless / would / could / maybe / I'd …), quoted speech and reported speech (said / suggested …), and bare "going with" mid-sentence.
  - *Alignment note is consumed only by a real reply.* `brain_turn_context` offers the note (`offered_count`); the plugin acks it (`ack_note_id`) after the turn that carried it produced a non-empty reply and did not only call memory (`brain_*`) tools. `brain_status` shows it as pending (offered N×). A note offered 6× without an ack retires (safety valve for hosts that never ack).
- **0.1.0 compatibility:** the `SHARPWAVE_*` env aliases stay through 0.2.x (now "stop working in 0.3.0"), because 0.1.0 never shipped to a live install.

## 0.1.0 (Xanima) — unreleased

Rename + belief foundation (design: Xanima phase 1).

- **Rename:** `sharpwave-core` → `xanima-core`, `sharpwave` → `xanima`, `sharpwave-server` → `xanima-server` (all 0.1.0). Old bins (`sharpwave`, `sharpwave-server`) remain as aliases. `XANIMA_*` env vars, with `SHARPWAVE_*` read as deprecated aliases for 0.1.x. Default data dir `~/.xanima`, falling back to `~/.sharpwave` until migrated.
- **`xanima-server migrate`:** copies `~/.sharpwave` → `~/.xanima` (skips `_backup-*`), migrates and verifies every brain (counts before == after, integrity), rewrites paths in the copied config.json, writes MIGRATED-FROM-SHARPWAVE.json. Never touches the source; refuses a non-empty target or a running service.
- **Schema v19 (additive):** nodes gain `confidence`, `confidence_score`, `source_type`, `verified_at`, `contradicted_at`, `evidence`, `status`, `status_reason`, `status_changed_at`, `sensitivity`, `review_flagged_at`. Backfill: `legacy` / `medium 0.6`; already-closed rows become `superseded` (if a supersedes edge points at them) or `archived`.
- **Tools:** `brain_retract` (reason required; history kept; downstream nodes listed), `brain_status` (counts, low-confidence / disputed / flagged, hot conflicts, injection estimate, last sleep summary), `brain_supersede` `reason` + related nodes, `brain_query` `as_of`, `brain_write` `confidence` / `source_type` / `sensitivity` / `evidence`.
- **Injection:** recall lines carry relative time and a `(?)` low-confidence / `disputed` / `confirm before acting` marker; an optional one-line `[BRAIN: status]` footer when something needs attention.
- **Sleep:** belief review pass stamps contradictions, flags low-confidence / disputed beliefs for review and exempts them (and retracted/superseded history) from the Deep prune; records a sleep summary. `xanima-server sleep now`.
- **Flags (BrainConfig, and service config.json `brain`):** `beliefMetadata`, `relativeTimeLabels`, `selfStatus`, `lowConfidenceThreshold`, `sleepBeliefReview`.
- **Follow-ups:** `as_of` accepts epoch-ms numbers as well as strings; `xanima-server migrate` no longer prints the "old data folder" warning (it is the fix); the first sleep on a migrated brain flags legacy heartbeat / NO_REPLY nodes for review (`brain_status` says so; nothing is retired automatically).

## [Unreleased]

### Added — system-noise guard + reversible noise review (`engram/skip-heartbeat-noise`)

- **core** `system-noise.ts`: `isSystemNoiseTurn` / `classifySystemTurn` /
  `isSystemNoiseEpisode` (OpenClaw 2026.9.7 markers; mirror of openwave 0.1.4).
  `runSwsPhase` consumes noise episodes without extracting nodes;
  `drainExtractionQueue` drops them. Retire registry keys
  (`retired:node:<id>` / `retired:episode:<id>` in `meta_kv`): SWS synaptic
  downscaling and Deep pruning skip registered nodes.
- **core fix**: spreading activation (`getNeighbors`) and the bootstrap
  top-salience fill no longer surface nodes whose `valid_until` has passed
  (retired / superseded nodes leaked back into recall through live edges).
- **server**: `brain_episode_append` skips system-noise turns
  (`skipSystemNoiseEpisodes`, default true); `noise scan|check|retire|unretire|status`
  admin commands (`docs/noise-review-runbook.md`).

### Added — `sharpwave-server` 0.1.0 (new private package, not published)

- **Brain service** (`packages/server`): one process owns a `shared` brain
  (starts empty) plus one private brain per agent; MCP Streamable HTTP on
  `127.0.0.1:18790` + a tailnet IP (never `0.0.0.0`/`::`); per-agent bearer
  tokens stored as sha256 hashes; server-stamped `writer_agent_id`; one
  serialized write queue per brain + read-only WAL readers; in-process sleep with
  a single budget; JSONL audit log; nightly `VACUUM INTO` backups with rotation;
  `sharpwave-client` CLI; Windows scheduled-task scripts (not installed).
  No `sharpwave-core` changes.

## [0.4.5] — Unreleased

> **Do not publish until 0.4.4 is published first.** Schema 18 + busy_timeout
> land on top of the unpublished 0.4.4 Engram Graft A work.

### Added

- **`PRAGMA busy_timeout` on every brain connection** (default 5000 ms).
  Configurable via `SHARPWAVE_BUSY_TIMEOUT_MS` or `getDb(agentId, { busyTimeoutMs })`.
  Complements (does not replace) `wal-retry.ts`: SQLite waits out ordinary lock
  contention; `wal-retry` still covers `SQLITE_BUSY_SNAPSHOT` and exhausted waits.
  The single-writer-per-brain contract is unchanged — the shared-brain service
  remains the supported multi-agent path.
- **Schema 18 — `writer_agent_id` provenance** on `nodes`, `episodes`, and
  `edges` (nullable TEXT; index `nodes_writer_agent`). Existing rows stay NULL
  (no backfill — the opening agent id is not a reliable historical writer).
  New writes default to the brain's own `agentId`; consolidation / sleep writes
  stamp `system:sleep` (`SYSTEM_SLEEP_WRITER`). MCP `brain_write` accepts an
  optional `writer_agent_id` (defaults to the `agent` arg). Query / history /
  expand surface the stamp when present.

### Tests

- Multi-connection / multi-process interleaved write+read busy_timeout stress
  (no `SQLITE_BUSY` surfaces; all rows land; <5 s).
- Schema 17 → 18 migration against a copy of a real brain snapshot (counts
  unchanged; new column present; new writes stamped).

## [0.4.4] — Unreleased

### Changed

- **`externalMemoryActive` now suppresses all host-curated durable prose
  (Engram Graft A).** When a host memory tier (OpenClaw memory-core's
  MEMORY.md/USER.md) is active, `buildSelfModelHeader` omits `[identity]`,
  `[user]` and `[goals]` (the `[SharpWave]` banner and `[neuro]` still inject),
  and `buildBootstrapContext` omits the self-model prose block as well as
  active goals. Recall, procedural, dream, morning-brief, episodes, review
  queue and skill-candidate content are unchanged. Omitting the option or
  passing `false` keeps the previous behavior. Required by openwave#1.

## [0.4.3] — 2026-09-20

### Fixed

- **vec0 index writes no longer fail on re-embedding, and a UNIQUE error no
  longer disables vector writes.** `vec0` virtual tables ignore
  `INSERT OR REPLACE`, so re-embedding an already-indexed node threw
  `UNIQUE constraint failed on nodes_vec primary key`. `storeEmbedding` misread
  that as a dimension mismatch and switched off every later vec0 write for the
  process, leaving a growing share of nodes out of vector search (observed:
  170 of 413 nodes in one live brain). Writes now go through the new
  `upsertNodeVector` (delete + insert in one transaction), and only a genuine
  dimension error disables vec0 writes. `consolidation` uses the same helper
  for schema-centroid vectors.

### Added

- **`rebuildNodesVec(agentId)`** re-indexes `nodes_vec` from the embedding blobs
  stored on `nodes` (only blobs of exactly `EXPECTED_VEC_DIM` floats), is safe
  to re-run, and re-arms vec0 writes. `upsertNodeVector` is exported too.

## [0.4.1] — 2026-08-31

### Fixed

- **`callOpenRouter` now strips a leading `openrouter/` from the model id.**
  `DEFAULT_CONFIG.ingestionModel` ships as
  `"openrouter/deepseek/deepseek-v4-flash"`, but the OpenRouter
  chat-completions API wants the bare `deepseek/deepseek-v4-flash`. Through
  0.4.0 the prefixed default 404'd and LLM fact extraction + generative-REM
  consolidation silently fell back to keyword heuristics. `fetchEmbedding`
  already did this strip for the embed endpoint; `callOpenRouter` now matches.
- **Retired nodes (`valid_until` in the past) no longer surface** in
  `getTopByType`, `getActiveGoals`, `getReviewQueue`, or dopamine propagation.
  Ports clawbrain-v4's F-9 audit fix, which only reached
  `getOperationalProcedures` during the MCP split.
- **`fetchEmbedding` accepts an optional `AbortSignal` again.** The
  proactive-relevance monitor races the semantic-priming embed against a 250ms
  budget; when the budget won, the underlying HTTP request kept running. It is
  now cancelled.

### Changed

- **Docs are client-neutral again.** The README leads with what Sharpwave is,
  then lists OpenClaw / Claude Code / Claude Desktop / Cursor even-handedly.
  (0.4.0 briefly framed everything around OpenClaw; the OpenClaw-specific
  wake-up/auto-injection layer is moving to a separate `openwave` plugin, so
  the MCP server stays cross-platform.)
- **Injected-context and log markers rebranded** `ClawBrain v4` → `SharpWave`.
  The always-on headers now read `[SharpWave active]` (bootstrap) and
  `[SharpWave]` (self-model); structured-log lines are prefixed `[sharpwave]`.
  `BRAIN_HEADER` keeps a `(compat: ClawBrain v3)` tail.

## [0.4.0] — 2026-08-30

### Changed

- Fixed the `homepage` / `repository` / `bugs` URLs (`EnlightenedRepublic` →
  `Enlightened-Republic`) and repaired control-character corruption in the
  README's companion-tools table. `claude-desktop-config-example.json` is
  replaced by `openclaw-config-example.json` + `mcp-config-example.json`.
  Dropped `brain_health` from the documented tool list (it was never
  registered); documented `brain_reset`.

### Added

- **Multi-agent mode.** Leave `SHARPWAVE_AGENT_ID` unset and one server process
  serves any number of agents: every `brain_*` tool then carries a required
  `agent` argument (the calling agent's own id), and each id maps to its own
  `<dataDir>/<agentId>/brain.db`. `SHARPWAVE_AGENTS` (comma list) is an optional
  allowlist. Setting `SHARPWAVE_AGENT_ID` keeps the original single-agent
  behavior unchanged — the `agent` arg becomes optional and, if passed, must
  match. `brain_reset`'s `confirm` must equal the resolved agent id in both
  modes. Working-memory cleanup and the embedding drain run per-agent in
  multi-agent mode; the startup update check is skipped (no single db to stamp).

- **`brain_reset` tool** — `src/reset.ts`. Transactionally wipes every node,
  edge, episode, vector, working-memory row and the self-model for an agent,
  then re-seeds an empty self-model. Takes a timestamped `.db` backup first
  (via `createBackup`). Requires `confirm` to exactly equal the agent's
  `SHARPWAVE_AGENT_ID`. Uses `DELETE FROM` (never `DROP`), so the `nodes_vec`
  dimension (`float[1024]`) and the embedding provider config
  (Ollama → OpenRouter) are untouched — writes and recall work immediately
  after a reset. FTS indexes are force-rebuilt, then `wal_checkpoint(TRUNCATE)`
  + `VACUUM` reclaim disk.

### Fixed

- **`db-backup.ts` was fully non-functional.** Database path came from
  `db.exec("PRAGMA database_list")[0]?.file` — better-sqlite3's `.exec()`
  returns the `Database` object, not rows, so this was always `undefined` and
  every backup threw *"Could not determine database path"*. Now uses `db.name`.
  Also replaced `require("node:fs")` calls that fail under the esbuild ESM
  bundle (*"Dynamic require of node:fs is not supported"*) with static imports.

## [0.3.0] — v0.3.0 audit port

Ports the audit fixes from ClawBrain v0.4.0 (Python `clawbrain.py`) into the
TypeScript codebase. All changes are additive — existing API surface is
preserved.

### Added

- **WAL retry with exponential backoff** — new `src/wal-retry.ts` wraps
  every critical write path (`writeNode`, `touchNode`, `writeEdge`,
  `closeEdge*`, `appendEpisode`, `setMeta`, `updateSelfModelField`,
  `forgetNodeById`) with retry on `SQLITE_BUSY` / `SQLITE_LOCKED`.
  Exponential backoff (100ms → 200ms → 400ms) plus 0–50ms jitter,
  max 3 attempts. Async and sync variants both provided.

- **Embedding LRU cache** — new process-lifetime `Map`-based LRU
  (default 1024 entries, `SHARPWAVE_EMBEDDING_CACHE_MAXSIZE` override)
  wrapping `fetchEmbedding` via `fetchEmbeddingCached`. Re-entrancy
  guard via `cacheBusyKey` prevents duplicate provider calls during
  in-flight fetches for the same text. New `embeddingCacheStats()`
  returns `{size, maxsize, hits, misses}`.

- **MinHash entity resolution** — `src/entity-resolution.ts` was a stub
  (`mergeCoreferentNodes` returned 0). Now ships:
  - `findNearDuplicates(agentId, content, embedding?, threshold, typeFilter?)`:
    embedding cosine fast path, character-trigram Jaccard fallback.
  - `deduplicateExisting(agentId, threshold)`: union-find grouping
    over pairwise Jaccard for offline maintenance.
  - `mergeCoreferentNodes(agentId, log)`: wires `coreference_of` edges
    from duplicates to the oldest canonical node. Idempotent.

  No external dependency — pure-JS character trigram shingling + Jaccard
  (datasketch is Python-only).

- **FTS5 maintenance** — new `maintenance()` public entry point in
  `src/db.ts` runs rebuild + optimize and returns cache stats. The
  private `bumpWriteCounter()` (exported) auto-triggers an `optimize`
  every N writes (default 100, `SHARPWAVE_FTS_OPTIMIZE_EVERY` override).
  Both ops no-op gracefully if FTS tables are missing (sqlite-vec / FTS5
  unavailable on the platform).

- **Observability module** — new `src/observability.ts`:
  - Always-on diagnostic counters: `memories_stored`, `memories_recalled`,
    `memories_forgotten`, `memories_merged`, `embeddings_computed`,
    `embeddings_cached`, `fts_optimizes`, `fts_rebuilds`, `wal_retries`,
    `wal_retry_failures`.
  - Optional JSONL event log at
    `${SHARPWAVE_DATA_DIR}/brain_events.jsonl` when
    `SHARPWAVE_OBSERVABILITY=1`. Default OFF so standard installs stay
    silent.
  - `setLastConsolidationAt()` / `getLastConsolidationAt()` surface
    consolidation freshness.

- **`brain_health` tool** — new MCP tool returning counters, embedding
  cache, FTS state, observability-enabled flag, and last-consolidation
  timestamp. Zero side effects; safe to call repeatedly.

- **Input validation** — new `src/validation.ts`:
  - `validateNonEmptyString(value, field)` — throws on empty/whitespace
  - `clampImportance`, `clampConfidence`, `clampTrait` — number [0, 1]
  - `validateMemoryKind` / `validateDurability` / `validateScope` —
    allowlist check, defaults to `fact` / `long_term` / `private` with a
    stderr warn on invalid

  Wired into all tool handlers that take user-provided IDs/strings:
  `brain_write`, `brain_supersede`, `brain_link`, `brain_review`,
  `brain_expand`, `brain_edges`, `brain_forget`. Also clamps `brain_query`'s
  `limit` to [1, 100].

- **`brain_stats` extended** — now includes an "Observability (v0.4)"
  section with all diagnostic counters inline.

- **Write-node dedupe gate** — `writeNode()` gains an optional
  `deduplicate: boolean` (default true) and `dedupeThreshold: number`
  (default 0.85). When a near-duplicate is found above threshold, the
  canonical node's importance is bumped instead of inserting a duplicate
  row. The SWS path opts out (it already has its own Jaccard pre-check).

### Changed

- **package.json version** — bumped from 0.2.1 to 0.3.0.

### Backwards compatibility

All public API surfaces are preserved. New optional parameters on
`writeNode` default to behavior compatible with v0.2.x. The new
`brain_health` tool is purely additive.

## [0.2.1] — prior release

FSRS-6 spaced-repetition model, FSRS-6 SIGMA per-node calibration,
CLS two-store split (is_consolidated), pattern-separation hash, temporal
validity windows, deterministic REM / SWS / Deep / NEXUS consolidation
phases, hybrid FTS + vector + spreading-activation retrieval.

## [0.1.0] — initial release

Baseline TypeScript port: better-sqlite3 storage, sqlite-vec vector
search, FTS5 keyword search, MCP server with the original 10 tools.
