import { describe, it, expect, vi, afterEach } from "vitest";
import { callOpenRouter } from "../src/llm.js";

// P1 (follow-up ticket, 2026-08-31 final review): DEFAULT_CONFIG.ingestionModel
// ships as `"openrouter/deepseek/deepseek-v4-flash"`, but the OpenRouter
// chat-completions API wants the BARE `deepseek/deepseek-v4-flash`. embeddings.ts
// already strips a leading `openrouter/` for the embed endpoint; callOpenRouter
// did not, so LLM fact-extraction + generative-REM consolidation 404'd and fell
// back to keyword heuristics whenever the prefixed default was used.

function okResponse(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 });
}

describe("callOpenRouter — model id normalization", () => {
  afterEach(() => vi.restoreAllMocks());

  it("strips a leading openrouter/ prefix before hitting the OpenRouter API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());

    await callOpenRouter("prompt", "openrouter/deepseek/deepseek-v4-flash", "key-123");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("deepseek/deepseek-v4-flash");
  });

  it("passes a bare provider/model id through unchanged", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse());

    await callOpenRouter("prompt", "deepseek/deepseek-v4-flash", "key-123");

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("deepseek/deepseek-v4-flash");
  });
});
