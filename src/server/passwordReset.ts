import { Hono } from "hono";
import { auth, MAX_PASSWORD_LENGTH } from "./auth.ts";
import { MIN_PASSWORD_LENGTH } from "../shared/limits.ts";
import { orgDb, prisma, type OrgDb } from "./db.ts";
import { env } from "./env.ts";
import { readBody, signInAs } from "./http.ts";
import { loadSso } from "./sso.ts";
import { escapeHtml, isEmailConfigured, sendMail, type Mail } from "./mail.ts";
import { resetAttemptsPerIp, resetRequestsPerEmail, resetRequestsPerIp, TOO_MANY_ATTEMPTS_15_MIN, TOO_MANY_REQUESTS_15_MIN } from "./rateLimit.ts";
import { limitIp } from "./clientIp.ts";
import { describeError } from "./logging.ts";
import { hashToken, newToken } from "./tokens.ts";

// Forgotten passwords. An admin makes a one-time reset link for someone (Manage → People)
// and passes it on; when the app can send email, people can also ask for one themselves
// from the sign-in page. Like an invite, the link holds a random token, only its hash is
// stored, and it works once. Using it signs the person in here and out everywhere else.

export const ADMIN_LINK_HOURS = 24;
export const EMAIL_LINK_HOURS = 1;
const EXPIRED = { error: "This reset link has expired or was already used. Ask an admin for a new one." };


/** True when this install's organization can send email, so people can ask for a reset link themselves. */
export async function passwordResetByEmail(): Promise<boolean> {
  const installation = await prisma.installation.findUnique({ where: { id: 1 }, select: { organizationId: true } });
  return installation?.organizationId ? isEmailConfigured(orgDb(installation.organizationId)) : false;
}

function resetEmail(name: string, to: string, organizationName: string, link: string): Mail {
  const asked = `Someone asked for a new password for ${to} at ${organizationName}. If that was you, open this link within the hour:`;
  const ignore = "If it wasn't you, ignore this email: nothing changes until the link is used.";
  return {
    to,
    subject: `Reset your password for ${organizationName}`,
    text: `Hi ${name},\n\n${asked}\n\n${link}\n\n${ignore}`,
    html: `<p>Hi ${escapeHtml(name)},</p><p>${escapeHtml(asked)}</p><p><a href="${link}">${link}</a></p><p>${escapeHtml(ignore)}</p>`,
  };
}

/** A new reset link for a person, replacing any older one. Returns the token that goes in the link. */
export async function createResetToken(db: OrgDb, userId: string, hours: number) {
  const token = newToken();
  const link = { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000) };
  const create = { userId, ...link };
  await db.passwordReset.upsert({ where: { userId }, create: create as typeof create & { organizationId: string }, update: link });
  return { token, expiresAt: link.expiresAt };
}

/** The reset a token stands for, if it is still good and the person can still sign in. */
async function liveReset(token: unknown) {
  if (typeof token !== "string" || !token) return null;
  const reset = await prisma.passwordReset.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, expiresAt: true, user: { select: { id: true, name: true, email: true, role: true, organizationId: true, deactivatedAt: true, organization: { select: { name: true } } } } },
  });
  if (!reset || reset.expiresAt < new Date() || reset.user.deactivatedAt) return null;
  return reset;
}

// Opening a reset link, before anyone is signed in.
export const passwordResetRoutes = new Hono()
  // Who the link is for, so the page can say so.
  .get("/:token", async (c) => {
    const reset = await liveReset(c.req.param("token"));
    if (!reset) return c.json(EXPIRED, 404);
    return c.json({ name: reset.user.name, email: reset.user.email, organizationName: reset.user.organization.name });
  })
  // "Forgot your password?": emails a link when the address belongs to someone here and email is
  // on. The answer is the same either way, so nobody can use it to learn who has an account.
  .post("/request", async (c) => {
    const body = await readBody(c);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || email.length > 254) return c.json({ error: "Enter your email address." }, 400);
    if (!resetRequestsPerIp.hit(limitIp(c)) || !resetRequestsPerEmail.hit(email)) {
      return c.json({ error: TOO_MANY_REQUESTS_15_MIN }, 429);
    }
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, name: true, organizationId: true, deactivatedAt: true, organization: { select: { name: true } }, _count: { select: { accounts: true } } },
    });
    // Only someone who already has a login (a password, or single sign-on) gets a link. People
    // added by an import, or invited but not yet joined, get their first login from an invitation.
    if (user && !user.deactivatedAt && user._count.accounts > 0) {
      const db = orgDb(user.organizationId);
      if (await isEmailConfigured(db)) {
        const { token } = await createResetToken(db, user.id, EMAIL_LINK_HOURS);
        // Sent without waiting, so how long the answer takes doesn't say whether the address has a login.
        // A failed send shows up as the last error under Manage → Email, not here.
        void sendMail(db, resetEmail(user.name, email, user.organization.name, `${env.baseUrl}/reset/${token}`)).catch((error) => console.error("Sending a password reset email failed", describeError(error)));
      }
    }
    return c.json({ ok: true });
  })
  // Sets the new password, signs the person out everywhere, and signs this browser in.
  .post("/", async (c) => {
    if (!resetAttemptsPerIp.hit(limitIp(c))) return c.json({ error: TOO_MANY_ATTEMPTS_15_MIN }, 429);
    const body = await readBody(c);
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return c.json({ error: `Choose a password of ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.` }, 400);
    }
    const reset = await liveReset(body.token);
    if (!reset) return c.json(EXPIRED, 404);
    // With single sign-on required, only admins sign in with a password (sso.ts); the link stays usable.
    const sso = await loadSso();
    if (sso?.requireSso && sso.organizationId === reset.user.organizationId && reset.user.role !== "admin") {
      return c.json({ error: `Your organization signs in with ${sso.providerName}, so you don't need a password. Use “Sign in with ${sso.providerName}” instead.` }, 409);
    }
    const passwordHash = await (await auth.$context).password.hash(password);

    try {
      await prisma.$transaction(async (tx) => {
        // Only one go can use a link, even if two arrive at once.
        const { count } = await tx.passwordReset.deleteMany({ where: { id: reset.id, expiresAt: { gt: new Date() } } });
        if (!count) throw new LinkUsed();
        const { count: changed } = await tx.account.updateMany({ where: { userId: reset.user.id, providerId: "credential" }, data: { password: passwordHash } });
        // Someone who has only ever signed in through single sign-on gets their first password;
        // someone with no login at all (an admin's link made before they joined) needs an invitation.
        if (!changed && !(await tx.account.count({ where: { userId: reset.user.id } }))) throw new NoLogin();
        if (!changed) await tx.account.create({ data: { userId: reset.user.id, accountId: reset.user.id, providerId: "credential", password: passwordHash } });
        // Whoever is signed in as them, anywhere, is signed out.
        await tx.session.deleteMany({ where: { userId: reset.user.id } });
      });
    } catch (error) {
      if (error instanceof LinkUsed) return c.json(EXPIRED, 404);
      if (error instanceof NoLogin) return c.json({ error: "You don't have a login yet. Ask an admin to invite you." }, 409);
      throw error;
    }

    await signInAs(c, reset.user.email, password);
    return c.json({ ok: true });
  });

class LinkUsed extends Error {}
class NoLogin extends Error {}
