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

Agents may add to and change their **own** identity (the `- **Field:** value` lines of the always-on header, `self_model.identity`) and core values (`identity` nodes) with `brain_identity {action: add | change | remove, target: field | value, field / value_id, value, reason}`. `get` / `history` read.

* **Applied at once** when the change comes from the agent's own turn. Every applied change is a numbered **version** in `identity_changes`: target, old and new value, the required reason, provenance, writer, the identity text after it. Values are superseded / retracted, never deleted. Soul-review accepts and legacy `brain_update_self_model` identity writes are versioned too.
* **Readable:** `xanima-server identity history --agent X [--all]` (read-only; `--all` adds held and refused attempts), `identity show`, `brain_status` (`identity: vN (last …) · changes in 24 h · held · refused · locked`), `brain_changes {topic: "identity"}`, the audit log.
* **Revertible:** `xanima-server identity revert <version> --agent X` (service stopped, backup first) applies the inverse as a **new** version. It refuses when the same field / value changed later, unless `--force`.
* **Provenance:** the OpenClaw plugin attests each call (`attested_provenance`, overwriting anything the model put there): `agent_turn` (clean), `tool_output` (a non-memory tool returned output in this run, e.g. web_fetch, read, exec), `untrusted_sender` (the run started from a non-owner message, when `commands.ownerAllowFrom` is set), `tool_output_echo` (the new text repeats recent tool output from the session). Anything but `agent_turn`, a model-supplied `source_type` tool / agent / import, or injection-looking text is **held** in the review queue (kind `identity_change`, `pending`) whatever the quarantine mode (except `off`). Nothing is stored until an admin accepts (applied as a version) or rejects.
* **Locked fields:** `identity.locked` (default `["Name"]`) can't be added, changed or removed by the agent, and an accept can't move them either. Hailey changes them via a soul import + review.
* **Caps:** `identity.maxChangesPerDay` (5 applied agent changes per rolling 24 h), `maxFieldChars` 300, `maxValueChars` 600, `maxIdentityChars` 1000 (whole header), `maxFieldNameChars` 40, reason 3–300 chars. Over the limit = refused (recorded).
* **Unattested callers** (a bare MCP client with no host plugin) are treated as the agent's own turn, subject to every other check. Set `identity.requireAttestation: true` to hold them instead.
* **Workspace mirror (plugin, off by default):** with `identityMirror: true` the OpenClaw plugin writes the applied identity back to the workspace `IDENTITY.md` (only the `- **Field:**` lines change) and agent-made values into a managed block in `SOUL.md`, so OpenClaw's files stay in sync.

Soul package imports are unchanged: identity, values and goals from a package always wait in review.

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
