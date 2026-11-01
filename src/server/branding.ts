import { Hono, type Context } from "hono";
import { COLOR_MODES, HEX_COLOR, type ColorModeName } from "../shared/color.ts";
import { prisma, type OrgDb } from "./db.ts";
import { checkLogo } from "./logo.ts";
import { readBody, requireAdmin, type SignedIn } from "./http.ts";
import { isCurrency } from "../shared/money.ts";
import { currencies, ratesOf, readRate } from "./currency.ts";
import { loadSso } from "./sso.ts";
import { diff, recordAudit } from "./audit.ts";

export type Branding = {
  name: string | null;
  /** Replaces the product name in the interface. Null means the product name. */
  appName: string | null;
  accentColor: string | null;
  colorMode: ColorModeName;
  /** Changes whenever the logo does, so browsers fetch the new one. Null when there is no logo. */
  logoVersion: number | null;
};
const DEFAULT: Branding = { name: null, appName: null, accentColor: null, colorMode: "system", logoVersion: null };
const FIELDS = { name: true, appName: true, accentColor: true, colorMode: true, logo: { select: { updatedAt: true } } } as const;

type Row = { name: string; appName: string | null; accentColor: string | null; colorMode: ColorModeName; logo: { updatedAt: Date } | null };
const toBranding = ({ logo, ...rest }: Row): Branding => ({ ...rest, logoVersion: logo?.updatedAt.getTime() ?? null });

// The sign-in screen shows the install's own branding before anyone signs in.
// Only the organization created by setup is ever exposed here; the demo, with
// many organizations and no setup, gets the default look.
export async function installOrganizationId(): Promise<string | null> {
  const installation = await prisma.installation.findUnique({ where: { id: 1 } });
  return installation?.organizationId ?? null;
}

async function serveLogo(c: Context, logo: { contentType: string; data: Uint8Array; updatedAt: Date } | null) {
  if (!logo) return c.json({ error: "No logo." }, 404);
  const etag = `"${logo.updatedAt.getTime()}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "no-cache");
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  c.header("Content-Type", logo.contentType);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Disposition", "inline");
  return c.body(new Uint8Array(logo.data));
}

export const publicBrandingRoutes = new Hono()
  .get("/", async (c) => {
    const organizationId = await installOrganizationId();
    const row = organizationId && (await prisma.organization.findUnique({ where: { id: organizationId }, select: FIELDS }));
    // The single sign-on button, if the organization has a provider set up (sso.ts).
    const sso = organizationId ? await loadSso() : null;
    const button = sso && sso.organizationId === organizationId ? { name: sso.providerName, required: sso.requireSso } : null;
    return c.json({ ...(row ? toBranding(row) : DEFAULT), sso: button });
  })
  .get("/logo", async (c) => {
    const organizationId = await installOrganizationId();
    return serveLogo(c, organizationId ? await prisma.logo.findUnique({ where: { organizationId } }) : null);
  });

const adminOnly = requireAdmin("change these settings");

// The signed-in person's own organization's logo, for the app's header.
export const logoRoutes = new Hono<SignedIn>().get("/", async (c) => serveLogo(c, await c.get("db").logo.findFirst()));

export const appearanceRoutes = new Hono<SignedIn>()
  .put("/", adminOnly, async (c) => {
    const body = await readBody(c);
    const { accentColor, colorMode } = body;
    if (accentColor !== null && (typeof accentColor !== "string" || !HEX_COLOR.test(accentColor))) {
      return c.json({ error: "Choose a color like #2b4a78, or reset to the default." }, 400);
    }
    if (typeof colorMode !== "string" || !COLOR_MODES.includes(colorMode as ColorModeName)) {
      return c.json({ error: "Choose System, Light or Dark." }, 400);
    }

    const row = await c.get("db").organization.update({
      where: { id: c.get("user").organizationId },
      data: { accentColor: accentColor?.toLowerCase() ?? null, colorMode: colorMode as ColorModeName },
      select: FIELDS,
    });
    return c.json(toBranding(row));
  })
  // The request body is the image file itself.
  .put("/logo", adminOnly, async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const result = checkLogo(bytes);
    if ("error" in result) return c.json({ error: result.error }, result.status);

    const data = { contentType: result.contentType, width: result.width, height: result.height, data: bytes };
    const logo = await c.get("db").logo.upsert({
      where: { organizationId: c.get("user").organizationId },
      create: data as typeof data & { organizationId: string }, // orgDb fills in organizationId
      update: data,
      select: { updatedAt: true },
    });
    return c.json({ logoVersion: logo.updatedAt.getTime() });
  })
  .delete("/logo", adminOnly, async (c) => {
    await c.get("db").logo.deleteMany();
    return c.json({ logoVersion: null });
  });

/** The other currencies clients are billed in, with their exchange rates as typed ("1.08"). */
async function otherCurrencies(db: OrgDb) {
  const { home, rates } = await currencies(db);
  const used = await db.client.groupBy({ by: ["currency"], where: { currency: { not: home } }, _count: { _all: true } });
  return used
    .map((u) => ({ currency: u.currency, clients: u._count._all, rate: rates[u.currency] ? String(rates[u.currency]! / 1_000_000) : "" }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/** The exchange rates as the history shows them: "EUR 1.08, GBP 1.27". */
const ratesText = (rates: Record<string, number>) =>
  Object.entries(rates).sort(([a], [b]) => a.localeCompare(b)).map(([code, micros]) => `${code} ${micros / 1_000_000}`).join(", ");

// Manage → Settings: the organization's name, the app's name, currency, exchange rates and address.
export const companyRoutes = new Hono<SignedIn>()
  // What the Settings screen needs beyond Me: whether the currency can still change, and the
  // other currencies clients are billed in, with their exchange rates (currency.ts).
  .get("/", adminOnly, async (c) => {
    const db = c.get("db");
    const organization = await db.organization.findFirstOrThrow({ select: { name: true, appName: true, currency: true, address: true } });
    const currencyLocked = (await db.invoice.count()) > 0 || (await db.expense.count()) > 0;
    return c.json({ organization, currencyLocked, otherCurrencies: await otherCurrencies(db) });
  })
  .put("/", adminOnly, async (c) => {
  const body = await readBody(c);
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const name = text(body.name);
  const appName = text(body.appName);
  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (!name || name.length > 100) return c.json({ error: "Enter your company name (up to 100 characters)." }, 400);
  if (appName.length > 40) return c.json({ error: "Keep the app name to 40 characters." }, 400);
  if (!isCurrency(body.currency)) return c.json({ error: "Choose a currency from the list." }, 400);
  const currency = body.currency;
  if (address.length > 500) return c.json({ error: "Keep the address to 500 characters." }, 400);

  const db = c.get("db");
  const before = await db.organization.findFirstOrThrow({ select: { name: true, appName: true, currency: true, address: true, exchangeRates: true } });
  const beforeRates = ratesOf(before.exchangeRates);
  const others = await otherCurrencies(db);
  // Invoices and expenses are amounts in the currency they were made in; the app doesn't convert them.
  if (currency !== before.currency && ((await db.invoice.count()) || (await db.expense.count()))) {
    return c.json({ error: `The currency can't change once there are invoices or expenses: their amounts are in ${before.currency}.` }, 409);
  }
  // Exchange rates are against the home currency, so it stays while clients use others.
  if (currency !== before.currency && others.length) {
    return c.json({ error: `Some clients are billed in ${others.map((o) => o.currency).join(" and ")}, at exchange rates against ${before.currency}. Change those clients to ${before.currency} first.` }, 409);
  }
  // `exchangeRates`, when sent: { "EUR": "1.08" } for each other currency clients use.
  let rates = currency === before.currency ? beforeRates : {};
  if (currency === before.currency && body.exchangeRates !== undefined) {
    const sent = body.exchangeRates;
    if (!sent || typeof sent !== "object" || Array.isArray(sent)) return c.json({ error: "Enter each exchange rate as a number, like 1.08." }, 400);
    rates = {};
    for (const [code, value] of Object.entries(sent as Record<string, unknown>)) {
      if (!isCurrency(code) || code === currency) continue;
      const micros = readRate(value);
      if (micros === null) return c.json({ error: `Enter what 1 ${code} is worth in ${currency} as a number, like 1.08.` }, 400);
      rates[code] = micros;
    }
    const missing = others.find((o) => !rates[o.currency]);
    if (missing) return c.json({ error: `Clients are billed in ${missing.currency}, so it needs an exchange rate.` }, 400);
  }
  const organization = await db.$transaction(async (tx) => {
    const after = await tx.organization.update({
      where: { id: c.get("user").organizationId },
      data: { name, appName: appName || null, currency, address, exchangeRates: rates },
      select: { name: true, appName: true, currency: true, address: true },
    });
    // Clients billed in the old home currency move with it (nothing has been invoiced yet).
    if (currency !== before.currency) await tx.client.updateMany({ where: { currency: before.currency }, data: { currency } });
    const changes = diff({ ...before, exchangeRates: ratesText(beforeRates) }, { ...after, exchangeRates: ratesText(rates) }, ["name", "appName", "currency", "address", "exchangeRates"]);
    await recordAudit(tx as OrgDb, c.get("user"), { kind: "settings", action: "changed", label: "Company details", changes });
    return after;
  });
  return c.json({ organization, otherCurrencies: await otherCurrencies(db) });
  });
