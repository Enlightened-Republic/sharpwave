// packages/core/src/llm.ts
//
// Shared OpenRouter chat-completion call for the engine.
//
// Extracted verbatim from consolidation.ts's private `callRemLlm` (openwave /
// sharpwave-core split, Task 6d) so that consolidation's generative-REM /
// contradiction path and extraction.ts share ONE OpenRouter fetch site — no
// drift between the two. Body, headers, and error shape are unchanged from the
// original `callRemLlm`. Two optional trailing args let extraction preserve its
// clawbrain behaviour without touching consolidation's serialized request:
//   - `maxTokens` (default 600 — the original hard-coded value); extraction
//     passes 1500.
//   - `temperature` — omitted entirely from the body when undefined (so
//     consolidation's 3-arg calls serialize byte-identically); extraction
//     passes 0.1 for near-deterministic clean-JSON output, matching
//     clawbrain-v4/src/extraction.ts:166.

// Direct LLM call via OpenRouter — used when no subagentRunner is injected
// (i.e., in the standalone MCP server, where no host subagent API exists).
// Falls back gracefully if the API key is missing (caller degrades to its
// heuristic path on the thrown error / empty string).
export async function callOpenRouter(
  message: string,
  model: string,
  apiKey: string,
  maxTokens = 600,
  temperature?: number,
): Promise<string> {
  // OpenRouter's chat-completions API wants the bare `provider/model` id. Config
  // defaults (and operator overrides) may carry a leading `openrouter/` — strip
  // it here so `openrouter/deepseek/deepseek-v4-flash` and `deepseek/deepseek-v4-flash`
  // both resolve. Mirrors the same strip in embeddings.ts:fetchEmbedding.
  const openRouterModel = model.startsWith("openrouter/")
    ? model.slice("openrouter/".length)
    : model;

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: openRouterModel,
      messages: [{ role: "user", content: message }],
      max_tokens: maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
    }),
  });
  if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}`);
  const json = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? "";
}
