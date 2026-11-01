import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { serveInterface } from "./interface.ts";
import { env, isDemoMode } from "./env.ts";
import { deleteExpiredDemos } from "./demo.ts";
import { sendTimesheetReminders } from "./timesheets.ts";
import { sweepPayments } from "./payments.ts";
import { sweepRecurringInvoices } from "./recurring.ts";
import { sweepReminders } from "./reminders.ts";
import { deleteExpiredSessions, reloadAuth } from "./auth.ts";
import { describeError } from "./logging.ts";

const app = createApp();

// In production one process serves both the API and the built interface.
// In development Vite serves the interface and forwards /api here.
if (env.isProduction) {
  serveInterface(app, "./dist/client");
}

// The demo deletes expired workspaces every 15 minutes.
if (isDemoMode()) {
  const sweep = () => deleteExpiredDemos().catch((error) => console.error("Demo cleanup failed", describeError(error)));
  void sweep();
  setInterval(sweep, 15 * 60 * 1000).unref();
}

// Monday's timesheet reminders. Checking every 10 minutes is cheap; each week is sent once.
const remind = () => sendTimesheetReminders().catch((error) => console.error("Timesheet reminders failed", describeError(error)));
setInterval(remind, 10 * 60 * 1000).unref();

// Open online payments are checked with the provider every 5 minutes, so they arrive even
// when the provider can't reach this server. Nothing is contacted unless payments are connected.
const checkPayments = () => sweepPayments().catch((error) => console.error("Checking online payments failed", describeError(error)));
setInterval(checkPayments, 5 * 60 * 1000).unref();

// Repeating invoices make their drafts on each organization's own date; checked every 10 minutes.
const repeatInvoices = () => sweepRecurringInvoices().catch((error) => console.error("Making repeating invoices failed", describeError(error)));
void repeatInvoices();
setInterval(repeatInvoices, 10 * 60 * 1000).unref();

// Late-payment reminders go out on each organization's own date; checked every 10 minutes.
const remindLate = () => sweepReminders().catch((error) => console.error("Late-payment reminders failed", describeError(error)));
setInterval(remindLate, 10 * 60 * 1000).unref();

// Expired sign-in sessions are deleted every hour, with the address and browser they recorded.
const clearSessions = () => deleteExpiredSessions().catch((error) => console.error("Deleting expired sessions failed", describeError(error)));
void clearSessions();
setInterval(clearSessions, 60 * 60 * 1000).unref();

// Sign-in starts with the organization's single sign-on provider, if it has one (sso.ts), and
// builds it again every 10 minutes, so a provider that was unreachable at startup comes back
// by itself. If the settings can't be read, sign-in works with passwords meanwhile.
const loadSignIn = () => reloadAuth().catch((error) => console.error("Loading single sign-on failed", describeError(error)));
await loadSignIn();
setInterval(loadSignIn, 10 * 60 * 1000).unref();

serve({ fetch: app.fetch, port: env.port }, () => {
  console.log(`The app is running on ${env.baseUrl}`);
});
