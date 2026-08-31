// Isolate every test's DB writes to a throwaway temp dir. sharpwave-core's
// db.ts honors SHARPWAVE_DATA_DIR directly. Each test still picks a unique
// agentId so their dbs never collide.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

const dir = join(tmpdir(), "openwave-test-" + randomUUID());
mkdirSync(dir, { recursive: true });
process.env["SHARPWAVE_DATA_DIR"] = dir;
process.env["OLLAMA_BASE_URL"] = "http://127.0.0.1:59999"; // dead port — no live embeds
delete process.env["OPENROUTER_API_KEY"];
delete process.env["SHARPWAVE_OPENROUTER_API_KEY"];
