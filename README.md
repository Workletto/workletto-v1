# Workletto

Time tracking, project management, and invoicing for teams that want control of their own software.

Time tracking, projects and invoicing for small studios and agencies: timers and timesheets,
clients and projects with rates and budgets, tasks, expenses, reports,
invoices, CSV and Harvest import, and your own branding. React + Vite interface, Hono API,
Better Auth (email and password), Prisma 7,
Postgres 17. One Node process serves both the API and the built interface in production.

## Run it locally

Needs Node.js 22 or later and Postgres 17 with two empty databases, `work_dev` and
`work_test`. Tests use the `_test` one and empty it between tests.

```bash
cp .env.example .env   # first time only; fill in the three blank values
npm install
npx prisma migrate deploy && npx prisma generate
npm run dev            # http://localhost:5173
npm test
```

## Deploy it

- **Render** (`render.yaml`), the recommended way: one web service built from the `Dockerfile`
  and a Postgres 17 database. Render generates `BETTER_AUTH_SECRET` and `SETUP_CODE`; the setup
  page links to the service's Environment page in Render, where you copy the code.
- **Any other host** that runs a Docker container that stays running (not a serverless-only
  host): the same `Dockerfile`, a Postgres 17 database, and `DATABASE_URL`,
  `BETTER_AUTH_SECRET`, `SETUP_CODE` and `BETTER_AUTH_URL` (your app's address), plus
  `TRUST_PROXY=1` behind the host's proxy.
- **Docker Compose** (`compose.yaml`), for your own server, if you're comfortable running
  one: fill in the three values in `.env`, then `docker compose up -d`. Put an HTTPS proxy
  on the same server in front of port 3000 (the app listens there on the server's own address only). You look after the server, its updates and its backups.

All of them run `npm start`, which applies new migrations and then starts the server.

## Updating

Updates arrive as a pull request in your own repository. Nothing changes in your running
app until you merge it.

**Once:** in your repository's Settings, under Actions → General → Workflow permissions,
tick "Allow GitHub Actions to create and approve pull requests".

The workflow downloads the newest release for your major version (1.x, for example) from
Workletto's public repository on GitHub, and only applies it if Workletto's signature checks
out against the key in `.github/update-app/allowed_signers`. A new major version (2.0, for
example) is never applied by Update app: its release notes say how to move to it.

**Each update:**

1. Take a backup (see "Backups and recovery" below).
2. Actions tab → **Update app** → Run workflow, ticking the backup box.
3. Open the pull request it creates, look through Files changed, and merge it with
   **Create a merge commit** (not squash or rebase: the next update relies on that merge).
   Render then deploys by itself; with Docker Compose run `git pull` and
   `docker compose up -d --build` on your server.

**Your own changes are kept.** The workflow keeps a `vendor` branch holding only untouched
releases, starting from your repository's first commit. Merging it brings in only what
changed between releases. If you and an update changed the same lines, GitHub asks you to
choose; an AI coding assistant can do that for you. For `package-lock.json`, keep the
update's version and run `npm install`. Database changes are separate files in
`prisma/migrations`, so migrations you add yourself never collide with ours.

**Workflow files.** GitHub doesn't let a workflow change files in `.github/workflows` with its
built-in token. When a release changes one, the pull request says so. To include them, add a
secret `UPDATE_TOKEN`: a fine-grained token for this repository only, with Contents, Pull
requests and Workflows set to read and write.

## Changing it with an AI coding assistant

This copy is yours to change. You can ask an AI coding assistant, such as Claude Code or Codex,
to add a feature or change a screen. `AGENTS.md` tells the assistant how the code is laid out and
the rules that keep your data safe, and the **Test** workflow (`.github/workflows/test.yml`) checks
every pull request: the type check, the server tests and a build. Download a backup before merging
a big change. Updates keep your changes: they arrive as a pull request that merges into your copy.

## Backups and recovery

### Taking a backup

Either way gives you everything the app holds:

- **From the app** (simplest, any host, nothing to install): Manage → Security & data →
  **Download backup**. You restore it from the setup screen of a new install (Help Center:
  "Back up and restore").
- **From the database**, with the Postgres 17 client tools:

| | Back up | Restore |
| --- | --- | --- |
| Render | `pg_dump -Fc "<External Database URL>" > backup.dump` | `pg_restore --clean --if-exists --no-owner -d "<External Database URL>" backup.dump` |
| Docker Compose | `docker compose exec -T db pg_dump -U work -Fc work > backup.dump` | `docker compose exec -T db pg_restore -U work -d work --clean --if-exists < backup.dump` |

The Render database is closed to outside connections (`ipAllowList: []` in `render.yaml`), so before
`pg_dump` or `pg_restore` can reach the External Database URL from your computer, add your
computer's IP address to the database's access list on Render, and remove it afterwards.

The app doesn't back itself up on a schedule. Render's paid databases keep their own backups and
offer point-in-time recovery from the database's page; check your plan. With Docker Compose, a
line like this in the server's crontab (`crontab -e`) keeps a copy every night at 3 a.m.:

```
0 3 * * * cd /path/to/app && docker compose exec -T db pg_dump -U work -Fc work > backups/work-$(date +\%F).dump
```

**Keep backups private.** They hold your clients' details and every person's password (as the
scrambled hash the app stores). Your host's settings aren't in them: keep `BETTER_AUTH_SECRET`
and `SETUP_CODE` in your password manager too.

### Restoring a database backup

1. **Stop the app first**, so nobody's changes land halfway through: on Render, **Suspend**
   the web service (its Settings page); with Docker Compose, `docker compose stop app`.
2. Run the restore command from the table above.
3. Start the app again (Render: **Resume**; Docker Compose: `docker compose start app`). On
   start it brings the database up to its own version.

Anything entered after the backup was taken is gone.

### When an update goes wrong

Going back to the previous code and restoring the database are different things:

- **Going back to the previous code** keeps all your data, including anything entered since
  the update. On Render, roll the service back to its previous deploy from the Render
  dashboard. With Docker Compose, run `git checkout HEAD~1` and `docker compose up -d --build`.
  The database keeps whatever the update added to it. Updates within v1 only add database
  columns and tables, so the older code runs on the newer database.
- **Restoring the database** takes the data back to when the backup was made. Use it only when
  the data itself is wrong, or after a failed database change (below).

Don't use GitHub's Revert button on an update pull request: later updates would then leave out
the reverted changes.

### If the app won't start after an update

Each update's database changes run when the app starts (`prisma migrate deploy`). If one fails,
the app doesn't start. The log names the failed change, and every later start, even of the
previous code, stops with `P3009` ("migrate found failed migrations in the target database").
On Render the failed deploy doesn't go live and the previous one keeps running, but it can't
restart until this is fixed; with Docker Compose the app restarts over and over.

To recover, choose one:

1. **Restore the backup you took before the update** (above), then go back to the previous
   code. This is the safe choice: a change with several steps may have done some of them
   before it failed, and the restore undoes them.
2. **Or mark the failed change as rolled back**, when the error shows it failed on its first
   step (nothing was changed), then go back to the previous code. Use the change's name from
   the log:
   - Docker Compose: `docker compose stop app`, then
     `docker compose run --rm app npx prisma migrate resolve --rolled-back <name>`
   - Render: on your computer, in a copy of your repository with `npm ci` run, with your IP
     address on the database's access list:
     `DATABASE_URL="<External Database URL>" npx prisma migrate resolve --rolled-back <name>`

Either way, keep the error from the log: it shows a developer or an AI coding assistant what went wrong.

### Moving to a new host or address

1. Install the app on the new host as under "Deploy it", with the **same**
   `BETTER_AUTH_SECRET` as before. The email password, Stripe key and single sign-on secret
   are stored encrypted with it; with another one, the app asks for them again.
2. Restore your backup: from the new install's setup screen (a backup from the app), or with
   `pg_restore` into its database (a database backup), with the app stopped.
3. If the address changed: set `BETTER_AUTH_URL` to it (Render sets the address
   itself). With single sign-on, add the new redirect address at your provider (Manage →
   Settings shows it). With Stripe, Manage → Payments says payment notifications go to the
   old address and lets an admin move them.
4. Everyone signs in again; their passwords are unchanged.

### Versions

A backup restores on the same version or a newer 1.x version: on start, the app adds what the
newer version changed. A backup from a newer version into older code: the app's own restore
refuses it ("Update this install first"); a database restore works within 1.x, because updates
only add to the database, but update the app first anyway.

## Demo data

`npm run demo:load` fills an empty database with two years of a made-up studio (14 people,
20 clients, about 10,000 time entries, 165 invoices) as a normal installation, and prints the
admin's password once. Set `DEMO_ADMIN_EMAIL` to choose the email. It refuses any database whose
name doesn't end in `_test`, `_staging` or `_demo`, and any that already has an installation.

## How it fits together

- **First-run setup** (`src/server/setup.ts`): until an admin exists, the app shows only
  a setup screen that asks for `SETUP_CODE`. It creates the organization and the admin in
  one transaction, then is gone for good.
- **Organization scoping** (`src/server/db.ts`): signed-in routes get `c.get("db")`, a
  database client that only sees one organization's rows. New business tables must be
  added to `ORG_SCOPED_MODELS`. The demo will run many organizations on this same code.
- **Appearance** (`src/server/branding.ts`, `src/client/theme.ts`): admins pick an accent color
  and System, Light or Dark mode. Stored on the organization, so updates never overwrite it. The
  sign-in screen shows the install's own organization name and colors. Admins can also upload a logo (PNG, JPEG or WebP, up to 1 MB). It is stored as uploaded after `src/server/logo.ts` checks the file header, type and size; the server never decodes images.
- **Time tracking** (`src/server/time.ts`): everyone tracks their own time with a timer or by
  typing a duration, in a day view or a week timesheet (type into a day's box, add project
  rows). Durations are whole seconds and every total is added up from entries, never stored.
  An entry belongs to the person's own calendar day; timer start times are UTC. The database
  allows one running timer per person (a partial unique index).
- **Clients and projects** (`src/server/clients.ts`, `projects.ts`, `billing.ts`): a project
  may belong to a client, bills at one project rate or at each person's rate, may have a budget
  in hours or fees, and is open to everyone or to a chosen team. Members see and track time only
  on their projects, without rates or budgets. Clients and projects that are in use can be
  archived but not deleted. Money is stored in whole cents of the organization's currency.
- **Tasks and the project page** (`src/server/tasks.ts`): to-dos with status, assignee and due
  date; time can be tracked against a task. The project page shows hours, money, budget used
  and the project's tasks.
- **Expenses** (`src/server/expenses.ts`): per person, per project, billable or not.
- **Reports** (`src/server/reports.ts`): hours, billable hours and money by client, project,
  person or task for any period, with budgets and a CSV of every entry. Members see their own.
- **Invoices** (`src/server/invoices.ts`): made from a client's billable time and expenses that
  aren't invoiced yet. Lines keep their own amounts; invoiced time and expenses are locked so
  they're never billed twice. Drafts can be edited; save as PDF from the print dialog.
- **Import and export** (`src/server/importExport.ts`, `src/shared/importFields.ts`): CSV for
  clients, projects, tasks, time and expenses, including Harvest's detailed time report. The
  browser matches columns; the server checks every row before anything is saved. People that an
  import adds have no login until an admin invites them. Time imports read the whole file first
  (`src/shared/importPlan.ts`): each person gets their most common billable rate and each new
  project is billed by project or by person. Rows equal to time or expenses already here are
  skipped, so importing a file twice adds nothing; time marked as invoiced comes in as not
  billable (or is left out), so it can't be invoiced again.
- **People** (`src/server/people.ts`, `src/shared/roles.ts`): admins invite people by link
  (the admin copies the link, and with email turned on under Manage → Email the app can email it too). A link works once, for 7 days, and only
  its hash is stored. Roles: Admin (everything), Manager (also clients, projects, invoices,
  everyone's reports), Member (own time, expenses and reports; client and colleague names but no contact details; no invoices). Admins can turn accounts off, which
  signs the person out and blocks sign-in; nobody is deleted, so their time stays. Admins can't
  change their own role, so there is always an admin. Forgotten passwords: an admin makes a
  one-time reset link (24 hours) from the same screen (`src/server/passwordReset.ts`), and
  anyone can change their own password from the account menu; both sign that person out
  everywhere else.
- **Company settings** (Manage → Settings): company name, the app's name (shown in the header,
  browser tab and sign-in page; the organization's name when left empty), currency, and the address printed on invoices.
- **Every link stays inside one organization.** Tables link with both the row's id and its
  organization's (or, for tasks, its project's), so the database itself rejects a project
  pointing at another organization's client, an entry at another's project or person, or a
  task from another project.
- **Sign-in throttling** (`src/server/rateLimit.ts`, `app.ts`): 10 attempts a minute per
  address, then a minute's wait. The address comes from the connection or, with `TRUST_PROXY`,
  from the proxy in front (`src/server/clientIp.ts`); visitors can't forge it. The example
  values in `.env.example` are refused in production (`src/server/env.ts`).
- **No phone-home**: no license check, no usage tracking, Better Auth telemetry off, Prisma CLI
  telemetry off in `npm start`. `tests/noPhoneHome.test.ts` fails if server code gains a network
  call. The allowed exceptions, which an admin turns on, are `src/server/mail.ts` (Manage → Email:
  the app sends through their SMTP server, `src/server/emailSettings.ts`) and
  `src/server/stripe.ts` (when an admin connects Stripe: `api.stripe.com`, with their own Stripe keys). Both
  secrets are encrypted by `src/server/secrets.ts` with a key derived from `BETTER_AUTH_SECRET`.
  The Update app workflow
  runs in the customer's GitHub repository and downloads signed releases from Workletto's public
  repository on GitHub; it sends nothing to us.
  `SECURITY.md` explains what is protected and how to check it; admins see the live facts
  under Manage → Security & data (`src/server/security.ts`).

## Settings

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `BETTER_AUTH_SECRET` | 32+ random characters; signs sessions |
| `BETTER_AUTH_URL` | Public address. Optional on Render (it sets `RENDER_EXTERNAL_URL`) |
| `SETUP_CODE` | 16+ characters; required to create the first admin |
| `TRUST_PROXY` | Proxies in front of the app: 1 on Render or behind Caddy (both setups set it), 0 when browsers reach the app directly. Decides which address sign-in throttling counts |
| `PORT` | Set by the host; 3000 by default |


## License

MIT: see `LICENSE`. There's no support desk and no promised updates. Fixes are published when we choose to make them, security fixes first. To fix or change your copy, see "Changing it with an AI coding assistant" above.
