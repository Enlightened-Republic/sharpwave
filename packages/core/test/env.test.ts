/**
 * Xanima 0.1.x env + data-dir compatibility: XANIMA_* first, SHARPWAVE_*
 * honoured with a one-time deprecation warning, ~/.xanima default with a
 * ~/.sharpwave fallback for un-migrated installs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  envGet, envSet, envDelete, envSnapshot, envRestore, resolveDataDir, defaultDataHome,
  setDeprecationWarningSink, resetDeprecationWarnings,
} from "../src/env.js";

let warnings: string[] = [];
beforeEach(() => {
  warnings = [];
  resetDeprecationWarnings();
  setDeprecationWarningSink((m) => warnings.push(m));
});
afterEach(() => setDeprecationWarningSink((m) => process.stderr.write(m + "\n")));

describe("envGet", () => {
  it("prefers XANIMA_*, falls back to SHARPWAVE_* with one warning per name", () => {
    const env = { XANIMA_A: "new", SHARPWAVE_A: "old", SHARPWAVE_B: "legacy" } as NodeJS.ProcessEnv;
    expect(envGet("A", env)).toBe("new");
    expect(warnings).toEqual([]);
    expect(envGet("B", env)).toBe("legacy");
    expect(envGet("B", env)).toBe("legacy");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/SHARPWAVE_B is deprecated; set XANIMA_B/);
    expect(envGet("C", env)).toBeUndefined();
  });

  it("an empty XANIMA_ value does not hide a set SHARPWAVE_ value", () => {
    expect(envGet("D", { XANIMA_D: "", SHARPWAVE_D: "x" } as NodeJS.ProcessEnv)).toBe("x");
  });

  it("envSet/envDelete/snapshot/restore keep both names in sync", () => {
    const env = { SHARPWAVE_E: "orig" } as NodeJS.ProcessEnv;
    const snap = envSnapshot("E", env);
    envSet("E", "v", env);
    expect(env).toMatchObject({ XANIMA_E: "v", SHARPWAVE_E: "v" });
    envDelete("E", env);
    expect(env["XANIMA_E"]).toBeUndefined();
    envRestore("E", snap, env);
    expect(env).toEqual({ SHARPWAVE_E: "orig" });
  });
});

describe("data dir", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "xa-home-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("defaults to ~/.xanima on a fresh machine", () => {
    expect(defaultDataHome({ XANIMA_HOME_OVERRIDE: home } as NodeJS.ProcessEnv)).toBe(join(home, ".xanima"));
    expect(warnings).toEqual([]);
  });

  it("uses ~/.sharpwave (with a warning) when only the old folder exists", () => {
    mkdirSync(join(home, ".sharpwave"));
    expect(defaultDataHome({ XANIMA_HOME_OVERRIDE: home } as NodeJS.ProcessEnv)).toBe(join(home, ".sharpwave"));
    expect(warnings.join()).toMatch(/xanima-server migrate/);
  });

  it("prefers ~/.xanima once it exists", () => {
    mkdirSync(join(home, ".sharpwave"));
    mkdirSync(join(home, ".xanima"));
    expect(defaultDataHome({ XANIMA_HOME_OVERRIDE: home } as NodeJS.ProcessEnv)).toBe(join(home, ".xanima"));
  });

  it("XANIMA_DATA_DIR beats SHARPWAVE_DATA_DIR beats the default", () => {
    const base = { XANIMA_HOME_OVERRIDE: home } as NodeJS.ProcessEnv;
    expect(resolveDataDir({ ...base, XANIMA_DATA_DIR: "/a", SHARPWAVE_DATA_DIR: "/b" })).toBe("/a");
    expect(resolveDataDir({ ...base, SHARPWAVE_DATA_DIR: "/b" })).toBe("/b");
    expect(resolveDataDir(base)).toBe(join(home, ".xanima"));
  });
});
