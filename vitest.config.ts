// Two test projects:
//  - "node": the shipped rating and analysis tests, the frozen-file hash check, and the end-to-end export test
//    (which drives the bundled Worker in Miniflare and runs analyze() on its export).
//  - "worker": route tests inside workerd against a local D1 with the migrations applied.
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Pinned so a developer's local .dev.vars (which the plugin also reads) cannot change what the tests see.
export const TEST_BINDINGS = {
  PROD_HOST: "wtpquestionrank.spiffyspaceman.com",
  ADMIN_SECRET: "",
  CODE_PEPPER: "test-pepper-not-a-secret",
  TURNSTILE_SECRET: "test-turnstile-secret",
  TURNSTILE_SITEKEY: "test-sitekey",
  ACCESS_TEAM_DOMAIN: "testteam.cloudflareaccess.com",
  ACCESS_AUD: "test-aud-tag",
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/rating/**/*.test.ts", "analysis/**/*.test.ts", "test/node/**/*.test.ts"],
          testTimeout: 120_000,
        },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: { ...TEST_BINDINGS, TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")) },
            },
          })),
        ],
        test: {
          name: "worker",
          include: ["test/worker/**/*.test.ts"],
          setupFiles: ["./test/worker/apply-migrations.ts"],
          testTimeout: 60_000,
        },
      },
    ],
  },
});
