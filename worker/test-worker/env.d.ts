/// <reference types="@cloudflare/vitest-plugin/types" />

// Test-only binding set via vitest.config.ts's miniflare.bindings, not a real
// wrangler.jsonc binding - merged onto the generated Env here rather than there.
interface Env {
  TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
}

declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
