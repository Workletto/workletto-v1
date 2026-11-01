# Security and your data

Workletto is software you run on your own hosting account (Render or your own server). Everything
you and your team enter is kept in the Postgres database named in `DATABASE_URL`. The app doesn't
send it to us, and it has no way to reach your database from our side. What we do receive is
listed under "What the makers can see" below.

In the app, admins can see these facts for their own install under **Manage → Security &
data**.

## Where your data is

- **One database.** Time, clients, projects, tasks, expenses, invoices, people and
  your logo are all stored in the Postgres database named in `DATABASE_URL`. The app doesn't
  copy them anywhere else.
- **Who can open the database:** your hosting provider runs the server and the database, so
  it can reach them, and so can whoever can sign in to your hosting account. Protect that
  account with a strong password and two-step sign-in. The app itself is a web server that
  anyone with its address can reach over the internet (they still have to sign in). The Render
  setup closes the database to outside connections (`ipAllowList: []` in `render.yaml`), so
  only your Render account's own services can reach it, until you add your computer's address
  to run a backup (README, "Backups and recovery"). Keep the database's connection string private.
- **Your host's own protections** (disk encryption, automatic backups, point-in-time recovery)
  depend on your host and plan. For example, Render's paid databases offer point-in-time
  recovery; check your plan and Render's documentation.
- **Taking it with you:** Manage → Import & export downloads clients, projects, tasks, time
  and expenses as CSV. A backup (Manage → Security & data, or README → "Backups and recovery") has everything.

## What leaves your server

The app doesn't phone home: it has no usage tracking, no error reporting to us and no license
check. It connects to other services only when you turn something on, or when someone
chooses to use it:

- **Your hosting provider** runs the server and the database, so your data passes through
  its systems. Its terms and protections apply.
Each of these is off until someone turns it on, and only contacts the address you chose:

| What | When it connects | Where to | What it sends | What's kept |
| --- | --- | --- | --- | --- |
| **Email** | After an admin sets it up under Manage → Email, only while sending | The SMTP server you entered (your own, or an email service's) | Your SMTP username and password, and each email: invite and password reset links, invoices to clients, timesheet reminders, budget alerts, test emails | The password, encrypted with a key made from `BETTER_AUTH_SECRET` |
| **Online invoice payments** | After an admin connects a Stripe account under Manage → Payments | `api.stripe.com`, with your own Stripe keys | To start a payment: invoice number, amount, currency and the client's email address, if the invoice has one. Then checks of that payment, and setting up and checking Stripe's payment notifications | Your Stripe keys, encrypted like the email password |
| **Single sign-on** | After an admin sets it up under Manage → Settings: when it's saved, and when someone signs in through it | The identity provider you chose (such as Google Workspace, Microsoft Entra ID or Okta), over OpenID Connect | Reads the provider's published settings and keys; at sign-in, trades a one-time code (with your client ID and secret) for the person's name and email | The client secret, encrypted like the email password. The provider's access, refresh and ID tokens are thrown away, never stored |
| **Calendar import** | When someone who saved their own calendar's private iCal address loads a week under Time → Import from calendar | The address they saved, over https only, never a private network address | Only the request for the calendar file | The address, encrypted like the email password. The events become time entries only for the ones the person ticks |
| **The Update app workflow** | Only when you start it. It runs in your GitHub repository | GitHub: the releases of Workletto's public repository | Only the requests for the list of releases and the download, like any visitor to a public repository. Nothing about you or your data | Nothing. The release is applied only if Workletto's signature checks out against `.github/update-app/allowed_signers` |

The sign-in library's telemetry is turned off (`src/server/auth.ts`), and `npm start` turns
off the database tool's update check (`CHECKPOINT_DISABLE=1`).

Building the app (on your host, when you deploy or update) downloads the Node.js base image
and open-source packages from npm, like any Node.js app. That sends none of your data.

## What the makers can see

- **Updates.** Nothing. Your Update app workflow downloads releases from GitHub. GitHub shows
  us how many times each release was downloaded, with nothing about who downloaded it.
- **The demo.** Anything you type into the demo we run is on our server. Don't enter real
  client data there.
- **Help and donate links.** The "?" links in the app and the donate link open pages on
  workletto.com. Clicking one tells us the visitor's IP address and which page they opened.
  The app sends no referrer, so we don't learn which install the visit came from.
- **Anything you choose to send us.** For example, an admin can download a
  diagnostics file (app, Node.js and Postgres versions, which setup options are on, and
  whether email and payments work). It holds no secrets, addresses or business data, and the
  app never sends it: if you share it with us, we see it.

We don't receive the contents of your database, and the app never sends them to us.

## How the app protects your data

- **Passwords** are stored only as scrypt hashes (by the Better Auth library), never as
  typed. Passwords must be 10 to 128 characters.
- **Nobody can sign up on their own.** The first admin is created on the setup screen,
  which needs the `SETUP_CODE` you chose when you deployed (16+ characters; 10 tries per
  address and 50 in total every 15 minutes). After that, people join only by an admin's invite link.
- **Invite links** contain a long random code. Only a hash of it is stored, it works once,
  and it expires after 7 days.
- **Sign-in sessions** are kept in a cookie that page scripts can't read (`HttpOnly`), that
  other sites can't send along with their own forms (`SameSite=Lax`) and, when your address
  starts with `https://`, that is only sent over HTTPS (`Secure`). Each session also records the IP
  address and browser (user agent) it was started from. Signing out deletes the session, and one
  that expires is deleted about a day later, with the address and browser it recorded.
- **Too many sign-in attempts are slowed down:** 10 tries a minute from one address, then
  that address waits a minute. Repeated setup and invite attempts are limited too. The address
  is the connection's own, or, with `TRUST_PROXY` set to the number of proxies in front of the
  app (1 on Render or behind Caddy), the one those proxies saw; a visitor can't forge it by
  adding `X-Forwarded-For` entries of their own. The same address is kept on sessions.
- **The example values in `.env.example`** (`BETTER_AUTH_SECRET`, `SETUP_CODE`) are refused
  on a production install: the app won't start on the example secret, and the example setup
  code counts as not set.
- **Turning someone off** (Manage → People) signs them out everywhere and blocks sign-in.
- **Single sign-on** lets in only email addresses at your own domain that the provider has
  verified, and only people already in your organization or invited to it (unless an admin
  lets anyone at the domain join as a member). It can never reach another organization's
  people. When it's required, only admins can also use a password, so a broken provider
  can't lock you out; that check runs after the password, so it doesn't reveal who has an
  account.
- **Two-factor sign-in** (optional, or required by an admin under Manage → Settings) asks for a
  6-digit code from an authenticator app, or one of 10 one-time backup codes, after the
  password. The app's secret is stored encrypted with a key made from `BETTER_AUTH_SECRET`;
  the backup codes only as keyed hashes. Codes count against the same per-address limit as
  passwords, a sign-in attempt ends after 5 wrong codes, and repeated failures lock the account
  for a while. There's no "trust this device": every password sign-in asks. Turning it off takes
  the password and a current code. An admin can reset someone's (Manage → People), which is
  recorded in History. People who sign in through single sign-on aren't asked; two-factor
  sign-in for them is set up with your single sign-on provider. A backup restored into an install with another `BETTER_AUTH_SECRET` turns
  two-factor off for everyone in it, so nobody is locked out; they set it up again.
- **Forgotten passwords:** an admin makes a one-time reset link (Manage → People) that works
  once, for 24 hours; only its hash is stored. Using it, or changing your own password from
  the account menu, signs that person out everywhere else.
- **Other websites can't act for you.** The app refuses form submissions that come from
  another site (it checks the browser's `Origin` and `Sec-Fetch-Site` headers), and it doesn't
  let other sites' scripts call it.
- **Your browser is told to load the app's pages only from your own address.** The
  `Content-Security-Policy` header (`src/server/app.ts`) is `default-src 'self'` with
  these changes: images may also come from `data:` addresses, styles may also be inline
  (`'unsafe-inline'`), pages can't be shown inside other sites (`frame-ancestors 'none'`)
  and forms can only post to your own address (`form-action 'self'`). Scripts, fonts and
  connections from the pages themselves are limited to your own address. Links don't tell
  other sites which page you came from (`Referrer-Policy: no-referrer`).
- **Each organization's data is kept apart.** Every signed-in request goes through a database
  client that adds the person's organization to every query and refuses one that would read or
  change another organization's rows (`src/server/db.ts`). The app makes this check.
  Postgres row-level security isn't used, so the database login itself can see every row. On top of it, the
  database rejects links between two organizations' rows (composite foreign keys). The
  unrestricted client is used only before anyone is signed in (sign-in, setup, invite and reset
  links, Pay now pages), by background jobs and backups, and to check an email address isn't
  already used on the install; a test lists those files.
- **Roles:** Members see their own time, expenses and reports, and the projects they can
  track time on (open to everyone, or ones they're on) with total hours but without rates,
  budgets or money. They see clients' and colleagues' names, but not their email addresses,
  billing addresses or roles, and they can't see invoices. Managers also see every project,
  client, report, invoice and rate. Only admins can manage people and settings.
- **Uploads:** the logo (PNG, JPEG or WebP, up to 1 MB), expense receipts (PDF, PNG, JPEG or
  WebP, up to 5 MB) and a backup to restore on the setup page. The server checks each file's
  type from its first bytes, ignores the type the browser reports, and stores it as is; it never opens
  or converts images.
- **Request size** is limited to 1 MB, apart from those uploads.
- **Logs:** when something fails, the server log gets the error and where in the code it
  happened, never a request's body, headers or cookies. Database errors are logged by their type
  and code only, because their messages can quote the data that was sent, and any email address
  in an error message is replaced with `[email]`, and anything shaped like a Stripe key or
  webhook secret with `[secret]`.

## Check it yourself

1. **In the app:** Manage → Security & data shows where your database is, who can sign in,
   which sign-in methods are on and which outside services (if any) the app uses.
2. **In your browser:** open the developer tools (Network tab) and use the app. Requests
   go to your own address (a client's "Pay now" page sends them on to Stripe). The response headers include the
   `Content-Security-Policy` above.
3. **In the code:** this search finds network calls only in `src/server/mail.ts` (email),
   `src/server/stripe.ts` (online payments), `src/server/ssoSettings.ts` (single sign-on) and
   `src/server/calendarFetch.ts` (calendar import), plus the
   type notes for the email library (`src/server/nodemailer.d.ts`):

   ```bash
   grep -rnE "fetch\(|nodemailer|node:(http|https|net|tls|dns)" src/server
   ```

4. **With the tests:** `npm test` includes `tests/noPhoneHome.test.ts`. It fails if any server
   code other than those four files gains a network call, in the source or in the built server
   (`dist/server.js`), or if starting the app stops turning off the database tool's update
   check. It also watches the running app: with email and payments off it connects to nothing
   but your database, and a single sign-on sign-in reaches only the chosen provider.

## Reporting a security problem

Please don't open a public issue. Email **security@workletto.com** with what you found
and how to reproduce it. We'll confirm we got it and keep you posted on the fix.

