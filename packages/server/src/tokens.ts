// packages/server/src/tokens.ts
//
// Per-agent bearer tokens. The token file stores ONLY sha256 hashes — the
// plaintext is printed once by `sharpwave-server token mint` and never written
// anywhere. Tokens are 256 bits of CSPRNG output, so a fast hash is the right
// tool (a slow KDF such as scrypt only matters for low-entropy secrets like
// passwords, and would add per-request latency for no gain).
//
// Verification hashes the presented token and compares it against EVERY stored
// hash with crypto.timingSafeEqual, without early exit, so response timing does
// not reveal which (or whether any) entry matched a prefix.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SCOPES = ["read", "write", "shared-write", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

/** Agent ids double as private-brain directory names. */
export const AGENT_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
/** Brain names that can never be an agent's private brain. */
export const RESERVED_BRAIN_NAMES = new Set(["shared", "_system", "backups", "audit"]);

export const TOKEN_PREFIX = "swt_";

export interface TokenEntry {
  /** Public, non-secret handle (for list/revoke). */
  id: string;
  /** "sha256:<hex>" of the plaintext token. */
  hash: string;
  agentId: string;
  scopes: Scope[];
  label?: string;
  createdAt: string;
  revoked?: boolean;
}

export interface TokenFile {
  version: 1;
  tokens: TokenEntry[];
}

export interface Principal {
  tokenId: string;
  agentId: string;
  scopes: ReadonlySet<Scope>;
}

export function hashToken(token: string): string {
  return "sha256:" + createHash("sha256").update(token, "utf8").digest("hex");
}

export function validateAgentId(agentId: string): string | null {
  if (!AGENT_ID_RE.test(agentId)) return `invalid agent id "${agentId}" (letters, digits, . _ -; max 64)`;
  if (RESERVED_BRAIN_NAMES.has(agentId.toLowerCase())) return `agent id "${agentId}" is reserved`;
  return null;
}

export function parseScopes(input: string | string[]): Scope[] {
  const list = (Array.isArray(input) ? input : input.split(","))
    .map((s) => s.trim()).filter(Boolean);
  const out: Scope[] = [];
  for (const s of list) {
    if (!(SCOPES as readonly string[]).includes(s)) {
      throw new Error(`unknown scope "${s}" (valid: ${SCOPES.join(", ")})`);
    }
    if (!out.includes(s as Scope)) out.push(s as Scope);
  }
  if (out.length === 0) throw new Error("at least one scope is required");
  return out;
}

export function readTokenFile(path: string): TokenFile {
  if (!existsSync(path)) return { version: 1, tokens: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as TokenFile;
  if (!parsed || !Array.isArray(parsed.tokens)) throw new Error(`${path}: not a sharpwave token file`);
  for (const t of parsed.tokens) {
    if (typeof t.hash !== "string" || !t.hash.startsWith("sha256:")) {
      throw new Error(`${path}: token ${t.id ?? "?"} has no sha256 hash — refusing to load`);
    }
    if ((t as unknown as Record<string, unknown>)["token"] !== undefined) {
      throw new Error(`${path}: token ${t.id} contains a plaintext "token" field — refusing to load`);
    }
  }
  return parsed;
}

export function writeTokenFile(path: string, file: TokenFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

export interface MintResult {
  token: string;
  entry: TokenEntry;
}

/** Mint a token, persist ONLY its hash, return the plaintext exactly once. */
export function mintToken(
  path: string,
  agentId: string,
  scopes: Scope[],
  label?: string,
): MintResult {
  const bad = validateAgentId(agentId);
  if (bad) throw new Error(bad);
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const entry: TokenEntry = {
    id: "tok_" + randomUUID().replace(/-/g, "").slice(0, 12),
    hash: hashToken(token),
    agentId,
    scopes,
    ...(label ? { label } : {}),
    createdAt: new Date().toISOString(),
  };
  const file = readTokenFile(path);
  file.tokens.push(entry);
  writeTokenFile(path, file);
  return { token, entry };
}

export function revokeToken(path: string, id: string): boolean {
  const file = readTokenFile(path);
  const t = file.tokens.find((x) => x.id === id);
  if (!t) return false;
  t.revoked = true;
  writeTokenFile(path, file);
  return true;
}

/**
 * In-memory view of the token file. Reloads automatically when the file's
 * mtime/size changes, so a freshly minted or revoked token takes effect
 * without restarting the service.
 */
export class TokenStore {
  private entries: Array<{ entry: TokenEntry; digest: Buffer }> = [];
  private stamp = "";

  constructor(private readonly path: string) {
    this.reloadIfChanged();
  }

  private reloadIfChanged(): void {
    let stamp = "missing";
    try {
      const s = statSync(this.path);
      stamp = `${s.mtimeMs}:${s.size}`;
    } catch { /* missing file = no tokens */ }
    if (stamp === this.stamp) return;
    const file = readTokenFile(this.path);
    this.entries = file.tokens
      .filter((t) => !t.revoked && validateAgentId(t.agentId) === null)
      .map((entry) => ({ entry, digest: Buffer.from(entry.hash.slice("sha256:".length), "hex") }));
    this.stamp = stamp;
  }

  get size(): number {
    this.reloadIfChanged();
    return this.entries.length;
  }

  /** Resolve a presented bearer token to its principal, or null. Constant-time over all entries. */
  verify(presented: string | undefined | null): Principal | null {
    if (!presented) return null;
    try {
      this.reloadIfChanged();
    } catch {
      // A corrupt file mid-write must not lock everyone out with a 500; keep the last good set.
    }
    const digest = createHash("sha256").update(presented, "utf8").digest();
    let match: TokenEntry | null = null;
    for (const { entry, digest: stored } of this.entries) {
      const eq = stored.length === digest.length && timingSafeEqual(stored, digest);
      if (eq && match === null) match = entry;
    }
    if (!match) return null;
    return { tokenId: match.id, agentId: match.agentId, scopes: new Set(match.scopes) };
  }
}
