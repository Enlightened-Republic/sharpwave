# Xanima security model (0.5.0)

This covers what an agent's memory trusts, what it does not trust, and the controls Xanima provides. Everything here works without an LLM.

## Principals and boundaries

| Boundary | Enforced by |
|---|---|
| Which agent a call acts as | The bearer token. Client-supplied `writer_agent_id` / `agent` are ignored on the service. |
| Private brains | No argument can name another agent's private brain. |
| `shared` brain | Everyone reads it. Writing needs the `shared-write` scope. |
| Rooms | Token scope **and** live room membership (read / write / admin), checked on every call. Creating a room needs the `room-admin` scope. See [rooms.md](rooms.md). |
| Admin operations | `admin` scope: `brain_import_soul`, review accept / reject, `brain_seed`, `brain_reset` (which also needs `allowReset`). The CLI on the brain host acts as an admin. |
| Audit | `audit.jsonl` records who did what to which brain and node, plus every denial. It never records memory content. |

## Untrusted input

Some text should never change who the agent is without a check:

* **tool output** (`source_type: tool`): web pages, files, API results;
* **other agents** (`source_type: agent`), including room content;
* **imports** (`source_type: import`): Soul Packages and merges;
* **injection-looking text from anyone**: "ignore previous instructions", "your new identity is…", "you are now…", "from now on, you…", "new system prompt", "override your identity / rules / values / goals". The pattern is `INJECTION_RE` in `xanima-core`.

## Protected targets

* identity: `identity` nodes, `self_model.identity`, and labels starting with value / rule / identity / goal / mission / persona / principle;
* goals: `goal` nodes, `brain_set_goal`, and `brain_update_goal` changes. Logging progress (`progress`) and toggling `track` / `untrack` do not change what a goal is, so they are not protected;
* any write whose text looks like an injection.

## Quarantine

A write is quarantined when it hits a **protected target** and comes from an **untrusted source**.

| `quarantine` | Behaviour |
|---|---|
| `off` | No checks. |
| `log` (default in 0.5.0) | Goal writes are applied, and a review item with status `logged` records what enforce would have held. **Identity / value writes are held** (`pending`, nothing stored) even in log mode, since the 0.5.0 follow-up: log mode used to store injected identity text. |
| `enforce` | The write is **not** applied. A `pending` review item (kind `quarantine`) holds the exact proposed operation. An admin runs `brain_review {"action":"accept","id":…}` (applied through the normal write path, so supersede keeps history and goal versions are kept) or `reject` (nothing changes). |

Not blocked under enforce, by design:

* the agent's own explicit, trusted updates through its tools: `brain_set_goal` / `brain_update_goal` without an untrusted `source_type`, `brain_write` identity from `source_type: user`, and `brain_update_self_model` with ordinary text;
* ordinary facts from tools (`brain_write` semantic with `source_type: tool`);
* goal progress notes.

Tests pin both a poisoning corpus and a false-positive corpus (`packages/core/test/v050.test.ts`, `packages/server/test/rooms-v050.test.ts`).

Visibility: `brain_status` shows `quarantine (mode): N held for review, M logged (applied), A accepted, R rejected`, and an attention line appears whenever something is held. `brain_review {"action":"list","kind":"quarantine","status":"pending|logged|all"}` and `xanima-server soul review list --agent X --kind quarantine` list the items.

Soul imports keep their 0.4.0 rule: identity, values and goals from a package **always** wait in review, whatever the quarantine mode, and injection-looking text is flagged.

## Agent-evolved identity (`brain_identity`)

**Rule:** identity changes only from the agent's own reflection on its experience and its conversations with its owner, never from outside content. Research, web and tool content goes into knowledge, skills and tools (`brain_write`), not identity. There is no review queue on this path.

* **What the agent can change:** the `- **Field:** value` lines of its always-on header (`self_model.identity`) and its core values (`identity` nodes), with `brain_identity {action: add | change | remove, target: field | value, …, reason}`. `get` / `history` read.
* **Applied at once and versioned** when the host plugin attests the run as an origin listed in `identity.changesFrom`. The default is `["owner_turn"]`: who the agent is changes only through conversations with its owner. A change proposed from the agent's own `reflection` run (cron / heartbeat, no outside input) or a clean `agent_turn` is **held**, not applied and not lost: it becomes a pending review item (kind `identity_change`) that the owner accepts (`brain_review accept`, admin, or `xanima-server soul review accept`) or rejects; `brain_status` shows "N held for review". Add `reflection` / `agent_turn` to `changesFrom` to let the agent evolve on its own. Every applied change is a numbered version in `identity_changes` (old / new value, reason, provenance, writer, identity text after). Values are superseded / retracted, never deleted.
* **Sleep never changes identity.** Consolidation used to classify "I am …" / "I value …" / "I prefer …" sentences in stored turns as `identity` nodes, which then showed up as the agent's core values. An owner's statement is now kept as a semantic fact about the owner ("Owner said: …"); the agent's own or a tool's sentences of that shape are dropped. The LLM / heuristic extractor does the same ("About the owner: …").
* **Refused** (not held) when the run read outside content: `tool_output` (a non-memory tool such as web_fetch / read / exec returned output in the run), `untrusted_sender` (a non-owner message started the run, when `commands.ownerAllowFrom` is set), `tool_output_echo` (the new text repeats recent tool output), a model-claimed `source_type` tool / agent / import, or injection-looking text. The refusal tells the agent to save what it learned with `brain_write` as a fact or skill. No review item is created. The model can't claim its own provenance: the plugin overwrites `attested_provenance`.
* **Nothing lost:** a refused proposal is kept as a candidate knowledge note (`semantic`, `source_type: tool`, confidence 0.4, tags `source:web`, `identity-candidate`). The note goes through the normal quarantine gate first, so injection text is quarantined, not stored.
* **Readable / revertible:** `xanima-server identity history --agent X [--all]` (`--all` adds refused attempts), `identity show`, `brain_status` (`identity: vN … refused in 24 h`), `brain_changes {topic: "identity"}`. `identity revert <version>` (service stopped, backup first) applies the inverse as a new version.
* **Switches** (`identity.*` in the brain config, one each):

  | switch | default | effect |
  |---|---|---|
  | `selfEdit` | `true` | `false` = `brain_identity` is read-only. |
  | `refuseUntrusted` | `true` | The refusal above. `false` = such changes apply like any other (still versioned), and quarantine log mode logs untrusted identity writes again instead of holding them. |
  | `saveRefusedAsNote` | `true` | Keep a refused proposal as a candidate knowledge note. |
  | `locked` | `["Name"]` | Fields the agent can't change. `[]` = none. Hailey changes a locked field via a soul import + review. |
  | `maxChangesPerDay` | `0` (off) | `N` = refuse after N applied agent changes per rolling 24 h. |
  | `maxChars` | `2000` | Cap on the identity header and one value's text. `0` = no cap. |
  | `requireAttestation` | `false` | `true` = refuse changes with no host attestation (bare MCP clients). |
  | `changesFrom` | `["owner_turn"]` | Run origins that may change identity directly. Others among `reflection` / `agent_turn` are held for the owner's review. |

* **Steering:** the tool description and the per-turn identity header carry a one-line note: identity = who you are, changed through conversations with your owner (a change you propose on your own is held for them); what you learn goes to knowledge / skills.
* **Workspace mirror (plugin, off by default):** `identityMirror: true` writes applied changes back to the workspace `IDENTITY.md` field lines and a managed block in `SOUL.md`.
* **Soul package imports** (an explicit external source the operator triggers) still wait in review.
* `brain_write` / `brain_supersede` of `identity` nodes from untrusted sources stay a quarantine matter: held as `pending` (kind `quarantine`) in log and enforce mode.

## Injection control

The always-on **header** (identity, top goals or alignment notes, operational rules) is separate from selective **recall**.

* `injectionCategories` switches each part: `identity`, `goals`, `rules` (header) and `recall`, `decisions`, `rooms` (recall). It also sets `sensitive` to `relevant` (default), `never` or `always`.
* `brain_focus` suppresses or boosts topics, projects (`tags` on `brain_write`), rooms or node types in recall, for N turns or until a task is cleared. It never touches the header, and explicit `brain_query` calls are never shaped.
* Sensitivity: `sensitive` items are injected only when the turn names their topic (two label words, or a tag). `confirm_before_acting` items carry a "(confirm before acting)" marker in the injected line. Publishing a sensitive item to a room needs `allow_sensitive`.

## Known limits

* The injection patterns are heuristic: they catch the common phrasings, not every paraphrase. The source-type rule is the main protection, so the host should tag tool output as `source_type: tool` when it writes memories.
* Room members see what is published to the room; publishing is a deliberate act and is audited.
* `log` mode does not protect goals, it only measures. Turn on `enforce` after reviewing the logged items. (Identity / value writes from untrusted sources are held in log mode too.)
* Identity provenance is only as good as the host's attestation. The OpenClaw plugin taints a run once any non-memory tool returns output, so an agent that browses and then decides to change itself in the same run is held: that's deliberate (false positives cost a review click). Text the agent saw in an *earlier* run is caught only by the echo check (exact-ish overlap with recent tool output) and the injection patterns.
