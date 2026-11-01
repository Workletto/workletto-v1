import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { auth } from "./auth.ts";
import { orgDb, prisma } from "./db.ts";
import { checkBudgets } from "./budget.ts";
import { DEMO_HOURS, demoMaxWorkspaces, isDemoMode } from "./env.ts";
import { demoStartsPerIp } from "./rateLimit.ts";
import { limitIp } from "./clientIp.ts";
import { generateDataset, type DemoDataset } from "./demoDataset.ts";
import { writeDataset } from "./demoWrite.ts";
import { daysBetween, isIsoDate } from "../shared/time.ts";
import { signInAs } from "./http.ts";
import { DEMO_LOGO } from "./demoLogo.ts";

// The live demo runs the real app with DEMO_MODE=true. Each visitor gets their
// own organization with sample people, signed in as its admin. Every query is
// already limited to one organization (see orgDb), so visitors never see each
// other's workspaces. Workspaces are deleted after DEMO_HOURS.


/** How many months of history a visitor's workspace gets. The full two years stay available to `npm run demo:load`. */
export const DEMO_MONTHS = 6;

// The same day gives the same dataset, so remember the last one instead of rebuilding it for every visitor.
let remembered: { key: string; dataset: DemoDataset } | null = null;
function datasetFor(today: string) {
  if (remembered?.key !== today) remembered = { key: today, dataset: generateDataset({ today, months: DEMO_MONTHS }) };
  return remembered.dataset;
}

/** Deletes expired demo workspaces; everything in them goes too (cascading deletes). */
export async function deleteExpiredDemos(now = new Date()) {
  const { count } = await prisma.organization.deleteMany({ where: { demoExpiresAt: { lt: now } } });
  return count;
}

/** Keeps the number of live workspaces under the cap by removing the oldest ones. */
async function makeRoom() {
  const max = demoMaxWorkspaces();
  const live = await prisma.organization.count({ where: { demoExpiresAt: { not: null } } });
  if (live < max) return;
  const oldest = await prisma.organization.findMany({
    where: { demoExpiresAt: { not: null } },
    orderBy: { createdAt: "asc" },
    take: live - max + 1,
    select: { id: true },
  });
  await prisma.organization.deleteMany({ where: { id: { in: oldest.map((o) => o.id) } } });
}

export const demoRoutes = new Hono().post("/start", async (c) => {
  if (!isDemoMode()) return c.json({ error: "Not found." }, 404);
  if (!demoStartsPerIp.hit(limitIp(c))) {
    return c.json({ error: "You've started several demos in the last hour. Try again later." }, 429);
  }

  await deleteExpiredDemos();
  await makeRoom();

  // The history ends on the visitor's own today, if their clock is roughly right.
  const { today } = ((await c.req.json().catch(() => null)) ?? {}) as { today?: unknown };
  const serverToday = new Date().toISOString().slice(0, 10);
  const seedToday = isIsoDate(today) && Math.abs(daysBetween(serverToday, today)) <= 1 ? today : serverToday;

  // Nobody ever learns these: the visitor is signed in straight away.
  // A short random domain keeps each workspace's addresses unique and readable.
  const domain = `demo-${randomBytes(5).toString("hex")}.invalid`;
  const email = `you@${domain}`;
  const password = randomBytes(24).toString("base64url");
  const ctx = await auth.$context;
  const passwordHash = await ctx.password.hash(password);

  const dataset = datasetFor(seedToday);
  const organizationId = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: { name: "Demo Studio", demoExpiresAt: new Date(Date.now() + DEMO_HOURS * 60 * 60 * 1000) },
    });
    const admin = await tx.user.create({
      data: { name: "You", email, role: "admin", organizationId: organization.id },
    });
    // A logo, so the demo shows what a customer's own brand looks like.
    await tx.logo.create({ data: { organizationId: organization.id, ...DEMO_LOGO, data: new Uint8Array(DEMO_LOGO.data) } });
    await tx.account.create({
      data: { userId: admin.id, accountId: admin.id, providerId: "credential", password: passwordHash },
    });
    await writeDataset(tx, organization.id, admin.id, domain, dataset);
    return organization.id;
  }, { timeout: 30_000 });
  await checkBudgets(orgDb(organizationId), "all", false);

  await signInAs(c, email, password);
  return c.json({ ok: true }, 201);
});

// Auth features a demo visitor must not use.
export const DEMO_BLOCKED_AUTH_PATHS = ["/api/auth/change-password", "/api/auth/update-user", "/api/auth/two-factor/enable"];
