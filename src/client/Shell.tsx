import { createContext, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Callout, DropdownMenu } from "@radix-ui/themes";
import { api, type Me } from "./api.ts";
import { announce, APPROVALS_CHANGED, requestPageFocus } from "./a11y.tsx";
import { appName, setTimerTitle } from "./theme.ts";
import { formatDuration } from "../shared/time.ts";
import { Link, navigate, usePath } from "./router.tsx";
import { elapsed, useNow, useTimer } from "./timer.tsx";
import { canManageOrganization, canManageWork, isRole, ROLE_LABELS } from "../shared/roles.ts";
import { ActionButton, helpUrl, InfoIcon, NavTabs } from "./ui.tsx";
import { NAV_ICONS, StopIcon, UpDownIcon } from "./icons.tsx";
import { lastTimeMode } from "./screens/Time.tsx";
import { ChangePasswordDialog } from "./ChangePassword.tsx";

type Section = "time" | "approvals" | "team" | "expenses" | "projects" | "clients" | "reports" | "invoices" | "manage";

// The sections in the sidebar, in groups: daily work, what it's for, and money. Manage sits at the bottom.
const LINKS: { section: Section; to: string; label: string; group: number; allowed?: (role: string) => boolean; needsApprovals?: boolean }[] = [
  { section: "time", to: "/", label: "Time", group: 0 },
  { section: "approvals", to: "/approvals", label: "Approvals", group: 0, allowed: canManageWork, needsApprovals: true },
  { section: "team", to: "/team", label: "Team", group: 0, allowed: canManageWork },
  { section: "expenses", to: "/expenses", label: "Expenses", group: 0 },
  { section: "projects", to: "/projects", label: "Projects", group: 1 },
  { section: "clients", to: "/clients", label: "Clients", group: 1, allowed: canManageWork },
  { section: "reports", to: "/reports", label: "Reports", group: 2 },
  { section: "invoices", to: "/invoices", label: "Invoices", group: 2, allowed: canManageWork },
  { section: "manage", to: "/manage", label: "Manage", group: 3, allowed: canManageWork },
];

/** The Page not found screen says it is showing, so the navigation highlights nothing. */
export const NotFoundSignal = createContext<(showing: boolean) => void>(() => undefined);

function sectionOf(path: string): Section {
  if (path.startsWith("/approvals")) return "approvals";
  if (path.startsWith("/team")) return "team";
  if (path.startsWith("/projects")) return "projects";
  if (path.startsWith("/clients") || path === "/manage/clients") return "clients";
  if (path.startsWith("/expenses")) return "expenses";
  if (path.startsWith("/reports")) return "reports";
  if (path.startsWith("/invoices")) return "invoices";
  if (path.startsWith("/manage")) return "manage";
  return "time";
}

/** How many weeks wait for a manager's decision, for the count beside Approvals. Checked again on each page and when Approvals says a decision was made. */
function useWaitingWeeks(enabled: boolean, path: string, myId: string) {
  const [count, setCount] = useState(0);
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    const onChange = () => setChanges((n) => n + 1);
    window.addEventListener(APPROVALS_CHANGED, onChange);
    return () => window.removeEventListener(APPROVALS_CHANGED, onChange);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    api<{ weeks: { person: { id: string } }[] }>("/api/timesheets?status=submitted")
      // Nobody approves their own week, so it isn't one of the weeks waiting for this person.
      .then((r) => current && setCount(r.weeks.filter((w) => w.person.id !== myId).length))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [enabled, path, changes, myId]);
  return enabled ? count : 0;
}

// The signed-in frame: a sidebar with the app's name or logo, the running timer, the sections and
// the account menu, beside one white sheet that holds the page. Below 75rem the sidebar becomes a
// bar across the top and the sections fold into a Menu button.
export function Shell({ me, onSignOut, children }: { me: Me; onSignOut: () => void; children: ReactNode }) {
  const path = usePath();
  const [notFound, setNotFound] = useState(false);
  const section = notFound ? null : sectionOf(path);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  // Demo visitors have no password of their own to change.
  const demo = me.organization.demoExpiresAt !== null;
  const [changingPassword, setChangingPassword] = useState(false);
  useEffect(() => setMenuOpen(false), [path]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButton.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);
  async function signOut() {
    const ok = await api("/api/auth/sign-out", {}).then(() => true, () => false);
    // Refused, for example when the app is opened at an address other than the one it's set up for.
    if (!ok) window.alert("Signing out didn't work. Reload the page and try again. If it keeps happening, open the app at its usual address.");
    requestPageFocus();
    onSignOut();
  }
  const links = LINKS.filter((l) => (!l.allowed || l.allowed(me.user.role)) && (!l.needsApprovals || me.organization.timesheetApprovals));
  const waiting = useWaitingWeeks(me.organization.timesheetApprovals && canManageWork(me.user.role), path, me.user.id);
  // The last group (Manage, or nothing for members) sits at the bottom of the sidebar, with Help.
  const groups = [...[0, 1, 2].map((g) => links.filter((l) => l.group === g)).filter((g) => g.length > 0), links.filter((l) => l.group === 3)];
  const closeMenu = () => {
    // The link is about to be hidden. Keep focus on the Menu button rather than losing it;
    // going to a new page moves it to that page's heading.
    if (menuOpen) menuButton.current?.focus();
    setMenuOpen(false);
  };

  return (
    <div className="wl-app">
      <a
        href="#main"
        onClick={(event) => {
          // Move focus without adding #main to the address.
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
        className="wl-skip"
      >
        Skip to content
      </a>
      {!demo && <ChangePasswordDialog
          open={changingPassword}
          onOpenChange={setChangingPassword}
          // The account menu button, or on a phone (where it is hidden) the Menu button.
          returnFocus={() => (accountButton.current && accountButton.current.getClientRects().length > 0 ? accountButton.current : menuButton.current)}
        />}
      <header className="wl-sidebar">
        <div className="wl-sidebar-top">
          <Brand me={me} />
          <ActionButton
            ref={menuButton}
            type="button"
            variant="outline"
            color="gray"
            size="2"
            className="wl-menu-button"
            aria-expanded={menuOpen}
            aria-controls="main-nav"
            onClick={() => setMenuOpen((open) => !open)}
          >
            Menu
          </ActionButton>
        </div>
        {/* The day view has its own large running card, so there the sidebar keeps to one line. */}
        <RunningTimer full={section === "time" && (path.startsWith("/time/week") || (path === "/" && lastTimeMode() === "week"))} />
        <nav id="main-nav" aria-label="Main" className="wl-nav" data-open={menuOpen}>
          {groups.map((group, i) => (
            <div key={i} className="wl-nav-group" data-bottom={i === groups.length - 1 ? true : undefined}>
              {group.map((l) => (
                <Link key={l.section} to={l.to} onClick={closeMenu} aria-current={section === l.section ? "page" : undefined} className="wl-navlink">
                  {NAV_ICONS[l.section]}
                  <span className="wl-navlink-label">{l.label}</span>
                  {l.section === "approvals" && waiting > 0 && (
                    <span className="wl-nav-count">
                      {waiting}
                      <span className="wl-sr-only"> waiting</span>
                    </span>
                  )}
                </Link>
              ))}
              {i === groups.length - 1 && (
                <a href={helpUrl("")} target="_blank" rel="noreferrer" className="wl-navlink">
                  {NAV_ICONS.help}
                  <span className="wl-navlink-label">Help</span>
                  <span className="wl-sr-only"> (opens in a new tab)</span>
                </a>
              )}
            </div>
          ))}
          {!demo && (
            <button type="button" onClick={() => setChangingPassword(true)} className="wl-navlink wl-nav-signout">
              Change password
            </button>
          )}
          <button type="button" onClick={() => void signOut()} className="wl-navlink wl-nav-signout">
            Sign out
          </button>
        </nav>
        <UserMenu buttonRef={accountButton} name={me.user.name} email={me.user.email} role={me.user.role} onSignOut={signOut} onChangePassword={demo ? undefined : () => setChangingPassword(true)} onTwoFactor={demo ? undefined : () => navigate("/account/two-factor")} />
      </header>
      <div className="wl-workarea">
        <div className="wl-sheet">
          {me.organization.demoExpiresAt && (
            <section className="wl-demo" aria-label="About this demo">
              <Callout.Root size="1" color="amber" variant="soft" highContrast>
                <Callout.Icon>
                  <InfoIcon />
                </Callout.Icon>
                <Callout.Text>
                  This demo runs on our server and is deleted after 2 hours (at{" "}
                  {new Date(me.organization.demoExpiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}). Don't enter real client data.
                </Callout.Text>
              </Callout.Root>
            </section>
          )}
          <main id="main" tabIndex={-1} className="wl-main">
            <NotFoundSignal.Provider value={setNotFound}>{children}</NotFoundSignal.Provider>
          </main>
        </div>
      </div>
    </div>
  );
}

// The organization's logo and name, or a mark with the first letter of the app's name. A square
// or nearly square logo sits beside the name (the app name, else the organization's: the same as the tab title); a wide one is usually a wordmark that already
// spells the name, so it stands alone (the name is still there for screen readers).
export function Brand({ me }: { me: Me }) {
  const name = appName();
  const [wide, setWide] = useState(false);
  if (me.organization.logoVersion) {
    return (
      <p className="wl-brand" data-logo={wide ? "wide" : "square"}>
        <img
          src={`/api/logo?v=${me.organization.logoVersion}`}
          alt=""
          onLoad={(event) => setWide(event.currentTarget.naturalWidth >= 2 * event.currentTarget.naturalHeight)}
        />
        <span className={wide ? "wl-sr-only" : "wl-brand-name"} title={wide ? undefined : name}>{name}</span>
      </p>
    );
  }
  return (
    <p className="wl-brand">
      <span className="wl-brand-mark" aria-hidden>{name.trim().charAt(0).toUpperCase()}</span>
      <span className="wl-brand-text">
        <span className="wl-brand-name" title={name}>{name}</span>
      </span>
    </p>
  );
}

// The signed-in person, with Change password and Sign out in a menu. (On phones they're in the Menu.)
function UserMenu({ buttonRef, name, email, role, onSignOut, onChangePassword, onTwoFactor }: { buttonRef: Ref<HTMLButtonElement>; name: string; email: string; role: string; onSignOut: () => Promise<void>; onChangePassword?: () => void; onTwoFactor?: () => void }) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger>
        <button ref={buttonRef} type="button" className="wl-account" aria-label={`${name}, account menu`}>
          <span className="wl-avatar" aria-hidden>{name.trim().charAt(0).toUpperCase()}</span>
          <span className="wl-account-text">
            <span className="wl-brand-name">{name}</span>
            <span className="wl-account-role">{isRole(role) ? ROLE_LABELS[role] : role}</span>
          </span>
          <UpDownIcon />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start" side="top" size="2">
        <DropdownMenu.Label>{email}</DropdownMenu.Label>
        <DropdownMenu.Separator />
        {onChangePassword && <DropdownMenu.Item onSelect={onChangePassword}>Change password</DropdownMenu.Item>}
        {onTwoFactor && <DropdownMenu.Item onSelect={onTwoFactor}>Two-factor sign-in</DropdownMenu.Item>}
        <DropdownMenu.Item onSelect={() => void onSignOut()}>Sign out</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

// Shown in the sidebar on every page while a timer runs, and in the browser tab's title while the
// tab is in the background. On Time it is a card with the clock large; elsewhere one quiet line,
// so it doesn't compete with the page.
function RunningTimer({ full }: { full: boolean }) {
  const { running, stop } = useTimer();
  const now = useNow(running !== null);
  const time = running ? formatDuration(elapsed(running, now), true) : "";
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    setTimerTitle(running ? `${time} · ${running.project.name} – ${appName()}` : null);
  }, [running, time]);

  async function stopTimer() {
    if (stopping) return;
    setStopping(true);
    try {
      await stop();
    } catch (e) {
      announce((e as Error).message);
    } finally {
      setStopping(false);
    }
  }

  if (!running) return null;
  if (!full) {
    return (
      <div className="wl-timer" data-size="compact" role="group" aria-label="Running timer">
        <span className="wl-pulse" aria-hidden />
        <Link to={`/time/day/${running.date}`} className="wl-timer-project">{running.project.name}</Link>
        <span role="timer" className="wl-num wl-timer-time">{time}</span>
        <ActionButton size="1" variant="soft" color="gray" onClick={() => void stopTimer()} busy={stopping} className="wl-timer-stop" aria-label="Stop timer">
          <StopIcon />
        </ActionButton>
      </div>
    );
  }
  return (
    <div className="wl-timer" data-size="full" role="group" aria-label="Running timer">
      <p className="wl-timer-state">
        <span className="wl-pulse" aria-hidden />
        Timer running
      </p>
      <span role="timer" className="wl-num wl-timer-time">{time}</span>
      <p className="wl-timer-what">
        <Link to={`/time/day/${running.date}`} className="wl-timer-project">{running.project.name}</Link>
        {running.project.client && <span className="wl-timer-client">{running.project.client.name}</span>}
      </p>
      <ActionButton size="2" variant="soft" color="gray" onClick={() => void stopTimer()} busy={stopping} className="wl-timer-stop">
        <StopIcon />
        Stop timer
      </ActionButton>
    </div>
  );
}

/** Where Manage opens: People for admins, Import & export for managers. */
export const manageHome = (role: string) => (canManageOrganization(role) ? "/manage/people" : "/manage/data");

/** The tabs at the top of the Manage pages. Managers see Import & export. */
export function ManageTabs({ role }: { role: string }) {
  const path = usePath();
  const tabs = [
    ...(canManageOrganization(role)
      ? [
          { to: "/manage/people", label: "People" },
        ]
      : []),
    { to: "/manage/tasks", label: "Tasks" },
    { to: "/manage/templates", label: "Templates" },
    ...(canManageOrganization(role)
      ? [
          { to: "/manage/settings", label: "Settings" },
          { to: "/manage/invoices", label: "Invoicing" },
          { to: "/manage/payments", label: "Payments" },
          { to: "/manage/email", label: "Email" },
          { to: "/manage/appearance", label: "Appearance" },
          { to: "/manage/security", label: "Security & data" },
          { to: "/manage/history", label: "History" },
        ]
      : []),
    { to: "/manage/data", label: "Import & export" },
    ...(canManageOrganization(role) ? [{ to: "/manage/about", label: "About" }] : []),
  ];
  return <NavTabs label="Manage sections" tabs={tabs.map((t) => ({ ...t, active: path === t.to || (path === "/manage" && t.to === manageHome(role)) }))} />;
}
