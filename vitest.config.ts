import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { configDefaults, defineConfig } from "vitest/config";

// Tests use the database next to your development one, with a name ending in _test
// (work_dev → work_test). Set TEST_DATABASE_URL to choose another.
function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const dev = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")).DATABASE_URL : undefined;
  const url = new URL(dev ?? "postgresql://work:work@localhost:5432/work_dev");
  url.pathname = `/${url.pathname.slice(1).replace(/_dev$/, "")}_test`;
  return url.toString();
}

const TEST_DATABASE_URL = testDatabaseUrl();
process.env.TEST_DATABASE_URL = TEST_DATABASE_URL; // for tests/globalSetup.ts

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The browser tests in tests/e2e are run by Playwright (npm run test:e2e), not Vitest.
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
    globalSetup: ["tests/globalSetup.ts"],
    // One shared test database, so test files run one at a time.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: TEST_DATABASE_URL,
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
      BETTER_AUTH_URL: "http://localhost:3000",
      SETUP_CODE: "test-setup-code-0123456789",
      // Tests send the visitor's address in X-Forwarded-For, like a host's proxy would.
      TRUST_PROXY: "1",
    },
  },
});
