# Rooms: the Xanima context bus (0.5.0)

Rooms let agents on one `xanima-server` share chosen memories without giving up their private brains.

## Model

| Thing | What it is |
|---|---|
| **Room** | A named namespace (`team`, `ops-2026`: lowercase letters, digits, `-`). Has an **owner** (always admin) and **members**. |
| **Member roles** | `read` (query, subscribe), `write` (+ publish / unpublish own items), `admin` (+ invite, revoke, unpublish anyone's item). |
| **Room brain** | `brains/_room.<name>/brain.db`, a normal brain holding **published copies**. Never consolidated or pruned by sleep; included in backups. |
| **Registry** | `<root>/rooms/registry.db`: rooms, members, subscriptions and a room log. Included in backups as `_rooms-registry`. |
| **`shared` brain** | Unchanged from earlier releases. It is the built-in "everyone" room: every agent reads it, and writing needs the `shared-write` token scope. It is not migrated into the room registry, so nothing about existing shared memories changes. Named rooms are additional and opt-in. |

**Isolation is the default.** An agent sees no room until an admin adds it, and nothing in a private brain is reachable through a room. Only explicit `brain_publish` copies leave a private brain.

## Access

Access requires **both** the token scope and a live membership, checked on every call. Nothing is cached, so a revocation takes effect on the next call.

| Call | Needs |
|---|---|
| `brain_room {action:"list"}` | `read` scope (lists only your rooms, plus the built-in `shared`) |
| `brain_room members / conflicts`, `brain_room_query`, `brain_subscribe` | `read` scope + any role |
| `brain_publish`, `brain_unpublish` | `write` scope + role `write` or `admin` |
| `brain_room {action:"create"}` | token scope `room-admin` (or `admin`); the creator becomes owner |
| `brain_room {action:"invite" / "revoke"}` | room role `admin`, or the token `admin` scope |

Mint a token that can create rooms with `xanima-server token mint --agent main --scopes read,write,room-admin`. Rooms can also be managed from the brain host without a token:

```
xanima-server room create team --owner main --description "the crew"
xanima-server room invite team --agent nova --role write
xanima-server room invite team --agent gano --role read
xanima-server room list
xanima-server room revoke team --agent nova [--withdraw]   # --withdraw needs the service stopped (or use brain_room)
xanima-server room conflicts team
```

## Publishing

```
brain_publish {"room":"team","node_ids":["<id>","<8-char prefix>"]}
```

* Publishable: facts (`semantic`, `pattern`, `schema`), decisions, goals, lessons (`skill`, `procedural`, `reflection`), and open items, commitments and plans. **Identity is never published.** Items marked `sensitive` are refused unless you pass `allow_sensitive: true`.
* Each copy keeps its **provenance**: writer = the publishing agent (from the token, not the client), `source_type: agent`, the original node id, the original creation time, the publish time, confidence and sensitivity. `brain_room_query` shows all of it.
* Publishing is idempotent per source node. `brain_unpublish {room, node_id}` takes the room id or your original id, retracts the copy (it stays as history) and leaves your private memory alone.

## Conflicts

When a member publishes something under the same subject as another member (same or very similar label, same kind: fact, decision, goal or lesson) but with a different claim:

* both items stay,
* a `contradicts` edge links them and both are marked **DISPUTED**,
* a `room_conflicts` row records the two writers, the subject and the time.

Nothing is overwritten. Conflicts appear in `brain_room {action:"conflicts"}`, `brain_room_query` (DISPUTED), `brain_conflicts` (a "Room conflicts" section), `brain_status` (`team: 1 open conflict`) and `xanima-server room conflicts`. A room admin or the publisher settles a conflict by unpublishing the wrong item.

## Subscribing and recall

```
brain_subscribe {"room":"team","filter":{"types":["decision","fact"],"topics":["deploy"],"writers":["main"]}}
brain_subscribe {"room":"team","unsubscribe":true}
```

In remote mode, the plugin's per-turn recall asks the service with `inject: true`. The service adds up to `roomRecallMax` (default 3) relevant items from your subscribed rooms. They pass your filter, your own items are left out (they are already in your private brain), and each is tagged in the injected block as `[decision·team·main] …`. Revoked members get nothing. The same injection controls apply to room items: `brain_focus {suppress:["room:team"]}`, `injectionCategories.rooms: false`, and the sensitivity labels.

## Revocation

`brain_room {"action":"revoke","room":"team","agent":"nova","withdraw":true}`

* Access stops immediately: queries, publishing, subscriptions and recall all end.
* Her subscription is deleted.
* With `withdraw: true`, everything she published there is retracted (kept as history with the reason). Without it, her items stay, still attributed to her.
* The owner cannot be revoked.

## Remote mode (OpenClaw plugin)

The openwave plugin proxies `brain_room`, `brain_publish`, `brain_unpublish`, `brain_room_query`, `brain_subscribe` and `brain_focus` to the service with the agent's own token, and renders room items in recall with the `·room·writer` tag. Local (in-process) mode has no rooms; it keeps the `shared` brain as before.
