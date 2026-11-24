import { applyD1Migrations, env } from "cloudflare:test";

// Storage is isolated per test file; apply the migrations to each file's fresh local D1.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
