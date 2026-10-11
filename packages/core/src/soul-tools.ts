/**
 * Xanima 0.4.0 soul tools, shared by the MCP server, xanima-server and the
 * OpenClaw plugin (local mode).
 *
 * Permission model (documented in the README):
 *   brain_export_soul  self-only: exports the CALLER's own private brain (read scope). No
 *                      include_sensitive and no shared brain over the tool — those are
 *                      admin CLI options (`xanima-server soul export`).
 *   brain_review       list / show: read scope, own brain. accept / reject: admin only
 *                      (identity and goal changes need a human or admin decision).
 *   brain_import_soul  admin only; never offered by the plugin's agent-facing tool list.
 *                      Prefer the CLI, which takes a backup and refuses while the service runs.
 */
import type { BrainConfig } from "./types.js";
import { getDb } from "./db.js";
import { exportSoul, serializeSoul, soulSummary, listReviews, getReview, formatReview, acceptReview, rejectReview, importSoul, formatImportReport, parseSoul, type SoulPackage } from "./soul.js";

export interface SoulToolDef { description: string; inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] } }
export interface SoulToolResult { text: string; isError?: boolean }
export interface SoulToolCtx { admin: boolean; by: string; backup?: () => string | null }

export const SOUL_TOOL_DEFS: Record<string, SoulToolDef> = {
  brain_export_soul: {
    description: "Export your own Soul Package (xanima-soul/1): identity, core values, active goals with history, top skills, decision lessons and key facts, with provenance and a sha256 integrity hash. compact (default, token-budgeted) or full. format summary (default) shows counts and size; format json returns the package itself (compact only over this tool).",
    inputSchema: { type: "object", properties: {
      profile: { type: "string", enum: ["compact", "full"] },
      include_open_items: { type: "boolean", description: "Also include open hypotheses / questions / assumptions and open commitments." },
      format: { type: "string", enum: ["summary", "json"] },
    } },
  },
  brain_review: {
    description: "Pending-review queue: identity / value / goal changes from soul imports and three-way merge conflicts (with conflict markers). list (status pending|accepted|rejected|all), show (id). accept / reject need an admin (a human decides what reaches your identity and goals).",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["list", "show", "accept", "reject"] },
      id: { type: "string", description: "Review item id (or a unique prefix)." },
      status: { type: "string", enum: ["pending", "accepted", "rejected", "all"] },
      reason: { type: "string" },
    }, required: ["action"] },
  },
  brain_import_soul: {
    description: "ADMIN ONLY. Import a Soul Package into this brain (mode new | merge, dry_run). Validates schema and hash; identity, values and goals go to review; differences never overwrite.",
    inputSchema: { type: "object", properties: {
      package: { type: ["object", "string"], description: "The package (object or JSON text)." },
      mode: { type: "string", enum: ["new", "merge"] }, dry_run: { type: "boolean" },
    }, required: ["package"] },
  },
};
export const SOUL_TOOL_NAMES = Object.keys(SOUL_TOOL_DEFS);
/** The subset an agent may call on its own brain (plugin remote proxy offers these). */
export const SOUL_AGENT_TOOLS = ["brain_export_soul", "brain_review"];
/** Calls that only read (scope read): export, review list/show. */
export function soulToolNeedsAdmin(name: string, args: Record<string, unknown>): boolean {
  if (name === "brain_import_soul") return true;
  if (name === "brain_review") return args["action"] === "accept" || args["action"] === "reject";
  return false;
}

const ok = (text: string): SoulToolResult => ({ text });
const err = (text: string): SoulToolResult => ({ text: `Error: ${text}`, isError: true });

export function dispatchSoulTool(name: string, agentId: string, args: Record<string, unknown>, config: Partial<BrainConfig>, ctx: SoulToolCtx): SoulToolResult | null {
  if (!SOUL_TOOL_NAMES.includes(name)) return null;
  if (soulToolNeedsAdmin(name, args) && !ctx.admin) return err(`${name}${args["action"] ? ` ${String(args["action"])}` : ""} needs an admin (use xanima-server soul … on the brain host)`);
  try {
    if (name === "brain_export_soul") {
      const profile = args["profile"] === "full" ? "full" : "compact";
      const pkg = exportSoul(getDb(agentId), { agentId, profile, includeOpenItems: args["include_open_items"] === true, config });
      if (args["format"] === "json") {
        if (profile === "full" && !ctx.admin) return err("format json is compact-only over this tool (a full package can be large); use profile compact, or xanima-server soul export --profile full");
        return ok(serializeSoul(pkg));
      }
      return ok(soulSummary(pkg, Buffer.byteLength(serializeSoul(pkg))));
    }
    if (name === "brain_review") {
      const db = getDb(agentId);
      const action = String(args["action"] ?? "list");
      if (action === "list") {
        const st = (["pending", "accepted", "rejected", "all"].includes(String(args["status"])) ? args["status"] : "pending") as "pending";
        const rows = listReviews(db, { status: st, limit: 30 });
        return ok(rows.length ? `${rows.length} review item(s) (${st}):\n${rows.map((r) => formatReview(r)).join("\n")}` : `No ${st} review items.`);
      }
      const id = typeof args["id"] === "string" ? args["id"] : "";
      if (!id) return err("id is required");
      if (action === "show") { const r = getReview(db, id); return r ? ok(formatReview(r, true)) : err(`review item ${id} not found (or ambiguous)`); }
      if (action === "accept") { const r = acceptReview(agentId, id, { by: ctx.by, config, ...(typeof args["reason"] === "string" ? { note: args["reason"] } : {}) }); return r.ok ? ok(`accepted ${r.id}: ${r.applied}`) : err(r.error ?? "accept failed"); }
      if (action === "reject") { const r = rejectReview(agentId, id, { by: ctx.by, ...(typeof args["reason"] === "string" ? { reason: args["reason"] } : {}) }); return r.ok ? ok(`rejected ${r.id}; nothing changed`) : err(r.error ?? "reject failed"); }
      return err("action must be list | show | accept | reject");
    }
    if (name === "brain_import_soul") {
      const raw = args["package"];
      const pkg = (typeof raw === "string" ? parseSoul(raw) : raw) as SoulPackage;
      const mode = args["mode"] === "merge" ? "merge" : "new";
      const rep = importSoul(agentId, pkg, { mode, dryRun: args["dry_run"] === true, by: ctx.by, config, ...(ctx.backup ? { backup: ctx.backup } : {}) });
      return ok(formatImportReport(rep));
    }
  } catch (x) {
    return err(x instanceof Error ? x.message : String(x));
  }
  return null;
}
