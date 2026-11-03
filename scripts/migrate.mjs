// Applies the database migrations when the app starts (`npm start`), before the server runs.
//
// A host can start the app before a new database accepts connections: Render does on a first
// deploy, when it creates the database and the app together. Prisma then fails with P1001
// ("Can't reach database server") and the app would stop. This tries again on that error, and
// only that error, for up to 10 minutes. Any other failure, such as a migration that fails,
// stops the start straight away, as before.
//
//   node scripts/migrate.mjs
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const WAIT_MS = 10 * 60_000;
const RETRY_MS = 5_000;

/** Prisma's errors for a database it can't connect to yet: P1001 can't reach it, P1002 timed out. */
export const isUnreachable = (output) => /\bP100[12]\b/.test(output);

const prisma = fileURLToPath(new URL("../node_modules/.bin/prisma", import.meta.url));

function migrate() {
  // CHECKPOINT_DISABLE turns off the Prisma CLI's update check, so starting never contacts anyone.
  const run = spawnSync(prisma, ["migrate", "deploy"], {
    encoding: "utf8",
    env: { ...process.env, CHECKPOINT_DISABLE: "1" },
  });
  process.stdout.write(run.stdout ?? "");
  process.stderr.write(run.stderr ?? "");
  if (run.error) throw run.error;
  return { status: run.status ?? 1, output: `${run.stdout}${run.stderr}` };
}

async function main() {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const { status, output } = migrate();
    if (status === 0) return;
    if (!isUnreachable(output) || Date.now() + RETRY_MS > deadline) process.exit(status);
    console.log(`The database isn't accepting connections yet. Trying again in ${RETRY_MS / 1000} seconds.`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
