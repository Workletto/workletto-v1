// What the server log says about an error (WRK-81): enough to find the problem, never the
// personal data a message can carry. A database error's message can quote the values that were
// sent (a name, an email address), so it's logged by its type and code only; any email address
// left in a message, such as a mail server's "recipient rejected", is replaced, and so is
// anything shaped like a Stripe key or webhook secret (WRK-80).

const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi;
const STRIPE_SECRET = /\b(?:sk|rk|whsec)_[A-Za-z0-9_*]+/g;
const clean = (text: string) => text.replace(EMAIL, "[email]").replace(STRIPE_SECRET, "[secret]");

/** One log entry for an error: its type and message (cleaned), then where it happened. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return clean(String(error));
  const frames = (error.stack ?? "").split("\n").filter((line) => line.trimStart().startsWith("at "));
  let summary: string;
  if (error.name.startsWith("PrismaClient")) {
    const { code, meta } = error as Error & { code?: string; meta?: { modelName?: unknown; target?: unknown } };
    const model = typeof meta?.modelName === "string" ? ` on ${meta.modelName}` : "";
    const target = Array.isArray(meta?.target) ? ` (${meta.target.join(", ")})` : "";
    summary = `${error.name}${code ? ` ${code}` : ""}${model}${target}`;
  } else {
    summary = clean(`${error.name}: ${error.message}`);
  }
  return [summary, ...frames].join("\n");
}
