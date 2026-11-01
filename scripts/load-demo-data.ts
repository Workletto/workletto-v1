// Loads two years of a made-up studio into an empty database, as a normal installation (not a demo
// workspace), for screenshots, QA and trying the app. Run with `npm run demo:load`.
//
//   DATABASE_URL        the database to fill (its name must end in _test, _staging or _demo)
//   DEMO_ADMIN_EMAIL    the admin's sign-in email (default admin@demo.invalid)
//
// It makes up a password for the admin and prints it once.
import { randomBytes } from "node:crypto";

const url = process.env.DATABASE_URL ?? "";
const name = (() => {
  try {
    return new URL(url).pathname.slice(1);
  } catch {
    return "";
  }
})();
if (!/_(test|staging|demo)$/.test(name)) {
  console.error(`Refusing to load demo data into "${name || "(no DATABASE_URL)"}": the database name must end in _test, _staging or _demo.`);
  process.exit(1);
}

const { orgDb, prisma } = await import("../src/server/db.ts");
const { checkBudgets } = await import("../src/server/budget.ts");
const { auth } = await import("../src/server/auth.ts");
const { generateDataset } = await import("../src/server/demoDataset.ts");
const { writeDataset } = await import("../src/server/demoWrite.ts");

if ((await prisma.installation.count()) > 0) {
  console.error("This database already has an installation. Use an empty database.");
  await prisma.$disconnect();
  process.exit(1);
}

const email = (process.env.DEMO_ADMIN_EMAIL || "admin@demo.invalid").trim().toLowerCase();
const password = randomBytes(18).toString("base64url");
const passwordHash = await (await auth.$context).password.hash(password);
const dataset = generateDataset({ today: new Date().toISOString().slice(0, 10), months: 24 });

const started = Date.now();
const organizationId = await prisma.$transaction(
  async (tx) => {
    await tx.installation.create({ data: { id: 1 } });
    const organization = await tx.organization.create({ data: { name: "Demo Studio" } });
    await tx.installation.update({ where: { id: 1 }, data: { organizationId: organization.id } });
    const admin = await tx.user.create({ data: { name: "You", email, role: "admin", organizationId: organization.id } });
    await tx.account.create({ data: { userId: admin.id, accountId: admin.id, providerId: "credential", password: passwordHash } });
    await writeDataset(tx, organization.id, admin.id, "demo.invalid", dataset);
    return organization.id;
  },
  { timeout: 120_000 },
);
await checkBudgets(orgDb(organizationId), "all", false);
await prisma.$disconnect();

console.log(`Loaded ${dataset.entries.length} time entries and ${dataset.invoices.length} invoices in ${Date.now() - started} ms.`);
console.log(`Sign in as ${email} with the password ${password}`);
console.log("This password is shown once.");
