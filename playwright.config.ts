import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { defineConfig, devices } from "@playwright/test";
import { ADMIN_STATE, SETUP_CODE } from "./tests/e2e/helpers.ts";

// End-to-end tests: a real browser against the built app (dist/) and a throwaway
// Postgres database. They are separate from the Vitest tests in tests/*.test.ts.
//
//   npm run build        (once, and after every change to src/)
//   npm run test:e2e
//
// The database must already exist, empty or not: it is wiped and migrated before the
// server starts. Its name has to end in _test. Set E2E_DATABASE_URL to use another.
// Tests use the Google Chrome installed on this computer; no browser is downloaded.

const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgresql://work:work@localhost:5432/work_e2e_test";
if (!new URL(DATABASE_URL).pathname.endsWith("_test")) {
  throw new Error("E2E_DATABASE_URL must name a database that ends in _test: it is emptied before every run.");
}
if (!existsSync("dist/server.js") || !existsSync("dist/client/index.html")) {
  throw new Error("Build the app first: npm run build");
}

/** Asks the system for a port nobody is using. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

// Chosen once, in the process that starts the run. Test workers inherit it.
process.env.E2E_PORT ??= String(await freePort());
process.env.E2E_AUTH_SECRET ??= randomBytes(32).toString("hex");
const port = Number(process.env.E2E_PORT);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  // One server, one database and one organization: tests run one after another.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // First-run setup creates the admin account (once per database) and saves its sign-in.
    {
      name: "setup",
      testMatch: "setup.spec.ts",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
    // Everything else starts signed in as that admin and makes its own clients and projects.
    {
      name: "app",
      testIgnore: "setup.spec.ts",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], channel: "chrome", storageState: ADMIN_STATE },
    },
  ],
  webServer: {
    // Empties the database and applies the migrations, then starts the built server.
    command: "node tests/e2e/prepare-database.mjs && node dist/server.js",
    url: `${baseURL}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      NODE_ENV: "production",
      PORT: String(port),
      DATABASE_URL,
      BETTER_AUTH_SECRET: process.env.E2E_AUTH_SECRET,
      BETTER_AUTH_URL: baseURL,
      SETUP_CODE,
      CHECKPOINT_DISABLE: "1",
      // Switched off, whatever the shell says, so the run is the same everywhere.
      DEMO_MODE: "",
      RENDER_EXTERNAL_URL: "",
      RAILWAY_PUBLIC_DOMAIN: "",
    },
  },
});
