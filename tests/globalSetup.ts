import { execSync } from "node:child_process";

// Bring the test database up to date with the migrations, exactly as an install would.
export default function setup() {
  const url = process.env.TEST_DATABASE_URL!; // set by vitest.config.ts
  if (!new URL(url).pathname.endsWith("_test")) throw new Error("Tests only run against a database whose name ends in _test.");
  execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: url } });
}
