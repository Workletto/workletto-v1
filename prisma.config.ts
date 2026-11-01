import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Local development keeps settings in .env; hosts set real environment variables.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // `prisma generate` runs during the Docker build, before any database exists.
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
