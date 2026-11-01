import { Hono } from "hono";
import { domainOf, loadSso } from "./sso.ts";
import { auth, MAX_PASSWORD_LENGTH } from "./auth.ts";
import { MIN_PASSWORD_LENGTH } from "../shared/limits.ts";
import { prisma, type OrgDb } from "./db.ts";
import { env } from "./env.ts";
import { escapeHtml, isEmailConfigured, sendMail } from "./mail.ts";
import { isUniqueViolation, readBody, requireAdmin, readName, signInAs, type SignedIn } from "./http.ts";
import { acceptAttemptsPerIp, TOO_MANY_ATTEMPTS_15_MIN } from "./rateLimit.ts";
import { limitIp } from "./clientIp.ts";
import { ADMIN_LINK_HOURS, createResetToken } from "./passwordReset.ts";
import { isRole } from "../shared/roles.ts";
import { isCents } from "../shared/money.ts";
import { diff, recordAudit } from "./audit.ts";
import { checkBudgets } from "./budget.ts";
import { stopRunning } from "./time.ts";
import { isEmail } from "../shared/email.ts";
import { hashToken, newToken } from "./tokens.ts";

// Manage → People: admins invite people, change their role, and turn accounts
// off and on. Nobody is ever deleted, so their time stays in the reports.
//
// Invites are links. The admin can pass them on themselves, and when email is set up the app
// also emails the link.
// The link holds a random token; only its hash is stored, and it works once.

const INVITE_DAYS = 7;
/** Every hour of the week, in seconds: the most a weekly capacity can be. */
const MAX_WEEKLY_CAPACITY = 7 * 24 * 3600;
const EXPIRED = { error: "This invite link has expired or was already used. Ask your admin for a new one." };
const EMAIL_TAKEN = "Someone with that email already has an account.";

function newInvite() {
  const token = newToken();
  return { token, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000) };
}

const PERSON = {
  id: true, name: true, email: true, role: true, hourlyRate: true, costRate: true, weeklyCapacity: true, deactivatedAt: true, twoFactorEnabled: true,
  accounts: { select: { id: true }, take: 1 },
} as const;
const INVITE = { id: true, name: true, email: true, role: true, expiresAt: true, userId: true } as const;
type PersonRow = { id: string; name: string; email: string; role: string; hourlyRate: number | null; costRate: number | null; weeklyCapacity: number; deactivatedAt: Date | null; twoFactorEnabled: boolean; accounts: { id: string }[] };
// What the history records about a person: name, email, billable and cost rates, weekly capacity,
// role and whether their account is on.
const AUDITED = ["name", "email", "hourlyRate", "costRate", "weeklyCapacity", "role", "active"] as const;
const audited = (p: Omit<PersonRow, "id" | "accounts">) => ({
  name: p.name,
  email: p.email.endsWith(PLACEHOLDER_DOMAIN) ? null : p.email,
  hourlyRate: p.hourlyRate,
  costRate: p.costRate,
  weeklyCapacity: p.weeklyCapacity,
  role: p.role,
  active: !p.deactivatedAt,
});

// People brought in by an import have no login until they're invited; their email is a placeholder until then.
const toPerson = ({ deactivatedAt, accounts, email, ...rest }: PersonRow) => {
  const joined = accounts.length > 0;
  return { ...rest, email: joined || !email.endsWith(PLACEHOLDER_DOMAIN) ? email : "", active: deactivatedAt === null, joined };
};
export const PLACEHOLDER_DOMAIN = "@no-login.invalid";

/**
 * Emails an invite link when email is on and the admin didn't untick "Email the link".
 * The answer says what happened, for the card on the People screen; the link is shown either way.
 */
async function emailInvite(db: OrgDb, body: Record<string, unknown>, invite: { name: string; email: string }, token: string) {
  if (body.emailLink === false || !(await isEmailConfigured(db))) return { emailed: false };
  const { name: organizationName } = await db.organization.findFirstOrThrow({ select: { name: true } });
  const link = `${env.baseUrl}/invite/${token}`;
  const intro = `${organizationName} has invited you to join. Open this link within ${INVITE_DAYS} days to choose a password:`;
  const sent = await sendMail(db, {
    to: invite.email,
    subject: `Join ${organizationName}`,
    text: `Hi ${invite.name},\n\n${intro}\n\n${link}`,
    html: `<p>Hi ${escapeHtml(invite.name)},</p><p>${escapeHtml(intro)}</p><p><a href="${link}">${link}</a></p>`,
  });
  return sent.ok ? { emailed: true } : { emailed: false, emailError: sent.error };
}


export const peopleRoutes = new Hono<SignedIn>()
  .use(requireAdmin("manage people"))
  .get("/", async (c) => {
    const db = c.get("db");
    const [people, invites] = await Promise.all([
      db.user.findMany({ select: PERSON, orderBy: { name: "asc" } }),
      db.invite.findMany({ select: INVITE, orderBy: { createdAt: "asc" } }),
    ]);
    return c.json({ people: people.map(toPerson), invites, emailConfigured: await isEmailConfigured(db) });
  })
  .post("/invites", async (c) => {
    const body = await readBody(c);
    const name = readName(body.name);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!name) return c.json({ error: "Enter their name (up to 200 characters)." }, 400);
    if (email.length > 254 || !isEmail(email)) return c.json({ error: "Enter a valid email address." }, 400);
    if (!isRole(body.role)) return c.json({ error: "Choose Admin, Manager or Member." }, 400);
    if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) return c.json({ error: EMAIL_TAKEN }, 409);

    const { token, ...secret } = newInvite();
    try {
      const data = { name, email, role: body.role, ...secret };
      const invite = await c.get("db").invite.create({
        data: data as typeof data & { organizationId: string }, // orgDb fills in organizationId
        select: INVITE,
      });
      return c.json({ invite, token, ...(await emailInvite(c.get("db"), body, invite, token)) }, 201);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return c.json({ error: "That email already has an invite. Make a new link for it instead." }, 409);
    }
  })
  // A fresh link for an invite, for when the first one was lost or expired. The old link stops working.
  .post("/invites/:id/renew", async (c) => {
    const body = await readBody(c);
    const { token, ...secret } = newInvite();
    const db = c.get("db");
    const { count } = await db.invite.updateMany({ where: { id: c.req.param("id") }, data: secret });
    if (!count) return c.json({ error: "Invite not found." }, 404);
    const invite = await db.invite.findFirstOrThrow({ where: { id: c.req.param("id") }, select: INVITE });
    return c.json({ invite, token, ...(await emailInvite(db, body, invite, token)) });
  })
  .delete("/invites/:id", async (c) => {
    const { count } = await c.get("db").invite.deleteMany({ where: { id: c.req.param("id") } });
    if (!count) return c.json({ error: "Invite not found." }, 404);
    return c.json({ ok: true });
  })
  // A login for someone already here without one (for example from an import).
  .post("/:id/invite", async (c) => {
    const db = c.get("db");
    const person = await db.user.findFirst({ where: { id: c.req.param("id") }, select: { id: true, name: true, role: true, accounts: { select: { id: true }, take: 1 } } });
    if (!person) return c.json({ error: "Person not found." }, 404);
    if (person.accounts.length) return c.json({ error: "They can already sign in." }, 409);
    const body = await readBody(c);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (email.length > 254 || !isEmail(email) || email.endsWith(PLACEHOLDER_DOMAIN)) return c.json({ error: "Enter a valid email address." }, 400);
    const owner = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (owner && owner.id !== person.id) return c.json({ error: EMAIL_TAKEN }, 409);

    const { token, ...secret } = newInvite();
    try {
      const invite = await db.$transaction(async (tx) => {
        await tx.invite.deleteMany({ where: { OR: [{ userId: person.id }, { email }] } });
        const data = { name: person.name, email, role: person.role, userId: person.id, ...secret };
        return tx.invite.create({ data: data as typeof data & { organizationId: string }, select: INVITE });
      });
      return c.json({ invite, token, ...(await emailInvite(db, body, invite, token)) }, 201);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return c.json({ error: "That email already has an invite." }, 409);
    }
  })
  // A one-time link for someone who forgot their password. The admin passes it on; it works once, for 24 hours.
  .post("/:id/reset-link", async (c) => {
    const db = c.get("db");
    const person = await db.user.findFirst({
      where: { id: c.req.param("id") },
      select: { id: true, name: true, deactivatedAt: true, accounts: { select: { id: true }, take: 1 } },
    });
    if (!person) return c.json({ error: "Person not found." }, 404);
    if (person.id === c.get("user").id) return c.json({ error: "Change your own password from the account menu." }, 400);
    if (person.deactivatedAt) return c.json({ error: "Turn their account back on first." }, 409);
    if (!person.accounts.length) return c.json({ error: "They have no login yet. Invite them instead." }, 409);
    const { token, expiresAt } = await createResetToken(db, person.id, ADMIN_LINK_HOURS);
    // Whoever has the link can set their password, so who made one is on record.
    await recordAudit(db, c.get("user"), { kind: "person", action: "changed", subjectId: person.id, label: person.name, changes: [{ field: "resetLink", from: null, to: "created" }] });
    return c.json({ token, expiresAt }, 201);
  })
  // Change someone's name, email, role, billable or cost rate or weekly capacity, or turn their account off ({ active: false })
  // or back on. Admins can't change their own role or account, so there is always at least one admin left.
  .patch("/:id", async (c) => {
    const body = await readBody(c);
    const db = c.get("db");
    const person = await db.user.findFirst({ where: { id: c.req.param("id") }, select: PERSON });
    if (!person) return c.json({ error: "Person not found." }, 404);
    if (person.id === c.get("user").id && ("role" in body || "active" in body)) {
      return c.json({ error: "You can't change your own role or turn off your own account." }, 400);
    }

    const data: { name?: string; email?: string; role?: "admin" | "manager" | "member"; deactivatedAt?: Date | null; hourlyRate?: number | null; costRate?: number | null; weeklyCapacity?: number } = {};
    if ("name" in body) {
      const name = readName(body.name);
      if (!name) return c.json({ error: "Enter their name (up to 200 characters)." }, 400);
      data.name = name;
    }
    if ("email" in body) {
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (email.length > 254 || !isEmail(email) || email.endsWith(PLACEHOLDER_DOMAIN)) return c.json({ error: "Enter a valid email address." }, 400);
      if (email !== person.email) {
        // Email addresses sign people in, so each belongs to one person in the whole install,
        // and not to someone with an invite on the way either.
        const owner = await prisma.user.findUnique({ where: { email }, select: { id: true } });
        // (An invite for a new person has no userId; "not this person" has to keep those.)
        const invited = await prisma.invite.findFirst({ where: { email, expiresAt: { gt: new Date() }, OR: [{ userId: null }, { userId: { not: person.id } }] }, select: { id: true } });
        if ((owner && owner.id !== person.id) || invited) return c.json({ error: EMAIL_TAKEN }, 409);
        data.email = email;
      }
    }
    if ("hourlyRate" in body) {
      if (body.hourlyRate !== null && !isCents(body.hourlyRate)) return c.json({ error: "Enter a rate like 120 or 95.50." }, 400);
      data.hourlyRate = body.hourlyRate as number | null;
    }
    if ("costRate" in body) {
      if (body.costRate !== null && !isCents(body.costRate)) return c.json({ error: "Enter a cost rate like 60 or 45.50." }, 400);
      data.costRate = body.costRate as number | null;
    }
    if ("weeklyCapacity" in body) {
      const seconds = body.weeklyCapacity;
      if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 0 || seconds > MAX_WEEKLY_CAPACITY) {
        return c.json({ error: "Enter the hours they work in a week, from 0 to 168." }, 400);
      }
      data.weeklyCapacity = seconds;
    }
    if ("role" in body) {
      if (!isRole(body.role)) return c.json({ error: "Choose Admin, Manager or Member." }, 400);
      data.role = body.role;
    }
    if ("active" in body) {
      if (typeof body.active !== "boolean") return c.json({ error: "Active must be true or false." }, 400);
      data.deactivatedAt = body.active ? null : new Date();
    }
    let updated: PersonRow;
    try {
      updated = await db.$transaction(async (tx) => {
        // A timer left running would otherwise keep adding time to their reports and budgets.
        if (data.deactivatedAt) await stopRunning(tx as OrgDb, person.id, data.deactivatedAt);
        const after = await tx.user.update({ where: { id: person.id }, data, select: PERSON });
        const changes = diff(audited(person), audited(after), AUDITED);
        await recordAudit(tx as OrgDb, c.get("user"), { kind: "person", action: "changed", subjectId: person.id, label: person.name, changes });
        return after;
      });
    } catch (error) {
      if (isUniqueViolation(error)) return c.json({ error: EMAIL_TAKEN }, 409); // taken a moment ago
      throw error;
    }
    // Signs them out everywhere straight away: turned off, or signing in with a new address now.
    if (data.deactivatedAt || data.email) await prisma.session.deleteMany({ where: { userId: person.id } });
    if (data.email) await prisma.passwordReset.deleteMany({ where: { userId: person.id } });
    // A person's rate counts toward fee budgets on projects billed by person.
    if (updated.hourlyRate !== person.hourlyRate) await checkBudgets(db, "all", true);
    return c.json({ person: toPerson(updated) });
  });

// Opening an invite link, before anyone is signed in.
export const inviteRoutes = new Hono()
  .get("/:token", async (c) => {
    const invite = await prisma.invite.findUnique({
      where: { tokenHash: hashToken(c.req.param("token")) },
      select: { name: true, email: true, role: true, userId: true, organizationId: true, expiresAt: true, organization: { select: { name: true } } },
    });
    if (!invite || invite.expiresAt < new Date()) return c.json(EXPIRED, 404);
    return c.json({ name: invite.name, email: invite.email, organizationName: invite.organization.name, sso: await ssoForInvite(invite) });
  })
  // Creates the account with the invite's email and role, then signs the person in.
  .post("/accept", async (c) => {
    if (!acceptAttemptsPerIp.hit(limitIp(c))) return c.json({ error: TOO_MANY_ATTEMPTS_15_MIN }, 429);
    const body = await readBody(c);
    const name = readName(body.name);
    const password = typeof body.password === "string" ? body.password : "";
    if (typeof body.token !== "string") return c.json(EXPIRED, 404);
    if (!name) return c.json({ error: "Enter your name (up to 200 characters)." }, 400);
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return c.json({ error: `Choose a password of ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.` }, 400);
    }

    const invite = await prisma.invite.findUnique({ where: { tokenHash: hashToken(body.token) } });
    if (!invite || invite.expiresAt < new Date()) return c.json(EXPIRED, 404);
    // With SSO required, only admins choose a password; everyone else joins through the provider.
    const sso = await ssoForInvite(invite);
    if (sso?.required) return c.json({ error: `Your organization signs in with ${sso.name}. Use “Join with ${sso.name}” instead.` }, 409);
    const passwordHash = await (await auth.$context).password.hash(password);

    try {
      await prisma.$transaction(async (tx) => {
        // Only one person can use a link, even if two try at once.
        const { count } = await tx.invite.deleteMany({ where: { id: invite.id, expiresAt: { gt: new Date() } } });
        if (!count) throw new InviteUsed();
        // Someone already in the organization gets a login; everyone else is added.
        const user = invite.userId
          ? await tx.user.update({ where: { id: invite.userId }, data: { name, email: invite.email } })
          : await tx.user.create({ data: { name, email: invite.email, role: invite.role, organizationId: invite.organizationId } });
        await tx.account.create({ data: { userId: user.id, accountId: user.id, providerId: "credential", password: passwordHash } });
      });
    } catch (error) {
      if (error instanceof InviteUsed) return c.json(EXPIRED, 404);
      if (isUniqueViolation(error)) return c.json({ error: `${EMAIL_TAKEN} Try signing in instead.` }, 409);
      throw error;
    }

    await signInAs(c, invite.email, password);
    return c.json({ ok: true }, 201);
  });

class InviteUsed extends Error {}

/**
 * The single sign-on button for an invitation, when the organization has a provider and the
 * invited email is at its domain (sso.ts). `required`: SSO is required and they aren't an admin,
 * so they join through the provider only. Someone already in the organization without a login
 * (invited with a userId) sets up a password first, so gets no button.
 */
async function ssoForInvite(invite: { email: string; role: string; userId: string | null; organizationId: string }) {
  const sso = await loadSso();
  if (!sso || sso.organizationId !== invite.organizationId || invite.userId || domainOf(invite.email) !== sso.domain) return null;
  return { name: sso.providerName, required: sso.requireSso && invite.role !== "admin" };
}
