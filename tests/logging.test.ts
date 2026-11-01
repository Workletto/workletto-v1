import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeError } from "../src/server/logging.ts";

// The server log never gets personal data from an error message (WRK-81).

function prismaError(name: string, message: string, extra: Record<string, unknown> = {}) {
  const error = Object.assign(new Error(message), extra);
  error.name = name;
  return error;
}

describe("describeError", () => {
  it("logs a database validation error by its type only, since its message quotes the data sent", () => {
    const error = prismaError(
      "PrismaClientValidationError",
      'Invalid `prisma.user.create()` invocation:\n{ data: { email: "ada@studio.test", name: "Ada Lovelace" } }',
    );
    const line = describeError(error);
    expect(line).toMatch(/^PrismaClientValidationError/);
    for (const leak of ["ada@studio.test", "Ada Lovelace", "invocation"]) expect(line, leak).not.toContain(leak);
    expect(line).toContain("at "); // where it happened is kept
  });

  it("keeps a known database error's code, table and field names, without values", () => {
    const error = prismaError("PrismaClientKnownRequestError", "Unique constraint failed on the fields: (`email`) ada@studio.test", {
      code: "P2002",
      meta: { modelName: "User", target: ["email"] },
    });
    const line = describeError(error).split("\n")[0];
    expect(line).toBe("PrismaClientKnownRequestError P2002 on User (email)");
  });

  it("replaces email addresses in any other message", () => {
    const line = describeError(new Error("550 5.1.1 <ada@studio.test>: Recipient address rejected"));
    expect(line).toContain("Error: 550 5.1.1 <[email]>: Recipient address rejected");
    expect(line).not.toContain("ada@studio.test");
    expect(describeError("failed for bob@example.com")).toBe("failed for [email]");
  });

  it("replaces anything shaped like a Stripe key or webhook secret", () => {
    const line = describeError(new Error("Invalid API Key provided: rk_test_abc123DEF456; webhook whsec_s3cret and sk_live_****ghij"));
    expect(line).toContain("Error: Invalid API Key provided: [secret]; webhook [secret] and [secret]");
    expect(line).not.toMatch(/rk_test|whsec_|sk_live/);
  });

  it("is what every error log line on the server goes through", () => {
    for (const file of readdirSync("src/server").filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(`src/server/${file}`, "utf8");
      for (const call of source.match(/console\.error\([^\n]*/g) ?? []) expect(call, `${file}: ${call}`).toContain("describeError(");
    }
  });
});
