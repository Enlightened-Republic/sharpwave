// packages/server/src/rooms-tools.ts
//
// Xanima 0.5.0 — the room tools as served by xanima-server, plus the helpers the
// injection path uses (subscribed room items in recall, status / conflict lines).
//
// Access = token scope AND room membership, checked on EVERY call (no caching), so a
// revocation takes effect on the very next call:
//   brain_room list                          read scope (lists only rooms you are in)
//   brain_room members|conflicts, room_query read scope + member (any role)
//   brain_subscribe                          read scope + member
//   brain_publish / brain_unpublish          write scope + role write|admin
//   brain_room create                        room-admin or admin scope (creator = owner)
//   brain_room invite|revoke                 room admin role, or the admin scope
// Room content lives in `_room.<name>` brains; private brains are never reachable here.

import {
  ROOM_TOOL_DEFS, FOCUS_TOOL_DEF, roomBrainName, roleOf, roleAtLeast, getRoom, createRoom, setMember, revokeMember, listMembers, roomsFor,
  parseRoomFilter, subscribe, unsubscribe, subscriptionsFor, filterAccepts, publishNodes, unpublish, withdrawAll, roomQuery, roomConflicts,
  formatRoomItem, formatRoomConflict, relativeTime, ROOM_NAME_RE,
  type RoomItem, type RoomRole, type BrainNode,
} from "xanima-core";
import type { ToolContext, ToolOutput } from "./tools.js";
import type { Scope } from "./tokens.js";
import { validateAgentId } from "./tokens.js";

export const ROOM_SERVICE_TOOL_NAMES = Object.keys(ROOM_TOOL_DEFS);
export const ROOM_SERVICE_TOOLS = [
  ...ROOM_SERVICE_TOOL_NAMES.map((name) => ({ name, description: ROOM_TOOL_DEFS[name]!.description, inputSchema: ROOM_TOOL_DEFS[name]!.inputSchema })),
];
export const FOCUS_SERVICE_TOOL = { name: "brain_focus", description: FOCUS_TOOL_DEF.description, inputSchema: FOCUS_TOOL_DEF.inputSchema as { type: "object"; properties: Record<string, unknown> } };

const ok = (text: string): ToolOutput => ({ text });
const err = (text: string): ToolOutput => ({ text: `Error: ${text}`, isError: true });
const has = (ctx: ToolContext, s: Scope) => ctx.principal.scopes.has(s) || ctx.principal.scopes.has("admin");
const ago = (t: number) => relativeTime(t);

function roomArg(args: Record<string, unknown>): string | ToolOutput {
  const r = typeof args["room"] === "string" ? args["room"].trim().toLowerCase() : "";
  if (!r) return err("room is required");
  if (r === "shared") return err(`"shared" is the built-in everyone room — use brain_query scope:"shared" / brain_write visibility:"shared"`);
  if (!ROOM_NAME_RE.test(r)) return err("room name must be lowercase letters, digits or -");
  return r;
}

/** Resolve the caller's live role, auditing denials. */
function need(ctx: ToolContext, tool: string, room: string, min: RoomRole): RoomRole | ToolOutput {
  const reg = ctx.brains.roomRegistry();
  if (!getRoom(reg, room)) return err(`room ${room} not found`);
  const role = roleOf(reg, room, ctx.principal.agentId);
  if (!roleAtLeast(role, min)) {
    ctx.audit.append({ agentId: ctx.principal.agentId, tool, brain: roomBrainName(room), nodeId: null, outcome: "denied", detail: `role ${role ?? "none"} < ${min}` });
    return err(role ? `forbidden — your role in ${room} is ${role}; this needs ${min}` : `forbidden — you are not a member of room ${room}`);
  }
  return role!;
}

export async function callRoomTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolOutput> {
  if (ctx.brainConfig.rooms === false) return err("rooms are disabled on this service (rooms: false)");
  const p = ctx.principal;
  const reg = ctx.brains.roomRegistry();
  switch (name) {
    case "brain_room": {
      const action = String(args["action"] ?? "list");
      if (action === "list") {
        if (!has(ctx, "read")) return err("forbidden — needs the read scope");
        const rows = roomsFor(reg, p.agentId);
        const head = `Rooms for ${p.agentId}: built-in "shared" (everyone; write needs shared-write)`;
        if (!rows.length) return ok(`${head}\nNo named rooms — isolation is the default until an admin adds you to one.`);
        return ok([head, ...rows.map((r) => `${r.name} — ${r.role}${r.subscribed ? ", subscribed" : ""} (owner ${r.owner})${r.description ? `: ${r.description}` : ""}`)].join("\n"));
      }
      const room = roomArg(args); if (typeof room !== "string") return room;
      if (action === "create") {
        if (!has(ctx, "room-admin")) return err("forbidden — creating a room needs the room-admin (or admin) token scope");
        const r = createRoom(reg, { name: room, owner: p.agentId, description: typeof args["description"] === "string" ? args["description"] : undefined });
        if (!r.ok) return err(r.error!);
        await ctx.brains.write(roomBrainName(room), () => undefined); // create the room brain
        ctx.audit.append({ agentId: p.agentId, tool: name, brain: roomBrainName(room), nodeId: null, outcome: "ok", detail: "create" });
        return ok(`Created room ${room} (owner ${p.agentId}, admin). Invite members with brain_room {"action":"invite","room":"${room}","agent":"…","role":"read|write|admin"}.`);
      }
      if (action === "members" || action === "conflicts") {
        if (!has(ctx, "read")) return err("forbidden — needs the read scope");
        const r = need(ctx, name, room, "read"); if (typeof r !== "string") return r;
        if (action === "members") {
          const m = listMembers(reg, room, true);
          return ok([`Room ${room} (owner ${getRoom(reg, room)!.owner}):`, ...m.map((x) => `  ${x.agent_id} — ${x.role}${x.revoked_at ? ` (REVOKED ${ago(x.revoked_at)} by ${x.revoked_by})` : ` (added ${ago(x.added_at)} by ${x.added_by})`}`)].join("\n"));
        }
        const st = args["status"] === "all" ? "all" : "open";
        const cs = ctx.brains.read(roomBrainName(room), (db) => roomConflicts(room, { status: st }, db));
        return ok(cs.length ? `${cs.length} ${st === "open" ? "open " : ""}conflict(s) in ${room} — both claims are kept; nothing was overwritten:\n${cs.map((c) => formatRoomConflict(c, ago)).join("\n")}` : `No ${st === "open" ? "open " : ""}conflicts in ${room}.`);
      }
      if (action === "invite" || action === "revoke") {
        const agent = typeof args["agent"] === "string" ? args["agent"].trim() : "";
        if (!agent || validateAgentId(agent)) return err("agent must be a valid agent id");
        if (!p.scopes.has("admin")) { const r = need(ctx, name, room, "admin"); if (typeof r !== "string") return r; }
        if (action === "invite") {
          const role = (args["role"] ?? "read") as RoomRole;
          const r = setMember(reg, { room, agent, role, by: p.agentId });
          if (!r.ok) return err(r.error!);
          ctx.audit.append({ agentId: p.agentId, tool: name, brain: roomBrainName(room), nodeId: null, outcome: "ok", detail: `invite ${agent}=${role}` });
          return ok(`${agent} is now ${role} in ${room}${r.previous ? ` (was ${r.previous})` : ""}.`);
        }
        const r = revokeMember(reg, { room, agent, by: p.agentId });
        if (!r.ok) return err(r.error!);
        let withdrawn = 0;
        if (args["withdraw"] === true) withdrawn = await ctx.brains.write(roomBrainName(room), () => withdrawAll(room, agent, `withdrawn: ${agent} was revoked from ${room} by ${p.agentId}`));
        ctx.audit.append({ agentId: p.agentId, tool: name, brain: roomBrainName(room), nodeId: null, outcome: "ok", detail: `revoke ${agent}${args["withdraw"] === true ? ` withdraw=${withdrawn}` : ""}` });
        return ok(`Revoked ${agent} from ${room}: access stops now.${args["withdraw"] === true ? ` Withdrew ${withdrawn} published item(s) (kept as history).` : " Their published items stay (pass withdraw:true to withdraw them)."}`);
      }
      return err("action must be list, members, conflicts, create, invite or revoke");
    }

    case "brain_publish": {
      if (!has(ctx, "write")) return err("forbidden — publishing needs the write scope");
      const room = roomArg(args); if (typeof room !== "string") return room;
      const r = need(ctx, name, room, "write"); if (typeof r !== "string") return r;
      const ids = args["node_ids"];
      if (!Array.isArray(ids) || !ids.length || ids.length > 20 || !ids.every((x) => typeof x === "string" && x.length >= 8 && x.length <= 64)) return err("node_ids must be 1–20 node ids (or 8+ char prefixes) from your private brain");
      const mine = ctx.brains.privateBrain(p.agentId);
      const nodes: BrainNode[] = []; const missing: string[] = [];
      ctx.brains.read(mine, (db) => {
        for (const id of ids as string[]) {
          const rows = db.prepare("SELECT * FROM nodes WHERE id = ? OR id LIKE ? LIMIT 2").all(id, `${id}%`) as BrainNode[];
          if (rows.length === 1) nodes.push(rows[0]!); else missing.push(id);
        }
      });
      const res = await ctx.brains.write(roomBrainName(room), () => publishNodes(room, p.agentId, nodes, { allowSensitive: args["allow_sensitive"] === true }));
      for (const x of res.published) ctx.audit.append({ agentId: p.agentId, tool: name, brain: roomBrainName(room), nodeId: x.roomId, outcome: "ok", detail: `from ${x.origin}` });
      const L = [`Published ${res.published.length} item(s) to ${room} as ${p.agentId}.`];
      for (const x of res.published) L.push(`  + ${x.roomId} ← ${x.origin.slice(0, 8)} "${x.label.slice(0, 60)}"`);
      for (const x of res.already) L.push(`  = ${x.origin.slice(0, 8)} already published as ${x.roomId.slice(0, 8)}`);
      for (const x of res.skipped) L.push(`  - ${x.id.slice(0, 8)} skipped: ${x.reason}`);
      for (const m of missing) L.push(`  - ${m} not found in your private brain`);
      for (const c of res.conflicts) L.push(`  ⚠ CONFLICT ${c.id}: ${c.aWriter ?? "?"} already asserted something different about "${c.label.slice(0, 60)}" — both are kept and marked disputed (brain_room {"action":"conflicts","room":"${room}"}).`);
      return ok(L.join("\n"));
    }

    case "brain_unpublish": {
      if (!has(ctx, "write")) return err("forbidden — needs the write scope");
      const room = roomArg(args); if (typeof room !== "string") return room;
      const r = need(ctx, name, room, "write"); if (typeof r !== "string") return r;
      const id = typeof args["node_id"] === "string" ? args["node_id"].trim() : "";
      if (id.length < 8) return err("node_id (8+ chars) is required");
      const u = await ctx.brains.write(roomBrainName(room), () => unpublish(room, { agent: p.agentId, id, isAdmin: r === "admin", reason: typeof args["reason"] === "string" ? args["reason"] : undefined }));
      if (!u.ok) return err(u.error!);
      ctx.audit.append({ agentId: p.agentId, tool: name, brain: roomBrainName(room), nodeId: u.roomId!, outcome: "ok" });
      return ok(`Unpublished ${u.roomId} from ${room} (kept as history; your private memory is unchanged).`);
    }

    case "brain_room_query": {
      if (!has(ctx, "read")) return err("forbidden — needs the read scope");
      const room = roomArg(args); if (typeof room !== "string") return room;
      const r = need(ctx, name, room, "read"); if (typeof r !== "string") return r;
      const q = typeof args["query"] === "string" ? args["query"].slice(0, 500) : "";
      const lim = typeof args["limit"] === "number" ? args["limit"] : 10;
      const items = ctx.brains.read(roomBrainName(room), (db) => roomQuery(room, q, lim, db));
      if (args["format"] === "json") return ok(JSON.stringify({ room, role: r, results: items }, null, 2));
      return ok(items.length ? items.map((it) => formatRoomItem(it, ago)).join("\n\n") : `No matching items in ${room}.`);
    }

    case "brain_subscribe": {
      if (!has(ctx, "read")) return err("forbidden — needs the read scope");
      const room = roomArg(args); if (typeof room !== "string") return room;
      if (args["unsubscribe"] === true) return ok(unsubscribe(reg, { room, agent: p.agentId }) ? `Unsubscribed from ${room}.` : `You were not subscribed to ${room}.`);
      const r = need(ctx, name, room, "read"); if (typeof r !== "string") return r;
      const f = parseRoomFilter(args["filter"]);
      if ("error" in f) return err(f.error);
      subscribe(reg, { room, agent: p.agentId, filter: f });
      return ok(`Subscribed to ${room}${Object.keys(f).length ? ` with filter ${JSON.stringify(f)}` : ""}. Relevant items will surface in your recall tagged [type·${room}·writer] (up to ${ctx.brainConfig.roomRecallMax ?? 3} per turn).`);
    }
  }
  return err(`unknown tool: ${name}`);
}

/** Subscribed rooms' items relevant to this turn (live membership only; own items left out — they are in the private brain). */
export function subscribedRoomItems(ctx: ToolContext, query: string, cap: number): RoomItem[] {
  if (ctx.brainConfig.rooms === false || cap <= 0 || !query.trim()) return [];
  const reg = ctx.brains.roomRegistry();
  const out: RoomItem[] = [];
  for (const s of subscriptionsFor(reg, ctx.principal.agentId)) {
    if (!roleAtLeast(roleOf(reg, s.room, ctx.principal.agentId), "read")) continue;
    let items: RoomItem[] = [];
    try { items = ctx.brains.read(roomBrainName(s.room), (db) => roomQuery(s.room, query, cap * 3, db)); } catch { continue; }
    for (const it of items) if (it.writer !== ctx.principal.agentId && filterAccepts(s.filter, it)) out.push(it);
  }
  return out.slice(0, cap * 3);
}

/** brain_status lines for the caller's rooms. */
export function roomStatusLines(ctx: ToolContext): string[] {
  if (ctx.brainConfig.rooms === false) return [];
  const reg = ctx.brains.roomRegistry();
  const rows = roomsFor(reg, ctx.principal.agentId);
  if (!rows.length) return [];
  const L = [`[rooms] ${rows.map((r) => `${r.name} (${r.role}${r.subscribed ? ", subscribed" : ""})`).join(", ")}`];
  for (const r of rows) {
    let open = 0;
    try { open = ctx.brains.read(roomBrainName(r.name), (db) => roomConflicts(r.name, { status: "open" }, db).length); } catch { /* */ }
    if (open) L.push(`  ${r.name}: ${open} open conflict(s) — brain_room {"action":"conflicts","room":"${r.name}"}`);
  }
  return L;
}

/** Text appended to brain_conflicts: open conflicts in the caller's rooms. */
export function roomConflictText(ctx: ToolContext): string {
  if (ctx.brainConfig.rooms === false) return "";
  const reg = ctx.brains.roomRegistry();
  const out: string[] = [];
  for (const r of roomsFor(reg, ctx.principal.agentId)) {
    let cs: ReturnType<typeof roomConflicts> = [];
    try { cs = ctx.brains.read(roomBrainName(r.name), (db) => roomConflicts(r.name, { status: "open" }, db)); } catch { /* */ }
    for (const c of cs) out.push(formatRoomConflict(c, ago));
  }
  return out.length ? `\n\nRoom conflicts (both claims kept, with their sources):\n${out.join("\n")}` : "";
}
