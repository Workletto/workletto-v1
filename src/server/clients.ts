import { Hono } from "hono";
import type { OrgDb } from "./db.ts";
import { requireManager, isStillReferenced, readBody, readName, type SignedIn } from "./http.ts";
import { canManageWork } from "../shared/roles.ts";
import { isEmail } from "../shared/email.ts";
import { isCurrency } from "../shared/money.ts";
import { currencies, readRate } from "./currency.ts";
import { readCustomFields, saveCustomFields } from "./customFields.ts";

// Clients are the companies a studio works for. Everyone can see their names;
// only admins and managers see their billing details, and add, rename, archive
// or delete them. Each client is billed in one currency (currency.ts).

const SELECT = {
  id: true, name: true, address: true, email: true, currency: true, archived: true, _count: { select: { projects: true } },
  // Custom fields in use (WRK-148).
  customValues: { where: { field: { archivedAt: null } }, select: { fieldId: true, value: true } },
} as const;
type Row = { id: string; name: string; address: string; email: string; currency: string; archived: boolean; _count: { projects: number }; customValues: { fieldId: string; value: string }[] };
const toClient = ({ _count, customValues, ...rest }: Row) => ({ ...rest, projectCount: _count.projects, customFields: Object.fromEntries(customValues.map((v) => [v.fieldId, v.value])) });

const NAME_ERROR = "Enter a client name (up to 200 characters).";
const taken = (name: string) => `There's already a client called ${name}.`;

/**
 * Checks a currency for a client, and saves its exchange rate when one is given (`exchangeRate`,
 * like "1.08": what one unit is worth in the home currency). A currency other than the home one
 * needs a rate, so reports can add its amounts up. Returns an error message, or null.
 */
async function useCurrency(db: OrgDb, currency: unknown, exchangeRate: unknown): Promise<string | null> {
  if (!isCurrency(currency)) return "Choose a currency from the list.";
  const { home, rates } = await currencies(db);
  if (currency === home) return null;
  if (exchangeRate === undefined || exchangeRate === null || exchangeRate === "") {
    return rates[currency] ? null : `Enter what 1 ${currency} is worth in ${home}, like 1.08. Reports use it to add amounts up.`;
  }
  const micros = readRate(exchangeRate);
  if (micros === null) return `Enter what 1 ${currency} is worth in ${home} as a number, like 1.08.`;
  await db.organization.updateMany({ data: { exchangeRates: { ...rates, [currency]: micros } } });
  return null;
}

/** Why a client's currency can't change now, or null if it can. */
async function currencyLocked(db: OrgDb, clientId: string, to: string) {
  const client = await db.client.findFirst({ where: { id: clientId }, select: { currency: true } });
  if (!client || client.currency === to) return null;
  const [invoices, expenses] = await Promise.all([
    db.invoice.count({ where: { clientId } }),
    db.expense.count({ where: { project: { clientId } } }),
  ]);
  if (invoices || expenses) return `The currency can't change once the client has invoices or expenses: their amounts are in ${client.currency}.`;
  const { home } = await currencies(db);
  // People's own rates are in the home currency, so they can't bill a client in another one.
  if (to !== home && (await db.project.count({ where: { clientId, billBy: "person", fixedFee: null } }))) {
    return `Some of this client's projects bill at each person's own rate, which is in ${home}. Give them a project rate or a fixed fee first.`;
  }
  return null;
}

export const clientRoutes = new Hono<SignedIn>()
  .get("/", async (c) => {
    const rows = await c.get("db").client.findMany({ select: SELECT, orderBy: { name: "asc" } });
    if (!canManageWork(c.get("user").role)) return c.json({ clients: rows.map(({ id, name, archived }) => ({ id, name, archived })) });
    // The exchange rates already set ("1.08" for EUR), so a client's form can offer them.
    const { rates } = await currencies(c.get("db"));
    const exchangeRates = Object.fromEntries(Object.entries(rates).map(([code, micros]) => [code, String(micros / 1_000_000)]));
    return c.json({ clients: rows.map(toClient), exchangeRates });
  })
  .post("/", requireManager("add clients"), async (c) => {
    const body = await readBody(c);
    const db = c.get("db");
    const name = readName(body.name);
    if (!name) return c.json({ error: NAME_ERROR }, 400);
    // Names are told apart ignoring capitals, archived clients included.
    if (await db.client.findFirst({ where: { name: { equals: name, mode: "insensitive" } }, select: { id: true } })) return c.json({ error: taken(name) }, 409);
    // Billed in the home currency unless another is chosen.
    const currency = body.currency ?? (await currencies(db)).home;
    const problem = await useCurrency(db, currency, body.exchangeRate);
    if (problem) return c.json({ error: problem }, 400);
    const fields = await readCustomFields(db, "client", body, true);
    if (!(fields instanceof Map)) return c.json(fields, 400);
    const row = await db.$transaction(async (tx) => {
      const created = await tx.client.create({ data: { name, currency } as { name: string; currency: string; organizationId: string } /* orgDb fills it in */, select: { id: true } });
      await saveCustomFields(tx as OrgDb, "client", created.id, fields);
      return tx.client.findFirstOrThrow({ where: { id: created.id }, select: SELECT });
    });
    return c.json({ client: toClient(row) }, 201);
  })
  .patch("/:id", requireManager("change clients"), async (c) => {
    const body = await readBody(c);
    const data: { name?: string; archived?: boolean; address?: string; email?: string; currency?: string } = {};
    if ("name" in body) {
      const name = readName(body.name);
      if (!name) return c.json({ error: NAME_ERROR }, 400);
      if (await c.get("db").client.findFirst({ where: { name: { equals: name, mode: "insensitive" }, id: { not: c.req.param("id") } }, select: { id: true } })) return c.json({ error: taken(name) }, 409);
      data.name = name;
    }
    if ("address" in body) {
      if (typeof body.address !== "string" || body.address.length > 500) return c.json({ error: "Keep the address to 500 characters." }, 400);
      data.address = body.address.trim();
    }
    if ("email" in body) {
      const email = typeof body.email === "string" ? body.email.trim() : "";
      if (email && (email.length > 254 || !isEmail(email))) return c.json({ error: "Enter a valid email address, or leave it empty." }, 400);
      data.email = email;
    }
    if ("archived" in body) {
      if (typeof body.archived !== "boolean") return c.json({ error: "Archived must be true or false." }, 400);
      data.archived = body.archived;
    }
    const db = c.get("db");
    if ("currency" in body) {
      if (!isCurrency(body.currency)) return c.json({ error: "Choose a currency from the list." }, 400);
      const locked = await currencyLocked(db, c.req.param("id"), body.currency);
      if (locked) return c.json({ error: locked }, 409);
      const problem = await useCurrency(db, body.currency, body.exchangeRate);
      if (problem) return c.json({ error: problem }, 400);
      data.currency = body.currency;
    }
    const fields = await readCustomFields(db, "client", body, false);
    if (!(fields instanceof Map)) return c.json(fields, 400);
    const count = await db.$transaction(async (tx) => {
      const { count } = await tx.client.updateMany({ where: { id: c.req.param("id") }, data });
      if (count) await saveCustomFields(tx as OrgDb, "client", c.req.param("id"), fields);
      return count;
    });
    if (!count) return c.json({ error: "Client not found." }, 404);
    return c.json({ client: toClient(await db.client.findFirstOrThrow({ where: { id: c.req.param("id") }, select: SELECT })) });
  })
  // Only a client with no projects can be deleted; otherwise archive it.
  .delete("/:id", requireManager("delete clients"), async (c) => {
    const db = c.get("db");
    try {
      const { count } = await db.client.deleteMany({ where: { id: c.req.param("id") } });
      if (!count) return c.json({ error: "Client not found." }, 404);
    } catch (error) {
      if (!isStillReferenced(error)) throw error;
      return c.json({ error: "This client has projects or invoices. Archive it instead." }, 409);
    }
    return c.json({ ok: true });
  });
