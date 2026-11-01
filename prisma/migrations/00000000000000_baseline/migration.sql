-- The whole schema for 0.9.0 in one migration (WRK-94). The migrations before it are in git history.
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ColorMode" AS ENUM ('system', 'light', 'dark');

-- CreateEnum
CREATE TYPE "EmailProvider" AS ENUM ('smtp');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'manager', 'member');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'sent', 'paid');

-- CreateEnum
CREATE TYPE "InvoiceLineKind" AS ENUM ('time', 'expense', 'custom', 'fee');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('todo', 'in_progress', 'done');

-- CreateEnum
CREATE TYPE "BillBy" AS ENUM ('project', 'person');

-- CreateEnum
CREATE TYPE "BudgetBy" AS ENUM ('none', 'hours', 'fees');

-- CreateEnum
CREATE TYPE "AuditKind" AS ENUM ('time', 'timesheet', 'expense', 'project', 'person', 'invoice', 'import', 'backup', 'settings');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('created', 'changed', 'deleted');

-- CreateEnum
CREATE TYPE "TimesheetStatus" AS ENUM ('submitted', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('stripe');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('open', 'processing', 'paid', 'expired', 'failed');

-- CreateEnum
CREATE TYPE "TimeOffKind" AS ENUM ('vacation', 'sick', 'other');

-- CreateEnum
CREATE TYPE "TimeOffStatus" AS ENUM ('approved', 'pending');

-- CreateEnum
CREATE TYPE "RepeatEvery" AS ENUM ('week', 'month', 'quarter');

-- CreateEnum
CREATE TYPE "CustomFieldKind" AS ENUM ('time', 'project', 'client');

-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('text', 'choice', 'number');

-- CreateTable
CREATE TABLE "installation" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" TEXT,

    CONSTRAINT "installation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "appName" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "exchangeRates" JSONB NOT NULL DEFAULT '{}',
    "address" TEXT NOT NULL DEFAULT '',
    "invoicePrefix" TEXT NOT NULL DEFAULT '',
    "invoiceNextNumber" INTEGER NOT NULL DEFAULT 1,
    "invoiceNumberDigits" INTEGER NOT NULL DEFAULT 4,
    "invoiceDueDays" INTEGER NOT NULL DEFAULT 30,
    "invoiceTaxBasisPoints" INTEGER NOT NULL DEFAULT 0,
    "invoiceTaxLabel" TEXT NOT NULL DEFAULT 'Tax',
    "invoiceNotes" TEXT NOT NULL DEFAULT '',
    "invoiceReminderDays" INTEGER NOT NULL DEFAULT 0,
    "accentColor" TEXT,
    "colorMode" "ColorMode" NOT NULL DEFAULT 'system',
    "timeOffApproval" BOOLEAN NOT NULL DEFAULT false,
    "requireTwoFactor" BOOLEAN NOT NULL DEFAULT false,
    "demoExpiresAt" TIMESTAMP(3),
    "timesheetApprovals" BOOLEAN NOT NULL DEFAULT false,
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "reminderWeek" DATE,
    "donationPromptDismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logo" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "logo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "EmailProvider" NOT NULL,
    "fromName" TEXT NOT NULL DEFAULT '',
    "fromEmail" TEXT NOT NULL,
    "smtpHost" TEXT NOT NULL DEFAULT '',
    "smtpPort" INTEGER NOT NULL DEFAULT 587,
    "smtpSecure" BOOLEAN NOT NULL DEFAULT false,
    "smtpUser" TEXT NOT NULL DEFAULT '',
    "secret" TEXT NOT NULL DEFAULT '',
    "lastTestAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'member',
    "deactivatedAt" TIMESTAMP(3),
    "hourlyRate" INTEGER,
    "costRate" INTEGER,
    "weeklyCapacity" INTEGER NOT NULL DEFAULT 144000,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT,
    "choices" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "viaSso" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factor" (
    "id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "backupCodes" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT true,
    "failedVerificationCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "two_factor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'member',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "currency" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "billBy" "BillBy" NOT NULL DEFAULT 'project',
    "hourlyRate" INTEGER,
    "fixedFee" INTEGER,
    "feeByPhase" BOOLEAN NOT NULL DEFAULT false,
    "budgetBy" "BudgetBy" NOT NULL DEFAULT 'none',
    "budgetSeconds" INTEGER,
    "budgetAmount" INTEGER,
    "budgetAlertLevel" INTEGER NOT NULL DEFAULT 0,
    "everyone" BOOLEAN NOT NULL DEFAULT true,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "category" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "billable" BOOLEAN NOT NULL,
    "reimbursable" BOOLEAN NOT NULL DEFAULT false,
    "invoiceLineId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "issueDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "periodFrom" DATE,
    "periodTo" DATE,
    "currency" TEXT NOT NULL,
    "taxBasisPoints" INTEGER NOT NULL DEFAULT 0,
    "taxLabel" TEXT NOT NULL DEFAULT 'Tax',
    "discountBasisPoints" INTEGER NOT NULL DEFAULT 0,
    "discountAmount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "poNumber" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL DEFAULT '',
    "sentAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "emailedAt" TIMESTAMP(3),
    "emailedTo" TEXT,
    "remindersSent" INTEGER NOT NULL DEFAULT 0,
    "lastReminderAt" TIMESTAMP(3),
    "remindersOff" BOOLEAN NOT NULL DEFAULT false,
    "billToName" TEXT,
    "billToAddress" TEXT,
    "fromName" TEXT,
    "fromAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "InvoiceLineKind" NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "projectId" TEXT,
    "taskId" TEXT,

    CONSTRAINT "invoice_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "status" "TaskStatus" NOT NULL DEFAULT 'todo',
    "assigneeId" TEXT,
    "dueDate" DATE,
    "completedAt" TIMESTAMP(3),
    "fee" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "common_task" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "addToNewProjects" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "common_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_template" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "billBy" "BillBy" NOT NULL DEFAULT 'project',
    "hourlyRate" INTEGER,
    "fixedFee" INTEGER,
    "feeByPhase" BOOLEAN NOT NULL DEFAULT false,
    "budgetBy" "BudgetBy" NOT NULL DEFAULT 'none',
    "budgetSeconds" INTEGER,
    "budgetAmount" INTEGER,
    "everyone" BOOLEAN NOT NULL DEFAULT true,
    "memberIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tasks" JSONB NOT NULL DEFAULT '[]',
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_member" (
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_member_pkey" PRIMARY KEY ("projectId","userId")
);

-- CreateTable
CREATE TABLE "time_entry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT,
    "date" DATE NOT NULL,
    "seconds" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "notes" TEXT NOT NULL DEFAULT '',
    "calendarEventId" TEXT,
    "billable" BOOLEAN NOT NULL,
    "invoiceLineId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "kind" "AuditKind" NOT NULL,
    "action" "AuditAction" NOT NULL,
    "subjectId" TEXT,
    "label" TEXT NOT NULL,
    "entryDate" DATE,
    "changes" JSONB NOT NULL DEFAULT '[]',
    "currency" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timesheet_week" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "status" "TimesheetStatus" NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "note" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "timesheet_week_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sso_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "allowJoin" BOOLEAN NOT NULL DEFAULT false,
    "requireSso" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sso_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "mode" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "keyHint" TEXT NOT NULL,
    "webhookId" TEXT,
    "webhookSecret" TEXT,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerRef" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_off" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "half" BOOLEAN NOT NULL DEFAULT false,
    "kind" "TimeOffKind" NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "status" "TimeOffStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_off_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holiday" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_work" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_work_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_schedule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "every" "RepeatEvery" NOT NULL,
    "startDate" DATE NOT NULL,
    "made" INTEGER NOT NULL DEFAULT 0,
    "endDate" DATE,
    "pausedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "appliesTo" "CustomFieldKind" NOT NULL,
    "type" "CustomFieldType" NOT NULL,
    "choices" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "required" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_value" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "timeEntryId" TEXT,
    "projectId" TEXT,
    "clientId" TEXT,
    "value" TEXT NOT NULL,

    CONSTRAINT "custom_field_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_group" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_group_member" (
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "user_group_member_pkey" PRIMARY KEY ("groupId","userId")
);

-- CreateIndex
CREATE INDEX "organization_demoExpiresAt_idx" ON "organization"("demoExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "logo_organizationId_key" ON "logo"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "email_settings_organizationId_key" ON "email_settings"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_organizationId_idx" ON "user"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "user_id_organizationId_key" ON "user"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_settings_userId_key" ON "calendar_settings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_settings_userId_organizationId_key" ON "calendar_settings"("userId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "two_factor_userId_key" ON "two_factor"("userId");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "invite_tokenHash_key" ON "invite"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "invite_organizationId_email_key" ON "invite"("organizationId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "invite_userId_organizationId_key" ON "invite"("userId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_userId_key" ON "password_reset"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokenHash_key" ON "password_reset"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_userId_organizationId_key" ON "password_reset"("userId", "organizationId");

-- CreateIndex
CREATE INDEX "client_organizationId_idx" ON "client"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "client_id_organizationId_key" ON "client"("id", "organizationId");

-- CreateIndex
CREATE INDEX "project_organizationId_idx" ON "project"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "project_id_organizationId_key" ON "project"("id", "organizationId");

-- CreateIndex
CREATE INDEX "expense_organizationId_userId_date_idx" ON "expense"("organizationId", "userId", "date");

-- CreateIndex
CREATE INDEX "expense_organizationId_date_idx" ON "expense"("organizationId", "date");

-- CreateIndex
CREATE INDEX "expense_projectId_date_idx" ON "expense"("projectId", "date");

-- CreateIndex
CREATE INDEX "expense_invoiceLineId_idx" ON "expense"("invoiceLineId");

-- CreateIndex
CREATE UNIQUE INDEX "expense_id_organizationId_key" ON "expense"("id", "organizationId");

-- CreateIndex
CREATE INDEX "invoice_clientId_idx" ON "invoice"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_organizationId_number_key" ON "invoice"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_id_organizationId_key" ON "invoice"("id", "organizationId");

-- CreateIndex
CREATE INDEX "invoice_line_invoiceId_idx" ON "invoice_line"("invoiceId");

-- CreateIndex
CREATE INDEX "invoice_line_projectId_idx" ON "invoice_line"("projectId");

-- CreateIndex
CREATE INDEX "invoice_line_taskId_idx" ON "invoice_line"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_line_id_organizationId_key" ON "invoice_line"("id", "organizationId");

-- CreateIndex
CREATE INDEX "task_projectId_idx" ON "task"("projectId");

-- CreateIndex
CREATE INDEX "task_organizationId_assigneeId_idx" ON "task"("organizationId", "assigneeId");

-- CreateIndex
CREATE UNIQUE INDEX "task_id_organizationId_key" ON "task"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "task_id_projectId_key" ON "task"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "common_task_organizationId_title_key" ON "common_task"("organizationId", "title");

-- CreateIndex
CREATE UNIQUE INDEX "project_template_organizationId_name_key" ON "project_template"("organizationId", "name");

-- CreateIndex
CREATE INDEX "project_member_organizationId_userId_idx" ON "project_member"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "time_entry_organizationId_userId_date_idx" ON "time_entry"("organizationId", "userId", "date");

-- CreateIndex
CREATE INDEX "time_entry_organizationId_date_idx" ON "time_entry"("organizationId", "date");

-- CreateIndex
CREATE INDEX "time_entry_projectId_date_idx" ON "time_entry"("projectId", "date");

-- CreateIndex
CREATE INDEX "time_entry_invoiceLineId_idx" ON "time_entry"("invoiceLineId");

-- CreateIndex
CREATE UNIQUE INDEX "time_entry_one_running_timer" ON "time_entry"("userId") WHERE ("startedAt" IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "time_entry_userId_calendarEventId_key" ON "time_entry"("userId", "calendarEventId");

-- CreateIndex
CREATE UNIQUE INDEX "time_entry_id_organizationId_key" ON "time_entry"("id", "organizationId");

-- CreateIndex
CREATE INDEX "audit_event_organizationId_createdAt_idx" ON "audit_event"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_event_organizationId_actorId_createdAt_idx" ON "audit_event"("organizationId", "actorId", "createdAt");

-- CreateIndex
CREATE INDEX "timesheet_week_organizationId_status_weekStart_idx" ON "timesheet_week"("organizationId", "status", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "timesheet_week_userId_weekStart_key" ON "timesheet_week"("userId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_expenseId_key" ON "receipt"("expenseId");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_expenseId_organizationId_key" ON "receipt"("expenseId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "sso_settings_organizationId_key" ON "sso_settings"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_settings_organizationId_key" ON "payment_settings"("organizationId");

-- CreateIndex
CREATE INDEX "payment_organizationId_status_idx" ON "payment"("organizationId", "status");

-- CreateIndex
CREATE INDEX "payment_invoiceId_idx" ON "payment"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_provider_providerRef_key" ON "payment"("provider", "providerRef");

-- CreateIndex
CREATE INDEX "time_off_organizationId_date_idx" ON "time_off"("organizationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "time_off_userId_date_key" ON "time_off"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "holiday_organizationId_date_key" ON "holiday"("organizationId", "date");

-- CreateIndex
CREATE INDEX "scheduled_work_organizationId_weekStart_idx" ON "scheduled_work"("organizationId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_work_userId_projectId_weekStart_key" ON "scheduled_work"("userId", "projectId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_schedule_invoiceId_organizationId_key" ON "invoice_schedule"("invoiceId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_schedule_id_organizationId_key" ON "invoice_schedule"("id", "organizationId");

-- CreateIndex
CREATE INDEX "custom_field_organizationId_idx" ON "custom_field"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_id_organizationId_key" ON "custom_field"("id", "organizationId");

-- CreateIndex
CREATE INDEX "custom_field_value_timeEntryId_idx" ON "custom_field_value"("timeEntryId");

-- CreateIndex
CREATE INDEX "custom_field_value_projectId_idx" ON "custom_field_value"("projectId");

-- CreateIndex
CREATE INDEX "custom_field_value_clientId_idx" ON "custom_field_value"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_value_fieldId_timeEntryId_key" ON "custom_field_value"("fieldId", "timeEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_value_fieldId_projectId_key" ON "custom_field_value"("fieldId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_value_fieldId_clientId_key" ON "custom_field_value"("fieldId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "user_group_organizationId_name_key" ON "user_group"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "user_group_id_organizationId_key" ON "user_group"("id", "organizationId");

-- CreateIndex
CREATE INDEX "user_group_member_organizationId_userId_idx" ON "user_group_member"("organizationId", "userId");

-- AddForeignKey
ALTER TABLE "logo" ADD CONSTRAINT "logo_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_settings" ADD CONSTRAINT "calendar_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_settings" ADD CONSTRAINT "calendar_settings_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "user"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite" ADD CONSTRAINT "invite_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite" ADD CONSTRAINT "invite_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "user"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset" ADD CONSTRAINT "password_reset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset" ADD CONSTRAINT "password_reset_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "user"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client" ADD CONSTRAINT "client_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_clientId_organizationId_fkey" FOREIGN KEY ("clientId", "organizationId") REFERENCES "client"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "user"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_invoiceLineId_organizationId_fkey" FOREIGN KEY ("invoiceLineId", "organizationId") REFERENCES "invoice_line"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_clientId_organizationId_fkey" FOREIGN KEY ("clientId", "organizationId") REFERENCES "client"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_invoiceId_organizationId_fkey" FOREIGN KEY ("invoiceId", "organizationId") REFERENCES "invoice"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_taskId_organizationId_fkey" FOREIGN KEY ("taskId", "organizationId") REFERENCES "task"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_assigneeId_organizationId_fkey" FOREIGN KEY ("assigneeId", "organizationId") REFERENCES "user"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "common_task" ADD CONSTRAINT "common_task_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_template" ADD CONSTRAINT "project_template_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "user"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "user"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "task"("id", "projectId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_invoiceLineId_organizationId_fkey" FOREIGN KEY ("invoiceLineId", "organizationId") REFERENCES "invoice_line"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_week" ADD CONSTRAINT "timesheet_week_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_week" ADD CONSTRAINT "timesheet_week_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "user"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_expenseId_organizationId_fkey" FOREIGN KEY ("expenseId", "organizationId") REFERENCES "expense"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sso_settings" ADD CONSTRAINT "sso_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_settings" ADD CONSTRAINT "payment_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_invoiceId_organizationId_fkey" FOREIGN KEY ("invoiceId", "organizationId") REFERENCES "invoice"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "user"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holiday" ADD CONSTRAINT "holiday_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_work" ADD CONSTRAINT "scheduled_work_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_work" ADD CONSTRAINT "scheduled_work_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "user"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_work" ADD CONSTRAINT "scheduled_work_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_schedule" ADD CONSTRAINT "invoice_schedule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_schedule" ADD CONSTRAINT "invoice_schedule_invoiceId_organizationId_fkey" FOREIGN KEY ("invoiceId", "organizationId") REFERENCES "invoice"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field" ADD CONSTRAINT "custom_field_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_fieldId_organizationId_fkey" FOREIGN KEY ("fieldId", "organizationId") REFERENCES "custom_field"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_timeEntryId_organizationId_fkey" FOREIGN KEY ("timeEntryId", "organizationId") REFERENCES "time_entry"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_clientId_organizationId_fkey" FOREIGN KEY ("clientId", "organizationId") REFERENCES "client"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_group" ADD CONSTRAINT "user_group_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_group_member" ADD CONSTRAINT "user_group_member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_group_member" ADD CONSTRAINT "user_group_member_groupId_organizationId_fkey" FOREIGN KEY ("groupId", "organizationId") REFERENCES "user_group"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_group_member" ADD CONSTRAINT "user_group_member_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "user"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

