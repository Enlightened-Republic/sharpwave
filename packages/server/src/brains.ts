// packages/server/src/brains.ts
//
// BrainManager — the one owner of every brain this process serves.
//
//   <root>/brains/shared/brain.db        the shared brain (created EMPTY)
//   <root>/brains/<agentId>/brain.db     one private brain per agent
//
// Connections, per brain:
//   • ONE write connection — sharpwave-core's cached `getDb(brain)` connection.
//     Every mutation (writes, links, supersede, review, forget, reset, recall
//     reinforcement, consolidation) runs through that brain's SerialQueue, so
//     mutations are strictly serialized in-process and never contend for the
//     SQLite write lock with each other.
//   • N read-only WAL connections (`readonly`, `query_only`) used by the pure
//     read tools (expand, edges, history, stats) and by backups. WAL readers
//     never block the writer and never wait on it.
//
// sharpwave-core resolves brain paths from SHARPWAVE_DATA_DIR, which is
// process-global — so only ONE BrainManager may be open per process.

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getDb, closeDb, clearStaleWorkingMemory, resolveBusyTimeoutMs } from "sharpwave-core";

import { validateAgentId } from "./tokens.js";

export const SHARED_BRAIN = "shared";

/** Promise-chain mutex: tasks run one at a time, in submission order. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private _pending = 0;

  get pending(): number {
    return this._pending;
  }

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    this._pending++;
    const next = this.tail.then(() => fn());
    // Keep the chain alive regardless of this task's outcome.
    this.tail = next.then(
      () => { this._pending--; },
      () => { this._pending--; },
    );
    return next;
  }

  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}

let activeManager: BrainManager | null = null;

export class BrainManager {
  private readonly queues = new Map<string, SerialQueue>();
  private readonly readers = new Map<string, { conns: Database.Database[]; next: number }>();
  private readonly opened = new Set<string>();
  private closed = false;

  constructor(
    readonly brainsDir: string,
    private readonly readConnections = 2,
  ) {}

  /** Point core at our brains dir and create the (empty) shared brain. */
  init(): void {
    if (activeManager && activeManager !== this) {
      throw new Error("another BrainManager is already open in this process (core's data dir is process-global)");
    }
    activeManager = this;
    mkdirSync(this.brainsDir, { recursive: true });
    // An explicit single-db override would route EVERY brain to one file.
    delete process.env["SHARPWAVE_DB_PATH"];
    process.env["SHARPWAVE_DATA_DIR"] = this.brainsDir;
    this.open(SHARED_BRAIN);
  }

  dbPath(brain: string): string {
    return join(this.brainsDir, brain, "brain.db");
  }

  /** Brain name for an agent's private brain (validated). */
  privateBrain(agentId: string): string {
    const bad = validateAgentId(agentId);
    if (bad) throw new Error(bad);
    return agentId;
  }

  /** Open (creating + migrating if needed) the brain's write connection. */
  open(brain: string): void {
    if (this.closed) throw new Error("brain manager is closed");
    if (this.opened.has(brain)) return;
    if (brain !== SHARED_BRAIN) this.privateBrain(brain);
    getDb(brain);
    this.opened.add(brain);
    // Working-memory rows from a previous process belong to dead sessions.
    try { clearStaleWorkingMemory(brain); } catch { /* never block */ }
  }

  isOpen(brain: string): boolean {
    return this.opened.has(brain);
  }

  openBrains(): string[] {
    return [...this.opened];
  }

  /** Every brain on disk (shared first), whether or not opened yet. */
  listBrains(): string[] {
    const out = new Set<string>([SHARED_BRAIN]);
    if (existsSync(this.brainsDir)) {
      for (const e of readdirSync(this.brainsDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (e.name !== SHARED_BRAIN && validateAgentId(e.name) !== null) continue;
        if (existsSync(join(this.brainsDir, e.name, "brain.db"))) out.add(e.name);
      }
    }
    return [...out];
  }

  queue(brain: string): SerialQueue {
    let q = this.queues.get(brain);
    if (!q) {
      q = new SerialQueue();
      this.queues.set(brain, q);
    }
    return q;
  }

  /** Run a mutation on the brain's single write connection, serialized. */
  write<T>(brain: string, fn: () => T | Promise<T>): Promise<T> {
    this.open(brain);
    return this.queue(brain).run(fn);
  }

  /** Run a read on one of the brain's read-only WAL connections. */
  read<T>(brain: string, fn: (db: Database.Database) => T): T {
    this.open(brain); // guarantees the file + schema exist before a readonly open
    let pool = this.readers.get(brain);
    if (!pool) {
      pool = { conns: [], next: 0 };
      this.readers.set(brain, pool);
    }
    const n = Math.max(1, this.readConnections);
    if (pool.conns.length < n) {
      pool.conns.push(openReadConnection(this.dbPath(brain)));
    }
    const db = pool.conns[pool.next % pool.conns.length]!;
    pool.next++;
    return fn(db);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.queues.values()].map((q) => q.idle().catch(() => undefined)));
    for (const { conns } of this.readers.values()) for (const c of conns) { try { c.close(); } catch { /* */ } }
    this.readers.clear();
    for (const b of this.opened) { try { closeDb(b); } catch { /* */ } }
    this.opened.clear();
    if (activeManager === this) activeManager = null;
  }
}

export function openReadConnection(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: resolveBusyTimeoutMs() });
  db.pragma("query_only = ON");
  return db;
}
