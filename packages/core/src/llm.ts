// packages/core/src/llm.ts
//
// Shared OpenRouter chat-completion call for the engine.
//
// Extracted verbatim from consolidation.ts's private `callRemLlm` (openwave /
// sharpwave-core split, Task 6d) so that consolidation's generative-REM /
// contradiction path and extraction.ts share ONE OpenRouter fetch site — no
// drift between the two. Body, headers, and error shape are unchanged from the
// original `callRemLlm`; the only addition is an optional `maxTokens` argument
// (default 600 — the original hard-coded value) so extraction can keep its
// larger 1500-token budget without changing consolidation's behaviour.

// Direct LLM call via OpenRouter — used when no subagentRunner is injected
// (i.e., in the standalone MCP server, where no host subagent API exists).
// Falls back gracefully if the API key is missing (caller degrades to its
// heuristic path on the thrown error / empty string).
export async function callOpenRouter(
  message: string,
  model: string,
  apiKey: string,
  maxTokens = 600,
): Promise<string> {
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: message }],
      max_tokens: maxTokens,
    }),
  });
  if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}`);
  const json = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? "";
}
