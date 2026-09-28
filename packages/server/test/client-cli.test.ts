// End-to-end: the dependency-free sharpwave-client against a live test server,
// run as a child process with plain `node` (as Chief of Staff would on Windows).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { startService } from "./helpers.js";

const run = promisify(execFile);
const CLIENT = fileURLToPath(new URL("../bin/sharpwave-client.mjs", import.meta.url));
const SERVER_CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

let h: Awaited<ReturnType<typeof startService>>;
let token: string;

async function client(args: string[], env: Record<string, string> = {}) {
  try {
    const r = await run(process.execPath, [CLIENT, ...args], { env: { ...process.env, SHARPWAVE_TOKEN: "", SHARPWAVE_TOKEN_FILE: "", ...env } });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, stdout: x.stdout, stderr: x.stderr };
  }
}

beforeAll(async () => {
  h = await startService();
  // Mint through the real admin CLI: prints the token once, stores only the hash.
  const r = await run(process.execPath, [SERVER_CLI, "token", "mint", "--agent", "chief-of-staff", "--scopes", "read,write", "--root", h.root, "--json"]);
  token = JSON.parse(r.stdout).token;
  expect(token).toMatch(/^swt_/);
});
afterAll(async () => { await h.stop(); });

describe("sharpwave-client", () => {
  it("write → search → read → stats round trip (token via --token)", async () => {
    const w = await client(["write", "Quarterly", "report", "is", "due", "on", "the", "fifth", "--label", "Report cadence", "--url", h.url, "--token", token, "--json"]);
    expect(w.code, w.stderr).toBe(0);
    const written = JSON.parse(w.stdout);
    expect(written).toMatchObject({ brain: "private", writer: "chief-of-staff", label: "Report cadence" });

    const s = await client(["search", "quarterly report", "--url", h.url, "--token", token]);
    expect(s.code, s.stderr).toBe(0);
    expect(s.stdout).toContain("[private] Report cadence");
    expect(s.stdout).toContain(written.id);

    const sj = await client(["search", "quarterly report", "--url", h.url, "--token", token, "--json"]);
    expect(JSON.parse(sj.stdout).results[0]).toMatchObject({ id: written.id, brain: "private", writer: "chief-of-staff" });

    const r = await client(["read", written.id, "--url", h.url, "--token", token]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Quarterly report is due on the fifth");

    const st = await client(["stats", "--url", h.url, "--token", token, "--json"]);
    const stats = JSON.parse(st.stdout);
    expect(stats.brains.find((b: { brain: string }) => b.brain === "private").nodes).toBe(1);
    expect(stats.brains.find((b: { brain: string }) => b.brain === "shared").nodes).toBe(0);
  });

  it("reads the token from SHARPWAVE_TOKEN and from a token file", async () => {
    const e = await client(["stats", "--url", h.url], { SHARPWAVE_TOKEN: token });
    expect(e.code, e.stderr).toBe(0);
    expect(e.stdout).toMatch(/\[private\] \d+ nodes/);
    const file = join(h.root, "cos.token");
    writeFileSync(file, token + "\r\n"); // CRLF, as Notepad would save it
    const f = await client(["stats", "--url", h.url, "--token-file", file]);
    expect(f.code, f.stderr).toBe(0);
  });

  it("exit 3 on a bad token, 1 on a forbidden shared write, 4 when the service is down", async () => {
    const bad = await client(["stats", "--url", h.url, "--token", "swt_wrong"]);
    expect(bad.code).toBe(3);
    expect(bad.stderr).toMatch(/401/);
    const sh = await client(["write", "x", "--label", "y", "--shared", "--url", h.url, "--token", token]);
    expect(sh.code).toBe(1);
    expect(sh.stderr).toMatch(/shared-write/);
    const down = await client(["stats", "--url", "http://127.0.0.1:9", "--token", token]);
    expect(down.code).toBe(4);
  });

  it("health needs no token", async () => {
    const r = await client(["health", "--url", h.url]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^ok\s+v\S+\s+127\.0\.0\.1:\d+/);
  });
});
