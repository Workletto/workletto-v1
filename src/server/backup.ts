import { createGunzip, createGzip, type Gzip } from "node:zlib";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Hono } from "hono";
import { symmetricDecrypt } from "better-auth/crypto";
import type { Prisma } from "../generated/prisma/client.ts";
import { prisma } from "./db.ts";
import { env } from "./env.ts";
import { requireAdmin, type SignedIn } from "./http.ts";
import { recordAudit } from "./audit.ts";
import { describeError } from "./logging.ts";

// Backups: one file with everything an organization has, to restore into a
// brand-new install (src/server/setup.ts). The file is gzipped JSON lines: a
// header, then one line per row, table by table, parents before children, so a
// restore can insert rows as it reads them and never holds the whole file in
// memory. Dates and binary data (the logo, receipts) are tagged, so any column
// round-trips without a list of types here. A backup is read from one snapshot of
// the database, so rows saved while it downloads can't leave it inconsistent.
//
// What isn't in it: sessions (everyone signs in again), password-reset links and
// sign-in verifications (short-lived). Passwords are only in it as the scrambled
// hashes the app keeps, which is why each download is recorded in the history. The
// email password and the Stripe key are in it encrypted with this install's
// BETTER_AUTH_SECRET: a new install with the same secret can use them; with
// another secret, an admin enters them again.

export const BACKUP_FORMAT = "time-tracking-backup";
export const BACKUP_VERSION = 1;

// Parents before children. `where` picks one organization's rows; `key` is a row's place in
// `order`, to read the next page from; `page` is smaller for tables with large rows (files);
// `omit` are columns left out of the file.
type Table = {
  name: string; model: string; where: (organizationId: string) => Record<string, unknown>; order: Record<string, "asc">[];
  key?: (row: Record<string, unknown>) => Record<string, unknown>; page?: number; omit?: Record<string, null>;
};
const byOrg = (organizationId: string) => ({ organizationId });
const ID = [{ id: "asc" as const }];
export const TABLES: Table[] = [
  { name: "organization", model: "organization", where: (id) => ({ id }), order: ID },
  { name: "logo", model: "logo", where: byOrg, order: ID, page: 10 },
  { name: "emailSettings", model: "emailSettings", where: byOrg, order: ID },
  { name: "paymentSettings", model: "paymentSettings", where: byOrg, order: ID },
  { name: "ssoSettings", model: "ssoSettings", where: byOrg, order: ID },
  { name: "holiday", model: "holiday", where: byOrg, order: ID },
  { name: "user", model: "user", where: byOrg, order: ID },
  { name: "account", model: "account", where: (organizationId) => ({ user: { organizationId } }), order: ID, omit: { accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null } },
  { name: "calendarSettings", model: "calendarSettings", where: byOrg, order: ID },
  // Two-factor sign-in (WRK-147): the secret encrypted with BETTER_AUTH_SECRET, the backup codes hashed with it.
  { name: "twoFactor", model: "twoFactor", where: (organizationId) => ({ user: { organizationId } }), order: ID },
  { name: "invite", model: "invite", where: byOrg, order: ID },
  { name: "userGroup", model: "userGroup", where: byOrg, order: ID },
  { name: "userGroupMember", model: "userGroupMember", where: byOrg, order: [{ groupId: "asc" }, { userId: "asc" }], key: (r) => ({ groupId_userId: { groupId: r.groupId, userId: r.userId } }) },
  { name: "customField", model: "customField", where: byOrg, order: ID },
  { name: "client", model: "client", where: byOrg, order: ID },
  { name: "project", model: "project", where: byOrg, order: ID },
  { name: "projectMember", model: "projectMember", where: byOrg, order: [{ projectId: "asc" }, { userId: "asc" }], key: (r) => ({ projectId_userId: { projectId: r.projectId, userId: r.userId } }) },
  { name: "commonTask", model: "commonTask", where: byOrg, order: ID },
  { name: "projectTemplate", model: "projectTemplate", where: byOrg, order: ID },
  { name: "task", model: "task", where: byOrg, order: ID },
  { name: "invoice", model: "invoice", where: byOrg, order: ID },
  { name: "invoiceLine", model: "invoiceLine", where: byOrg, order: ID },
  { name: "invoiceSchedule", model: "invoiceSchedule", where: byOrg, order: ID },
  { name: "payment", model: "payment", where: byOrg, order: ID },
  { name: "timeEntry", model: "timeEntry", where: byOrg, order: ID },
  { name: "customFieldValue", model: "customFieldValue", where: byOrg, order: ID },
  { name: "expense", model: "expense", where: byOrg, order: ID },
  { name: "receipt", model: "receipt", where: byOrg, order: ID, page: 10 }, // up to 5 MB each
  { name: "timesheetWeek", model: "timesheetWeek", where: byOrg, order: ID },
  { name: "timeOff", model: "timeOff", where: byOrg, order: ID },
  { name: "scheduledWork", model: "scheduledWork", where: byOrg, order: ID },
  { name: "auditEvent", model: "auditEvent", where: byOrg, order: ID },
];
const TABLE_NAMES = new Set(TABLES.map((t) => t.name));

const PAGE = 500;
/** Rows wait for a restore's next insert until there are this many bytes of them. */
const BATCH_BYTES = 16 * 1024 * 1024;
/** The longest line a backup has: a 5 MB receipt is about 7 MB written out. */
const MAX_LINE = 16 * 1024 * 1024;
/** Far beyond any real backup once unzipped; a file that unzips to more is refused. */
const MAX_UNZIPPED = 64 * 1024 ** 3;
type Delegate = {
  findMany: (args: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  createMany: (args: { data: Record<string, unknown>[] }) => Promise<unknown>;
};
const delegate = (client: unknown, model: string) => (client as Record<string, Delegate>)[model]!;

/** Dates and bytes as tagged objects, so they survive JSON. */
function encode(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? { $date: v.toISOString() } : v instanceof Uint8Array ? { $bytes: Buffer.from(v).toString("base64") } : v;
  }
  return out;
}
function decode(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const tagged = v as { $date?: unknown; $bytes?: unknown };
      if (typeof tagged.$date === "string") {
        out[k] = new Date(tagged.$date);
        continue;
      }
      if (typeof tagged.$bytes === "string") {
        out[k] = Buffer.from(tagged.$bytes, "base64");
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}

/** The one migration 1.0.0 starts from, and the newest of the migrations it replaced. */
const BASELINE = "00000000000000_baseline";
const LAST_BEFORE_BASELINE = "20261031120000_donation_prompt";

/** The newest migration this database has, which says which version of the app made a backup. */
export async function latestMigration(): Promise<string> {
  const rows = await prisma.$queryRaw<{ migration_name: string }[]>`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1`;
  return rows[0]?.migration_name ?? "";
}

/** The backup as lines of JSON, one at a time, read with `db` (a transaction). */
async function* lines(db: unknown, organizationId: string) {
  yield JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, migration: await latestMigration(), createdAt: new Date().toISOString() });
  for (const table of TABLES) {
    const model = delegate(db, table.model);
    const take = table.page ?? PAGE;
    let cursor: Record<string, unknown> | undefined;
    for (;;) {
      const rows = await model.findMany({ where: table.where(organizationId), orderBy: table.order, take, ...(cursor ? { cursor, skip: 1 } : {}) });
      for (const row of rows) yield JSON.stringify({ t: table.name, r: encode({ ...row, ...table.omit }) });
      if (rows.length < take) break;
      const last = rows[rows.length - 1]!;
      cursor = table.key ? table.key(last) : { id: last.id };
    }
  }
}

class Cancelled extends Error {}

/** Waits until the gzip stream wants more, or the download was cancelled. */
const drained = (gzip: Gzip) =>
  new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => {
      gzip.off("drain", onDrain).off("close", onClose).off("error", done);
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => done();
    const onClose = () => done(new Cancelled());
    gzip.on("drain", onDrain).on("close", onClose).on("error", done);
  });

/**
 * A gzipped backup of one organization, as a stream to send. It's read inside one
 * repeatable-read transaction (a snapshot), and reading stops if the download is cancelled.
 */
export function backupStream(organizationId: string) {
  const gzip = createGzip();
  prisma
    .$transaction(
      async (tx) => {
        for await (const line of lines(tx, organizationId)) {
          if (gzip.destroyed) throw new Cancelled();
          if (!gzip.write(`${line}\n`)) await drained(gzip);
        }
      },
      { isolationLevel: "RepeatableRead", timeout: 60 * 60 * 1000, maxWait: 10_000 },
    )
    .then(
      () => gzip.end(),
      (error) => {
        if (gzip.destroyed) return; // cancelled
        console.error("Making a backup failed", describeError(error));
        gzip.destroy(error as Error);
      },
    );
  return Readable.toWeb(gzip) as unknown as ReadableStream;
}

/** Lines of the unzipped file, refusing a line or a whole longer than any backup has. */
async function* splitLines(input: AsyncIterable<Buffer>) {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let total = 0;
  for await (const chunk of input) {
    total += chunk.length;
    if (total > MAX_UNZIPPED) throw new BadBackup("This file is far larger than a backup from this app.");
    let start = 0;
    for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
      pending.push(chunk.subarray(start, end));
      yield Buffer.concat(pending).toString("utf8");
      pending = [];
      pendingBytes = 0;
      start = end + 1;
    }
    if (start < chunk.length) {
      pending.push(chunk.subarray(start));
      pendingBytes += chunk.length - start;
      if (pendingBytes > MAX_LINE) throw new BadBackup("This backup has a line this app doesn't recognise.");
    }
  }
  if (pendingBytes) yield Buffer.concat(pending).toString("utf8");
}

export class BadBackup extends Error {}
export class AlreadyInstalled extends Error {}

/**
 * Restores a backup into an empty database, in one transaction: all or nothing.
 * Returns the restored organization's id. The caller checks nothing is installed yet.
 */
/**
 * Two-factor secrets only work with the BETTER_AUTH_SECRET they were made with. Restored into an
 * install with another secret, they're removed and two-factor is turned off for those people, so
 * they can sign in with their password and set it up again (the organization's requirement, if on,
 * asks them to). Otherwise nobody with two-factor, admins included, could sign in at all.
 */
async function dropUnreadableTwoFactor(tx: Prisma.TransactionClient) {
  for (const row of await tx.twoFactor.findMany({ select: { id: true, userId: true, secret: true } })) {
    const readable = await symmetricDecrypt({ key: env.authSecret, data: row.secret }).then((plain) => !!plain, () => false);
    if (readable) continue;
    await tx.user.update({ where: { id: row.userId }, data: { twoFactorEnabled: false } });
    await tx.twoFactor.delete({ where: { id: row.id } });
  }
}

export async function restoreBackup(body: ReadableStream<Uint8Array>): Promise<{ organizationId: string; counts: Record<string, number> }> {
  const source = Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>);
  const gunzip = source.pipe(createGunzip());
  // The first error from the file (cut short, not gzip, upload aborted) is the one to report,
  // and it's kept here even if it happens before reading starts.
  let streamError: Error | null = null;
  source.on("error", (error) => gunzip.destroy(error));
  gunzip.on("error", (error) => (streamError ??= error));
  const current = await latestMigration();
  const counts: Record<string, number> = {};
  let organizationId: string | null = null;
  // The home currency, for clients in backups made before clients had their own (WRK-135).
  let homeCurrency = "USD";

  try {
    await prisma.$transaction(async (tx) => {
      // First, so a setup or restore that finished meanwhile stops this one straight away.
      try {
        await tx.installation.create({ data: { id: 1 } });
      } catch (error) {
        if ((error as { code?: string }).code === "P2002") throw new AlreadyInstalled();
        throw error;
      }
      let header = false;
      // Rows wait here until there are enough of one table to insert together.
      const batch = { table: "", rows: [] as Record<string, unknown>[], bytes: 0 };
      let lastTable = -1;
      const flush = async () => {
        if (!batch.rows.length) return;
        await delegate(tx, TABLES.find((t) => t.name === batch.table)!.model).createMany({ data: batch.rows });
        batch.rows = [];
        batch.bytes = 0;
      };
      const read = async function* () {
        try {
          yield* splitLines(gunzip);
        } catch (error) {
          throw streamError ?? error;
        }
        if (streamError) throw streamError;
      };
      for await (const text of read()) {
        if (!text.trim()) continue;
        let line: Record<string, unknown>;
        try {
          line = JSON.parse(text) as Record<string, unknown>;
        } catch {
          throw new BadBackup("This file isn't a complete backup. It may have been cut short; download it again.");
        }
        if (!header) {
          if (line.format !== BACKUP_FORMAT || line.version !== BACKUP_VERSION) throw new BadBackup("This file isn't a backup from this app.");
          // 1.0.0 replaced the earlier migrations with one baseline, so a backup from a version
          // before it names a migration that sorts after the baseline but isn't newer.
          if (typeof line.migration === "string" && line.migration > BASELINE && line.migration <= LAST_BEFORE_BASELINE) {
            throw new BadBackup("This backup comes from a test version of the app from before 1.0.0, so it can't be restored.");
          }
          if (typeof line.migration !== "string" || line.migration > current) {
            throw new BadBackup("This backup comes from a newer version of the app. Update this install first, then restore.");
          }
          header = true;
          continue;
        }
        const table = line.t;
        if (typeof table !== "string" || !TABLE_NAMES.has(table) || !line.r || typeof line.r !== "object") throw new BadBackup("This backup has a line this app doesn't recognise.");
        const index = TABLES.findIndex((t) => t.name === table);
        if (index < lastTable) throw new BadBackup("This backup's tables are out of order.");
        const row = decode(line.r as Record<string, unknown>);
        if (table === "organization") {
          if (organizationId) throw new BadBackup("This backup has more than one organization.");
          organizationId = row.id as string;
          homeCurrency = typeof row.currency === "string" ? row.currency : homeCurrency;
          row.demoExpiresAt = null; // a restored workspace is a real one, even from the demo
        } else if (!organizationId) {
          throw new BadBackup("This backup has no organization.");
        } else if ("organizationId" in row && row.organizationId !== organizationId) {
          throw new BadBackup("This backup has rows from more than one organization.");
        }
        if (table === "client" && typeof row.currency !== "string") row.currency = homeCurrency;
        if (batch.table !== table) {
          await flush();
          batch.table = table;
          lastTable = index;
        }
        batch.rows.push(row);
        batch.bytes += text.length;
        counts[table] = (counts[table] ?? 0) + 1;
        if (batch.rows.length >= PAGE || batch.bytes >= BATCH_BYTES) await flush();
      }
      await flush();
      if (!header || !organizationId) throw new BadBackup("This file isn't a backup from this app.");
      await dropUnreadableTwoFactor(tx);
      await tx.installation.update({ where: { id: 1 }, data: { organizationId } });
    }, { timeout: 30 * 60 * 1000, maxWait: 10_000 });
  } catch (error) {
    if (error instanceof BadBackup || error instanceof AlreadyInstalled) throw error;
    if ((error as Error).name === "PrismaClientValidationError") throw new BadBackup("This backup has data this version of the app can't read.");
    // A gzip or database error: the file is damaged or doesn't fit this install. Nothing was saved.
    const code = (error as { code?: string }).code;
    if (code === "Z_DATA_ERROR" || code === "Z_BUF_ERROR") throw new BadBackup("This file isn't a backup from this app, or it's damaged.");
    if (code === "P2002" || code === "P2003") throw new BadBackup("This backup doesn't fit together: some of its rows point at rows that aren't in it, or appear twice.");
    throw error;
  }
  return { organizationId: organizationId!, counts };
}

// Manage → Security & data: download a backup (admins).
export const backupRoutes = new Hono<SignedIn>().get("/", requireAdmin("download a backup"), async (c) => {
  const day = new Date().toISOString().slice(0, 10);
  await recordAudit(c.get("db"), c.get("user"), { kind: "backup", action: "created", label: `Backup ${day}` });
  c.header("Content-Type", "application/gzip");
  c.header("Content-Disposition", `attachment; filename="backup-${day}.jsonl.gz"`);
  c.header("Cache-Control", "no-store");
  return c.body(backupStream(c.get("user").organizationId));
});
