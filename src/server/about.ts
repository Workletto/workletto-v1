import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { prisma } from "./db.ts";
import { requireAdmin, type SignedIn } from "./http.ts";
import { env, isDemoMode, trustProxy } from "./env.ts";
import { changeGroups, changelogSection } from "../shared/changelog.ts";
import { DONATION_PROMPT_AFTER_DAYS } from "../shared/product.ts";

// Settings → About: the installed version, what it changed, a diagnostics file an admin can
// download to look into a problem, and the one-time donation card. Nothing here is sent
// anywhere by the app itself, and the diagnostics hold no secrets, addresses or business data.

/** A file from the app's folder (package.json, CHANGELOG.md), or "" when it isn't there. */
function appFile(name: string) {
  try {
    return readFileSync(join(process.cwd(), name), "utf8");
  } catch {
    return "";
  }
}

export const appVersion = (): string => {
  try {
    return (JSON.parse(appFile("package.json")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
};

async function migrations() {
  const rows = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
    SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name`;
  const applied = rows.filter((r) => r.finished_at && !r.rolled_back_at);
  const last = applied.at(-1);
  return {
    applied: applied.length,
    // Started but never finished: an update whose database step failed.
    unfinished: rows.filter((r) => !r.finished_at && !r.rolled_back_at).map((r) => r.migration_name),
    latest: last?.migration_name ?? null,
    latestAppliedAt: last?.finished_at?.toISOString() ?? null,
  };
}

export const aboutRoutes = new Hono<SignedIn>()
  .use(requireAdmin("see what's installed"))
  .get("/", async (c) => {
    const version = appVersion();
    const changelog = appFile("CHANGELOG.md");
    const section = changelogSection(changelog, version) ?? changelogSection(changelog, "Unreleased");
    const { applied, unfinished, latest, latestAppliedAt } = await migrations();
    return c.json({
      version,
      // "[0.8.0] - 2026-11-02" reads as "0.8.0 · 2026-11-02".
      notes: section && section.body ? { title: section.title.replace(/^\[([^\]]+)\](?:\s*-\s*)?/, (_, v: string) => `${v} · `).replace(/ · $/, ""), groups: changeGroups(section.body) } : null,
      database: { migrations: applied, unfinished, latest, latestAppliedAt },
    });
  })
  // The one-time donation card on the Time screen (WRK-168): admins only (this whole route is),
  // 14 days after setup, once the team has tracked time, until an admin donates or dismisses it.
  // The card is a plain link to the vendor's site; the app records only that it was dismissed.
  .get("/donation", async (c) => {
    if (isDemoMode()) return c.json({ show: false });
    const db = c.get("db");
    const org = await db.organization.findFirstOrThrow({ select: { createdAt: true, donationPromptDismissedAt: true } });
    if (org.donationPromptDismissedAt) return c.json({ show: false });
    const days = (Date.now() - org.createdAt.getTime()) / 86_400_000;
    if (days < DONATION_PROMPT_AFTER_DAYS) return c.json({ show: false });
    const tracked = await db.timeEntry.findFirst({ select: { id: true } });
    return c.json({ show: tracked !== null });
  })
  .post("/donation/dismiss", async (c) => {
    await c.get("db").organization.update({
      where: { id: c.get("user").organizationId },
      data: { donationPromptDismissedAt: new Date() },
    });
    return c.json({ ok: true });
  })
  // For looking into a problem, only when an admin downloads it: no secrets, addresses or business data.
  .get("/diagnostics", async (c) => {
    const db = c.get("db");
    const [database, server, email, payments] = await Promise.all([
      migrations(),
      prisma.$queryRaw<{ server_version: string }[]>`SHOW server_version`,
      db.emailSettings.findFirst({ select: { provider: true, lastError: true } }),
      db.paymentSettings.findFirst({ select: { provider: true, mode: true, webhookId: true, lastError: true } }),
    ]);
    const now = new Date();
    // The demo runs on the vendor's server: its software versions and load aren't the visitor's to see.
    const demo = isDemoMode();
    const report = {
      generatedAt: now.toISOString(),
      app: {
        version: appVersion(),
        ...(demo ? {} : {
          node: process.version,
          platform: `${process.platform} ${process.arch}`,
          uptimeMinutes: Math.round(process.uptime() / 60),
          memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        }),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        production: process.env.NODE_ENV === "production",
        demo,
      },
      database: { ...(demo ? {} : { postgres: server[0]?.server_version ?? "unknown" }), ...database },
      setup: {
        https: env.baseUrl.startsWith("https://"),
        trustedProxies: trustProxy(),
        email: email ? { provider: email.provider, working: !email.lastError } : null,
        payments: payments ? { provider: payments.provider, mode: payments.mode, notifications: payments.webhookId !== null, working: !payments.lastError } : null,
      },
    };
    c.header("Content-Disposition", `attachment; filename="diagnostics-${now.toISOString().slice(0, 10)}.json"`);
    c.header("Cache-Control", "no-store");
    return c.body(`${JSON.stringify(report, null, 2)}\n`, 200, { "Content-Type": "application/json; charset=utf-8" });
  });
