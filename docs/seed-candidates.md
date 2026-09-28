# Shared-brain seed candidates (curation only — nothing copied)

The brain service's `shared` brain **starts empty**. This is a curated list of
nodes from agent `main`'s brain that look like they belong in a shared brain:
durable, useful across agents, non-private, and not already owned by the
MEMORY.md / USER.md identity files. **Nothing has been copied or seeded** —
this is input for a human decision.

**Source:** read-only snapshot `brain-snap/main/brain.db` (+ `-wal`), schema v17,
533 nodes total (199 semantic, 57 skill). The snapshot was copied to a temp file
and only the copy was opened; the original's sha256 was verified unchanged.

**How to seed (when approved):** many SWS-extracted nodes are sentence
fragments (the extractor split mid-sentence), so seed by *re-authoring* each
item as a clean node via `brain_write` with `visibility: "shared"` (writer = the
seeding agent's token), citing the source id in the content — not by copying
rows. Prefer merging near-duplicates noted below into one node.

**Candidates: 46** (33 semantic, 13 skill)

## OpenClaw update & gateway service (Windows)

| # | node id | type | summary | why shared |
|---|---|---|---|---|
| 1 | `b34110e5-4c4a-4a9a-b7b2-7e826da35d69` | skill | A stale Windows Scheduled Task for the gateway blocks the OpenClaw updater; fix = re-register the task, verify with `--dry-run` first. | Canonical fix for a recurring host issue any ops agent may hit. |
| 2 | `991a540f-e32f-41b7-9f42-638a6a55a6ff` | skill | Doctor's "Service command does not include the gateway subcommand" means the gateway task's command line is wrong. | Maps a cryptic doctor message to its cause. |
| 3 | `d641eb94-e899-4d29-a16a-6a3535140091` | semantic | `openclaw update` can finish installing, then fail to restart because the service it restarts is misconfigured. | Explains a confusing failure mode. |
| 4 | `acea8263-93de-411e-b8bc-ba9c692e8f29` | semantic | The "global update (omit optional)" message is misleading; the real cause is in the npm debug log under `npm-cache/_logs/`. | Tells any agent where to look first. |
| 5 | `ad5ee778-85a9-40b0-a0fd-7443a7cd38a3` | semantic | When preinstall refuses, npm's rollback leaves EPERM errors; that's the source of the "global update" noise. | Keeps agents from chasing red-herring EPERMs. |
| 6 | `c36169d8-a228-423c-9fc3-7f6fcee8c93d` | semantic | No `openclaw update` flag (`--yes`, `--accept-capabilities`, `--tag`) bypasses the Node version gate in preinstall. | Durable tool behaviour; saves retries. |
| 7 | `159bcd29-5a26-4624-b0dc-bb652331bce5` | semantic | The npm engine check fires during real install/staging, not earlier. | Pairs with #8; explains why dry-run passes. |
| 8 | `2dc3cea3-5cf0-4318-a0a7-eb178fdcdf79` | skill | `openclaw update --dry-run` won't surface an engine mismatch (its validate phase doesn't invoke npm). | Prevents false confidence from a clean dry-run. |
| 9 | `bf337295-4875-4978-9833-b2efb9a1419c` | semantic | Without `--engine-strict=true`, EBADENGINE is only a warning; with it, npm refuses. | General npm fact. |
| 10 | `42bf22f1-fc9a-4ba1-acf8-d85731a9b01a` | skill | `openclaw update --dry-run` previews; `openclaw update status --json` reports state. | Safe, read-only commands for any agent. |
| 11 | `ec101867-ce88-4b1a-92d3-d5224a518725` | skill | If update still hits "global update" after re-registering, run `openclaw update repair`. | Next step in the same runbook. |
| 12 | `5e0bbead-0e17-4d36-b80e-c86b99a35c22` | skill | Run plugin update sync after a core update. | Post-update checklist item (merge with #13). |
| 13 | `f20289f1-2485-49b1-95cc-eeaf558dc326` | skill | After updating: restart the gateway service and run doctor. | Post-update checklist item. |
| 14 | `f6aabad4-34da-4ebb-af69-8a98bff01055` | semantic | `openclaw update` is the official update path (docs: /install/updating). | Steers agents away from ad-hoc `npm -g`. |
| 15 | `822b61e6-874c-4bc0-974c-58840dce93ed` | skill | `openclaw onboard recommendations --json` gives an informed pre-check. | Read-only diagnostic command. |
| 16 | `6c4783fc-e060-4b33-abe9-c4ddc113dabc` | skill | Run updates from outside the openclaw install tree (workspace, `~`, `C:\`). | Avoids the locked-CWD failure (#17). |
| 17 | `688222a6-9d2f-43ab-88b0-a0d8ca3100a5` | semantic | Windows won't delete the package dir if a shell's CWD is inside it (e.g. `node_modules\openclaw\docs`). | Root cause behind #16/#18. |
| 18 | `9cf9a6da-09bc-43bf-a3f0-53412415f456` | semantic | Result of #17: npm EBUSY/ENOTEMPTY, package partially replaced. | Symptom → cause mapping (merge with #17). |
| 19 | `729a94ca-cc8f-4124-9487-4f0f1c6ef951` | semantic | Doctor's nag-level warnings don't block anything; gateway and CLI work. | Triage guidance. |
| 20 | `39fc5d91-3e85-4c41-9b97-54c114adaaa2` | semantic | `openclaw update` can succeed yet still print doctor config warnings (leftover plugin block, groupPolicy, missing tool, no backup). | Prevents misreading success as failure. |

## Windows / npm environment on the host

| # | node id | type | summary | why shared |
|---|---|---|---|---|
| 21 | `59a3b64f-a717-4da8-8bc9-258dada3dc29` | semantic | "openclaw not recognized" = npm global bin dir not on PATH in that session; Node itself is fine. | Common PowerShell trap. |
| 22 | `164e527c-1a55-41c1-9a43-5f46498560ea` | semantic | Fix: `$env:Path += ";$env:APPDATA\npm"`. | The one-line fix for #21. |
| 23 | `2e5a322f-9344-4e1a-ac6c-6b90e416f539` | semantic | That PATH issue is a generic Windows npm-globals trap, not an OpenClaw bug. | Correct attribution. |
| 24 | `bcb1d60f-931d-4d02-9673-21b6847daf00` | skill | `npm bin -g` was removed in newer npm; use `npm prefix -g` (+ `node_modules`). | Durable npm change (fold in `fe567f11`). |
| 25 | `fc51c9b2-2260-488a-801a-8d6e796fb57e` | semantic | Node on the host is the standard install at `C:\Program Files\nodejs`. | Host fact every local agent needs. |
| 26 | `9a4d86f0-2085-43b6-ad8a-4e4f096942f5` | semantic | Node upgrade options on Windows: MSI, nvm-windows, or fnm (easiest); docs note Node 24. | Reusable how-to. |
| 27 | `7b0bd13c-8846-404e-9cc5-becff1c7852a` | semantic | Vercel CLI 59 goes interactive for env values; pipe the value via stdin instead of a positional arg. | Tool quirk any deploy agent hits. |

## OpenClaw configuration semantics

| # | node id | type | summary | why shared |
|---|---|---|---|---|
| 28 | `9adca641-4653-4a76-a6c3-4e97c4f86544` | semantic | `ownerAllowFrom` being set doesn't apply to the heartbeat; the heartbeat needs its own config. | Non-obvious config interaction. |
| 29 | `a17daa71-3e03-432f-b7c1-406cd92b8769` | semantic | Heartbeat defaults when no override: `target=owner`, `every=6h`, `timeoutSeconds=1800`. | Reference values. |
| 30 | `335a0689-8561-4a79-9e7c-c1c329961130` | semantic | A heartbeat/automation with no target falls back to the default write path (the chat). | Explains "why is it posting in chat". |
| 31 | `07a67350-1f57-45fe-86d2-f3a25177a204` | semantic | The cron list's "running" status for system-owned monitor jobs is persisted display state, not the live flag. | Prevents misreading cron output. |
| 32 | `1d30e583-5824-423d-b73c-82364b5be942` | semantic | None of the cron jobs is a watchdog; the gateway's Windows Scheduled Task is separate. | Clarifies the process model. |
| 33 | `8a48a425-aed5-4dab-a9db-95adaedcdf71` | semantic | Telegram `groupPolicy: allowlist` with empty `allowFrom` silently drops group messages. | Silent-failure config trap. |
| 34 | `96fb1d24-371d-4480-94b5-d9617c6c6f2b` | semantic | Moving plaintext secrets out of config: `openclaw secrets configure`, then `openclaw secrets audit --check`. | Security hygiene runbook (current; supersedes `3960bedc`). |
| 35 | `091917fb-cc6d-4282-9ae2-41b8745bd6ca` | semantic | OpenClaw seeds BOOTSTRAP.md into new workspaces and deletes it after the birth sequence — its absence is intentional. | Stops agents "restoring" it. |
| 36 | `2d4fc169-a2ef-47a8-9b02-720a338c9638` | semantic | ClawHub has 5,300+ skills; ~373 flagged malicious by external audits. | Supply-chain caution for every agent. |

## Agent operating policy

| # | node id | type | summary | why shared |
|---|---|---|---|---|
| 37 | `f089d68d-43a4-45f9-b3a8-d372d313f09e` | skill | Assistant policy: `npm install -g` and gateway restarts stay on the host owner's side. | Cross-agent boundary. |
| 38 | `f2af8cce-eb46-40e3-9b89-b1a283a4c450` | skill | `npm install -g openclaw@latest` is explicitly forbidden for agents. | Hard rule. |
| 39 | `6c643400-b94b-4744-9077-422d156bbeaf` | skill | `openclaw update` is system control — host owner only per runtime policy. | Hard rule. |
| 40 | `3b0d53f0-1676-40c7-89a0-6cf71c2840d7` | semantic | Escalation rule: "set up Stripe for me" IS a client request → escalate. | Client-facing escalation guard (pair with #41). |
| 41 | `745f90a3-eae9-44d7-916a-b1b0abf7dd4f` | semantic | "I'm looking at Stripe" is NOT a request → don't escalate. | Prevents fabricated escalations. |

## Client portal / site architecture

| # | node id | type | summary | why shared |
|---|---|---|---|---|
| 42 | `6d056235-2bba-4524-98c2-0e34e527b60f` | semantic | Portal escalation email: Resend primary, AgentMail fallback. | Architecture fact for any agent touching escalations. |
| 43 | `578c0e32-91ac-41dc-96d2-9c79a187a5bc` | semantic | Portal edit flow: drafts land in `portal/drafts/<projectId>/`, working copy re-assembled, client previews in an iframe before push. | Architecture fact. |
| 44 | `449b0e41-da97-49ce-8290-80f889c538d1` | semantic | The chat API only reads `MODELS` (converse) and `BUILD_MODELS` (build) env vars. | Prevents editing dead config (names only, no values). |
| 45 | `ec131e0b-1493-443c-a165-eebb40af5ffb` | semantic | The published Terms are governed by Arizona law. | Stable public fact. |
| 46 | `a13fb720-5b91-4cad-8b5a-3fd35060db4a` | semantic | The `.online` site is the sibling `enlightened-republic` folder, which the Vercel deploy doc targets (distinct from `.tech`). | Stops agents conflating the two sites. |

## Deliberately left out

- **Personal / identity** (owned by USER.md / MEMORY.md or private to the owner):
  communication-style and formatting preferences (`8003a65f`, `5997622f`), the
  owner's feedback about heartbeats (`2805703d`, `6f806d29`), company identity
  (`65b87cf7`), `take initiative` feedback (`c2cb7da2`).
- **Paths with a Windows username**: `d2f22964` (site path under a user profile).
- **Secret-adjacent**: `5392cab8` (mentions a master key file; also superseded),
  env-var blocker/staff-code notes (`d0ca00eb`, `48390864`). No node in the list
  contains a key, token, password, or phone number (regex-scanned).
- **Client roster**: allowlist contents (`7abdffed`, `2ee37326`).
- **Security-sensitive product details** not fit for a shared brain or a public
  repo: a portal credit-cap weakness (`1a0cfe55`), un-reviewed legal sections
  (`815f0035`), Vercel project identifiers (`94225cf9`), host shell policy (`12434950`).
- **How to kill heartbeats** (`f7e0c7a6`, `073c153e`, `0b0fa544`): accurate, but the
  owner objected to heartbeats being disabled; seeding it invites repeats.
- **Transient status / chatter**: "N issues queued", "ready when you are",
  deploy-pending notes, one-off incident narration, Terms/Privacy clause fragments.
- **Superseded nodes** (`valid_until` set), and all episodic/pattern/schema/goal nodes.
