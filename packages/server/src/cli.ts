// packages/server/src/cli.ts — `sharpwave-server` admin CLI.
//
//   sharpwave-server serve        [--config f] [--root d] [--port n] [--tailnet-ip ip|none]... [--log-file f] [--no-sleep] [--no-backup]
//   sharpwave-server token mint   --agent <id> [--scopes read,write] [--label txt] [--json]
//   sharpwave-server token list   [--json]
//   sharpwave-server token revoke <tokenId>
//   sharpwave-server backup now   [--keep n] [--brain name]... [--no-offsite]
//   sharpwave-server backup keygen [--key-file f] [--force]
//   sharpwave-server backup restore <file.swbk> --out <path> [--key-file f] [--force] [--require-manifest]
//   sharpwave-server brain adopt  --agent <id> --from <brain.db|dir> [--mode copy|move] [--dry-run] [--force] [--backfill-writer legacy|<id>] [--json]
//   sharpwave-server noise scan     --agent <id> [--out base] [--include-retired] [--json]
//   sharpwave-server noise check    --agent <id> --query <text> [--limit 10] [--json]
//   sharpwave-server noise retire   --agent <id> --ids-file <reviewed.csv|json|txt> [--dry-run] [--json]
//   sharpwave-server noise unretire --agent <id> (--batch <id> | --ids-file <f> | --all) [--dry-run] [--json]
//   sharpwave-server noise status   --agent <id> [--json]
//   sharpwave-server version
//
// Common: --config <file> (default <root>/config.json if present), --root <dir>
// (default ~/.sharpwave/service), --tokens-file <file>.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { brainsDir, backupsDir, defaultConfigPath, defaultRoot, expandHome, loadConfigFile, resolveConfig, type ServiceConfig } from "./config.js";
import { mintToken, parseScopes, readTokenFile, revokeToken } from "./tokens.js";
import { runBackupJob } from "./backup-job.js";
import { AuditLog } from "./audit.js";
import { createLogger } from "./log.js";
import { generateKeyFile, loadKey } from "./crypt.js";
import { servicePortInUse, restoreBackup } from "./restore.js";
import { defaultKeyFile } from "./config.js";
import { offsiteOk } from "./offsite.js";
import { adoptBrain, formatAdoptResult, type AdoptMode } from "./adopt.js";
import { defaultReportBase, ftsProbe, parseSelection, registryStatus, retireItems, scanBrainFile, unretireItems, writeReport } from "./noise.js";
import { BrainService } from "./service.js";
import { VERSION } from "./version.js";
import { validateAgentId } from "./tokens.js";

interface Parsed {
  _: string[];
  flags: Map<string, string[]>;
}

const BOOL_FLAGS = new Set(["json", "no-sleep", "no-backup", "help", "h", "allow-reset", "no-offsite", "force", "require-manifest", "dry-run", "include-retired", "all"]);

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
    offsiteBackup: {
      ...(file.offsiteBackup ?? {}),
      ...(one(p, "key-file") ? { keyFile: one(p, "key-file") } : {}),
    },
  });
}

const HELP = `sharpwave-server ${VERSION} — SharpWave brain service

Usage:
  sharpwave-server serve [--config file] [--root dir] [--port 18790] [--tailnet-ip 100.x.y.z|none] [--log-file f] [--no-sleep] [--no-backup]
  sharpwave-server token mint --agent <id> [--scopes read,write[,shared-write][,admin]] [--label text] [--json]
  sharpwave-server token list [--json]
  sharpwave-server token revoke <tokenId>
  sharpwave-server backup now [--keep N] [--brain name ...] [--no-offsite]
  sharpwave-server backup keygen [--key-file f] [--force]
  sharpwave-server backup restore <file.swbk> --out <path> [--key-file f] [--force] [--require-manifest]
  sharpwave-server brain adopt --agent <id> --from <brain.db or its folder> [--mode copy|move] [--dry-run] [--force]
                               [--backfill-writer legacy|<writer-id>] [--json]
      Make an existing brain.db the agent's private brain (<root>/brains/<id>/brain.db). The service must be stopped.
      Pre-adopt backup (VACUUM INTO, WAL included) + sha256, migrate via sharpwave-core, verify integrity/counts/schema.
      copy (default) never touches the source; --force moves an existing non-empty target aside (never deletes).
  sharpwave-server noise scan --agent <id> [--out <report base path>] [--include-retired] [--json]
      Read-only (safe while the service runs). Lists system-noise candidates (NO_REPLY / HEARTBEAT_OK triage,
      heartbeat/exec/cron wake markers, nodes minted from such episodes, triage phrasing) and writes
      <root>/noise-reports/<id>-<UTC>.csv + .json. High-confidence rows say action=retire, others action=review.
  sharpwave-server noise check --agent <id> --query <text> [--limit 10] [--json]
      Read-only FTS probe: top hits for the query among current (non-retired) nodes, flagged if candidates.
  sharpwave-server noise retire --agent <id> --ids-file <reviewed.csv|.json|.txt> [--dry-run] [--json]
      Service must be stopped. Backup first (VACUUM INTO -> <backups>/<id>/noise-retire/), then soft-retire ONLY
      rows left at action=retire: nodes get valid_until=now (hidden from recall), episodes importance=0. Prior
      values are kept in meta_kv (retired:node:/retired:episode:) for unretire. Nothing is deleted. Audit-logged.
  sharpwave-server noise unretire --agent <id> (--batch <noise-...> | --ids-file <f> | --all) [--dry-run] [--json]
      Service must be stopped. Backup first, then restore the recorded prior values exactly.
  sharpwave-server noise status --agent <id> [--json]
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
    if (sub === "now") {
      const only = many(p, "brain");
      const log = createLogger(cfg.logFile, true);
      const audit = new AuditLog(cfg.auditFile);
      const r = await runBackupJob(cfg, log, audit, { only: only.length ? only : undefined, offsite: !bool(p, "no-offsite") });
      for (const s of r.ok) {
        process.stdout.write(`ok     ${s.brain}  ${s.path}  ${(s.bytes / 1024).toFixed(0)} KiB${s.removed.length ? `  (rotated out ${s.removed.length})` : ""}\n`);
      }
      for (const f of r.failed) process.stdout.write(`FAILED ${f.brain}  ${f.error}\n`);
      if (r.ok.length === 0 && r.failed.length === 0) process.stdout.write(`no brains under ${brainsDir(cfg)}\n`);
      let offsiteFailed = false;
      for (const o of r.offsite) {
        if (offsiteOk(o)) {
          process.stdout.write(`offsite ${o.brain}  ${o.artifact}  key ${o.keyId}${o.folder?.ok ? `  -> ${o.folder.path}` : ""}${o.command?.ok ? "  command ok" : ""}\n`);
        } else {
          offsiteFailed = true;
          const why = o.error ?? (o.folder && !o.folder.ok ? `folder: ${o.folder.error}` : `command exit=${String(o.command?.code)}`);
          process.stdout.write(`OFFSITE FAILED ${o.brain}  ${why}  (local snapshot kept)\n`);
        }
      }
      return r.failed.length ? 1 : offsiteFailed ? 3 : 0;
    }
    if (sub === "keygen") {
      const keyFile = cfg.offsiteBackup.keyFile ?? defaultKeyFile();
      const key = generateKeyFile(keyFile, bool(p, "force"));
      const win = process.platform === "win32";
      process.stdout.write(
        `Wrote a new 256-bit backup key to ${keyFile}\n` +
        `Key id: ${key.id}  (not secret; recorded in every artifact so restore can tell keys apart)\n\n` +
        `IMPORTANT: store a copy of this key in your password manager NOW (open the file and copy the last line).\n` +
        `Without it, every encrypted backup is unrecoverable. Never put it in the synced backup folder or the repo.\n` +
        (win
          ? `\nRestrict the file to your account (PowerShell):\n  icacls "${keyFile}" /inheritance:r /grant:r "\${env:USERNAME}:(R,W)"\n`
          : `\nPermissions set to 0600 (owner read/write only).\n`) +
        `\nThen set offsiteBackup.keyFile in config.json (or the ${cfg.offsiteBackup.keyEnv} env var) and offsiteBackup.enabled=true.\n`,
      );
      return 0;
    }
    if (sub === "restore") {
      const file = p._[2];
      const out = one(p, "out");
      if (!file || !out) throw new Error("backup restore needs <file.swbk> --out <path>");
      const audit = new AuditLog(cfg.auditFile);
      const key = loadKey({ keyFile: cfg.offsiteBackup.keyFile ?? defaultKeyFile(), keyEnv: cfg.offsiteBackup.keyEnv });
      const r = await restoreBackup({
        artifact: file, out, key, force: bool(p, "force"), brainsDir: brainsDir(cfg), audit,
        requireManifest: bool(p, "require-manifest"),
        serviceRunning: () => servicePortInUse(cfg.port),
      });
      if (bool(p, "json")) process.stdout.write(JSON.stringify(r) + "\n");
      else process.stdout.write(
        `restored ${r.out}\n` +
        `  key id     ${r.keyId}\n` +
        `  verified   GCM tag ok${r.manifestChecked ? ", manifest sha256 + plaintext HMAC ok" : " (no manifest next to the artifact — tag only)"}\n` +
        `  integrity  ${r.integrity}\n` +
        `  counts     nodes=${r.counts.nodes ?? "-"} edges=${r.counts.edges ?? "-"} episodes=${r.counts.episodes ?? "-"}\n` +
        (r.movedAside.length ? `  moved aside (not deleted): ${r.movedAside.join(", ")}\n` : ""),
      );
      return 0;
    }
    throw new Error(`unknown backup subcommand "${sub ?? ""}" (now | keygen | restore)`);
  }

  if (cmd === "brain") {
    if (sub !== "adopt") throw new Error(`unknown brain subcommand "${sub ?? ""}" (adopt)`);
    const agent = one(p, "agent");
    const from = one(p, "from");
    if (!agent || !from) throw new Error("brain adopt needs --agent <id> and --from <path to brain.db or its folder>");
    const r = await adoptBrain({
      agentId: agent,
      from: expandHome(from),
      brainsDir: brainsDir(cfg),
      backupsDir: backupsDir(cfg),
      auditFile: cfg.auditFile,
      mode: (one(p, "mode") ?? "copy") as AdoptMode,
      dryRun: bool(p, "dry-run"),
      force: bool(p, "force"),
      backfillWriter: one(p, "backfill-writer") ?? null,
      serviceRunning: () => servicePortInUse(cfg.port),
    });
    process.stdout.write((bool(p, "json") ? JSON.stringify(r, null, 2) : formatAdoptResult(r)) + "\n");
    return 0;
  }

  if (cmd === "noise") {
    const agent = one(p, "agent");
    if (!agent) throw new Error("noise needs --agent <id>");
    const bad = agent === "shared" ? null : validateAgentId(agent);
    if (bad) throw new Error(bad);
    const dbPath = join(brainsDir(cfg), agent, "brain.db");
    if (!existsSync(dbPath)) throw new Error(`no brain for "${agent}" at ${dbPath}`);
    const json = bool(p, "json");
    const out = (o: unknown, text: string) => process.stdout.write((json ? JSON.stringify(o, null, 2) : text) + "\n");
    const mustBeStopped = async () => {
      if (await servicePortInUse(cfg.port)) throw new Error(`the brain service is listening on 127.0.0.1:${cfg.port} — stop it first (noise ${sub} writes the brain file directly)`);
    };
    if (sub === "scan") {
      const scan = scanBrainFile(dbPath, agent, { includeRetired: bool(p, "include-retired") });
      const files = writeReport(scan, one(p, "out") ? expandHome(one(p, "out")!) : defaultReportBase(cfg.root, agent));
      const c = scan.counts;
      out({ ...scan.counts, byCategory: scan.byCategory, report: files }, [
        `scanned ${agent}: ${c.nodes} nodes, ${c.episodes} episodes`,
        `candidates: ${c.candidates} (nodes ${c.nodeCandidates}, episodes ${c.episodeCandidates}; high ${c.high}, review ${c.medium}; already retired ${c.alreadyRetired})`,
        ...Object.entries(scan.byCategory).map(([k, v]) => `  ${k.padEnd(28)} ${v}`),
        `report: ${files.csv}`,
        `        ${files.json}`,
        `Review the CSV: keep action=retire only on rows to retire (change others to keep), then run noise retire --ids-file <csv>.`,
      ].join("\n"));
      return 0;
    }
    if (sub === "check") {
      const q = one(p, "query");
      if (!q) throw new Error("noise check needs --query <text>");
      const scan = scanBrainFile(dbPath, agent);
      const cand = new Map(scan.candidates.map((c) => [c.id, c]));
      const hits = ftsProbe(dbPath, q, Number(one(p, "limit") ?? 10)).map((h) => ({ ...h, candidate: cand.get(h.id)?.category ?? null }));
      out({ query: q, hits, candidatesInTop: hits.filter((h) => h.candidate).length },
        [`FTS top ${hits.length} for "${q}" (current nodes only):`, ...hits.map((h, i) => `${String(i + 1).padStart(2)}. ${h.candidate ? `[NOISE:${h.candidate}] ` : ""}${h.type} ${h.id}  ${h.preview.slice(0, 80)}`),
          `${hits.filter((h) => h.candidate).length} candidate(s) in the top ${hits.length}.`].join("\n"));
      return 0;
    }
    if (sub === "status") {
      const rows = registryStatus(dbPath);
      out(rows, rows.length ? rows.map((r) => `${r.batch}  nodes=${r.nodes} episodes=${r.episodes}  at ${r.retiredAt} by ${r.by}`).join("\n") : "nothing retired");
      return 0;
    }
    if (sub === "retire" || sub === "unretire") {
      const dryRun = bool(p, "dry-run");
      if (!dryRun) await mustBeStopped();
      const audit = new AuditLog(cfg.auditFile);
      const common = { dbPath, brain: agent, backupsDir: backupsDir(cfg), audit, dryRun, by: "admin:cli" };
      if (sub === "retire") {
        const f = one(p, "ids-file");
        if (!f) throw new Error("noise retire needs --ids-file <reviewed file>");
        const sel = parseSelection(expandHome(f));
        const r = retireItems(sel, common);
        out({ ...r, ignoredRows: sel.ignored }, [
          `${dryRun ? "DRY RUN — would retire" : "retired"} nodes=${r.retired.nodes.length} episodes=${r.retired.episodes.length}  batch=${r.batch}`,
          ...(r.backup ? [`backup   ${r.backup}`, `manifest ${r.manifest}`] : []),
          ...(sel.ignored ? [`rows not marked action=retire (left alone): ${sel.ignored}`] : []),
          ...r.skipped.map((s) => `skipped ${s.id}: ${s.reason}`),
          ...(dryRun ? [] : [`undo: sharpwave-server noise unretire --agent ${agent} --batch ${r.batch}`]),
        ].join("\n"));
        return 0;
      }
      const f = one(p, "ids-file");
      const r = unretireItems({ ...common, batch: one(p, "batch"), ids: f ? parseSelection(expandHome(f)) : undefined, all: bool(p, "all") });
      out(r, [
        `${dryRun ? "DRY RUN — would restore" : "restored"} nodes=${r.restored.nodes.length} episodes=${r.restored.episodes.length}`,
        ...(r.backup ? [`backup ${r.backup}`] : []),
        ...r.skipped.map((s) => `skipped ${s.id}: ${s.reason}`),
      ].join("\n"));
      return 0;
    }
    throw new Error(`unknown noise subcommand "${sub ?? ""}" (scan | check | retire | unretire | status)`);
  }

  throw new Error(`unknown command "${cmd}" — run sharpwave-server help`);
}

main(process.argv.slice(2)).then(
  (code) => { if (code !== undefined) process.exitCode = code; },
  (e) => {
    const msg = `sharpwave-server: ${e instanceof Error ? e.message : String(e)}`;
    process.stderr.write(msg + "\n");
    // Under the hidden Windows task there is no console, so stderr is lost:
    // also append fatal startup errors (bad config, port in use, ...) to the
    // --log-file when one was given.
    const i = process.argv.indexOf("--log-file");
    const eq = process.argv.find((a) => a.startsWith("--log-file="));
    const logFile = eq ? eq.slice("--log-file=".length) : i >= 0 ? process.argv[i + 1] : undefined;
    if (logFile) {
      try {
        const f = expandHome(logFile);
        mkdirSync(dirname(f), { recursive: true });
        appendFileSync(f, `${new Date().toISOString()} [sharpwave-server] fatal ${msg}\n`);
      } catch { /* best effort */ }
    }
    process.exitCode = 1;
  },
);
