import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["**/tests/**/*.test.ts"],
    alias: {
      "cloudflare:workers": new URL(
        "./shared/test-workers.ts",
        import.meta.url,
      ).pathname.replace(/^\/(\w:)/, "$1"),
    },
  },
});
