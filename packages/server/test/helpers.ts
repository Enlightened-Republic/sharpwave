import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrainService } from "../src/service.js";
import { resolveConfig, type ServiceConfig } from "../src/config.js";
import { mintToken, type Scope } from "../src/tokens.js";
import { memoryLogger } from "../src/log.js";

export function tempRoot(prefix = "sw-server-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

type Overrides = Partial<Omit<ServiceConfig, "sleep" | "backup" | "offsiteBackup">> & {
  sleep?: Partial<ServiceConfig["sleep"]>;
  backup?: Partial<ServiceConfig["backup"]>;
  offsiteBackup?: Partial<ServiceConfig["offsiteBackup"]>;
};

/** Test config: temp root, ephemeral port, no tailnet, no schedulers, no embed drain. */
export function testConfig(root: string, over: Overrides = {}): ServiceConfig {
  return resolveConfig({
    root,
    port: 0,
    tailnetHosts: [],
    embedDrainIntervalMs: 0,
    ...over,
    sleep: { enabled: false, ...(over.sleep ?? {}) },
    backup: { enabled: false, ...(over.backup ?? {}) },
  });
}

export async function startService(over: Overrides = {}, root = tempRoot()) {
  const cfg = testConfig(root, over);
  const log = memoryLogger();
  const svc = new BrainService(cfg, { log });
  await svc.start();
  return {
    svc, cfg, log, root, url: svc.url(),
    mint: (agentId: string, scopes: Scope[] = ["read", "write"]) => mintToken(cfg.tokensFile, agentId, scopes).token,
    async stop(clean = true) {
      await svc.stop();
      if (clean) rmSync(root, { recursive: true, force: true });
    },
  };
}

let id = 0;
export interface RpcResult {
  status: number;
  body: any;
}

export async function rpc(url: string, token: string | null, method: string, params: unknown, extraHeaders: Record<string, string> = {}): Promise<RpcResult> {
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body };
}

/** Call a tool; returns { text, isError } or throws on a non-200. */
export async function tool(url: string, token: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = await rpc(url, token, "tools/call", { name, arguments: args });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  if (r.body.error) throw new Error(`RPC error: ${JSON.stringify(r.body.error)}`);
  const text = (r.body.result.content as Array<{ text: string }>).map((c) => c.text).join("\n");
  return { text, isError: !!r.body.result.isError };
}

export function nodeIdFrom(text: string): string {
  const m = /node ([0-9a-f-]{36})/.exec(text);
  if (!m) throw new Error(`no node id in: ${text}`);
  return m[1]!;
}
