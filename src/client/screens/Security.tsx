import { useEffect, useState, type ReactNode } from "react";
import { Badge, Code, Flex, Text } from "@radix-ui/themes";
import { api } from "../api.ts";
import { Link } from "../router.tsx";
import { ManageTabs } from "../Shell.tsx";
import { ActionButton, ErrorNote, PageHeader, SettingsSection } from "../ui.tsx";
import { PRODUCT_NAME } from "../../shared/product.ts";

type Facts = {
  demo: boolean;
  databaseHost: string | null;
  appAddress: string;
  trustProxy: number;
  recovery: { byEmail: boolean };
  email: { provider: "smtp"; host: string; lastError: string | null } | null;
  sso: { providerName: string; host: string; required: boolean } | null;
  calendarLinks: number;
  payments: { provider: string; mode: string; host: string } | null;
  people: { canSignIn: number; admins: { name: string; email: string }[]; turnedOff: number; openInvites: number };
  signIn: { emailAndPassword: boolean; attemptsPerMinute: number; twoFactor: { required: boolean; enabled: number } };
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const code = (text: string) => <Code size="1">{text}</Code>;
const P = ({ children, muted }: { children: ReactNode; muted?: boolean }) => <Text as="p" size="2" color={muted ? "gray" : undefined}>{children}</Text>;

// Manage → Security & data (admins): where the data lives and who can reach it.
// Every answer comes from the running app, with a way to check it.
export function Security({ demoExpiresAt }: { demoExpiresAt: string | null }) {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Facts>("/api/settings/security").then(setFacts, (e: Error) => setError(e.message));
  }, []);

  return (
    <>
      <PageHeader title="Security & data" intro="Where your data lives and who can reach it. Every answer comes from the running app, with a way to check it." help="hosting-and-maintenance/back-up-and-restore" />
      <ManageTabs role="admin" />
      <ErrorNote message={error} />
      {facts && <FactList facts={facts} demoExpiresAt={demoExpiresAt} />}
    </>
  );
}

function FactList({ facts, demoExpiresAt }: { facts: Facts; demoExpiresAt: string | null }) {
  const { people, signIn } = facts;
  const deletedAt = demoExpiresAt && new Date(demoExpiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return (
    <Flex direction="column" gap="5">
      <Fact
        title="Where your data is stored"
        check={
          facts.demo
            ? undefined
            : <>Compare it with the host in {code("DATABASE_URL")} in your hosting settings. Only people with access to your hosting account can open the database itself.</>
        }
      >
        {facts.demo ? (
          <P>This demo runs on our server. It's deleted at {deletedAt}. Don't enter real client data.</P>
        ) : (
          <P>
            In one Postgres database, at <Code size="2" style={{ overflowWrap: "anywhere" }}>{facts.databaseHost}</Code>. Time, clients,
            projects, invoices and people are all kept there. The app doesn't copy them anywhere else. Your hosting provider runs
            that database and the server, so it can also access your data.
          </P>
        )}
      </Fact>

      <Fact title="Who can sign in" check={<>Everyone is listed under <Link to="/manage/people" className="wl-link">Manage → People</Link>.</>}>
        <P>
          {plural(people.canSignIn, "person", "people")}. Admins: {people.admins.map((a) => `${a.name} (${a.email})`).join(", ")}.
        </P>
        <P>Nobody can sign up on their own: people join only through an invite link from an admin.</P>
        {(people.turnedOff > 0 || people.openInvites > 0) && (
          <P muted>
            {[
              people.turnedOff > 0 && `${plural(people.turnedOff, "account is", "accounts are")} turned off and can't sign in.`,
              people.openInvites > 0 && `${plural(people.openInvites, "invite link hasn't", "invite links haven't")} been used yet.`,
            ].filter(Boolean).join(" ")}
          </P>
        )}
      </Fact>

      <Fact
        title="How people sign in"
        check={
          <>
            {code("TRUST_PROXY")} should be 1 on Render or behind a proxy such as Caddy, and 0 when browsers reach the app directly.
          </>
        }
      >
        <Flex asChild direction="column" gap="2"><ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          <OnOff on={signIn.emailAndPassword} label="Email and password" note="Passwords are stored only as a scrambled hash, never as typed." />
          <OnOff
            on={signIn.twoFactor.required || signIn.twoFactor.enabled > 0}
            label="Two-factor sign-in"
            note={`${signIn.twoFactor.required ? "Required for everyone who signs in with a password." : "Optional."} ${signIn.twoFactor.enabled === 1 ? "1 person uses it" : `${signIn.twoFactor.enabled} people use it`}: a code from an authenticator app, or a one-time backup code, after the password. Change it under Manage → Settings.`}
          />
          <OnOff
            on={!!facts.sso}
            label="Single sign-on"
            note={
              facts.sso
                ? `Through ${facts.sso.providerName}.${facts.sso.required ? " Required for everyone but admins." : ""} Set it up under Manage → Settings.`
                : "An admin can set it up under Manage → Settings."
            }
          />
        </ul></Flex>
        <P muted>
          After {signIn.attemptsPerMinute} sign-in attempts in a minute from one address, that address waits a minute.{" "}
          {facts.trustProxy > 0
            ? `Addresses come from the proxy in front of the app (TRUST_PROXY=${facts.trustProxy}).`
            : "Addresses are those of the connection itself; forwarded headers are ignored (TRUST_PROXY=0)."}
        </P>
      </Fact>

      <Fact
        title="If someone forgets their password"
        check={<>Manage → People has a "Reset link" button on everyone but you. Only a hash of each link is stored, so nobody can read it back later, and it stops working once used.</>}
      >
        <P>An admin makes a one-time reset link under Manage → People and passes it on; it works once, for 24 hours. Anyone can change their own password from the account menu. Both sign that person out everywhere else.</P>
        <P>
          {facts.recovery.byEmail
            ? "People can also ask for a reset link themselves from the sign-in page; it arrives by email and works for 1 hour."
            : "Turn on email under Manage → Email, and people can ask for a reset link themselves from the sign-in page."}
        </P>
      </Fact>

      <Fact
        title="Connections to other services"
        check={
          <>
            In your browser's developer tools (Network tab), the requests from this page go to {facts.appAddress}. The app also tells
            browsers to load its pages only from that address (images may also be embedded in the page, and styles may be inline).
          </>
        }
      >
        {!facts.email && !facts.payments && !facts.sso && !facts.calendarLinks ? (
          <P><strong>None are turned on.</strong> The app doesn't contact any other service at the moment.</P>
        ) : (
          <>
            {facts.email && (
              <P>
                Email: your mail server at {code(facts.email.host)}, only while
                sending an email, and only what that email says. Turn it off under Manage → Email.
                {facts.email.lastError && <> The last email failed: {facts.email.lastError}</>}
              </P>
            )}
            {facts.sso && (
              <P>
                Single sign-on: {facts.sso.providerName} at {code(facts.sso.host)}, when the settings are saved and when someone signs in
                through it, to confirm who they are (their name and email). The provider's sign-in tokens aren't kept. Turn it off under
                Manage → Settings.
              </P>
            )}
            {facts.calendarLinks > 0 && (
              <P>
                Calendar import: {facts.calendarLinks === 1 ? "1 person has" : `${facts.calendarLinks} people have`} saved their own calendar's
                private iCal address. The app fetches it only when they load a week under Time → Import from calendar, and sends nothing but
                the request. Each person can remove theirs there.
              </P>
            )}
            {facts.payments && (
              <P>
                Online payments: Stripe ({code(facts.payments.host)}, {facts.payments.mode} mode) with your own Stripe account, to create the page
                where a client pays an invoice (invoice number, amount, currency and the client's email address, if the invoice has one) and to check
                Stripe's payment notifications. It is on only because an admin connected a Stripe account.
              </P>
            )}
          </>
        )}
        <P muted>
          Updates: the Update app workflow runs in your GitHub repository. It downloads the new version from{" "}
          {PRODUCT_NAME}'s public repository on GitHub and sends nothing about you.
        </P>
      </Fact>

      <Fact
        title={`What the makers of ${PRODUCT_NAME} can see`}
        check={<>{code("SECURITY.md")} in your copy of the code shows how to check this. A test in the code fails if anyone adds a network call to the server.</>}
      >
        {facts.demo ? (
          <P>This demo runs on our server, so we can see everything entered here. In your own copy, the app never sends us your data.</P>
        ) : (
          <>
            <P>
              <strong>We don't see your data.</strong> The app has no usage tracking, no error reporting and no license check, so it never sends us
              what you enter.
            </P>
            <P>
              We do see: anything you choose to share with us, such as the diagnostics file an admin can download. Updates come from
              GitHub, which shows us how many times a release was downloaded, with nothing about who downloaded it.
            </P>
          </>
        )}
      </Fact>

      <Fact title="Taking your data with you">
        <P>
          Download clients, projects, tasks, time and expenses as spreadsheets from{" "}
          <Link to="/manage/data" className="wl-link">Manage → Import &amp; export</Link>.
        </P>
        <P>For everything, including invoices and people, download a backup below. Recovering from a failed update or moving to another host: see "Backups and recovery" in {code("README.md")}.</P>
      </Fact>
      <SettingsSection title="Backup" description="One file with everything: people, clients, projects, time, invoices, expenses and receipts, settings, logo and history. Keep it somewhere safe: it holds your team's sign-in details, scrambled. Each download is recorded in History.">
        <div>
          <ActionButton asChild variant="outline" color="gray">
            <a href="/api/settings/backup" download>Download backup</a>
          </ActionButton>
        </div>
      </SettingsSection>
    </Flex>
  );
}

function Fact({ title, check, children }: { title: string; check?: ReactNode; children: ReactNode }) {
  return (
    <SettingsSection title={title}>
      <Flex direction="column" gap="2">{children}</Flex>
      {check && <Text as="p" size="1" color="gray"><Text weight="medium">Check it yourself:</Text> {check}</Text>}
    </SettingsSection>
  );
}

function OnOff({ on, label, note }: { on: boolean; label: string; note?: string }) {
  return (
    <li>
      <Flex align="baseline" gap="3" wrap="wrap">
        <Badge color={on ? "green" : "gray"} variant="soft" size="1" style={{ minWidth: "2.5rem", justifyContent: "center" }}>{on ? "On" : "Off"}</Badge>
        <Text size="2">
          {label}
          {note && <Text color="gray"> · {note}</Text>}
        </Text>
      </Flex>
    </li>
  );
}
