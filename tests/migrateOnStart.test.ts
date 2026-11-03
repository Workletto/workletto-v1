import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain JavaScript script, run by `npm start` before the server.
import { isUnreachable } from "../scripts/migrate.mjs";

// On a first deploy, Render can start the app before its new database accepts connections.
// The start waits for the database on that error only; any other failure stops it.
describe("migrations when the app starts", () => {
  it("tries again while the database can't be reached", () => {
    expect(isUnreachable("Error: P1001: Can't reach database server at `dpg-abc-a:5432`")).toBe(true);
    expect(isUnreachable("Error: P1002: The database server at `db:5432` was reached but timed out.")).toBe(true);
  });

  it("stops on any other failure", () => {
    expect(isUnreachable("Error: P3009: migrate found failed migrations in the target database")).toBe(false);
    expect(isUnreachable("Error: P3018: A migration failed to apply.")).toBe(false);
    expect(isUnreachable("Error: P1000: Authentication failed against database server")).toBe(false);
  });

  it("ships the script in the Docker image", () => {
    expect(readFileSync("Dockerfile", "utf8")).toMatch(/^COPY --from=build \/app\/scripts\/migrate\.mjs \.\/scripts\/migrate\.mjs$/m);
  });
});
