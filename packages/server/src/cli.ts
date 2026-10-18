// packages/server/src/cli.ts — `xanima-server` admin CLI.
//
//   xanima-server serve        [--config f] [--root d] [--port n] [--tailnet-ip ip|none]... [--log-file f] [--no-sleep] [--no-backup]
//   xanima-server token mint   --agent <id> [--scopes read,write] [--label txt] [--json]
//   xanima-server token list   [--json]
//   xanima-server token revoke <tokenId>
//   xanima-server backup now   [--keep n] [--brain name]... [--no-offsite]
//   xanima-server backup keygen [--key-file f] [--force]
//   xanima-server backup restore <file.swbk> --out <path> [--key-file f] [--force] [--require-manifest]
//   xanima-server brain adopt  --agent <id> --from <brain.db|dir> [--mode copy|move] [--dry-run] [--force] [--backfill-writer legacy|<id>] [--json]
//   xanima-server migrate [--from ~/.sharpwave] [--to ~/.xanima] [--dry-run] [--include-backups] [--json]
//   xanima-server sleep now [--force] [--brain name ...] [--json]
//   xanima-server noise scan     --agent <id> [--out base] [--include-retired] [--json]
//   xanima-server noise check    --agent <id> --query <text> [--limit 10] [--json]
//   xanima-server noise retire   --agent <id> --ids-file <reviewed.csv|json|txt> [--dry-run] [--json]
//   xanima-server noise unretire --agent <id> (--batch <id> | --ids-file <f> | --all) [--dry-run] [--json]
//   xanima-server noise status   --agent <id> [--json]
//   xanima-server soul export  --agent <id> [--out f] [--profile compact|full] [--include-sensitive] [--include-shared] [--include-open-items] [--sign --key-file f] [--sqlite f] [--parent id|none]
//   xanima-server soul fork    --agent <id> --out f [...export flags]
//   xanima-server soul import  --agent <id> --from f [--mode new|merge] [--dry-run] [--trust-key id]... [--require-signature]
//   xanima-server soul diff    <a.json> <b.json> [--json]
//   xanima-server soul merge   --base f --theirs f --into <id> [--dry-run] [--force]
//   xanima-server soul review  list|show|accept|reject --agent <id> [--id x | --all] [--reason txt] [--status pending|logged|accepted|rejected|all] [--kind quarantine|identity|goal|conflict…]
//   xanima-server soul validate --from f [--trust-key id]... [--require-signature]
//   xanima-server soul keygen  --key-file f [--force]
//   xanima-server room create  <name> --owner <agent> [--description txt]
//   xanima-server room invite  <name> --agent <id> --role read|write|admin
//   xanima-server room revoke  <name> --agent <id> [--withdraw]      (--withdraw: service stopped)
//   xanima-server room list | members <name> | conflicts <name> [--json]
//   xanima-server version
//
// Common: --config <file> (default <root>/config.json if present), --root <dir>
// (default ~/.xanima/service, or ~/.sharpwave/service before migrating), --tokens-file <file>.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { snapshotBrain } from "./backup.js";
import {
  exportSoul, serializeSoul, signSoul, generateSoulKeyPair, parseSoul, validateSoul, diffSoul, formatSoulDiff, importSoul, mergeSoul,
  formatImportReport, listReviews, getReview, formatReview, acceptReview, rejectReview, writeSoulSqlite, soulSummary, getDb,
  openRoomRegistry, allRooms, listMembers, createRoom, setMember, revokeMember, withdrawAll, roomConflicts, formatRoomConflict, roomBrainName, type RoomRole,
} from "xanima-core";
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
import { migrateDataDir, formatMigrateResult } from "./migrate.js";
import { SleepRunner } from "./sleep.js";
import { BrainManager } from "./brains.js";
import { DEFAULT_CONFIG, suppressDeprecationWarning, identityHistory, formatIdentityHistory, revertIdentityVersion, identityStatus, identityFields, listValues } from "xanima-core";
import { listLegacyGoalsFile, pauseLegacyGoalsFile, resumeLegacyGoalsFile } from "./goals-legacy.js";
import { defaultReportBase, ftsProbe, parseSelection, registryStatus, retireItems, scanBrainFile, unretireItems, writeReport } from "./noise.js";
import { BrainService } from "./service.js";
import { VERSION } from "./version.js";
import { validateAgentId } from "./tokens.js";

interface Parsed {
  _: string[];
  flags: Map<string, string[]>;
}

const BOOL_FLAGS = new Set(["withdraw", "include-sensitive", "include-shared", "include-open-items", "sign", "require-signature", "include-backups", "skip-port-check", "json", "no-sleep", "no-backup", "help", "h", "allow-reset", "no-offsite", "force", "require-manifest", "dry-run", "include-retired", "all"]);

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

const HELP = `xanima-server ${VERSION} — Xanima brain service

Usage:
  xanima-server serve [--config file] [--root dir] [--port 18790] [--tailnet-ip 100.x.y.z|none] [--log-file f] [--no-sleep] [--no-backup]
  xanima-server token mint --agent <id> [--scopes read,write[,shared-write][,admin|provision]] [--label text] [--json]
  xanima-server token list [--json]
  xanima-server token revoke <tokenId>
  xanima-server backup now [--keep N] [--brain name ...] [--no-offsite]
  xanima-server backup keygen [--key-file f] [--force]
  xanima-server backup restore <file.swbk> --out <path> [--key-file f] [--force] [--require-manifest]
  xanima-server brain adopt --agent <id> --from <brain.db or its folder> [--mode copy|move] [--dry-run] [--force]
                               [--backfill-writer legacy|<writer-id>] [--json]
      Make an existing brain.db the agent's private brain (<root>/brains/<id>/brain.db). The service must be stopped.
      Pre-adopt backup (VACUUM INTO, WAL included) + sha256, migrate via xanima-core, verify integrity/counts/schema.
      copy (default) never touches the source; --force moves an existing non-empty target aside (never deletes).
  xanima-server migrate [--from ~/.sharpwave] [--to ~/.xanima] [--dry-run] [--include-backups] [--skip-port-check] [--json]
      COPY the SharpWave data folder to the Xanima one (never moves or deletes the old folder; refuses a non-empty
      target and a running service). Every brain.db in the copy is migrated to the current schema and verified
      (node/edge/episode counts before == after, integrity ok); config.json paths are pointed at the new folder.
      _backup-* folders are skipped unless --include-backups. Report: <to>/MIGRATED-FROM-SHARPWAVE.json.
  xanima-server sleep now [--force] [--brain name ...] [--json]
      Run one sleep/consolidation cycle now (service must be stopped). --force ignores the episode gate.
  xanima-server noise scan --agent <id> [--out <report base path>] [--include-retired] [--json]
      Read-only (safe while the service runs). Lists system-noise candidates (NO_REPLY / HEARTBEAT_OK triage,
      heartbeat/exec/cron wake markers, nodes minted from such episodes, triage phrasing) and writes
      <root>/noise-reports/<id>-<UTC>.csv + .json. High-confidence rows say action=retire, others action=review.
  xanima-server noise check --agent <id> --query <text> [--limit 10] [--json]
      Read-only FTS probe: top hits for the query among current (non-retired) nodes, flagged if candidates.
  xanima-server noise retire --agent <id> --ids-file <reviewed.csv|.json|.txt> [--dry-run] [--json]
      Service must be stopped. Backup first (VACUUM INTO -> <backups>/<id>/noise-retire/), then soft-retire ONLY
      rows left at action=retire: nodes get valid_until=now (hidden from recall), episodes importance=0. Prior
      values are kept in meta_kv (retired:node:/retired:episode:) for unretire. Nothing is deleted. Audit-logged.
  xanima-server noise unretire --agent <id> (--batch <noise-...> | --ids-file <f> | --all) [--dry-run] [--json]
      Service must be stopped. Backup first, then restore the recorded prior values exactly.
  xanima-server noise status --agent <id> [--json]
  xanima-server goals list-legacy --agent <id> [--json]
      Read-only. Active *untracked* (pre-0.2.0 backfilled) goals, each marked when it looks like a chat fragment.
  xanima-server goals pause-legacy --agent <id> [--all-untracked] [--dry-run] [--json]
      Service must be stopped. Backup first, then pause the untracked goals that look like chat fragments
      (all untracked ones with --all-untracked). Audited; undo with goals resume-legacy --batch <goals-...>.
  xanima-server goals resume-legacy --agent <id> --batch <goals-...> [--dry-run] [--json]
  xanima-server identity history --agent <id> [--all] [--limit 50] [--json]
      Read-only (safe while the service runs). The agent's identity versions: what changed (old → new), reason,
      who / provenance, review id, reverted-by. --all also lists changes held for review and refused attempts.
  xanima-server identity show --agent <id> [--json]      Current identity fields + values (read-only).
  xanima-server identity revert <version> --agent <id> [--reason text] [--force] [--json]
      Service must be stopped. Backup first, then undo that version as a NEW version (history kept). Refuses when the
      same field / value changed later (revert the later version first, or --force).
  xanima-server soul export --agent <id> [--out f] [--profile compact|full] [--include-sensitive] [--include-shared]
                           [--include-open-items] [--sign --key-file f] [--sqlite f] [--parent <id>|none]
      Write the agent's Soul Package (xanima-soul/1, deterministic JSON + sha256). Read-only: safe while the service runs.
  xanima-server soul fork --agent <id> --out f   Full-profile export marked as a fork (the base for a later three-way merge).
  xanima-server soul import --agent <id> --from f [--mode new|merge] [--dry-run] [--trust-key <key id>]... [--require-signature]
      Service must be stopped. Validates schema + hash (+ signature), backs up, imports with provenance
      (source_type import, imported_from edges). Identity, values and goals go to the review queue; differences never overwrite.
  xanima-server soul diff <a.json> <b.json> [--json]
  xanima-server soul merge --base <parent pkg> --theirs <fork pkg> --into <id> [--dry-run] [--force]
      Service must be stopped. Three-way merge per item; conflicts become review items with markers.
  xanima-server soul review list|show|accept|reject --agent <id> [--id <rv-…> | --all] [--reason text] [--status pending|all]
      accept / reject need the service stopped (they write the brain file).
  xanima-server soul validate --from f [--trust-key id]... [--require-signature]
  xanima-server soul keygen --key-file f [--force]   ed25519 signing key (keep it out of any repo).
  xanima-server version

Binds 127.0.0.1 always, plus the tailnet IP (default 100.121.136.3). Never 0.0.0.0/::.
Root defaults to ~/.xanima/service (brains/, backups/, audit/, tokens.json, config.json); ~/.sharpwave/service
is used if ~/.xanima does not exist yet (run: xanima-server migrate). XANIMA_SERVICE_ROOT overrides.`;

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

  // `migrate` IS the fix for the old-data-folder warning; don't print it while migrating.
  if (cmd === "migrate") suppressDeprecationWarning("datadir");
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
          `This is the ONLY time the token is shown. Store it now (e.g. XANIMA_TOKEN or a token file).\n`,
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

  if (cmd === "migrate") {
    const { homedir } = await import("node:os");
    const from = expandHome(one(p, "from") ?? join(homedir(), ".sharpwave"));
    const to = expandHome(one(p, "to") ?? join(homedir(), ".xanima"));
    if (!bool(p, "skip-port-check") && !bool(p, "dry-run") && await servicePortInUse(cfg.port)) {
      throw new Error(`a brain service is listening on 127.0.0.1:${cfg.port} — stop it (and the gateway) before migrating, so the copy is consistent`);
    }
    const r = migrateDataDir({
      from, to, dryRun: bool(p, "dry-run"), includeBackups: bool(p, "include-backups"),
      log: bool(p, "json") ? undefined : (m) => process.stderr.write(m + "\n"),
    });
    process.stdout.write((bool(p, "json") ? JSON.stringify(r, null, 2) : formatMigrateResult(r)) + "\n");
    return r.ok ? 0 : 1;
  }

  if (cmd === "sleep") {
    if (sub !== "now") throw new Error(`unknown sleep subcommand "${sub ?? ""}" (now)`);
    if (await servicePortInUse(cfg.port)) throw new Error(`the brain service is listening on 127.0.0.1:${cfg.port} — stop it first (sleep now writes the brain files directly)`);
    const log = createLogger(cfg.logFile, true);
    const brainCfg = { ...DEFAULT_CONFIG, ...(cfg.brain ?? {}) };
    const mgr = new BrainManager(brainsDir(cfg), 1);
    mgr.init();
    const only = many(p, "brain");
    try {
      const runner = new SleepRunner(mgr, brainCfg, cfg.sleep.budgetMs, cfg.sleep.respectGate, log, new AuditLog(cfg.auditFile), only.length ? only : undefined);
      const r = await runner.runCycle({ force: bool(p, "force") });
      process.stdout.write((bool(p, "json") ? JSON.stringify(r, null, 2) : `sleep: ran=[${r.ran.join(",")}] gated=[${r.skippedGate.join(",")}] failed=${r.failed.length} in ${r.elapsedMs}ms`) + "\n");
      return r.failed.length ? 1 : 0;
    } finally {
      await mgr.close();
    }
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
          ...(dryRun ? [] : [`undo: xanima-server noise unretire --agent ${agent} --batch ${r.batch}`]),
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

  if (cmd === "goals") {
    const agent = one(p, "agent");
    if (!agent) throw new Error("goals needs --agent <id>");
    const bad = validateAgentId(agent);
    if (bad) throw new Error(bad);
    const dbPath = join(brainsDir(cfg), agent, "brain.db");
    if (!existsSync(dbPath)) throw new Error(`no brain for "${agent}" at ${dbPath}`);
    const json = bool(p, "json");
    const out = (o: unknown, text: string) => process.stdout.write((json ? JSON.stringify(o, null, 2) : text) + "\n");
    const row = (g: { lineage_id: string; priority: number; title: string; fragment: string | null }) => `  ${g.lineage_id.slice(0, 8)} P${g.priority} ${g.fragment ? `[fragment: ${g.fragment}]` : "[looks like a goal]"} ${g.title.slice(0, 70)}`;
    if (sub === "list-legacy") {
      const l = listLegacyGoalsFile(dbPath);
      out(l, [`${l.length} active untracked legacy goal(s); ${l.filter((g) => g.fragment).length} look like chat fragments`, ...l.map(row)].join("\n"));
      return 0;
    }
    if (sub === "pause-legacy" || sub === "resume-legacy") {
      const dryRun = bool(p, "dry-run");
      if (!dryRun && await servicePortInUse(cfg.port)) throw new Error(`the brain service is listening on 127.0.0.1:${cfg.port} — stop it first (goals ${sub} writes the brain file directly)`);
      const common = { dbPath, brain: agent, backupsDir: backupsDir(cfg), audit: new AuditLog(cfg.auditFile), dryRun, by: "admin:cli" };
      if (sub === "pause-legacy") {
        const r = pauseLegacyGoalsFile({ ...common, all: bool(p, "all-untracked") });
        out(r, [`${dryRun ? "DRY RUN — would pause" : "paused"} ${r.paused.length} untracked legacy goal(s), kept ${r.kept.length}  batch=${r.batch}`,
          ...r.paused.map(row), ...(r.kept.length ? ["kept (not fragment-like; --all-untracked pauses them too):", ...r.kept.map(row)] : []),
          ...(r.backup ? [`backup ${r.backup}`, `undo: xanima-server goals resume-legacy --agent ${agent} --batch ${r.batch}`] : [])].join("\n"));
        return 0;
      }
      const b = one(p, "batch");
      if (!b) throw new Error("goals resume-legacy needs --batch <goals-...>");
      const r = resumeLegacyGoalsFile({ ...common, batch: b });
      out(r, `${dryRun ? "DRY RUN — would resume" : "resumed"} ${r.resumed.length} goal(s) from ${b}${r.backup ? `\nbackup ${r.backup}` : ""}`);
      return 0;
    }
    throw new Error(`unknown goals subcommand "${sub ?? ""}" (list-legacy | pause-legacy | resume-legacy)`);
  }

  if (cmd === "identity") {
    const agent = one(p, "agent") ?? one(p, "brain");
    if (!agent) throw new Error("identity needs --agent <id> (or --brain <id>)");
    const bad = validateAgentId(agent);
    if (bad) throw new Error(bad);
    const dbPath = join(brainsDir(cfg), agent, "brain.db");
    if (!existsSync(dbPath)) throw new Error(`no brain for "${agent}" at ${dbPath}`);
    const json = bool(p, "json");
    const out = (o: unknown, text: string) => process.stdout.write((json ? JSON.stringify(o, null, 2) : text) + "\n");
    const brainCfg = { ...DEFAULT_CONFIG, ...(cfg.brain ?? {}) };
    if (sub === "history" || sub === "show") {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        if (sub === "history") {
          const lim = one(p, "limit");
          const rows = identityHistory(db, { all: bool(p, "all"), limit: lim ? Number(lim) : 50 });
          const st = identityStatus(db, brainCfg);
          out(rows, [`${agent}: identity v${st?.version ?? 0} · ${st?.held ?? 0} held for review · locked: ${st?.locked.join(", ") || "none"}${bool(p, "all") ? "" : " (applied versions; --all adds held / refused attempts)"}`, formatIdentityHistory(rows)].join("\n"));
        } else {
          const text = ((db.prepare("SELECT identity FROM self_model WHERE id = 'singleton'").get() as { identity?: string } | undefined)?.identity ?? "").trim();
          const values = listValues(db);
          out({ identity: text, fields: identityFields(text), values }, [`identity:`, text || "(empty)", "", `values (${values.length}):`, ...values.map((v) => `- ${v.id.slice(0, 8)} [${v.source_type ?? "?"}] ${v.label}`)].join("\n"));
        }
      } finally { db.close(); }
      return 0;
    }
    if (sub === "revert") {
      const v = Number(one(p, "version") ?? p._[2]);
      if (!Number.isInteger(v) || v < 1) throw new Error("identity revert needs a version number: xanima-server identity revert <version> --agent <id>");
      if (await servicePortInUse(cfg.port)) throw new Error(`the brain service is listening on 127.0.0.1:${cfg.port} — stop it first (identity revert writes the brain file directly)`);
      const backup = snapshotBrain(dbPath, join(backupsDir(cfg), agent), "identity", 1_000_000).path;
      const mgr = new BrainManager(brainsDir(cfg), 1);
      mgr.init();
      try {
        const r = await mgr.write(agent, () => revertIdentityVersion(agent, v, { by: "admin:cli", reason: one(p, "reason") ?? `revert v${v} (operator)`, force: bool(p, "force"), config: brainCfg }));
        new AuditLog(cfg.auditFile).append({ agentId: "admin:cli", tool: "identity revert", brain: agent, nodeId: null, outcome: r.status === "applied" ? "ok" : "error", detail: `v${v} → ${r.message.slice(0, 160)} backup=${backup}` });
        out({ ...r, backup }, `${r.message}\nbackup ${backup}`);
        return r.status === "applied" ? 0 : 1;
      } finally { await mgr.close(); }
    }
    throw new Error(`unknown identity subcommand "${sub ?? ""}" (history | show | revert)`);
  }

  if (cmd === "soul") return soulCommand(p, sub, cfg);
  if (cmd === "room") return roomCommand(p, sub, cfg);

  throw new Error(`unknown command "${cmd}" — run xanima-server help`);
}

async function roomCommand(p: Parsed, sub: string | undefined, cfg: ServiceConfig): Promise<number> {
  const json = bool(p, "json");
  const out = (o: unknown, text: string) => process.stdout.write((json ? JSON.stringify(o, null, 2) : text) + "\n");
  const reg = openRoomRegistry(join(brainsDir(cfg), "..", "rooms", "registry.db"));
  const audit = new AuditLog(cfg.auditFile);
  const by = "admin:cli";
  try {
    if (sub === "list") {
      const rooms = allRooms(reg).map((r) => ({ ...r, members: listMembers(reg, r.name) }));
      out(rooms, rooms.length ? rooms.map((r) => `${r.name} (owner ${r.owner}): ${r.members.map((m) => `${m.agent_id}=${m.role}`).join(", ")}${r.description ? ` — ${r.description}` : ""}`).join("\n") : "no rooms");
      return 0;
    }
    const name = p._[2];
    if (!name) throw new Error(`room ${sub ?? ""} needs a room name`);
    if (sub === "create") {
      const owner = one(p, "owner"); if (!owner) throw new Error("room create needs --owner <agent>");
      const bad = validateAgentId(owner); if (bad) throw new Error(bad);
      const r = createRoom(reg, { name, owner, description: one(p, "description") });
      if (!r.ok) throw new Error(r.error);
      audit.append({ agentId: by, tool: "room.create", brain: roomBrainName(name), nodeId: null, outcome: "ok", detail: `owner=${owner}` });
      out({ ok: true, room: name, owner }, `created room ${name} (owner ${owner})`);
      return 0;
    }
    if (sub === "invite" || sub === "revoke") {
      const agent = one(p, "agent"); if (!agent) throw new Error(`room ${sub} needs --agent <id>`);
      const bad = validateAgentId(agent); if (bad) throw new Error(bad);
      if (sub === "invite") {
        const role = (one(p, "role") ?? "read") as RoomRole;
        const r = setMember(reg, { room: name, agent, role, by });
        if (!r.ok) throw new Error(r.error);
        audit.append({ agentId: by, tool: "room.invite", brain: roomBrainName(name), nodeId: null, outcome: "ok", detail: `${agent}=${role}` });
        out({ ok: true, room: name, agent, role, previous: r.previous ?? null }, `${agent} is ${role} in ${name}${r.previous ? ` (was ${r.previous})` : ""}`);
        return 0;
      }
      const withdraw = bool(p, "withdraw");
      if (withdraw && await servicePortInUse(cfg.port)) throw new Error(`the brain service is listening on 127.0.0.1:${cfg.port} — stop it first for --withdraw, or use brain_room {"action":"revoke","withdraw":true} through the service`);
      const r = revokeMember(reg, { room: name, agent, by });
      if (!r.ok) throw new Error(r.error);
      let withdrawn = 0;
      if (withdraw) {
        const mgr = new BrainManager(brainsDir(cfg), 1); mgr.init();
        try { withdrawn = await mgr.write(roomBrainName(name), () => withdrawAll(name, agent, `withdrawn: ${agent} was revoked from ${name} by ${by}`)); } finally { await mgr.close(); }
      }
      audit.append({ agentId: by, tool: "room.revoke", brain: roomBrainName(name), nodeId: null, outcome: "ok", detail: `${agent}${withdraw ? ` withdraw=${withdrawn}` : ""}` });
      out({ ok: true, room: name, agent, withdrawn }, `revoked ${agent} from ${name}${withdraw ? `; withdrew ${withdrawn} item(s)` : ""}`);
      return 0;
    }
    if (sub === "members") {
      const m = listMembers(reg, name, true);
      out(m, m.map((x) => `${x.agent_id} ${x.role}${x.revoked_at ? " (revoked)" : ""}`).join("\n") || "no members");
      return 0;
    }
    if (sub === "conflicts") {
      const f = join(brainsDir(cfg), roomBrainName(name), "brain.db");
      if (!existsSync(f)) { out([], "no conflicts (room brain not created yet)"); return 0; }
      const db = new Database(f, { readonly: true });
      try {
        const cs = roomConflicts(name, { status: "all" }, db);
        out(cs, cs.map((c) => formatRoomConflict(c, (t) => new Date(t).toISOString())).join("\n") || "no conflicts");
      } finally { db.close(); }
      return 0;
    }
    throw new Error(`unknown room subcommand "${sub ?? ""}" (create | invite | revoke | list | members | conflicts)`);
  } finally { reg.close(); }
}

async function soulCommand(p: Parsed, sub: string | undefined, cfg: ServiceConfig): Promise<number> {
  const json = bool(p, "json");
  const out = (o: unknown, text: string) => process.stdout.write((json ? JSON.stringify(o, null, 2) : text) + "\n");
  const brainCfg = { ...DEFAULT_CONFIG, ...(cfg.brain ?? {}) };
  const readPkg = (f: string | undefined, what: string) => { if (!f) throw new Error(`soul ${sub} needs ${what}`); return parseSoul(readFileSync(expandHome(f), "utf8")); };
  const trust = { trustedKeyIds: many(p, "trust-key"), requireSignature: bool(p, "require-signature") };
  const agentDb = (agent: string | undefined) => {
    if (!agent) throw new Error(`soul ${sub} needs --agent <id>`);
    const bad = validateAgentId(agent); if (bad) throw new Error(bad);
    const f = join(brainsDir(cfg), agent, "brain.db");
    if (!existsSync(f)) throw new Error(`no brain for "${agent}" at ${f}`);
    return { agent, path: f };
  };
  const mustBeStopped = async () => {
    if (await servicePortInUse(cfg.port)) throw new Error(`the brain service is listening on 127.0.0.1:${cfg.port} — stop it first (soul ${sub} writes the brain file directly)`);
  };
  /** Run fn on the agent's brain through core (write path), with a pre-write backup + audit. */
  const withBrain = async <T>(agent: string, fn: (backup: () => string) => T): Promise<T> => {
    const mgr = new BrainManager(brainsDir(cfg), 1);
    mgr.init();
    try {
      const backup = () => snapshotBrain(join(brainsDir(cfg), agent, "brain.db"), join(backupsDir(cfg), agent), "soul", 1_000_000).path;
      return await mgr.write(agent, () => fn(backup));
    } finally { await mgr.close(); }
  };
  const audit = new AuditLog(cfg.auditFile);

  if (sub === "keygen") {
    const f = one(p, "key-file"); if (!f) throw new Error("soul keygen needs --key-file <path>");
    const path = expandHome(f);
    if (existsSync(path) && !bool(p, "force")) throw new Error(`${path} exists (use --force to replace it)`);
    const k = generateSoulKeyPair();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, k.privateKeyPem, { mode: 0o600 });
    writeFileSync(path + ".pub", k.publicKeyPem, { mode: 0o644 });
    out({ keyId: k.keyId, keyFile: path, publicKey: path + ".pub" }, `wrote ed25519 key ${k.keyId}\n  private ${path} (keep it secret; never commit it)\n  public  ${path}.pub`);
    return 0;
  }
  if (sub === "export" || sub === "fork") {
    const { agent, path } = agentDb(one(p, "agent"));
    const db = new Database(path, { readonly: true, fileMustExist: true });
    let sdb: InstanceType<typeof Database> | undefined;
    try {
      if (bool(p, "include-shared")) { const sf = join(brainsDir(cfg), "shared", "brain.db"); if (existsSync(sf)) sdb = new Database(sf, { readonly: true, fileMustExist: true }); }
      const parent = one(p, "parent");
      let pkg = exportSoul(db, { agentId: agent, profile: sub === "fork" ? "full" : (one(p, "profile") === "full" ? "full" : one(p, "profile") === "compact" ? "compact" : brainCfg.soulExportProfile), fork: sub === "fork",
        includeSensitive: bool(p, "include-sensitive"), ...(bool(p, "include-open-items") ? { includeOpenItems: true } : {}), ...(sdb ? { sharedDb: sdb } : {}),
        ...(parent ? { parentId: parent === "none" ? null : parent } : {}), config: brainCfg });
      if (bool(p, "sign")) { const kf = one(p, "key-file"); if (!kf) throw new Error("--sign needs --key-file <ed25519 private key PEM>"); pkg = signSoul(pkg, readFileSync(expandHome(kf), "utf8")); }
      const text = serializeSoul(pkg);
      const dest = one(p, "out");
      if (dest) { const f = expandHome(dest); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); }
      else if (!json) process.stdout.write(text);
      let sq: { nodes: number; edges: number } | null = null;
      if (one(p, "sqlite")) {
        const f = expandHome(one(p, "sqlite")!);
        if (existsSync(f)) throw new Error(`${f} exists; refusing to overwrite`);
        const o = new Database(f); try { sq = writeSoulSqlite(db, pkg, o); } finally { o.close(); }
      }
      audit.append({ agentId: "admin:cli", tool: `soul ${sub}`, brain: agent, nodeId: null, outcome: "ok", detail: `${pkg.package_id} ${pkg.profile}${pkg.signature ? " signed" : ""}` });
      if (dest || json) out({ packageId: pkg.package_id, profile: pkg.profile, bytes: Buffer.byteLength(text), approxTokens: pkg.stats.approx_tokens, counts: pkg.stats.counts, out: dest ?? null, sqlite: sq },
        `${soulSummary(pkg, Buffer.byteLength(text))}${dest ? `\nwrote ${expandHome(dest)}` : ""}${sq ? `\nsqlite subset: ${sq.nodes} nodes, ${sq.edges} edges` : ""}`);
      return 0;
    } finally { db.close(); sdb?.close(); }
  }
  if (sub === "validate") {
    const pkg = readPkg(one(p, "from"), "--from <package.json>");
    const v = validateSoul(pkg, trust);
    out(v, v.ok ? `ok  ${pkg.package_id} (${v.signed ? `signed, key ${v.keyId}` : "unsigned"})` : `INVALID\n${v.errors.map((e) => `  - ${e}`).join("\n")}`);
    return v.ok ? 0 : 1;
  }
  if (sub === "diff") {
    const [, , a, b] = p._;
    const d = diffSoul(readPkg(a, "<a.json> <b.json>"), readPkg(b, "<a.json> <b.json>"));
    out(d, formatSoulDiff(d));
    return 0;
  }
  if (sub === "import") {
    const { agent } = agentDb(one(p, "agent"));
    const pkg = readPkg(one(p, "from"), "--from <package.json>");
    const dryRun = bool(p, "dry-run");
    if (!dryRun) await mustBeStopped();
    const mode = one(p, "mode") === "merge" ? "merge" : "new";
    try {
      const r = await withBrain(agent, (backup) => importSoul(agent, pkg, { mode, dryRun, by: "admin:cli", config: brainCfg, ...trust, backup }));
      audit.append({ agentId: "admin:cli", tool: "soul import", brain: agent, nodeId: null, outcome: "ok", detail: `${pkg.package_id} mode=${mode}${dryRun ? " dry-run" : ""} created=${r.created.length} review=${r.review.length} backup=${r.backup ?? "-"}` });
      out(r, formatImportReport(r));
      return 0;
    } catch (e) {
      audit.append({ agentId: "admin:cli", tool: "soul import", brain: agent, nodeId: null, outcome: "error", detail: String(e instanceof Error ? e.message : e).slice(0, 300) });
      throw e;
    }
  }
  if (sub === "merge") {
    const { agent } = agentDb(one(p, "into"));
    const base = readPkg(one(p, "base"), "--base <parent package>");
    const theirs = readPkg(one(p, "theirs"), "--theirs <fork package>");
    const dryRun = bool(p, "dry-run");
    if (!dryRun) await mustBeStopped();
    const r = await withBrain(agent, (backup) => mergeSoul(agent, base, theirs, { dryRun, by: "admin:cli", config: brainCfg, force: bool(p, "force"), ...trust, backup }));
    audit.append({ agentId: "admin:cli", tool: "soul merge", brain: agent, nodeId: null, outcome: "ok", detail: `base=${base.package_id} theirs=${theirs.package_id}${dryRun ? " dry-run" : ""} conflicts=${r.conflicts} review=${r.review.length} backup=${r.backup ?? "-"}` });
    out(r, formatImportReport(r));
    return 0;
  }
  if (sub === "review") {
    const action = p._[2] ?? "list";
    const { agent, path } = agentDb(one(p, "agent"));
    if (action === "list" || action === "show") {
      const db = new Database(path, { readonly: true, fileMustExist: true });
      try {
        if (action === "list") {
          const st = (one(p, "status") ?? "pending") as "pending";
          const kind = one(p, "kind");
          const rows = listReviews(db, { status: st, ...(kind ? { kind } : {}) });
          out(rows, rows.length ? rows.map((r) => formatReview(r)).join("\n") : `no ${st} review items`);
        } else {
          const id = one(p, "id") ?? p._[3]; if (!id) throw new Error("soul review show needs --id <rv-…>");
          const r = getReview(db, id); if (!r) throw new Error(`review item ${id} not found (or ambiguous)`);
          out(r, formatReview(r, true));
        }
      } finally { db.close(); }
      return 0;
    }
    if (action !== "accept" && action !== "reject") throw new Error(`unknown soul review action "${action}" (list | show | accept | reject)`);
    await mustBeStopped();
    const res = await withBrain(agent, () => {
      const ids = bool(p, "all") ? listReviews(getDb(agent)).map((r) => r.id) : [one(p, "id") ?? p._[3]].filter((x): x is string => !!x);
      if (!ids.length) throw new Error(`soul review ${action} needs --id <rv-…> or --all`);
      return ids.map((id) => ({ id, ...(action === "accept" ? acceptReview(agent, id, { by: "admin:cli", config: brainCfg, ...(one(p, "reason") ? { note: one(p, "reason") } : {}) }) : rejectReview(agent, id, { by: "admin:cli", ...(one(p, "reason") ? { reason: one(p, "reason") } : {}) })) }));
    });
    for (const r of res) audit.append({ agentId: "admin:cli", tool: `soul review ${action}`, brain: agent, nodeId: null, outcome: r.ok ? "ok" : "error", detail: `${r.id} ${"applied" in r && r.applied ? r.applied : r.error ?? ""}`.slice(0, 300) });
    out(res, res.map((r) => (r.ok ? `${action}ed ${r.id}${"applied" in r && r.applied ? `: ${r.applied}` : ""}` : `FAILED ${r.id}: ${r.error}`)).join("\n"));
    return res.every((r) => r.ok) ? 0 : 1;
  }
  throw new Error(`unknown soul subcommand "${sub ?? ""}" (export | fork | import | diff | merge | review | validate | keygen)`);
}

main(process.argv.slice(2)).then(
  (code) => { if (code !== undefined) process.exitCode = code; },
  (e) => {
    const msg = `xanima-server: ${e instanceof Error ? e.message : String(e)}`;
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
        appendFileSync(f, `${new Date().toISOString()} [xanima-server] fatal ${msg}\n`);
      } catch { /* best effort */ }
    }
    process.exitCode = 1;
  },
);
