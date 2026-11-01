# Instructions for AI coding assistants

This repository is a studio's own copy of Workletto: time tracking, projects, invoicing and
reports for a small team, running on the studio's own hosting. The person asking you for a
change is often not a developer. Make the smallest change that does what they asked, keep
everything that works today working, and explain what you changed in plain words.

## How it's built

- **Server:** Node.js with [Hono](https://hono.dev), in `src/server`. One file per area
  (`time.ts`, `projects.ts`, `invoices.ts`, …), mounted in `src/server/app.ts`.
- **Screens:** React with Vite and Radix Themes, in `src/client` (`screens/` holds one file per
  page, `ui.tsx` the shared parts, `api.ts` the types the server returns).
- **Shared code:** `src/shared` (money, dates, roles, invoice math), used by both.
- **Database:** Postgres 17 through Prisma 7. The schema is `prisma/schema.prisma`; changes go
  in `prisma/migrations`, and the app applies them when it starts.
- **Sign-in:** Better Auth (`src/server/auth.ts`): email and password, optional single sign-on
  and two-factor.
- `README.md` explains each area in more detail ("How it fits together").

## Rules that keep the data safe

- **Every signed-in route reads and writes through `c.get("db")`.** That database client only
  sees the signed-in person's organization. Don't import `prisma` directly in route code;
  `tests/routeAccess.test.ts` lists the few files allowed to.
- **A new table that belongs to an organization** gets an `organizationId`, a composite
  foreign key to its parent (`[parentId, organizationId]`), and must be added to
  `ORG_SCOPED_MODELS` in `src/server/db.ts` and to `TABLES` in `src/server/backup.ts` (in the
  order rows depend on each other). Tests fail if either is missing.
- **Three roles:** admin, manager and member (`src/shared/roles.ts`). Guard routes with
  `requireManager(...)` or `requireAdmin(...)` from `src/server/http.ts`. Every API route must
  be listed in `tests/roleMatrix.test.ts` with the role it needs. Members never see rates,
  money or other people's details.
- **Money is whole cents** (integers), quantities are thousandths, and invoice totals come from
  `src/shared/invoiceMath.ts`. Never use floating-point money.
- **Dates** are `YYYY-MM-DD` strings; use the helpers in `src/shared/time.ts`.
- **No new outside connections** without saying so: a server file that calls the network must
  be listed in `tests/noPhoneHome.test.ts`, and `SECURITY.md` must say what leaves the server.
- **Errors in the server log** go through `describeError` (`src/server/logging.ts`), which keeps
  personal data out of the log.
- **Never commit secrets.** `.env` holds them and is never committed or printed.

## Rules that keep it the studio's own

- **Never hard-code the product's name in the app.** The app shows the studio's own name, logo
  and colors; use `displayAppName()` (`src/shared/product.ts`) and the organization's branding.
- **Accessibility:** every field has a label, everything works with the keyboard, and colors
  keep enough contrast. The browser tests check every page with axe.

## Database changes

1. Edit `prisma/schema.prisma`.
2. Create the migration with `npx prisma migrate dev --name what-it-does` against a local
   development database. Never edit a migration that already exists.
3. Read the generated SQL before keeping it. A change that could lose data (dropping a column,
   making one required) needs a step that keeps existing rows valid.

## Tests

Run these before you say a change is done:

```bash
npm run typecheck
npm test          # server tests; needs TEST_DATABASE_URL pointing at an empty Postgres 17 database
npm run build
npm run test:e2e  # browser tests; needs E2E_DATABASE_URL and Google Chrome
```

- Add or update tests for what you change: a server test in `tests/`, and a browser test in
  `tests/e2e/` when a screen changes.
- **Never delete, skip or loosen a test to make it pass.** If a test fails, fix the change, or
  explain why the test itself is wrong.
- If you can't run the tests where you are, open the pull request anyway: the **Test** workflow
  (`.github/workflows/test.yml`) runs them on every pull request.

## Keep updates easy

New versions of Workletto arrive as a pull request from the **Update app** workflow, merged
into this copy. Small, focused changes merge cleanly; sweeping ones conflict.

- Prefer adding new files to rewriting existing ones.
- Don't reformat, rename or reorganize code you aren't changing.
- Don't change `.github/workflows/update-app.yml`, the release signature check, or the
  migrations that came with Workletto.
- If an update's pull request has conflicts, keep both sides: Workletto's change and the
  studio's own.

## When you're done

Say in plain words what changed, what the person should check in the app, and anything you
weren't sure about. Suggest downloading a backup (Manage → Security & data → Download backup) before merging a
big change.
