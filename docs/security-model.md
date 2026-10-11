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
| `log` (default in 0.5.0) | The write is applied, and a review item with status `logged` records what enforce would have held. Use this to measure false positives before turning enforce on. |
| `enforce` | The write is **not** applied. A `pending` review item (kind `quarantine`) holds the exact proposed operation. An admin runs `brain_review {"action":"accept","id":…}` (applied through the normal write path, so supersede keeps history and goal versions are kept) or `reject` (nothing changes). |

Not blocked under enforce, by design:

* the agent's own explicit, trusted updates through its tools: `brain_set_goal` / `brain_update_goal` without an untrusted `source_type`, `brain_write` identity from `source_type: user`, and `brain_update_self_model` with ordinary text;
* ordinary facts from tools (`brain_write` semantic with `source_type: tool`);
* goal progress notes.

Tests pin both a poisoning corpus and a false-positive corpus (`packages/core/test/v050.test.ts`, `packages/server/test/rooms-v050.test.ts`).

Visibility: `brain_status` shows `quarantine (mode): N held for review, M logged (applied), A accepted, R rejected`, and an attention line appears whenever something is held. `brain_review {"action":"list","kind":"quarantine","status":"pending|logged|all"}` and `xanima-server soul review list --agent X --kind quarantine` list the items.

Soul imports keep their 0.4.0 rule: identity, values and goals from a package **always** wait in review, whatever the quarantine mode, and injection-looking text is flagged.

## Injection control

The always-on **header** (identity, top goals or alignment notes, operational rules) is separate from selective **recall**.

* `injectionCategories` switches each part: `identity`, `goals`, `rules` (header) and `recall`, `decisions`, `rooms` (recall). It also sets `sensitive` to `relevant` (default), `never` or `always`.
* `brain_focus` suppresses or boosts topics, projects (`tags` on `brain_write`), rooms or node types in recall, for N turns or until a task is cleared. It never touches the header, and explicit `brain_query` calls are never shaped.
* Sensitivity: `sensitive` items are injected only when the turn names their topic (two label words, or a tag). `confirm_before_acting` items carry a "(confirm before acting)" marker in the injected line. Publishing a sensitive item to a room needs `allow_sensitive`.

## Known limits

* The injection patterns are heuristic: they catch the common phrasings, not every paraphrase. The source-type rule is the main protection, so the host should tag tool output as `source_type: tool` when it writes memories.
* Room members see what is published to the room; publishing is a deliberate act and is audited.
* `log` mode does not protect, it only measures. Turn on `enforce` after reviewing the logged items.
