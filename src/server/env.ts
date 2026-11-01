import { existsSync } from "node:fs";

// Local development keeps settings in .env. Tests set their own values and must
// never pick up the development database by accident.
if (!process.env.VITEST && existsSync(".env")) process.loadEnvFile(".env");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. See .env.example.`);
  return value;
}

// The development examples in .env.example. They are public knowledge, so a real install must not run on them.
const EXAMPLE_SECRET = "dev-only-secret-not-for-real-installs-0123456789";
const EXAMPLE_SETUP_CODE = "local-setup-code-1234";
export const isExampleSecret = (value: string) => value === EXAMPLE_SECRET;
const isProduction = process.env.NODE_ENV === "production";

const secret = required("BETTER_AUTH_SECRET");
if (secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters.");
if (isProduction && isExampleSecret(secret)) {
  throw new Error("BETTER_AUTH_SECRET is the example value from .env.example. Make a real one: openssl rand -base64 32");
}

const port = Number(process.env.PORT ?? 3000);

/**
 * The app's own web address. Set it by hand with BETTER_AUTH_URL (a custom domain), or let the
 * host give it: Render sets RENDER_EXTERNAL_URL and Railway sets RAILWAY_PUBLIC_DOMAIN, so
 * customers on either never have to type it.
 */
export function appAddress(vars: Record<string, string | undefined>, port: number): string {
  // Without a trailing slash, so links don't come out as https://x//pay/….
  if (vars.BETTER_AUTH_URL) return vars.BETTER_AUTH_URL.replace(/\/+$/, "");
  if (vars.RENDER_EXTERNAL_URL) return vars.RENDER_EXTERNAL_URL;
  if (vars.RAILWAY_PUBLIC_DOMAIN) return `https://${vars.RAILWAY_PUBLIC_DOMAIN}`;
  return `http://localhost:${port}`;
}

export const env = {
  isProduction,
  port,
  databaseUrl: required("DATABASE_URL"),
  authSecret: secret,
  baseUrl: appAddress(process.env, port),
};

/**
 * On Render, the page of Render's dashboard that holds this service's SETUP_CODE (Render makes the
 * code; see render.yaml). Null anywhere else. The ID only opens the page for someone signed in to
 * the Render account, and the setup page shows it only until the install is claimed.
 */
export function setupCodeSettingsUrl(vars: Record<string, string | undefined>): string | null {
  const id = vars.RENDER_SERVICE_ID;
  return id && /^srv-[a-z0-9]{1,64}$/.test(id) ? `https://dashboard.render.com/web/${id}/env` : null;
}

// Read on every request rather than at startup, so tests can change it.
export const MIN_SETUP_CODE_LENGTH = 16;
export function setupCode(): string | undefined {
  const code = process.env.SETUP_CODE?.trim();
  if (!code || code.length < MIN_SETUP_CODE_LENGTH) return undefined;
  // The example from .env.example counts as not set on a real install.
  if (process.env.NODE_ENV === "production" && code === EXAMPLE_SETUP_CODE) return undefined;
  return code;
}

/**
 * How many proxies sit between the internet and the app (TRUST_PROXY). They decide which
 * entry of X-Forwarded-For is the visitor's address; 0 means the header is never believed.
 */
export function trustProxy(): number {
  const hops = Number(process.env.TRUST_PROXY ?? 0);
  return Number.isInteger(hops) && hops > 0 ? hops : 0;
}

// Demo mode: one shared deployment where every visitor gets a private
// workspace that is deleted after DEMO_HOURS. Read per request so tests can switch it.
export const isDemoMode = () => process.env.DEMO_MODE === "true";
export const DEMO_HOURS = 2;
export const demoMaxWorkspaces = () => Number(process.env.DEMO_MAX_WORKSPACES ?? 300);

