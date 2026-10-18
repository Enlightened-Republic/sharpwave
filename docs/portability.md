# Portability guide: Soul Packages (`xanima-soul/1`)

A Soul Package is the portable, high-signal part of an agent's brain: who it is, what it wants, what it
knows how to do, what it has learned, and where each of those came from. You can carry it to a fresh brain
on another machine, to another runtime (anything that can load `xanima-core`, or anything that can read
JSON), or fork it, let the copy evolve, and merge the changes back without losing either side's work.

## What is in a package

| Section | Source | Notes |
|---|---|---|
| `identity` | `self_model.identity` (the never-compacted header) | always goes to review on import |
| `values` | active `identity` nodes | review on import |
| `goals` | current version of each active goal, with its event history | review on import; compact keeps the last 3 events |
| `skills` | active `skill` / `procedural` nodes, ranked by importance × confidence | compact: top 25 |
| `lessons` | decisions with a recorded lesson (not merged, not drafts) | compact: newest 20 |
| `facts` | active `semantic` / `schema` nodes at or above `soulMinFactConfidence` (0.6), not sleep inferences | compact: top 40 |
| `open_items`, `commitments` | open / supported hypotheses, questions, assumptions; open commitments | full profile, or `--include-open-items` |
| `shared_facts` | the shared brain | only with `--include-shared` (CLI) |

Every item carries **provenance**: writer, `source_type`, confidence, created / updated time. Items carry an
**origin id** (the id in the brain the item first came from), so the same item keeps the same id across forks.

**Left out by default:** raw episodes (never exported), `sensitive` items (only with `--include-sensitive`,
CLI only), retired / superseded / retracted / archived / expired items, unconfirmed drafts, anything still in
the review queue, and shared-brain items.

## Integrity and signing

* `integrity.content_hash` = sha256 of the canonical JSON (keys sorted recursively, no whitespace) of the
  package without `package_id`, `integrity` and `signature`. `package_id` = `xs1-` + the first 24 hex chars.
  Per-section hashes are in `integrity.manifest`.
* Same brain + same options → the same bytes and the same package id (no wall-clock fields; `created_at` is
  the newest `updated_at` among the included items).
* Optional ed25519 signature: `xanima-server soul keygen --key-file ~/.xanima/keys/soul.key` writes a private
  key (mode 600) and `soul.key.pub`. Keep the private key out of every repo. `soul export --sign --key-file …`
  signs; `soul import|validate --trust-key <key id> --require-signature` enforces it.
* The JSON Schema is `packages/core/schema/xanima-soul-1.schema.json` (also shipped in the npm package as
  `xanima-core/schema/xanima-soul-1.schema.json`). `validateSoul()` checks the structure, the hash, the
  package id, the manifest and the signature. A tampered package is refused before anything is written.

## Loading a soul into a fresh brain on another machine

```bash
# on the source machine (read-only; fine while the service runs)
xanima-server soul export --agent tripp --profile full --out tripp.soul.json --sign --key-file ~/.xanima/keys/soul.key

# copy tripp.soul.json (and tripp's soul.key.pub key id) to the new machine, then, with the service stopped:
xanima-server soul validate --from tripp.soul.json --trust-key <key id>
xanima-server soul import --agent newbie --from tripp.soul.json --dry-run
xanima-server soul import --agent newbie --from tripp.soul.json            # backup first, audit entry
xanima-server soul review list --agent newbie                              # identity, values, goals wait here
xanima-server soul review accept --agent newbie --all                      # or accept / reject one by one (--id rv-…)
```

`--mode new` (default) needs a brain without a curated self (no identity, goals, skills, facts or decisions);
a brain with only a few episodes is fine. Use `--mode merge` for anything else: missing items are added and
every difference becomes a review item. **Nothing is ever overwritten.**

Imported memories land as `source_type: import` with confidence capped at `soulImportConfidence` (0.5), an
`imported_from` edge to an archived provenance anchor node for the package, and the original provenance in
`soul_provenance` (a later re-export shows the original writer, source and confidence again).

## Other runtimes

Any Node runtime can use the library directly (no OpenClaw needed):

```ts
import Database from "better-sqlite3";
import { exportSoul, serializeSoul, validateSoul, importSoul, listReviews, acceptReview, envSet } from "xanima-core";

const pkg = exportSoul(new Database("/path/to/brain.db", { readonly: true }), { agentId: "tripp", profile: "full" });
writeFileSync("tripp.soul.json", serializeSoul(pkg));

envSet("DATA_DIR", "/path/to/brains");        // <dir>/<agentId>/brain.db
const report = importSoul("newbie", JSON.parse(readFileSync("tripp.soul.json", "utf8")), { mode: "new", backup: () => myBackup() });
```

A runtime that does not use Xanima at all can still read the JSON: `content.identity.text`, `content.goals`,
`content.lessons` and `content.skills` are plain text with provenance, and the schema describes every field.

## Fork and three-way merge

```bash
xanima-server soul fork   --agent tripp --out base.soul.json            # full profile, fork: true
xanima-server soul import --agent nova --from base.soul.json --mode merge
#   … nova works: changes a goal, learns a lesson, corrects a fact …
xanima-server soul export --agent nova --profile full --out nova.soul.json   # parent_id = base package id
xanima-server soul diff   base.soul.json nova.soul.json
xanima-server soul merge  --base base.soul.json --theirs nova.soul.json --into tripp [--dry-run]
xanima-server soul review list --agent tripp
xanima-server soul review show --agent tripp --id rv-…                  # conflict markers: ours / base / theirs
xanima-server soul review accept|reject --agent tripp --id rv-… [--reason "…"]
```

Per item, by origin id:

| base → ours | base → theirs | result |
|---|---|---|
| same | same | unchanged |
| changed | same | ours kept (ours-only) |
| same | changed | skills / facts / lessons / open items: applied as a supersede (old version kept) when `soulMergeApplyTheirs` (default true), else review. Identity, values, goals: **always review** |
| same | added | created (identity / values / goals: review) |
| same | removed | review (`removal`; accept retracts, never deletes) |
| changed | changed differently | **conflict** review item with `<<<<<<< ours / ||||||| base / ======= / >>>>>>> theirs` markers |

Merges take a backup first and write an audit entry. Accepting a conflict replaces ours with theirs through
the normal supersede path (history kept); rejecting changes nothing.

## Permissions

| Path | Who |
|---|---|
| `brain_export_soul` (MCP / plugin) | the agent, **own brain only**, read scope. compact JSON or a summary; no sensitive items, no shared brain |
| `brain_review action:list/show` | the agent, own brain, read scope |
| `brain_review action:accept/reject` | admin scope only (a human decides what reaches identity and goals) |
| `brain_import_soul` | admin scope only; listed to admin tokens only; backup first |
| `xanima-server soul import / merge / review accept\|reject` | the operator on the brain host, service stopped |

## Flags (`brain` in the service config.json, or BrainConfig)

| Flag | Default | Meaning |
|---|---|---|
| `soulExportProfile` | `"compact"` | default profile |
| `soulTokenBudget` | `2000` | ≈ token budget (chars / 4) for compact content; facts are trimmed first, then open items, skills, lessons |
| `soulMinFactConfidence` | `0.6` | facts below this are left out |
| `soulImportConfidence` | `0.5` | confidence cap for imported memories |
| `soulMergeApplyTheirs` | `true` | apply theirs-only changes to skills / facts / lessons on merge |
| `soulPackageOnExport` | `false` | `xanima-server backup now` also writes a compact package per private brain into `<backups>/<brain>/soul-packages/` (read from the snapshot, rotated with `backup.keep`) |

## Seeing the soul in a remote agent's turns

In remote mode the OpenClaw plugin does not inject local mode's full self-model header. From 0.4.0,
`brain_turn_context` also returns the brain's identity (up to 400 chars) and its top 3 active goals, and the
plugin's `soulHeader` setting decides what's shown: `"identity"` (default, adds `[BRAIN: identity] …` only
when identity is non-empty and, while the setting is left unset, MEMORY.md / USER.md don't own identity —
setting it explicitly shows it regardless), `"identity+goals"` (also
`[BRAIN: active goals] a · b · c`), or `"off"`. Decision lessons arrive through normal recall.
