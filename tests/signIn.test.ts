import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/server/db.ts";
import { createLimiter, SIGN_IN_ATTEMPTS_PER_MINUTE, SIGN_IN_FAILURES_PER_ACCOUNT, signInAttemptsPerIp, TOO_MANY_FOR_ACCOUNT } from "../src/server/rateLimit.ts";
import { limitKey } from "../src/server/clientIp.ts";
import { isExampleSecret, setupCode, trustProxy } from "../src/server/env.ts";
import { request, requestForm, resetDatabase, validSetup } from "./helpers.ts";
import { readFileSync } from "node:fs";

const signIn = (password: string, ip?: string) => request("/api/auth/sign-in/email", { body: { email: validSetup.email, password }, ip });

describe("sign-in throttling", () => {
  beforeEach(async () => {
    await resetDatabase();
    await request("/api/setup", { body: validSetup });
  });

  it("pauses an address after ten attempts in a minute; other addresses carry on", async () => {
    for (let i = 0; i < SIGN_IN_ATTEMPTS_PER_MINUTE; i++) expect((await signIn("wrong-password-1")).status).toBe(401);
    const blocked = await signIn(validSetup.password);
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toMatch(/Wait a minute/);
    expect((await signIn(validSetup.password, "198.51.100.9")).status).toBe(200);
    // Once the minute is over, the address can try again.
    signInAttemptsPerIp.reset();
    expect((await signIn(validSetup.password)).status).toBe(200);
  });

  it("counts only failed tries: a team signing in from one address isn't held up (QA-64)", async () => {
    const office = "198.51.100.40";
    for (let i = 0; i < SIGN_IN_ATTEMPTS_PER_MINUTE * 2; i++) expect((await signIn(validSetup.password, office)).status).toBe(200);
    // Failures still count, and successes in between don't reset them.
    for (let i = 0; i < SIGN_IN_ATTEMPTS_PER_MINUTE; i++) {
      expect((await signIn("wrong-password-1", office)).status).toBe(401);
      if (i === 4) expect((await signIn(validSetup.password, office)).status).toBe(200);
    }
    expect((await signIn(validSetup.password, office)).status).toBe(429);
  });

  it("pauses an account after twenty failed tries, whatever addresses they come from", async () => {
    for (let i = 0; i < SIGN_IN_FAILURES_PER_ACCOUNT; i++) expect((await signIn("wrong-password-1", `203.0.113.${i + 1}`)).status).toBe(401);
    const blocked = await signIn(validSetup.password, "198.51.100.9");
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toBe(TOO_MANY_FOR_ACCOUNT);
  });

  it("counts form posts against the account too, and refuses a sign-in with no email", async () => {
    for (let i = 0; i < SIGN_IN_FAILURES_PER_ACCOUNT; i++) {
      const res = await requestForm("/api/auth/sign-in/email", { email: validSetup.email, password: "wrong-password-1" }, `198.51.100.${i + 1}`);
      expect(res.status).not.toBe(200);
    }
    expect((await signIn(validSetup.password, "192.0.2.50")).status).toBe(429);
    expect((await request("/api/auth/sign-in/email", { body: { password: "x" }, ip: "192.0.2.51" })).status).toBe(400);
  });

  it("counts IPv6 addresses by their /64 network", async () => {
    for (let i = 0; i < SIGN_IN_ATTEMPTS_PER_MINUTE; i++) expect((await signIn("wrong-password-1", `2001:db8:1:2::${i + 1}`)).status).toBe(401);
    expect((await signIn(validSetup.password, "2001:db8:1:2:ffff::9")).status).toBe(429);
    expect((await signIn(validSetup.password, "2001:db8:1:3::1")).status).toBe(200);
    expect(limitKey("2001:0db8:0001:0002:0000:0000:0000:0001")).toBe("2001:db8:1:2::/64");
    expect(limitKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(limitKey("203.0.113.5")).toBe("203.0.113.5");
  });

  it("counts by the address the proxy saw, not one the visitor puts in front of it", async () => {
    // Tests run with one trusted proxy: the last entry is the visitor; anything before it is theirs to make up.
    for (let i = 0; i < SIGN_IN_ATTEMPTS_PER_MINUTE; i++) {
      expect((await signIn("wrong-password-1", `10.${i}.0.1, 203.0.113.77`)).status).toBe(401);
    }
    expect((await signIn(validSetup.password, "10.99.0.1, 203.0.113.77")).status).toBe(429);
  });

  it("keeps the trusted address on the session, not a forged one", async () => {
    expect((await signIn(validSetup.password, "10.0.0.1, 203.0.113.78")).status).toBe(200);
    const session = await prisma.session.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(session.ipAddress).toBe("203.0.113.78");
  });

  it("ignores forwarded headers altogether when no proxy is trusted", async () => {
    process.env.TRUST_PROXY = "0";
    try {
      expect(trustProxy()).toBe(0);
      for (let i = 0; i < SIGN_IN_ATTEMPTS_PER_MINUTE; i++) await signIn("wrong-password-1", `203.0.113.${i + 1}`);
      // Every attempt counted against the same connection, whatever the header said.
      expect((await signIn(validSetup.password, "198.51.100.1")).status).toBe(429);
    } finally {
      process.env.TRUST_PROXY = "1";
    }
  });

  it("reads TRUST_PROXY as a count of proxies, never anything else", () => {
    const original = process.env.TRUST_PROXY;
    try {
      for (const [value, expected] of [["1", 1], ["2", 2], ["0", 0], ["-1", 0], ["yes", 0], ["1.5", 0], ["", 0]] as const) {
        process.env.TRUST_PROXY = value;
        expect(trustProxy(), `TRUST_PROXY=${value}`).toBe(expected);
      }
    } finally {
      process.env.TRUST_PROXY = original;
    }
  });
});

describe("createLimiter", () => {
  const realNow = Date.now;
  afterEach(() => {
    Date.now = realNow;
  });

  it("drops forgotten addresses so the map can't grow forever", () => {
    let now = 1_000_000;
    Date.now = () => now;
    const limiter = createLimiter(1, 1000);
    for (let i = 0; i < 1000; i++) limiter.hit(`ip-${i}`);
    expect(limiter.size).toBe(1000);
    now += 1001;
    limiter.hit("fresh");
    expect(limiter.size).toBe(1);
  });
});

describe("the example values in .env.example", () => {
  const original = { NODE_ENV: process.env.NODE_ENV, SETUP_CODE: process.env.SETUP_CODE };
  afterEach(() => {
    process.env.NODE_ENV = original.NODE_ENV;
    process.env.SETUP_CODE = original.SETUP_CODE;
  });

  it("are the ones the app knows about", () => {
    const example = readFileSync(".env.example", "utf8");
    expect(example).toContain("BETTER_AUTH_SECRET=dev-only-secret-not-for-real-installs-0123456789");
    expect(example).toContain("SETUP_CODE=local-setup-code-1234");
    expect(isExampleSecret("dev-only-secret-not-for-real-installs-0123456789")).toBe(true);
    expect(isExampleSecret(process.env.BETTER_AUTH_SECRET!)).toBe(false);
  });

  it("count as no setup code on a real install", () => {
    process.env.SETUP_CODE = "local-setup-code-1234";
    expect(setupCode()).toBe("local-setup-code-1234");
    process.env.NODE_ENV = "production";
    expect(setupCode()).toBeUndefined();
    process.env.SETUP_CODE = "a-real-code-of-some-length";
    expect(setupCode()).toBe("a-real-code-of-some-length");
  });
});
