import type { ColorModeName } from "../shared/color.ts";
import type { RepeatEvery } from "../shared/repeat.ts";

// Small fetch helpers. Errors come back as { error } from the server.
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function api<T>(path: string, body?: unknown, method?: "POST" | "PUT" | "PATCH" | "DELETE"): Promise<T> {
  const res = await fetch(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? data.message ?? "Something went wrong. Try again.", res.status);
  return data as T;
}

/**
 * Saves a file the server makes (a CSV export). The file is only saved when the server answered with
 * a file: an error answer throws, and nothing is downloaded.
 */
export async function downloadFile(path: string): Promise<void> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error ?? data.message ?? "Something went wrong. Try again.", res.status);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "download";
  const link = document.createElement("a");
  link.href = URL.createObjectURL(await res.blob());
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

export type SetupStatus = { needsSetup: boolean; setupCodeConfigured: boolean; setupCodeUrl: string | null; demo: boolean; passwordResetByEmail: boolean };
/** sso: the single sign-on button, when the organization has a provider (WRK-136). */
export type Sso = { name: string; required: boolean };
export type Branding = { name: string | null; appName: string | null; accentColor: string | null; colorMode: ColorModeName; logoVersion: number | null; sso?: Sso | null };
export type Me = {
  /** weeklyCapacity: the hours a week this person is expected to work, in seconds (Manage → People). */
  user: {
    id: string; name: string; email: string; role: string; weeklyCapacity: number;
    /** Two-factor sign-in (WRK-147). mustSetUp: the organization requires it and this person hasn't set it up. */
    twoFactor: { enabled: boolean; hasPassword: boolean; viaSso: boolean; mustSetUp: boolean };
  };
  organization: {
    id: string;
    name: string;
    appName: string | null;
    currency: string;
    address: string;
    accentColor: string | null;
    colorMode: ColorModeName;
    logoVersion: number | null;
    /** Only set in the demo: when this workspace is deleted. */
    demoExpiresAt: string | null;
    /** Whether people submit their weeks for approval (Manage → Settings). */
    timesheetApprovals: boolean;
  };
};

/** currency: what the client is billed in (WRK-135). Admins and managers only. */
/** The currency a project's money is in: its client's, or the home currency (WRK-135). */
export const projectCurrency = (project: { client: { currency?: string } | null }, home: string) => project.client?.currency ?? home;

export type Client = { id: string; name: string; address: string; email: string; currency: string; archived: boolean; projectCount: number; customFields?: Record<string, string> };
/** Manage → Templates (WRK-150): a project's settings, team and tasks, never its client. */
export type ProjectTemplate = {
  id: string; name: string; billable: boolean; billBy: "project" | "person"; hourlyRate: number | null; fixedFee: number | null;
  budgetBy: "none" | "hours" | "fees"; budgetSeconds: number | null; budgetAmount: number | null; everyone: boolean; memberIds: string[];
  tasks: { title: string; notes: string; fee: number | null }[];
  /** Fee per phase (WRK-151): the tasks' fees are the phases'. */
  feeByPhase: boolean;
  /** Custom field values (WRK-148), by field id. */
  customFields: Record<string, string>;
};

export type Project = {
  id: string;
  name: string;
  billable: boolean;
  archived: boolean;
  /** currency: the client's, which the project's money is in. Without a client, the home currency. */
  client: { id: string; name: string; archived: boolean; currency?: string } | null;
  // Only sent to admins and managers.
  billBy?: "project" | "person";
  hourlyRate?: number | null;
  /** Set (cents): a fixed fee project, whose fee is invoiced instead of its hours. */
  fixedFee?: number | null;
  /** Fee per phase (WRK-151): each task with a fee is a phase; fixedFee is their sum. */
  feeByPhase?: boolean;
  budgetBy?: "none" | "hours" | "fees";
  budgetSeconds?: number | null;
  budgetAmount?: number | null;
  /** 0, 80 or 100: the budget level last reached. */
  budgetAlertLevel?: 0 | 80 | 100;
  everyone?: boolean;
  memberIds?: string[];
  /** Custom field values (WRK-148), by field id: admins and managers only. */
  customFields?: Record<string, string>;
};
export type TaskStatus = "todo" | "in_progress" | "done";
export type Task = {
  id: string;
  projectId: string;
  title: string;
  notes: string;
  status: TaskStatus;
  dueDate: string | null;
  completedAt: string | null;
  assignee: { id: string; name: string } | null;
  /** Only in task lists that span projects. */
  project?: { name: string };
};
/** feeInvoiced: on a fixed fee project, how much of the fee is on invoices (drafts too). */
export type ProjectStats = { seconds: number; billableSeconds: number; billableAmount?: number; feeInvoiced?: number };
export type Member = { id: string; name: string; email: string; role: string; active: boolean };
export type TimeEntry = {
  id: string;
  /** The day it belongs to, "YYYY-MM-DD". */
  date: string;
  /** Whole seconds recorded; while running, add the time since startedAt. */
  seconds: number;
  /** Set only while the timer runs. */
  startedAt: string | null;
  notes: string;
  billable: boolean;
  project: { id: string; name: string; archived: boolean; client: { id: string; name: string } | null };
  task: { id: string; title: string } | null;
  /** Set once the time is on an invoice; it can't be changed then. */
  invoice: { id: string; number: string } | null;
  /** Custom field values (WRK-148), by field id. */
  customFields: Record<string, string>;
};

export type InvoiceStatus = "draft" | "sent" | "paid";
export type InvoiceLine = { id: string; position: number; kind: "time" | "expense" | "custom" | "fee"; description: string; quantity: number; unitPrice: number; amount: number };
export type Invoice = {
  id: string;
  number: string;
  status: InvoiceStatus;
  issueDate: string;
  dueDate: string;
  periodFrom: string | null;
  periodTo: string | null;
  currency: string;
  taxBasisPoints: number;
  taxLabel: string;
  discountBasisPoints: number;
  discountAmount: number; // cents
  poNumber: string;
  subject: string;
  notes: string;
  sentAt: string | null;
  paidAt: string | null;
  emailedAt: string | null;
  emailedTo: string | null;
  /** Late-payment reminders (WRK-146): how many went out, the last one, and "Don't remind". */
  remindersSent: number;
  lastReminderAt: string | null;
  remindersOff: boolean;
  client: { id: string; name: string; address: string; email: string };
  lines: InvoiceLine[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  /** Set when the invoice repeats (WRK-42). nextDate is null once its end date has passed. */
  schedule: InvoiceSchedule | null;
};
export type InvoiceSchedule = { every: RepeatEvery; nextDate: string | null; endDate: string | null; paused: boolean; made: number };
/** Manage → Invoicing. `nextNumber` is as typed, leading zeros included. */
export type InvoiceSettings = { prefix: string; nextNumber: string; dueDays: number; taxBasisPoints: number; taxLabel: string; notes: string; reminderDays: number };
