import { gunzipSync, gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { decryptSecret, encryptSecret } from "../src/server/secrets.ts";
import { latestMigration } from "../src/server/backup.ts";
import { addUser, app, cookieFrom, createOrgWithUser, ORIGIN, request, resetDatabase, SETUP_CODE, signIn, validSetup } from "./helpers.ts";

beforeEach(resetDatabase);

const DAY = "2026-10-12";
const png = () => {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, 200);
  new DataView(b.buffer).setUint32(20, 100);
  return b;
};
const put = (path: string, bytes: Uint8Array, cookie: string, extra: Record<string, string> = {}) =>
  app.request(path, { method: "PUT", headers: { origin: ORIGIN, "content-type": "application/octet-stream", cookie, ...extra }, body: new Blob([bytes as Uint8Array<ArrayBuffer>]) });
const restore = (bytes: Uint8Array, code = SETUP_CODE, ip = "198.51.100.7") =>
  app.request("/api/setup/restore", {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/gzip", "x-setup-code": code, "x-forwarded-for": ip },
    body: new Blob([bytes as Uint8Array<ArrayBuffer>]),
  });

/** A studio with a bit of everything: people, a client, a budgeted project, time, an invoice, a receipt, a logo, email settings. */
async function studio() {
  const admin = cookieFrom(await request("/api/setup", { body: validSetup }));
  const org = (await prisma.installation.findFirstOrThrow()).organizationId!;
  await request("/api/people/invites", { body: { name: "Mia Member", email: "mia@studio.test", role: "member", emailLink: false }, cookie: admin });
  await addUser(org, "member@studio.test", "member-password-1");
  const member = (await signIn("member@studio.test", "member-password-1")).cookie;
  const client = (await (await request("/api/clients", { body: { name: "Acme Ltd" }, cookie: admin })).json()).client;
  const project = (await (await request("/api/projects", { body: { name: "Website", clientId: client.id, hourlyRate: 12000, budgetBy: "hours", budgetSeconds: 36000 }, cookie: admin })).json()).project;
  await request("/api/time-entries", { body: { projectId: project.id, date: DAY, seconds: 7200, notes: "Design" }, cookie: member });
  await request("/api/time-entries", { body: { projectId: project.id, date: "2026-10-13", seconds: 3600 }, cookie: admin });
  const { expense } = await (await request("/api/expenses", { body: { projectId: project.id, date: DAY, category: "Travel", amount: 4250 }, cookie: member })).json();
  await put(`/api/expenses/${expense.id}/receipt`, png(), member, { "x-file-name": "taxi.png" });
  const { invoice } = await (await request("/api/invoices", { body: { clientId: client.id, issueDate: "2026-10-15" }, cookie: admin })).json();
  await put("/api/settings/appearance/logo", png(), admin);
  // Saved directly: saving through the API would try to reach the mail server.
  await prisma.emailSettings.create({ data: { organizationId: org, provider: "smtp", fromEmail: "hi@studio.test", smtpHost: "smtp.studio.test", smtpUser: "hi", secret: encryptSecret("smtp-password-123") } });
  return { admin, member, org, invoice };
}

async function snapshot(organizationId: string) {
  const [users, entries, invoices, lines, receipt, logo, email, audit, org] = await Promise.all([
    prisma.user.findMany({ where: { organizationId }, select: { id: true, email: true, role: true, hourlyRate: true }, orderBy: { email: "asc" } }),
    prisma.timeEntry.findMany({ where: { organizationId }, select: { id: true, date: true, seconds: true, notes: true, invoiceLineId: true }, orderBy: { id: "asc" } }),
    prisma.invoice.findMany({ where: { organizationId }, select: { id: true, number: true, status: true, issueDate: true }, orderBy: { id: "asc" } }),
    prisma.invoiceLine.findMany({ where: { organizationId }, select: { id: true, amount: true, quantity: true }, orderBy: { id: "asc" } }),
    prisma.receipt.findFirst({ where: { organizationId }, select: { fileName: true, data: true } }),
    prisma.logo.findFirst({ where: { organizationId }, select: { data: true, contentType: true } }),
    prisma.emailSettings.findFirst({ where: { organizationId }, select: { smtpHost: true, secret: true } }),
    prisma.auditEvent.count({ where: { organizationId } }),
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true, currency: true, invoiceNextNumber: true } }),
  ]);
  return { users, entries, invoices, lines, receipt, logo, email, audit, org };
}

const download = async (cookie: string) => {
  const res = await request("/api/settings/backup", { cookie });
  return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
};
const readLines = (bytes: Uint8Array) => gunzipSync(bytes).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("backup and restore", { timeout: 20_000 }, () => {
  it("restores a backup into a new install exactly, and people sign in as before", async () => {
    const s = await studio();
    const before = await snapshot(s.org);
    const { res, bytes } = await download(s.admin);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="backup-\d{4}-\d{2}-\d{2}\.jsonl\.gz"$/);
    const lines = readLines(bytes);
    expect(lines[0]).toMatchObject({ format: "time-tracking-backup", version: 1, migration: await latestMigration() });
    expect(lines.some((l) => l.t === "session")).toBe(false);

    await resetDatabase();
    const restored = await restore(bytes);
    expect(restored.status).toBe(201);
    expect((await restored.json()).counts).toMatchObject({ organization: 1, user: 2, timeEntry: 2, invoice: 1, receipt: 1, logo: 1 });
    // The download itself is in the history.
    expect(await snapshot(s.org)).toEqual({ ...before, audit: before.audit + 1 });
    expect(await prisma.auditEvent.findFirst({ where: { kind: "backup" }, select: { action: true, actorName: true } })).toEqual({ action: "created", actorName: validSetup.name });
    expect(decryptSecret(before.email!.secret)).toBe("smtp-password-123");
    expect((await prisma.installation.findFirstOrThrow()).organizationId).toBe(s.org);

    const { res: signedIn, cookie } = await signIn(validSetup.email, validSetup.password);
    expect(signedIn.status).toBe(200);
    expect((await (await request("/api/me", { cookie })).json()).organization.name).toBe(validSetup.organizationName);
    expect((await signIn("member@studio.test", "member-password-1")).res.status).toBe(200);
    // Setup is done: neither setup nor another restore works now.
    expect((await restore(bytes)).status).toBe(404);
    expect((await (await request("/api/setup/status")).json()).needsSetup).toBe(false);
  });

  it("is for admins, and holds only their own organization", async () => {
    const s = await studio();
    expect((await download(s.member)).res.status).toBe(403);
    expect((await request("/api/settings/backup")).status).toBe(401);
    const other = await createOrgWithUser("Other", "other@else.test", "other-password-1", "admin");
    await prisma.client.create({ data: { name: "Not yours", currency: "USD", organizationId: other.organization.id } });
    const text = gunzipSync((await download(s.admin)).bytes).toString("utf8");
    expect(text).not.toContain(other.organization.id);
    expect(text).not.toContain("Not yours");
    expect(text).not.toContain("other@else.test");
  });

  it("leaves out the tokens single sign-on keeps", async () => {
    const s = await studio();
    await prisma.account.updateMany({ data: { accessToken: "sso-access-token", refreshToken: "sso-refresh-token", idToken: "sso-id-token" } });
    const text = gunzipSync((await download(s.admin)).bytes).toString("utf8");
    expect(text).not.toContain("sso-");
    const account = text.trim().split("\n").map((l) => JSON.parse(l)).find((l) => l.t === "account");
    expect(account.r).toMatchObject({ accessToken: null, refreshToken: null, idToken: null });
    expect(account.r.password).toEqual(expect.any(String));
  });

  it("refuses rows of another organization, and lines longer than any backup has", async () => {
    const s = await studio();
    const { bytes } = await download(s.admin);
    await resetDatabase();
    const lines = gunzipSync(bytes).toString("utf8").split("\n");
    const i = lines.findIndex((l) => l.includes('"t":"client"'));
    const line = JSON.parse(lines[i]!);
    lines[i] = JSON.stringify({ ...line, r: { ...line.r, organizationId: "00000000-0000-4000-8000-000000000000" } });
    expect((await (await restore(gzipSync(lines.join("\n")))).json()).error).toBe("This backup has rows from more than one organization.");

    const header = gunzipSync(bytes).toString("utf8").split("\n")[0];
    const long = await restore(gzipSync(`${header}\n${"x".repeat(17 * 1024 * 1024)}`));
    expect((await long.json()).error).toBe("This backup has a line this app doesn't recognise.");
    expect(await prisma.organization.count()).toBe(0);
    expect((await restore(bytes, SETUP_CODE, "198.51.100.9")).status).toBe(201);
  });

  it("refuses a wrong setup code, a damaged file, another file and a newer version, saving nothing", async () => {
    const s = await studio();
    const { bytes } = await download(s.admin);
    await resetDatabase();

    expect((await restore(bytes, "wrong-code-wrong-code")).status).toBe(403);
    const cut = await restore(bytes.slice(0, Math.floor(bytes.length / 2)));
    expect(cut.status).toBe(400);
    const notGzip = await restore(new TextEncoder().encode("hello"));
    expect((await notGzip.json()).error).toBe("This file isn't a backup from this app, or it's damaged.");
    expect((await restore(gzipSync('{"format":"something-else","version":1}\n'))).status).toBe(400);

    const lines = gunzipSync(bytes).toString("utf8").split("\n");
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), migration: "99991231000000_from_the_future" });
    const newer = await restore(gzipSync(lines.join("\n")));
    expect((await newer.json()).error).toBe("This backup comes from a newer version of the app. Update this install first, then restore.");
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), migration: "20261023090000_phase_fees" });
    const beforeBaseline = await restore(gzipSync(lines.join("\n")));
    expect((await beforeBaseline.json()).error).toBe("This backup comes from a test version of the app from before 1.0.0, so it can't be restored.");

    const broken = gunzipSync(bytes).toString("utf8").split("\n").filter((l) => !l.includes('"t":"client"')).join("\n");
    const dangling = await restore(gzipSync(broken));
    expect(dangling.status).toBe(400);

    expect(await prisma.installation.count()).toBe(0);
    expect(await prisma.organization.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
    expect((await restore(bytes, SETUP_CODE, "198.51.100.8")).status).toBe(201);
  });
});
