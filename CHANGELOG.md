# Changelog

What changes in each version of this app, newest first. Versions follow
[Semantic Versioning](https://semver.org): updates within a major version (1.x) are
installed with the Update app workflow; a new major version says so.

Each version says whether it changes the database. Take a backup before every update
anyway: the Update app workflow explains how.

## [Unreleased]

## [1.0.1] - 2026-11-01

### Fixed

- A first install on Render no longer fails with "Can't reach database server". Render can start the app before its new database accepts connections; the app now waits up to 10 minutes for the database before it sets it up.

### Database

No changes.

## [1.0.0] - 2026-11-01

The first version: everything a small agency or studio needs to track time and bill for it.

### Added

- Time tracking with a timer, manual entries and weekly timesheets, with approvals and Monday reminders.
- Clients, projects and tasks, with budgets, billable rates and alerts at 80% and 100% of a budget.
- Fixed fee projects: bill an agreed fee, in full or in parts, instead of the hours.
- A currency per client: bill each client in its own currency; reports add everything up in yours at exchange rates you set.
- Single sign-on with Google Workspace, Microsoft Entra ID or Okta, which admins can require for everyone else.
- Invoices as files QuickBooks Online and Xero import, to the cent.
- Time off and company holidays, with optional approval; they come off capacity on the Team page.
- Scheduling: plan each person's hours a week by project against their capacity after time off and holidays, with over-booked weeks flagged and each person's plan on their Time page.
- Fixed fees per phase: a fixed fee project can bill a fee on each task (phase), each billed in full or in parts within its own fee, with the project's fee their sum.
- User groups: teams or departments that filter the Team page, Schedule, Approvals and Reports, add their people to a project in one step, and show in exports; roles stay as they are.
- Custom fields: your own fields on time entries, projects and clients (text, a number or a list, optionally required); reports filter and group by a list field, and CSV exports add a column for each.
- Two-factor sign-in: a code from an authenticator app (or a one-time backup code) after the password; admins can require it for everyone and reset it for someone who lost their phone.
- Calendar import: turn a week of your calendar's events into time entries, from a private iCal address (Google Calendar, Outlook) or an .ics file; all-day, declined and already imported events are left out.
- Project templates: save a project's billing, rates, budget, team and tasks under a name, and start new projects from it; templates are managed in Manage → Templates.
- Late-payment reminders: clients are emailed about sent, unpaid invoices 3, 7 or 14 days after the due date, then every 7 days, up to 3; each invoice can opt out, and its History records every reminder.
- Repeating invoices: repeat an invoice every week, month or 3 months; each repeat is a new draft, with the invoice's own lines and fixed fees, for you to check and send.
- Change it with an AI coding assistant: AGENTS.md (and CLAUDE.md) tell Claude Code, Codex and others how the app is built and what keeps data safe, and a Test workflow checks every pull request in your copy.
- Expenses, with receipts.
- Invoices from tracked time and expenses, with taxes and discounts, sent by email or printed (or saved as a PDF from your browser), and paid online through your own Stripe account.
- Reports and CSV exports.
- Team roles (admin, manager, member), invitations and password reset.
- History of changes to time, money, people and settings.
- Import from Harvest, and CSV exports of clients, projects, tasks, time and expenses.
- Your own app name, logo and colors.
- Backups you can download and restore into a new install.
- Manage → About, with this list and a diagnostics file to download when you look into a problem.

### Database

Creates the database. There's nothing to back up yet.
