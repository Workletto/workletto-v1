import { APIError } from "better-auth/api";
import { prisma } from "./db.ts";
import { isDemoMode } from "./env.ts";
import { decryptSecret } from "./secrets.ts";

// Single sign-on (WRK-136): "Sign in with your company account" through the organization's own
// identity provider (Google Workspace, Microsoft Entra ID, Okta) over OpenID Connect, with
// Better Auth's built-in generic OAuth plugin (auth.ts). The rules, enforced in auth.ts's hooks:
//   - only people with an email at the organization's domain, whose provider says it's verified;
//   - only people already in the organization, or invited to it, unless allowJoin is on;
//   - with requireSso, everyone but admins signs in through the provider (admins keep their
//     password, so a broken provider can't lock everyone out);
//   - never in the vendor's demo, which holds many organizations in one install.

export const SSO_PROVIDER = "sso";

export type SsoConfig = {
  organizationId: string;
  providerName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  domain: string;
  allowJoin: boolean;
  requireSso: boolean;
};

/** The organization's SSO settings, ready to use, or null when it has none (or its secret can't be read). */
export async function loadSso(): Promise<SsoConfig | null> {
  if (isDemoMode()) return null;
  const row = await prisma.ssoSettings.findFirst();
  if (!row) return null;
  const clientSecret = decryptSecret(row.secret);
  if (clientSecret === null) return null; // BETTER_AUTH_SECRET changed: an admin enters it again
  const { organizationId, providerName, issuer, clientId, domain, allowJoin, requireSso } = row;
  return { organizationId, providerName, issuer, clientId, clientSecret, domain, allowJoin, requireSso };
}

/** Where the provider describes itself (OpenID Connect discovery). */
export const discoveryUrl = (issuer: string) => `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;

/** The lower-cased domain of an email address. */
export const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/**
 * Why sign-in through the provider was refused, as `?error=` codes on the sign-in page. The page
 * shows its own text for each one, never text from the address bar.
 */
export const SSO_REFUSALS = {
  wrong_domain: "wrong_domain",
  not_invited: "not_invited",
  finish_invite: "finish_invite",
  account_off: "account_off",
  email_not_verified: "email_not_verified",
  use_sso: "use_sso",
} as const;

const refuse = (code: keyof typeof SSO_REFUSALS, message: string) => new APIError("FORBIDDEN", { code, message });

/**
 * Before Better Auth creates a person who signed in through the provider (nobody else is ever
 * created through Better Auth: setup, invitations and the demo write people themselves). They
 * must have an email at the domain, and an invitation, unless anyone at the domain may join.
 */
export async function userFromSso(sso: SsoConfig | null, user: { email: string; name?: string | null; emailVerified?: boolean }) {
  if (!sso) throw refuse("not_invited", "Single sign-on isn't set up.");
  if (!user.emailVerified) throw refuse("email_not_verified", "Your provider hasn't verified that email address.");
  const email = user.email.toLowerCase();
  if (domainOf(email) !== sso.domain) throw refuse("wrong_domain", `Only ${sso.domain} addresses can sign in here.`);
  const invite = await prisma.invite.findFirst({
    where: { organizationId: sso.organizationId, email: { equals: email, mode: "insensitive" }, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  // Someone already in the organization without a login (from an import) is joined up through their invitation.
  if (invite?.userId) throw refuse("finish_invite", "Open your invitation email first to set up your account.");
  if (!invite && !sso.allowJoin) throw refuse("not_invited", "Ask an admin to invite you first.");
  return {
    organizationId: sso.organizationId,
    role: invite?.role ?? "member",
    name: user.name?.trim() || invite?.name || email,
  };
}

/** After a person was created through the provider: their invitation has been used. */
export async function inviteUsed(sso: SsoConfig | null, email: string) {
  if (!sso) return;
  await prisma.invite.deleteMany({ where: { organizationId: sso.organizationId, email: { equals: email, mode: "insensitive" }, userId: null } });
}

/**
 * Before the provider's account is linked to an existing person: same organization, an email at
 * the domain, and not turned off. Anything else (another organization's person, an address the
 * domain doesn't own) is refused, so the provider can only ever reach this organization's people.
 */
export async function checkLink(sso: SsoConfig | null, account: { providerId: string; userId: string }) {
  if (account.providerId !== SSO_PROVIDER) return;
  if (!sso) throw refuse("not_invited", "Single sign-on isn't set up.");
  const user = await prisma.user.findUnique({ where: { id: account.userId }, select: { organizationId: true, email: true, deactivatedAt: true } });
  // Not found: the person was created a moment ago in this same sign-in, inside its transaction,
  // and userFromSso has just checked them.
  if (!user) return;
  if (user.organizationId !== sso.organizationId) throw refuse("not_invited", "Ask an admin to invite you first.");
  if (domainOf(user.email) !== sso.domain) throw refuse("wrong_domain", `Only ${sso.domain} addresses can sign in here.`);
  if (user.deactivatedAt) throw refuse("account_off", "This account has been turned off. Ask an admin to turn it back on.");
}

/** With requireSso, a password only signs admins in; everyone else uses the provider. */
export async function checkPasswordSignIn(sso: SsoConfig | null, userId: string) {
  if (!sso?.requireSso) return;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, organizationId: true } });
  if (user && user.organizationId === sso.organizationId && user.role !== "admin") {
    throw new APIError("FORBIDDEN", { code: "use_sso", message: `Your organization signs in with ${sso.providerName}. Use “Sign in with ${sso.providerName}” instead.` });
  }
}

/**
 * The profile from the provider. An email it says it hasn't verified can't link to anyone
 * (Better Auth only links verified emails) or create anyone (userFromSso). Microsoft Entra sends
 * no email_verified at all for work accounts; those are the organization's own, so they count,
 * but only from Entra: any other provider has to say the email is verified.
 */
export function profileToUser(profile: Record<string, unknown>, issuer: string) {
  const email = typeof profile.email === "string" ? profile.email.toLowerCase() : "";
  const name = typeof profile.name === "string" && profile.name.trim() ? profile.name.trim() : email;
  const claim = profile.email_verified;
  // Entra's issuers: the global cloud, its government and China clouds, and the older v1 address.
  const entra = /^https:\/\/(login\.microsoftonline\.(com|us)|login\.partner\.microsoftonline\.cn|sts\.windows\.net)\//.test(issuer);
  const emailVerified = claim === true || claim === "true" || (claim === undefined && entra);
  return { email, name, emailVerified };
}
