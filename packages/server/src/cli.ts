// packages/server/src/cli.ts — `sharpwave-server` admin CLI.
//
//   sharpwave-server serve        [--config f] [--root d] [--port n] [--tailnet-ip ip|none]... [--log-file f] [--no-sleep] [--no-backup]
//   sharpwave-server token mint   --agent <id> [--scopes read,write] [--label txt] [--json]
//   sharpwave-server token list   [--json]
//   sharpwave-server token revoke <tokenId>
//   sharpwave-server backup now   [--keep n] [--brain name]...
//   sharpwave-server version
//
// Common: --config <file> (default <root>/config.json if present), --root <dir>
// (default ~/.sharpwave/service), --tokens-file <file>.

import { brainsDir, backupsDir, defaultConfigPath, defaultRoot, expandHome, loadConfigFile, resolveConfig, type ServiceConfig } from "./config.js";
import { mintToken, parseScopes, readTokenFile, revokeToken } from "./tokens.js";
import { snapshotAll } from "./backup.js";
import { BrainService } from "./service.js";
import { VERSION } from "./version.js";

interface Parsed {
  _: string[];
  flags: Map<string, string[]>;
}

const BOOL_FLAGS = new Set(["json", "no-sleep", "no-backup", "help", "h", "allow-reset"]);

function parse(argv: string[]): Parsed {
  const out: Parsed = { _: [], flags: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--") || (a.startsWith("-") && a.length === 2)) {
      let key = a.replace(/^-+/, "");
      let val: string | undefined;
      const eq = key.indexOf("=");
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      else if (!BOOL_FLAGS.has(key)) {
        val = argv[++i];
        if (val === undefined) throw new Error(`--${key} needs a value`);
      }
      const list = out.flags.get(key) ?? [];
      list.push(val ?? "true");
      out.flags.set(key, list);
    } else out._.push(a);
  }
  return out;
}

const one = (p: Parsed, k: string) => p.flags.get(k)?.at(-1);
const many = (p: Parsed, k: string) => p.flags.get(k) ?? [];
const bool = (p: Parsed, k: string) => p.flags.has(k);

function buildConfig(p: Parsed): ServiceConfig {
  const rootFlag = one(p, "root");
  const root = rootFlag ? expandHome(rootFlag) : defaultRoot();
  const cfgPath = one(p, "config") ?? defaultConfigPath(root);
  const file = cfgPath ? loadConfigFile(cfgPath) : {};
  const tail = many(p, "tailnet-ip");
  const port = one(p, "port");
  return resolveConfig({
    ...file,
    ...(rootFlag ? { root: rootFlag } : {}),
    ...(port !== undefined ? { port: Number(port) } : {}),
    ...(tail.length ? { tailnetHosts: tail.includes("none") ? [] : tail } : {}),
    ...(one(p, "tokens-file") ? { tokensFile: one(p, "tokens-file") } : {}),
    ...(one(p, "log-file") ? { logFile: one(p, "log-file") } : {}),
    ...(bool(p, "allow-reset") ? { allowReset: true } : {}),
    sleep: { ...(file.sleep ?? {}), ...(bool(p, "no-sleep") ? { enabled: false } : {}) },
    backup: {
      ...(file.backup ?? {}),
      ...(bool(p, "no-backup") ? { enabled: false } : {}),
      ...(one(p, "keep") ? { keep: Number(one(p, "keep")) } : {}),
    },
  });
}

const HELP = `sharpwave-server ${VERSION} — SharpWave brain service

Usage:
  sharpwave-server serve [--config file] [--root dir] [--port 18790] [--tailnet-ip 100.x.y.z|none] [--log-file f] [--no-sleep] [--no-backup]
  sharpwave-server token mint --agent <id> [--scopes read,write[,shared-write][,admin]] [--label text] [--json]
  sharpwave-server token list [--json]
  sharpwave-server token revoke <tokenId>
  sharpwave-server backup now [--keep N] [--brain name ...]
  sharpwave-server version

Binds 127.0.0.1 always, plus the tailnet IP (default 100.121.136.3). Never 0.0.0.0/::.
Root defaults to ~/.sharpwave/service (brains/, backups/, audit/, tokens.json, config.json).`;

async function main(argv: string[]): Promise<number> {
  const p = parse(argv);
  const [cmd, sub] = p._;
  if (!cmd || cmd === "help" || bool(p, "help") || bool(p, "h")) {
    process.stdout.write(HELP + "\n");
    return cmd ? 0 : 2;
  }
  if (cmd === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const cfg = buildConfig(p);

  if (cmd === "serve") {
    const svc = new BrainService(cfg);
    await svc.start();
    const shutdown = async (sig: string) => {
      svc.log.info(`${sig} — shutting down`);
      await svc.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGBREAK", () => void shutdown("SIGBREAK")); // Windows console close
    await new Promise<never>(() => { /* serve forever */ });
  }

  if (cmd === "token") {
    if (sub === "mint") {
      const agent = one(p, "agent");
      if (!agent) throw new Error("token mint needs --agent <id>");
      const scopes = parseScopes(one(p, "scopes") ?? "read,write");
      const { token, entry } = mintToken(cfg.tokensFile, agent, scopes, one(p, "label"));
      if (bool(p, "json")) {
        process.stdout.write(JSON.stringify({ token, id: entry.id, agentId: entry.agentId, scopes: entry.scopes, tokensFile: cfg.tokensFile }) + "\n");
      } else {
        process.stdout.write(
          `Minted token ${entry.id} for agent "${entry.agentId}" scopes=${entry.scopes.join(",")}\n` +
          `Only its sha256 hash was stored in ${cfg.tokensFile}.\n\n` +
          `  ${token}\n\n` +
          `This is the ONLY time the token is shown. Store it now (e.g. SHARPWAVE_TOKEN or a token file).\n`,
        );
      }
      return 0;
    }
    if (sub === "list") {
      const f = readTokenFile(cfg.tokensFile);
      const rows = f.tokens.map(({ hash: _h, ...rest }) => rest);
      if (bool(p, "json")) process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      else if (rows.length === 0) process.stdout.write(`no tokens in ${cfg.tokensFile}\n`);
      else for (const r of rows) {
        process.stdout.write(`${r.id}  agent=${r.agentId}  scopes=${r.scopes.join(",")}  created=${r.createdAt}${r.label ? `  label="${r.label}"` : ""}${r.revoked ? "  REVOKED" : ""}\n`);
      }
      return 0;
    }
    if (sub === "revoke") {
      const id = p._[2];
      if (!id) throw new Error("token revoke needs <tokenId>");
      if (!revokeToken(cfg.tokensFile, id)) throw new Error(`no token ${id}`);
      process.stdout.write(`revoked ${id}\n`);
      return 0;
    }
    throw new Error(`unknown token subcommand "${sub ?? ""}" (mint | list | revoke)`);
  }

  if (cmd === "backup") {
    if (sub !== "now") throw new Error(`unknown backup subcommand "${sub ?? ""}" (now)`);
    const only = many(p, "brain");
    const r = snapshotAll(brainsDir(cfg), backupsDir(cfg), cfg.backup.keep, only.length ? only : undefined);
    for (const s of r.ok) {
      process.stdout.write(`ok     ${s.brain}  ${s.path}  ${(s.bytes / 1024).toFixed(0)} KiB${s.removed.length ? `  (rotated out ${s.removed.length})` : ""}\n`);
    }
    for (const f of r.failed) process.stdout.write(`FAILED ${f.brain}  ${f.error}\n`);
    if (r.ok.length === 0 && r.failed.length === 0) process.stdout.write(`no brains under ${brainsDir(cfg)}\n`);
    return r.failed.length ? 1 : 0;
  }

  throw new Error(`unknown command "${cmd}" — run sharpwave-server help`);
}

main(process.argv.slice(2)).then(
  (code) => { if (code !== undefined) process.exitCode = code; },
  (e) => {
    process.stderr.write(`sharpwave-server: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
