// packages/server/src/service.ts
//
// BrainService — wires config, tokens, brains, HTTP listeners, schedulers.
//
// Bind lifecycle:
//   1. Every configured host is checked by the bind policy BEFORE anything is
//      opened (0.0.0.0 / :: / hostnames → BindPolicyError, service refuses to start).
//   2. 127.0.0.1:<port> must bind or start() fails.
//   3. Each tailnet IP is bound on the same port in the background, retrying
//      with exponential backoff for `tailnetRetryWindowMs` (Tailscale may come up
//      after logon). If the window expires the service keeps serving on
//      127.0.0.1 only, logs a warning, and (if `tailnetBackgroundRetryMs` > 0)
//      keeps retrying at that interval.

import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG, drainEmbeddingQueue } from "sharpwave-core";
import type { BrainConfig } from "sharpwave-core";

import { assertBindableHost, listenOnce, listenWithRetry } from "./bind.js";
import { BrainManager } from "./brains.js";
import { AuditLog } from "./audit.js";
import { TokenStore, type Principal } from "./tokens.js";
import { createHandler } from "./http.js";
import { LOOPBACK, brainsDir, backupsDir, type ServiceConfig } from "./config.js";
import { createLogger, type Logger } from "./log.js";
import { SleepRunner, type SleepReport } from "./sleep.js";
import { makeOffsite, snapshotAndAudit, type BackupRun } from "./backup-job.js";
import type { OffsiteBackup } from "./offsite.js";
import { scheduleDaily, type DailyJob } from "./schedule.js";
import type { ToolContext } from "./tools.js";

export interface ServiceOptions {
  log?: Logger;
  brainConfig?: Partial<BrainConfig>;
}

export class BrainService {
  readonly log: Logger;
  readonly brains: BrainManager;
  readonly audit: AuditLog;
  readonly tokens: TokenStore;
  readonly brainConfig: BrainConfig;
  readonly sleep: SleepRunner;
  readonly offsite: OffsiteBackup;
  private readonly servers = new Map<string, Server>();
  private readonly bootId = randomUUID().slice(0, 8);
  private readonly abort = new AbortController();
  private timers: NodeJS.Timeout[] = [];
  private jobs: DailyJob[] = [];
  private _port = 0;
  private started = false;
  /** Resolves once every tailnet host is bound or its startup retry window ran out. */
  tailnetSettled: Promise<void> = Promise.resolve();

  constructor(readonly cfg: ServiceConfig, opts: ServiceOptions = {}) {
    // Policy check first: a bad host must fail before any file is touched.
    assertBindableHost(LOOPBACK);
    for (const h of cfg.tailnetHosts) assertBindableHost(h);
    this.log = opts.log ?? createLogger(cfg.logFile);
    this.brainConfig = { ...DEFAULT_CONFIG, ...(opts.brainConfig ?? {}) };
    this.brains = new BrainManager(brainsDir(cfg), cfg.readConnectionsPerBrain);
    this.audit = new AuditLog(cfg.auditFile);
    this.tokens = new TokenStore(cfg.tokensFile);
    this.sleep = new SleepRunner(this.brains, this.brainConfig, cfg.sleep.budgetMs, cfg.sleep.respectGate, this.log, this.audit);
    this.offsite = makeOffsite(cfg, this.log, this.audit);
  }

  get port(): number {
    return this._port;
  }

  /** "host:port" for every address currently bound. */
  addresses(): string[] {
    return [...this.servers.keys()].map((h) => `${h}:${this._port}`);
  }

  url(host = LOOPBACK): string {
    return `http://${host}:${this._port}`;
  }

  private makeContext = (principal: Principal): ToolContext => ({
    principal,
    brains: this.brains,
    audit: this.audit,
    brainConfig: this.brainConfig,
    allowReset: this.cfg.allowReset,
    sessionId: (agentId) => `svc:${agentId}:${this.bootId}`,
  });

  private makeHttpServer = (): Server => {
    const handler = createHandler({
      tokens: this.tokens,
      makeContext: this.makeContext,
      addresses: () => this.addresses(),
      maxBodyBytes: this.cfg.maxBodyBytes,
      allowedOrigins: this.cfg.allowedOrigins,
      log: this.log,
    });
    const s = createServer((req, res) => { void handler(req, res); });
    s.keepAliveTimeout = 5_000;
    return s;
  };

  async start(): Promise<void> {
    if (this.started) throw new Error("already started");
    this.started = true;
    this.brains.init();
    if (this.tokens.size === 0) {
      this.log.warn(`no tokens in ${this.cfg.tokensFile} — every /mcp request will get 401. Mint one with: sharpwave-server token mint --agent <id>`);
    }

    const loop = this.makeHttpServer();
    await listenOnce(loop, LOOPBACK, this.cfg.port);
    const addr = loop.address();
    this._port = typeof addr === "object" && addr ? addr.port : this.cfg.port;
    this.servers.set(LOOPBACK, loop);
    this.log.info(`listening on http://${LOOPBACK}:${this._port} (v-boot ${this.bootId})`);

    this.tailnetSettled = Promise.all(this.cfg.tailnetHosts.map((h) => this.bindTailnet(h))).then(() => undefined);

    if (this.cfg.embedDrainIntervalMs > 0) {
      const t = setInterval(() => {
        for (const b of this.brains.openBrains()) void drainEmbeddingQueue(b, this.brainConfig);
      }, this.cfg.embedDrainIntervalMs);
      t.unref();
      this.timers.push(t);
    }
    const onJobError = (what: string) => (e: unknown) => this.log.error(`${what} failed: ${String(e)}`);
    if (this.cfg.sleep.enabled) {
      this.jobs.push(scheduleDaily(this.cfg.sleep.at, () => this.sleep.runCycle(), onJobError("sleep")));
      this.log.info(`sleep/consolidation scheduled daily at ${this.cfg.sleep.at} (budget ${Math.round(this.cfg.sleep.budgetMs / 1000)}s)`);
    }
    if (this.cfg.backup.enabled) {
      this.jobs.push(scheduleDaily(this.cfg.backup.at, () => this.runBackup(), onJobError("backup")));
      this.log.info(`backups scheduled daily at ${this.cfg.backup.at} (keep ${this.cfg.backup.keep}) -> ${backupsDir(this.cfg)}`);
      if (this.cfg.offsiteBackup.enabled) {
        const o = this.cfg.offsiteBackup;
        this.log.info(`offsite backup enabled: outbox ${o.outboxDir}` + (o.folder ? `, folder ${o.folder}` : "") +
          (o.command?.length ? `, command ${o.command[0]}` : "") + ` (keep ${o.keepDaily} daily + ${o.keepWeekly} weekly)`);
      }
    }
  }

  private async bindTailnet(host: string): Promise<void> {
    const server = await listenWithRetry(this.makeHttpServer, host, this._port, {
      windowMs: this.cfg.tailnetRetryWindowMs,
      initialDelayMs: this.cfg.tailnetRetryInitialDelayMs,
      maxDelayMs: this.cfg.tailnetRetryMaxDelayMs,
      signal: this.abort.signal,
      onRetry: (e, attempt, wait) => this.log.info(`tailnet bind ${host}:${this._port} failed (${e.code ?? e.message}); retry #${attempt} in ${wait}ms`),
    });
    if (this.abort.signal.aborted) { server?.close(); return; }
    if (server) {
      this.servers.set(host, server);
      this.log.info(`listening on http://${host}:${this._port} (tailnet)`);
      return;
    }
    this.log.warn(`could not bind tailnet address ${host}:${this._port} within ${this.cfg.tailnetRetryWindowMs}ms — serving on ${LOOPBACK} only` +
      (this.cfg.tailnetBackgroundRetryMs > 0 ? `; retrying every ${this.cfg.tailnetBackgroundRetryMs}ms in the background` : ""));
    if (this.cfg.tailnetBackgroundRetryMs > 0) {
      const t = setInterval(async () => {
        if (this.servers.has(host) || this.abort.signal.aborted) return;
        const s = this.makeHttpServer();
        try {
          await listenOnce(s, host, this._port);
          if (this.abort.signal.aborted) { s.close(); return; }
          this.servers.set(host, s);
          clearInterval(t);
          this.log.info(`listening on http://${host}:${this._port} (tailnet, background retry)`);
        } catch {
          s.close();
        }
      }, this.cfg.tailnetBackgroundRetryMs);
      t.unref();
      this.timers.push(t);
    }
  }

  /** Local snapshots only (synchronous). */
  backupNow(only?: string[]) {
    return snapshotAndAudit(this.cfg, this.log, this.audit, only, this.brains.brainsDir);
  }

  /** Local snapshots, then (if enabled) encrypted off-PC copies. Off-PC failures never fail the local backup. */
  async runBackup(only?: string[]): Promise<BackupRun> {
    const r = this.backupNow(only);
    const offsite = await this.offsite.processAll(r.ok);
    return { ...r, offsite };
  }

  runSleepNow(force = false): Promise<SleepReport> {
    return this.sleep.runCycle({ force });
  }

  async stop(): Promise<void> {
    this.abort.abort();
    for (const t of this.timers) clearInterval(t);
    for (const j of this.jobs) j.stop();
    await Promise.all([...this.servers.values()].map((s) => new Promise<void>((r) => {
      s.close(() => r());
      s.closeAllConnections?.();
    })));
    this.servers.clear();
    await this.tailnetSettled.catch(() => undefined);
    await this.brains.close();
  }
}
