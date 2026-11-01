import { Hono } from "hono";
import type { OrgDb } from "./db.ts";
import type { SignedIn } from "./http.ts";
import { inspectImage } from "./logo.ts";
import { isDemoMode } from "./env.ts";
import { recordAudit, projectLabel } from "./audit.ts";
import { canManageWork } from "../shared/roles.ts";

// Receipts: one image or PDF per expense. Like the logo, the file is stored
// exactly as uploaded and never decoded on the server; its type comes from its
// own first bytes, never its name or the type the browser claims. People attach
// and remove receipts on their own expenses; admins and managers can open
// anyone's, for billing and reimbursement.

export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const DEMO_MAX_RECEIPT_BYTES = 1024 * 1024;
export const maxReceiptBytes = () => (isDemoMode() ? DEMO_MAX_RECEIPT_BYTES : MAX_RECEIPT_BYTES);
export const RECEIPT_PATH = /^\/api\/expenses\/[^/]+\/receipt$/;
export const receiptTooLarge = () => `That file is over ${maxReceiptBytes() / (1024 * 1024)} MB. Try a smaller photo or a compressed PDF.`;

const isPdf = (b: Uint8Array) => b.length > 5 && String.fromCharCode(...b.subarray(0, 5)) === "%PDF-";

/** The receipt's type, or a message for the person uploading. */
export function checkReceipt(bytes: Uint8Array): { contentType: string } | { status: 400 | 413; error: string } {
  if (!bytes.length) return { status: 400, error: "Choose a photo or PDF of the receipt." };
  if (bytes.length > maxReceiptBytes()) return { status: 413, error: receiptTooLarge() };
  if (isPdf(bytes)) return { contentType: "application/pdf" };
  const image = inspectImage(bytes);
  if (image) return { contentType: image.contentType };
  return { status: 400, error: "Upload a JPEG, PNG or WebP photo, or a PDF." };
}

/** A safe file name to show and download under: no paths, no control characters, 120 characters at most. */
function cleanName(raw: string | undefined, contentType: string) {
  let name = "";
  try {
    name = decodeURIComponent(raw ?? "");
  } catch {
    name = "";
  }
  name = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f"]/g, "").trim().slice(0, 120);
  const extension = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[contentType] ?? "bin";
  return name || `receipt.${extension}`;
}

const EXPENSE = { id: true, userId: true, category: true, date: true, project: { select: { name: true, client: { select: { name: true } } } } } as const;
type Expense = { id: string; category: string; date: Date; project: { name: string; client: { name: string } | null } };
const auditEvent = (e: Expense) => ({ kind: "expense" as const, subjectId: e.id, label: `${e.category} · ${projectLabel(e.project)}`, entryDate: e.date });

/** Your own expense, for attaching or removing. */
const ownExpense = (db: OrgDb, id: string, userId: string) => db.expense.findFirst({ where: { id, userId }, select: EXPENSE });

export const receiptRoutes = new Hono<SignedIn>()
  // The request body is the file itself; its name comes in X-File-Name (URI-encoded).
  .put("/:id/receipt", async (c) => {
    const db = c.get("db");
    const user = c.get("user");
    const expense = await ownExpense(db, c.req.param("id"), user.id);
    if (!expense) return c.json({ error: "Expense not found." }, 404);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const checked = checkReceipt(bytes);
    if ("error" in checked) return c.json({ error: checked.error }, checked.status);
    const fileName = cleanName(c.req.header("x-file-name"), checked.contentType);
    const data = { contentType: checked.contentType, fileName, size: bytes.length, data: bytes };

    const receipt = await db.$transaction(async (tx) => {
      const before = await tx.receipt.findFirst({ where: { expenseId: expense.id }, select: { fileName: true } });
      const saved = await tx.receipt.upsert({
        where: { expenseId: expense.id },
        create: { ...data, expenseId: expense.id } as typeof data & { expenseId: string; organizationId: string }, // orgDb fills in organizationId
        update: data,
        select: { fileName: true, contentType: true, size: true },
      });
      await recordAudit(tx as OrgDb, user, { ...auditEvent(expense), action: "changed", changes: [{ field: "receipt", from: before?.fileName ?? null, to: fileName }] });
      return saved;
    });
    return c.json({ receipt });
  })
  .get("/:id/receipt", async (c) => {
    const db = c.get("db");
    const user = c.get("user");
    // Your own, or anyone's for admins and managers.
    const where = canManageWork(user.role) ? { expenseId: c.req.param("id") } : { expenseId: c.req.param("id"), expense: { userId: user.id } };
    const receipt = await db.receipt.findFirst({ where, select: { contentType: true, fileName: true, data: true } });
    if (!receipt) return c.json({ error: "No receipt." }, 404);
    c.header("Content-Type", receipt.contentType);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "private, no-store");
    // Photos open in the browser. PDFs download: a PDF shown in the app's own address
    // could carry scripts, and a download keeps it out of the app's pages.
    const disposition = receipt.contentType === "application/pdf" ? "attachment" : "inline";
    c.header("Content-Disposition", `${disposition}; filename="${receipt.fileName.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(receipt.fileName)}`);
    return c.body(new Uint8Array(receipt.data));
  })
  .delete("/:id/receipt", async (c) => {
    const db = c.get("db");
    const user = c.get("user");
    const expense = await ownExpense(db, c.req.param("id"), user.id);
    if (!expense) return c.json({ error: "Expense not found." }, 404);
    const removed = await db.$transaction(async (tx) => {
      const before = await tx.receipt.findFirst({ where: { expenseId: expense.id }, select: { fileName: true } });
      if (!before) return false;
      await tx.receipt.deleteMany({ where: { expenseId: expense.id } });
      await recordAudit(tx as OrgDb, user, { ...auditEvent(expense), action: "changed", changes: [{ field: "receipt", from: before.fileName, to: null }] });
      return true;
    });
    if (!removed) return c.json({ error: "No receipt." }, 404);
    return c.json({ ok: true });
  });
