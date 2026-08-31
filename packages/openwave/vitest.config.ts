import { defineConfig } from "vitest/config";

// Standalone config (controller Ruling 1) — openwave is NOT a `projects` entry
// of a root vitest config. `npm run test --workspace openwave` runs this.
export default defineConfig({
  test: {
    setupFiles: ["test/setup.ts"],
    include: ["test/**/*.test.ts"],
  },
});
