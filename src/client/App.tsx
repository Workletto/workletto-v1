import { useCallback, useEffect, useState } from "react";
import { ErrorNote } from "./ui.tsx";
import { api, ApiError, type Branding, type Me, type SetupStatus, type Sso } from "./api.ts";
import { applyLook, setAppName, setTabIcon } from "./theme.ts";
import { Shell } from "./Shell.tsx";
import { navigate, usePath } from "./router.tsx";
import { requestPageFocus } from "./a11y.tsx";
import { localToday, TimerProvider } from "./timer.tsx";
import { isIsoDate, startOfWeek } from "../shared/time.ts";
import { Setup } from "./screens/Setup.tsx";
import { SignIn } from "./screens/SignIn.tsx";
import { lastTimeMode, Time, type TimeMode } from "./screens/Time.tsx";
import { Projects } from "./screens/Projects.tsx";
import { ProjectPage, useProjectRoute } from "./screens/ProjectPage.tsx";
import { Clients } from "./screens/Clients.tsx";
import { Appearance } from "./screens/Appearance.tsx";
import { People } from "./screens/People.tsx";
import { Email } from "./screens/Email.tsx";
import { Payments } from "./screens/Payments.tsx";
import { About } from "./screens/About.tsx";
import { InvoiceSettings } from "./screens/InvoiceSettings.tsx";
import { Settings } from "./screens/Settings.tsx";
import { Expenses } from "./screens/Expenses.tsx";
import { Reports } from "./screens/Reports.tsx";
import { Invoices, NewInvoice } from "./screens/Invoices.tsx";
import { InvoicePage } from "./screens/InvoicePage.tsx";
import { ImportExport } from "./screens/ImportExport.tsx";
import { Security } from "./screens/Security.tsx";
import { History } from "./screens/History.tsx";
import { Approvals } from "./screens/Approvals.tsx";
import { Team, TeamWeek } from "./screens/Team.tsx";
import { Schedule } from "./screens/Schedule.tsx";
import { TimeOff } from "./screens/TimeOff.tsx";
import { Profitability } from "./screens/Profitability.tsx";
import { CommonTasks } from "./screens/CommonTasks.tsx";
import { ProjectTemplates } from "./screens/ProjectTemplates.tsx";
import { CalendarImport } from "./screens/CalendarImport.tsx";
import { TwoFactorPage, TwoFactorRequired } from "./screens/TwoFactor.tsx";
import { AcceptInvite } from "./screens/AcceptInvite.tsx";
import { ResetPassword } from "./screens/ResetPassword.tsx";
import { canManageOrganization, canManageWork } from "../shared/roles.ts";
import { NotFound } from "./screens/NotFound.tsx";
import { DemoStart } from "./screens/DemoStart.tsx";

type State =
  | { screen: "loading" }
  | { screen: "setup"; codeConfigured: boolean; codeUrl: string | null }
  | { screen: "signIn"; organizationName: string | null; logoVersion: number | null; passwordResetByEmail: boolean; sso: Sso | null }
  | { screen: "demoStart" }
  | { screen: "invite" | "reset"; token: string; logoVersion: number | null }
  | { screen: "app"; me: Me }
  | { screen: "error"; message: string };

// In development the API can start a moment after the page; retry briefly.
async function withRetry<T>(load: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await load();
    } catch (e) {
      const retryable = !(e instanceof ApiError) || e.status >= 502;
      if (!retryable || attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

export function App() {
  const [state, setState] = useState<State>({ screen: "loading" });

  // Decide what to show: setup until an admin exists, then sign-in, then the app.
  const load = useCallback(async () => {
    try {
      // Invite and password reset links show their own page, signed in or not.
      const link = /^\/(invite|reset)\/([\w-]+)$/.exec(location.pathname);
      if (link) {
        const branding = await withRetry(() => api<Branding>("/api/branding"));
        applyLook(branding);
        setAppName(branding);
        setTabIcon(branding.logoVersion, false);
        return setState({ screen: link[1] as "invite" | "reset", token: link[2]!, logoVersion: branding.logoVersion });
      }
      const status = await withRetry(() => api<SetupStatus>("/api/setup/status"));
      if (status.needsSetup) return setState({ screen: "setup", codeConfigured: status.setupCodeConfigured, codeUrl: status.setupCodeUrl });
      try {
        const me = await api<Me>("/api/me");
        applyLook(me.organization);
        setAppName(me.organization);
        setTabIcon(me.organization.logoVersion, true);
        setState({ screen: "app", me });
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) throw e;
        if (status.demo) return setState({ screen: "demoStart" });
        const branding = await api<Branding>("/api/branding");
        applyLook(branding);
        setAppName(branding);
        setTabIcon(branding.logoVersion, false);
        setState({
          screen: "signIn",
          organizationName: branding.name,
          logoVersion: branding.logoVersion,
          passwordResetByEmail: status.passwordResetByEmail ?? false,
          sso: branding.sso ?? null,
        });
      }
    } catch (e) {
      setState({ screen: "error", message: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Signing in, setting up or accepting an invite replaces the whole screen: focus goes to the new page's heading.
  const enter = useCallback(() => {
    requestPageFocus();
    void load();
  }, [load]);

  switch (state.screen) {
    case "loading":
      return null;
    case "setup":
      return <Setup codeConfigured={state.codeConfigured} codeUrl={state.codeUrl} onDone={enter} />;
    case "demoStart":
      return <DemoStart onDone={enter} />;
    case "invite":
    case "reset": {
      // Done with the link: on to the app's front page, signed in.
      const leave = () => {
        navigate("/", { replace: true });
        enter();
      };
      const LinkPage = state.screen === "invite" ? AcceptInvite : ResetPassword;
      return <LinkPage token={state.token} logoVersion={state.logoVersion} onDone={leave} />;
    }
    case "signIn":
      return (
        <SignIn
          organizationName={state.organizationName}
          logoVersion={state.logoVersion}
          passwordResetByEmail={state.passwordResetByEmail}
          sso={state.sso}
          onDone={enter}
        />
      );
    case "error":
      return (
        <main id="main" className="wl-auth">
          <div className="wl-auth-inner">
            <ErrorNote message={`Could not reach the server: ${state.message}`} />
          </div>
        </main>
      );
    case "app": {
      const { me } = state;
      // The organization requires two-factor sign-in: nothing else until it's set up.
      if (me.user.twoFactor.mustSetUp) return <TwoFactorRequired me={me} onDone={enter} onSignOut={enter} />;
      return (
        <TimerProvider>
          <Shell me={me} onSignOut={load}>
            <Page
              me={me}
              onReload={load}
              onOrganizationChange={(changes) => {
                if (changes.logoVersion !== undefined) setTabIcon(changes.logoVersion, true);
                setState({ screen: "app", me: { ...me, organization: { ...me.organization, ...changes } } });
              }}
            />
          </Shell>
        </TimerProvider>
      );
    }
  }
}

// The signed-in pages, chosen by the address. "/" is today's time; anything else unknown or not allowed is Page not found.
function Page({ me, onOrganizationChange, onReload }: { me: Me; onOrganizationChange: (changes: Partial<Me["organization"]>) => void; onReload: () => void }) {
  const path = usePath();
  const project = useProjectRoute();
  const canManage = canManageWork(me.user.role);
  const isAdmin = canManageOrganization(me.user.role);

  if (path === "/account/two-factor") return <TwoFactorPage me={me} onChanged={onReload} />;
  const calendar = /^\/time\/calendar\/(.+)$/.exec(path);
  if (calendar && isIsoDate(calendar[1])) return <CalendarImport key="calendar" week={calendar[1]} />;
  const time = /^\/time\/(day|week)\/(.+)$/.exec(path);
  if (time && isIsoDate(time[2])) return <Time mode={time[1] as TimeMode} date={time[2]} canManage={canManage} admin={isAdmin} approvals={me.organization.timesheetApprovals} capacity={me.user.weeklyCapacity} />;
  if (canManage && me.organization.timesheetApprovals && /^\/approvals(\/(approved|rejected))?$/.test(path)) return <Approvals myId={me.user.id} />;
  if (canManage && path === "/team") return <Team key="team" week={startOfWeek(localToday())} isAdmin={isAdmin} />;
  if (path === "/time-off") return <TimeOff me={me} />;
  if (canManage && path === "/team/schedule") return <Schedule key="schedule" from={startOfWeek(localToday())} />;
  const scheduleWeek = /^\/team\/schedule\/(\d{4}-\d{2}-\d{2})$/.exec(path);
  if (canManage && scheduleWeek && isIsoDate(scheduleWeek[1])) return <Schedule key="schedule" from={startOfWeek(scheduleWeek[1])} />;
  const teamWeek = /^\/team\/(\d{4}-\d{2}-\d{2})$/.exec(path);
  if (canManage && teamWeek && isIsoDate(teamWeek[1])) return <Team key="team" week={startOfWeek(teamWeek[1])} isAdmin={isAdmin} />;
  const personWeek = /^\/team\/([\w-]+)\/(\d{4}-\d{2}-\d{2})$/.exec(path);
  if (canManage && personWeek && isIsoDate(personWeek[2])) return <TeamWeek key={personWeek[1]} userId={personWeek[1]!} week={startOfWeek(personWeek[2])} />;
  if (path === "/projects") return <Projects canManage={canManage} />;
  if (canManage && path === "/invoices") return <Invoices />;
  const newInvoice = /^\/invoices\/new(?:\/([\w-]+))?$/.exec(path);
  if (canManage && newInvoice) return <NewInvoice key={newInvoice[1]} clientId={newInvoice[1]} currency={me.organization.currency} />;
  const invoice = /^\/invoices\/([\w-]+)$/.exec(path);
  if (canManage && invoice) return <InvoicePage key={invoice[1]} id={invoice[1]!} isAdmin={isAdmin} />;
  if (path === "/reports") return <Reports canManage={canManage} currency={me.organization.currency} />;
  if (canManage && path === "/reports/profitability") return <Profitability currency={me.organization.currency} />;
  const expenses = /^\/expenses(?:\/(\d{4}-(?:0[1-9]|1[0-2])))?$/.exec(path);
  if (expenses) return <Expenses key={expenses[1]} month={expenses[1] ?? localToday().slice(0, 7)} currency={me.organization.currency} />;
  if (project) return <ProjectPage key={project.id} id={project.id} tab={project.tab} me={me} />;
  // Clients have their own place in the navigation; the old Manage address still works.
  if (canManage && (path === "/clients" || path === "/manage/clients")) return <Clients home={me.organization.currency} />;
  if (canManage && path === "/manage/tasks") return <CommonTasks role={me.user.role} />;
  if (canManage && path === "/manage/templates") return <ProjectTemplates role={me.user.role} />;
  if (canManage && (path === "/manage/data" || (path === "/manage" && !isAdmin))) return <ImportExport role={me.user.role} />;
  if (isAdmin && (path === "/manage/people" || path === "/manage")) return <People myId={me.user.id} currency={me.organization.currency} />;
  if (isAdmin && path === "/manage/settings") {
    return (
      <Settings
        me={me}
        onSaved={(changes) => {
          if (changes.name !== undefined && changes.appName !== undefined) setAppName({ name: changes.name, appName: changes.appName });
          onOrganizationChange(changes);
        }}
      />
    );
  }
  if (isAdmin && path === "/manage/invoices") return <InvoiceSettings />;
  if (isAdmin && path === "/manage/payments") return <Payments />;
  if (isAdmin && path === "/manage/about") return <About />;
  if (isAdmin && path === "/manage/email") return <Email />;
  if (isAdmin && path === "/manage/security") return <Security demoExpiresAt={me.organization.demoExpiresAt} />;
  if (isAdmin && path === "/manage/history") return <History currency={me.organization.currency} />;
  if (isAdmin && path === "/manage/appearance") return <Appearance me={me} onSaved={onOrganizationChange} />;
  // Only the front page is today's Time. Any other address is not a page this person can open.
  if (path === "/") return <Time mode={lastTimeMode()} date={localToday()} canManage={canManage} admin={isAdmin} approvals={me.organization.timesheetApprovals} capacity={me.user.weeklyCapacity} />;
  return <NotFound />;
}
