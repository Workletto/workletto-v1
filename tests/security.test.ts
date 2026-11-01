import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { databaseHost } from "../src/server/security.ts";
import { addUser, cookieFrom, createOrgWithUser, request, resetDatabase, signIn, validSetup } from "./helpers.ts";

beforeEach(resetDatabase);
afterEach(() => {
  delete process.env.DEMO_MODE;
});

const facts = async (cookie: string) => request("/api/settings/security", { cookie });

describe("Manage → Security & data", () => {
  it("shows where the data is and who can sign in, without the database password", async () => {
    const admin = cookieFrom(await request("/api/setup", { body: validSetup }));
    const org = await prisma.organization.findFirstOrThrow();
    await addUser(org.id, "sam@example.com", "member-password-1");
    const off = await addUser(org.id, "olly@example.com", "member-password-1");
    await prisma.user.update({ where: { id: off.id }, data: { deactivatedAt: new Date() } });
    // Imported people have no login, so they can't sign in.
    await prisma.user.create({ data: { name: "Imported", email: "imported@no-login.invalid", organizationId: org.id } });

    const res = await facts(admin);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body).toMatchObject({
      demo: false,
      databaseHost: new URL(process.env.DATABASE_URL!).hostname,
      appAddress: "localhost:3000",
      people: { canSignIn: 2, admins: [{ name: "Ada Admin", email: "ada@example.com" }], turnedOff: 1, openInvites: 0 },
      signIn: { emailAndPassword: true },
    });
    const { password, username } = new URL(process.env.DATABASE_URL!);
    expect(text).not.toContain(`${username}:${password}@`);
    expect(text).not.toContain(process.env.DATABASE_URL!);
  });

  it("is for admins only, and counts only their own organization", async () => {
    const a = await createOrgWithUser("Org A", "a@a.test", "admin-password-1", "admin");
    await addUser(a.organization.id, "m@a.test", "manager-password-1", "manager");
    const b = await createOrgWithUser("Org B", "b@b.test", "admin-password-1", "admin");
    await addUser(b.organization.id, "x@b.test", "member-password-1");
    await addUser(b.organization.id, "y@b.test", "member-password-1");

    expect((await request("/api/settings/security")).status).toBe(401);
    expect((await facts((await signIn("m@a.test", "manager-password-1")).cookie)).status).toBe(403);

    const body = await (await facts((await signIn("a@a.test", "admin-password-1")).cookie)).json();
    expect(body.people).toEqual({ canSignIn: 2, admins: [{ name: "a", email: "a@a.test" }], turnedOff: 0, openInvites: 0 });
  });

  it("hides the database host in the demo", async () => {
    const admin = cookieFrom(await request("/api/setup", { body: validSetup }));
    process.env.DEMO_MODE = "true";
    const body = await (await facts(admin)).json();
    expect(body).toMatchObject({ demo: true, databaseHost: null, signIn: { emailAndPassword: true } });
  });

  it("reads only the host from a database address", () => {
    expect(databaseHost("postgresql://work:s3cret@dpg-abc123-a.oregon-postgres.render.com:5432/work")).toBe("dpg-abc123-a.oregon-postgres.render.com");
    expect(databaseHost("postgresql://work:s3cret@db:5432/work")).toBe("db");
    expect(databaseHost("postgresql:///work?host=/var/run/postgresql")).toBe("a local socket on this server");
    expect(databaseHost("not a url")).toBe("unknown");
  });
});

describe("Manage → Security & data, with email on", () => {
  it("names the mail server as the one outside connection, never the password", async () => {
    const admin = cookieFrom(await request("/api/setup", { body: validSetup }));
    const settings = { provider: "smtp", fromName: "Studio North", fromEmail: "billing@studio.test", smtpHost: "127.0.0.1", smtpPort: 2525, smtpSecure: false, smtpUser: "mailer", secret: "smtp-password-9" };
    expect((await request("/api/settings/email", { method: "PUT", body: settings, cookie: admin })).status).toBe(200);
    const res = await facts(admin);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ email: { provider: "smtp", host: "127.0.0.1:2525", lastError: null }, recovery: { byEmail: true } });
    expect(text).not.toContain("smtp-password-9");
  });
});
