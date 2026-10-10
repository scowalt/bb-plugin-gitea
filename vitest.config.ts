import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    name: "bb-plugin-gitea",
    include: ["**/*.test.ts", "app-controls.test.tsx", "app-execution.test.tsx", "app-history.test.tsx", "app-environment-picker.test.tsx", "app-issue-filter.test.tsx"],
    exclude: ["node_modules/**"],
  },
});
