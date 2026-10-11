// packages/server/src/provision.ts
//
// brain_provision_agent — create an agent's private brain and mint its bearer
// token in one idempotent call, so a client (OpenWave) can onboard a new
// OpenClaw agent without a human running `xanima-server token mint`.
//
// Security model:
//   • Caller needs the narrow `provision` scope (or `admin`). `provision` grants
//     NOTHING else: no read, no write, no shared-write (see tools.ts has()).
//   • Loopback only: the request must have arrived on 127.0.0.1/::1. A call
//     arriving on the tailnet listener is refused even with a valid token.
//   • Scopes of minted tokens come from server config (`provisioning.scopes`,
//     default read,write,shared-write). The request cannot pass scopes, and the
//     config may never contain admin or provision (checked at load + call).
//   • Idempotent: an agent that already has a live (non-revoked) token gets
//     `already-provisioned` and NO token, unless rotate=true, which revokes the
//     agent's previous non-privileged tokens and mints a fresh one.
//   • Agents that hold a privileged token (admin/provision) cannot be
//     provisioned or rotated through this path.
//   • Guards: `provisioning.maxAgents` (distinct agents with live tokens) and
//     `provisioning.maxPerHour` (successful mints per rolling hour).
//   • Audit: one line per attempt (ok / denied / error) with the token id only.
//     The plaintext token is returned exactly once and never logged.

import { mintToken, parseScopes, readTokenFile, validateAgentId, writeTokenFile, type Principal, type Scope } from "./tokens.js";
import type { BrainManager } from "./brains.js";
import type { AuditLog } from "./audit.js";

export const PROVISION_TOOL_NAME = "brain_provision_agent";

export interface ProvisioningConfig {
  /** Master switch. Default true (the tool still needs a provision/admin token). */
  enabled: boolean;
  /** Scopes given to every provisioned agent token. Never admin/provision. */
  scopes: Scope[];
  /** Max distinct agents with a live token before provisioning refuses. */
  maxAgents: number;
  /** Max successful mints per rolling hour (process-local). */
  maxPerHour: number;
}

export const PRIVILEGED_SCOPES: ReadonlySet<Scope> = new Set<Scope>(["admin", "provision"]);

export function defaultProvisioningConfig(): ProvisioningConfig {
  return { enabled: true, scopes: ["read", "write", "shared-write"], maxAgents: 64, maxPerHour: 20 };
}

/** Throws if the configured scopes would escalate. */
export function assertSafeProvisionScopes(scopes: unknown): Scope[] {
  const parsed = parseScopes(scopes as string[] | string);
  const bad = parsed.filter((s) => PRIVILEGED_SCOPES.has(s));
  if (bad.length) throw new Error(`provisioning.scopes may not include ${bad.join(", ")}`);
  return parsed;
}

export const PROVISION_TOOL_DEF = {
  name: PROVISION_TOOL_NAME,
  description:
    "OPERATOR ONLY (needs the provision or admin scope; loopback connections only). Create a private brain for an agent and " +
    "mint its bearer token with the service's configured default scopes. Idempotent: returns status \"already-provisioned\" " +
    "(no token) when the agent already has a live token, unless rotate is true. The token is returned once; store it immediately.",
  inputSchema: {
    type: "object" as const,
    properties: {
      agentId: { type: "string", description: "Agent id (letters, digits, . _ -; max 64; not shared/_system/backups/audit)." },
      label: { type: "string", description: "Human label stored with the token (max 120 chars)." },
      rotate: { type: "boolean", description: "Revoke the agent's existing non-privileged tokens and mint a new one." },
    },
    required: ["agentId"],
  },
};

export class ProvisionRateLimiter {
  private stamps: number[] = [];
  constructor(private readonly perHour: number, private readonly now: () => number = Date.now) {}
  /** True (and records) if one more mint fits in the rolling hour. */
  take(): boolean {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < 3_600_000);
    if (this.stamps.length >= this.perHour) return false;
    this.stamps.push(t);
    return true;
  }
}

export interface ProvisionContext {
  principal: Principal;
  brains: BrainManager;
  audit: AuditLog;
  tokensFile: string;
  config: ProvisioningConfig;
  limiter: ProvisionRateLimiter;
  /** True when the HTTP request arrived on a loopback listener from a loopback peer. */
  loopback: boolean;
}

export interface ProvisionOutput { text: string; isError?: boolean }

const LABEL_RE = /^[\p{L}\p{N} ()._,:@'\/-]{1,120}$/u;

export function isLoopbackAddress(a: string | undefined | null): boolean {
  if (!a) return false;
  const x = a.toLowerCase();
  return x === "::1" || /^127\./.test(x) || /^::ffff:127\./.test(x);
}

export function provisionAgent(ctx: ProvisionContext, args: Record<string, unknown>): ProvisionOutput {
  const p = ctx.principal;
  const agentId = typeof args["agentId"] === "string" ? args["agentId"] : "";
  const audit = (outcome: "ok" | "denied" | "error", detail: string) =>
    ctx.audit.append({ agentId: p.agentId, tool: PROVISION_TOOL_NAME, brain: validateAgentId(agentId) ? "-" : agentId, nodeId: null, outcome, detail });
  const deny = (msg: string) => { audit("denied", msg); return { text: `Error: ${msg}`, isError: true }; };

  if (!p.scopes.has("provision") && !p.scopes.has("admin")) return deny("forbidden — brain_provision_agent needs the provision scope");
  if (!ctx.loopback) return deny("forbidden — provisioning is only accepted on 127.0.0.1");
  if (!ctx.config.enabled) return deny("provisioning is disabled on this service (provisioning.enabled=false)");
  const bad = validateAgentId(agentId);
  if (bad) return deny(bad);
  const rawLabel = args["label"];
  if (rawLabel !== undefined && (typeof rawLabel !== "string" || !LABEL_RE.test(rawLabel))) return deny("label must be 1-120 printable characters");
  const rotate = args["rotate"] === true;
  let scopes: Scope[];
  try { scopes = assertSafeProvisionScopes(ctx.config.scopes); } catch (e) { return deny(String((e as Error).message)); }

  const file = readTokenFile(ctx.tokensFile);
  const live = file.tokens.filter((t) => !t.revoked);
  const mine = live.filter((t) => t.agentId === agentId);
  if (mine.some((t) => t.scopes.some((s) => PRIVILEGED_SCOPES.has(s)))) {
    return deny(`agent "${agentId}" holds a privileged token; provision it by hand`);
  }
  if (mine.length && !rotate) {
    ctx.brains.open(agentId);
    audit("ok", `already-provisioned (${mine.map((t) => t.id).join(",")})`);
    return { text: JSON.stringify({ status: "already-provisioned", agentId, tokenIds: mine.map((t) => t.id) }) };
  }
  if (!mine.length) {
    const agents = new Set(live.filter((t) => !t.scopes.some((s) => PRIVILEGED_SCOPES.has(s))).map((t) => t.agentId));
    if (agents.size >= ctx.config.maxAgents) return deny(`max agents reached (${ctx.config.maxAgents}); raise provisioning.maxAgents`);
  }
  if (!ctx.limiter.take()) return deny(`rate limit: more than ${ctx.config.maxPerHour} provisions in the last hour`);

  try {
    ctx.brains.open(agentId); // creates + migrates <root>/brains/<agentId>/brain.db
    const revoked: string[] = [];
    if (rotate && mine.length) {
      const f2 = readTokenFile(ctx.tokensFile);
      for (const t of f2.tokens) if (t.agentId === agentId && !t.revoked) { t.revoked = true; revoked.push(t.id); }
      writeTokenFile(ctx.tokensFile, f2);
    }
    const label = typeof rawLabel === "string" ? rawLabel : `${agentId} via provisioning`;
    const { token, entry } = mintToken(ctx.tokensFile, agentId, scopes, label);
    audit("ok", `${rotate && revoked.length ? "rotated" : "provisioned"} ${entry.id} scopes=${scopes.join(",")}${revoked.length ? ` revoked=${revoked.join(",")}` : ""}`);
    return {
      text: JSON.stringify({
        status: rotate && revoked.length ? "rotated" : "provisioned",
        agentId, tokenId: entry.id, scopes, token, ...(revoked.length ? { revoked } : {}),
      }),
    };
  } catch (e) {
    audit("error", String((e as Error).message ?? e).slice(0, 200));
    return { text: `Error: provisioning failed: ${String((e as Error).message ?? e)}`, isError: true };
  }
}
