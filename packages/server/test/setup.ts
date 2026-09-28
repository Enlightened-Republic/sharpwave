// Keep tests hermetic: no live embedding provider, no LLM key.
process.env["OLLAMA_BASE_URL"] = "http://127.0.0.1:59999"; // dead port — no live embeds
delete process.env["OPENROUTER_API_KEY"];
delete process.env["SHARPWAVE_OPENROUTER_API_KEY"];
delete process.env["SHARPWAVE_DB_PATH"];
process.env["SHARPWAVE_NO_UPDATE_CHECK"] = "1";
