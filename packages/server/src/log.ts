// packages/server/src/log.ts — tiny leveled logger (stderr or append-only file).
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(file?: string, quiet = false): Logger {
  if (file) mkdirSync(dirname(file), { recursive: true });
  const emit = (level: string, msg: string) => {
    const line = `${new Date().toISOString()} [sharpwave-server] ${level} ${msg}\n`;
    if (file) {
      try { appendFileSync(file, line); } catch { process.stderr.write(line); }
    } else if (!quiet || level !== "info") {
      process.stderr.write(line);
    }
  };
  return {
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
  };
}

/** Collects lines in memory — used by tests to assert on warnings. */
export function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => { lines.push(`info ${m}`); },
    warn: (m) => { lines.push(`warn ${m}`); },
    error: (m) => { lines.push(`error ${m}`); },
  };
}
