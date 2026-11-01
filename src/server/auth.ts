import { createHmac } from "node:crypto";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { genericOAuth, twoFactor } from "better-auth/plugins";
import { MIN_PASSWORD_LENGTH } from "../shared/limits.ts";
import { NEUTRAL_APP_NAME } from "../shared/product.ts";
import { prisma } from "./db.ts";
import { env } from "./env.ts";
import { checkLink, checkPasswordSignIn, discoveryUrl, inviteUsed, loadSso, profileToUser, SSO_PROVIDER, userFromSso, type SsoConfig } from "./sso.ts";

export const MAX_PASSWORD_LENGTH = 128;

const withoutTokens = <T extends Record<string, unknown>>(account: T) => ({
  ...account,
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
});

// Turned off until a feature needs them. Each one is attack surface on installs the vendor
// cannot patch. Single sign-on (sso.ts) turns on "/sign-in/social" for its provider only.
const DISABLED_PATHS = [
  "/sign-up/email",
  "/sign-in/social",
  "/link-social",
  "/delete-user",
  "/change-email",
  "/request-password-reset",
  "/reset-password",
  "/send-verification-email",
  "/verify-email",
  // Names and emails change only through Manage → People, where they're checked and recorded
  // in History; sessions and accounts are managed by the app itself.
  "/update-user",
  "/update-session",
  "/list-accounts",
  "/unlink-account",
  "/get-access-token",
  "/refresh-token",
  "/account-info",
  // Checks a password for a signed-in session; the app never needs it, and it would let a stolen
  // session guess the password without the sign-in limits.
  "/verify-password",
  // Two-factor sign-in (WRK-147) uses an authenticator app and backup codes only: no codes by
  // email, and the setup address is shown once, when it's set up.
  "/two-factor/send-otp",
  "/two-factor/verify-otp",
  "/two-factor/get-totp-uri",
];

/**
 * Backup codes are kept only as keyed hashes (WRK-147). Better Auth checks a code by looking for
 * it in the stored list, so the list holds hashes and each code typed in is hashed first (the
 * before hook below). The codes contain no colon, so a stored hash is never hashed again.
 */
const BACKUP_HASH = "h1:";
export const hashBackupCode = (code: string) => BACKUP_HASH + createHmac("sha256", env.authSecret).update(`two-factor-backup-code:${code.trim()}`).digest("base64url");
const storeBackupCodes = {
  encrypt: async (json: string) => JSON.stringify((JSON.parse(json) as string[]).map((c) => (c.startsWith(BACKUP_HASH) ? c : hashBackupCode(c)))),
  decrypt: async (stored: string) => stored,
};

const WRONG_CODE = "That code didn't work. Enter the current code from your authenticator app, or one of your backup codes.";

/** Turning two-factor off takes the password (Better Auth checks it) and a current code. */
async function checkSecondFactor(headers: Headers | undefined, value: unknown) {
  const code = typeof value === "string" ? value.trim() : "";
  if (!code) throw new APIError("BAD_REQUEST", { message: "Enter a code from your authenticator app, or a backup code." });
  const totp = await auth.api.verifyTOTP({ headers: headers ?? new Headers(), body: { code } }).then(() => true, () => false);
  if (totp) return;
  const backup = await auth.api.verifyBackupCode({ headers: headers ?? new Headers(), body: { code, disableSession: true } }).then(() => true, () => false);
  if (!backup) throw new APIError("UNAUTHORIZED", { message: WRONG_CODE });
}

/** Where single sign-on finishes signing someone in. */
const isSsoCallback = (path: string | undefined) => !!path && (path.startsWith("/oauth2/callback") || path.startsWith("/callback"));

/**
 * The sign-in setup, with the organization's single sign-on provider if it has one. Better Auth
 * reads providers once, when this is built, so saving SSO settings builds it again (reloadAuth):
 * no restart. Without SSO it's exactly email and password, with everything else switched off.
 */
const buildAuth = (sso: SsoConfig | null) => betterAuth({
  // Only the fallback for the two-factor issuer name; the app sends the organization's own name.
  // Neutral on purpose: each customer's app has its own brand.
  appName: NEUTRAL_APP_NAME,
  baseURL: env.baseUrl,
  secret: env.authSecret,
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    // Nobody signs themselves up. The first admin comes from the setup screen;
    // later people are added by an admin.
    disableSignUp: true,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    maxPasswordLength: MAX_PASSWORD_LENGTH,
  },
  session: {
    additionalFields: {
      // Set by the session hook below, never by a request.
      viaSso: { type: "boolean", required: false, defaultValue: false, input: false },
    },
  },
  user: {
    additionalFields: {
      // input: false means no request can set these; only server code can. organizationId is
      // set by whoever creates the person; through single sign-on, the user.create hook sets it
      // (Better Auth checks required fields before that hook runs). The database requires it.
      organizationId: { type: "string", required: false, input: false },
      role: { type: "string", required: true, defaultValue: "member", input: false },
      deactivatedAt: { type: "date", required: false, input: false },
    },
  },
  databaseHooks: {
    session: {
      create: {
        // People an admin has turned off can't sign in. With SSO required, a password signs in
        // admins only (checked after the password, so it says nothing about who has an account).
        before: async (session, ctx) => {
          const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { deactivatedAt: true } });
          if (user?.deactivatedAt) {
            throw new APIError("FORBIDDEN", { message: "This account has been turned off. Ask an admin to turn it back on." });
          }
          if (ctx?.path === "/sign-in/email") await checkPasswordSignIn(sso, session.userId);
          // A session made from another one (turning two-factor on or off) keeps how it began.
          return { data: { ...session, viaSso: isSsoCallback(ctx?.path) || (session as { viaSso?: boolean }).viaSso === true } };
        },
      },
    },
    // Only sign-in through the provider creates people or links accounts in Better Auth (sso.ts).
    user: {
      create: {
        before: async (user) => ({ data: { ...user, ...(await userFromSso(sso, user)) } }),
        after: async (user) => inviteUsed(sso, user.email),
      },
    },
    // The provider only tells us who someone is. Its access, refresh and ID tokens are never
    // used afterwards, so they're never stored (they'd sit in the database and its backups).
    account: {
      create: {
        before: async (account) => {
          await checkLink(sso, account);
          return { data: withoutTokens(account) };
        },
      },
      update: { before: async (account) => ({ data: withoutTokens(account) }) },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      // No "trust this device": every password sign-in asks for a code.
      if (ctx.path === "/two-factor/verify-totp") return { context: { body: { ...body, trustDevice: false } } };
      if (ctx.path === "/two-factor/verify-backup-code" && typeof body.code === "string") {
        return { context: { body: { ...body, code: hashBackupCode(body.code), trustDevice: false } } };
      }
      if (ctx.path === "/two-factor/disable") await checkSecondFactor(ctx.headers, body.code);
    }),
  },
  plugins: [
    // Two-factor sign-in (WRK-147): an authenticator app, with 10 one-time backup codes. The
    // secret is encrypted with BETTER_AUTH_SECRET; wrong codes lock a sign-in attempt after 5 and
    // the account for a while after more (Better Auth's defaults), on top of app.ts's per-address limit.
    twoFactor({
      backupCodeOptions: { amount: 10, length: 10, storeBackupCodes },
    }),
    genericOAuth({
      config: sso
        ? [{
            providerId: SSO_PROVIDER,
            name: sso.providerName,
            discoveryUrl: discoveryUrl(sso.issuer),
            clientId: sso.clientId,
            clientSecret: sso.clientSecret,
            scopes: ["openid", "email", "profile"],
            pkce: true,
            mapProfileToUser: (profile) => profileToUser(profile as Record<string, unknown>, sso.issuer),
          }]
        : [],
    }),
  ],
  // Sign-in and password attempts are slowed down per address in app.ts (see rateLimit.ts),
  // with one rule that SECURITY.md explains. Better Auth's own limiter is off so there is
  // only that one: its default (3 sign-ins per 10 seconds) would stop a whole office
  // sharing one address from signing in together.
  rateLimit: { enabled: false },
  advanced: {
    database: { generateId: "uuid" },
    // The visitor's address, kept on sessions and used for rate limiting, comes only from
    // the header app.ts sets after working it out (see clientIp.ts), never from the visitor.
    ipAddress: { ipAddressHeaders: ["x-client-ip"] },
  },
  // Without SSO, people sign in with their email and password only, and there's nothing to
  // link. With it, the provider's account links to the person with the same email, if the
  // provider verified it (emails here are set by admins, so they count as they are), within
  // checkLink's rules.
  account: {
    accountLinking: sso ? { enabled: true, requireLocalEmailVerified: false, allowDifferentEmails: false } : { enabled: false },
  },
  disabledPaths: sso ? DISABLED_PATHS.filter((p) => p !== "/sign-in/social") : DISABLED_PATHS,
  // The app never phones home, to the vendor or to anyone else.
  telemetry: { enabled: false },
});

/** The sign-in setup in use. A live binding: everything that imports it sees a rebuilt one. */
/**
 * Sign-in sessions that ran out more than a day ago are deleted, together with the IP address
 * and browser they recorded (WRK-143). An expired session can't be used anyway; the day's margin
 * keeps a slightly fast server clock from cutting off one that's still valid.
 */
export async function deleteExpiredSessions(now = new Date()): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } } });
  return count;
}

export let auth = buildAuth(null);

/** Builds the sign-in setup again with the SSO settings as saved now. The server calls it once at startup. */
export async function reloadAuth() {
  auth = buildAuth(await loadSso());
}

/** A signed-in person. Every person belongs to an organization: the database requires it. */
export type SessionUser = Omit<typeof auth.$Infer.Session.user, "organizationId"> & { organizationId: string };
