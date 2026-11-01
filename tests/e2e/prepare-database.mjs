// Run by playwright.config.ts before the server starts: empties the end-to-end
// database and applies the migrations, exactly as an install would.
import { execFileSync } from "node:child_process";

const url = process.env.DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) {
  console.error("End-to-end tests only run against a database whose name ends in _test.");
  process.exit(1);
}

const prisma = (args, input) =>
  execFileSync("npx", ["prisma", ...args], { env: process.env, input, stdio: [input ? "pipe" : "ignore", "inherit", "inherit"] });

prisma(["db", "execute", "--stdin"], "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
prisma(["migrate", "deploy"]);
