import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Two projects, not one pool: the pure cleaning-function tests read fixtures off
// disk with node:fs, which the Workers runtime does not provide. Only the
// ingest tests need a simulated D1 binding, so only they pay for the Workers pool.
export default defineConfig(async () => {
  const migrationsPath = path.join(import.meta.dirname, "..", "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    test: {
      projects: [
        {
          test: {
            name: "unit",
            include: ["test/**/*.test.ts"],
          },
        },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: { TEST_MIGRATIONS: migrations },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["test-worker/**/*.test.ts"],
            setupFiles: ["./test-worker/apply-migrations.ts"],
          },
        },
      ],
    },
  };
});
