// Owner-only identity policy over the service (default identity.changesFrom = ["owner_turn"]):
// an own-turn proposal is held, shows in brain_status, and an admin accept applies it.
// Own file: core's data dir is process-global, so one BrainService per vitest worker.
import { describe, expect, it } from "vitest";
import { startService, tool } from "./helpers.js";

describe("identity: owner-only by default on the service", () => {
  it("holds an own-turn proposal, applies an owner-turn change, and the admin accept applies the held one", async () => {
    const h = await startService({ sleep: { enabled: false }, backup: { enabled: false } });
    try {
      const a = h.mint("a");
      // brain_review accept works on the caller's own brain: the owner accepts with an admin
      // token minted for that agent (or `xanima-server soul review accept --agent a` with the service stopped).
      const admin = h.mint("a", ["read", "write", "admin"]);
      const held = await tool(h.url, a, "brain_identity", { action: "add", field: "Vibe", value: "terse", reason: "I think I ramble", attested_provenance: { origin: "agent_turn", via: "openclaw" } });
      expect(held.isError).toBe(false);
      expect(held.text).toMatch(/^Held for your owner's review \(rv-i/);
      let tc = JSON.parse((await tool(h.url, a, "brain_turn_context", { query: "hi" })).text);
      expect(tc.identity ?? "").not.toMatch(/terse/);
      expect((await tool(h.url, a, "brain_status", { visibility: "private" })).text).toMatch(/1 identity change held for review/);

      expect((await tool(h.url, a, "brain_identity", { action: "add", field: "Emoji", value: "🧭", reason: "Hailey picked it", attested_provenance: { origin: "owner_turn", via: "openclaw" } })).text).toMatch(/Identity updated \(v1\)/);

      const list = (await tool(h.url, a, "brain_review", { action: "list", kind: "identity_change" })).text;
      expect(list).toMatch(/^1 review item\(s\) \(pending\):/);
      const reviewId = /(rv-i[0-9a-f]+) \[pending\] identity_change \(identity\) add Vibe/.exec(list)?.[1];
      expect(reviewId).toBeTruthy();
      const agentAccept = await tool(h.url, a, "brain_review", { action: "accept", id: reviewId });
      expect(agentAccept.isError).toBe(true); // needs admin
      const acc = await tool(h.url, admin, "brain_review", { action: "accept", id: reviewId });
      expect(acc.isError).toBe(false);
      tc = JSON.parse((await tool(h.url, a, "brain_turn_context", { query: "hi" })).text);
      expect(tc.identity).toMatch(/Vibe:\*\* terse/);
    } finally { await h.stop(); }
  });
});
