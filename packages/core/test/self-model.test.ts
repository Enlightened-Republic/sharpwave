import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { getSelfModel, updateSelfModelField, formatSelfModelForContext } from "../src/self-model.js";
import { closeDb } from "../src/db.js";

function fresh(): string { return `test-${randomUUID().slice(0, 8)}`; }

describe("self-model", () => {
  it("getSelfModel returns singleton row", () => {
    const id = fresh();
    const model = getSelfModel(id);
    expect(model).toBeDefined();
    expect(model.id).toBe("singleton");
    closeDb(id);
  });

  it("updateSelfModelField updates identity field", () => {
    const id = fresh();
    updateSelfModelField(id, "identity", "I am a test agent");
    const model = getSelfModel(id);
    expect(model.identity).toBe("I am a test agent");
    closeDb(id);
  });

  it("updateSelfModelField updates goals field", () => {
    const id = fresh();
    updateSelfModelField(id, "goals", JSON.stringify(["goal one", "goal two"]));
    const model = getSelfModel(id);
    const parsed = JSON.parse(model.goals);
    expect(parsed).toContain("goal one");
    closeDb(id);
  });

  it("updateSelfModelField updates user_model field", () => {
    const id = fresh();
    updateSelfModelField(id, "user_model", JSON.stringify({ name: "Alice", role: "developer" }));
    const model = getSelfModel(id);
    const parsed = JSON.parse(model.user_model);
    expect(parsed.name).toBe("Alice");
    closeDb(id);
  });

  it("updateSelfModelField throws on invalid field — SQL injection guard", () => {
    const id = fresh();
    expect(() => {
      // This would inject SQL without the allowlist guard
      updateSelfModelField(id, "identity = 'hacked'; --" as never, "value");
    }).toThrow("Invalid self_model field");
    closeDb(id);
  });

  it("updateSelfModelField throws on arbitrary field name", () => {
    const id = fresh();
    expect(() => {
      updateSelfModelField(id, "updated_at" as never, "0");
    }).toThrow("Invalid self_model field");
    closeDb(id);
  });

  it("formatSelfModelForContext includes identity block", () => {
    const id = fresh();
    updateSelfModelField(id, "identity", "I am a test agent");
    const model = getSelfModel(id);
    const out = formatSelfModelForContext(model, 5000);
    expect(out).toContain("[BRAIN: self]");
    expect(out).toContain("I am a test agent");
    closeDb(id);
  });

  it("formatSelfModelForContext includes goals block", () => {
    const id = fresh();
    updateSelfModelField(id, "goals", JSON.stringify(["finish v3", "ship plugin"]));
    const model = getSelfModel(id);
    const out = formatSelfModelForContext(model, 5000);
    expect(out).toContain("[BRAIN: goals]");
    expect(out).toContain("finish v3");
    closeDb(id);
  });

  it("formatSelfModelForContext truncates to budget", () => {
    const id = fresh();
    updateSelfModelField(id, "identity", "A".repeat(1000));
    const model = getSelfModel(id);
    const out = formatSelfModelForContext(model, 100);
    expect(out.length).toBeLessThanOrEqual(120); // budget + truncation marker
    expect(out).toContain("[...truncated]");
    closeDb(id);
  });
});
