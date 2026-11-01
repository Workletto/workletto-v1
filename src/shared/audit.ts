// Audit history types, shared by the server (src/server/audit.ts) and the History screen.

export const AUDIT_KINDS = ["time", "timesheet", "expense", "project", "person", "invoice", "import", "backup", "settings"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export type AuditValue = string | number | boolean | null;
/** One field that changed. Values are raw: cents, seconds, ISO dates, role names. */
export type Change = { field: string; from: AuditValue; to: AuditValue };
