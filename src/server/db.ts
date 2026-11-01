import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.ts";
import { env } from "./env.ts";

// The unrestricted client. Everything a signed-in person does goes through orgDb().
// It's used directly only where no one is signed in or no single organization is
// meant: sign-in and sessions, first-run setup and restore, invite and reset tokens,
// public branding and the Pay now pages (each looks up its organization, then uses
// orgDb), Stripe's notifications, background jobs (reminders, payment checks, demo
// cleanup), backups, the health check and the diagnostics page, and checks that a
// person's email address is unused anywhere on the install (it is unique across all
// organizations).
export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.databaseUrl }) });

// Every model that holds one organization's data. A new business table must be
// added here, or orgDb() refuses to touch it.
//
// When tables reference each other (a project's client, an entry's project), also
// give the relation a compound key on (organizationId, id) so the database itself
// rejects links between two organizations' rows.
export const ORG_SCOPED_MODELS = new Set<string>(["User", "Logo", "Invite", "PasswordReset", "EmailSettings", "Client", "Project", "ProjectMember", "Task", "TimeEntry", "Expense", "Invoice", "InvoiceLine", "AuditEvent", "TimesheetWeek", "Receipt", "PaymentSettings", "Payment", "CommonTask", "SsoSettings", "TimeOff", "Holiday", "ScheduledWork", "InvoiceSchedule", "ProjectTemplate", "CalendarSettings", "CustomField", "CustomFieldValue", "UserGroup", "UserGroupMember"]);

const WHERE_OPERATIONS = new Set([
  "findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow",
  "count", "aggregate", "groupBy",
  "update", "updateMany", "updateManyAndReturn", "upsert",
  "delete", "deleteMany",
]);
const CREATE_OPERATIONS = new Set(["create", "createMany", "createManyAndReturn", "upsert"]);

export class OrgScopeError extends Error {}

function withOrg(data: unknown, organizationId: string) {
  const row = (data ?? {}) as Record<string, unknown>;
  if ("organizationId" in row && row.organizationId !== organizationId) {
    throw new OrgScopeError("Cannot write a row into another organization.");
  }
  if ("organization" in row) throw new OrgScopeError("Set organizationId through orgDb, not a relation.");
  return { ...row, organizationId };
}

// A database client that can only see and change one organization's rows.
// The demo (many organizations) and a customer install (one) run the same code.
export function orgDb(organizationId: string) {
  if (!organizationId) throw new OrgScopeError("orgDb needs an organization id.");

  return prisma.$extends({
    name: "org-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const a = (args ?? {}) as Record<string, any>;

          if (model === "Organization") {
            // Read or rename your own organization; never create or delete one here.
            if (!WHERE_OPERATIONS.has(operation) || operation.startsWith("delete") || operation === "upsert") {
              throw new OrgScopeError(`orgDb cannot ${operation} organizations.`);
            }
            a.where = operation === "findUnique" || operation === "findUniqueOrThrow" || operation === "update"
              ? { ...a.where, id: organizationId }
              : { AND: [a.where ?? {}, { id: organizationId }] };
            return query(a);
          }

          if (!ORG_SCOPED_MODELS.has(model)) {
            throw new OrgScopeError(`${model} is not organization-scoped. Add it to ORG_SCOPED_MODELS or use prisma directly in auth code.`);
          }

          if (WHERE_OPERATIONS.has(operation)) {
            // Unique lookups accept extra filters, but not inside AND.
            a.where = ["findUnique", "findUniqueOrThrow", "update", "delete", "upsert"].includes(operation)
              ? { ...a.where, organizationId }
              : { AND: [a.where ?? {}, { organizationId }] };
          }
          if (CREATE_OPERATIONS.has(operation)) {
            if (operation === "upsert") a.create = withOrg(a.create, organizationId);
            else if (Array.isArray(a.data)) a.data = a.data.map((row: unknown) => withOrg(row, organizationId));
            else a.data = withOrg(a.data, organizationId);
          }
          if (operation.startsWith("update") || operation === "upsert") {
            const data = operation === "upsert" ? a.update : a.data;
            if (data && ("organizationId" in data || "organization" in data)) {
              throw new OrgScopeError("Rows cannot move between organizations.");
            }
          }
          return query(a);
        },
      },
    },
  });
}

export type OrgDb = ReturnType<typeof orgDb>;
