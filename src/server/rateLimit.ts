// Every rate limiter in the app lives here. They are small in-memory counters, per
// process: enough for one app instance (which is how this is deployed), because they
// only slow guessing down, while the length of the secret being guessed is the real
// protection. They start empty again whenever the app restarts.
export function createLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  // Once this many addresses are being counted, the forgotten ones are dropped, so the map can't grow forever.
  const PRUNE_AT = 1000;
  return {
    hit(key: string): boolean {
      const now = Date.now();
      if (hits.size >= PRUNE_AT) for (const [k, e] of hits) if (e.resetAt <= now) hits.delete(k);
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      entry.count += 1;
      return entry.count <= max;
    },
    /** Takes back one counted try, for an attempt that turned out fine. */
    refund(key: string) {
      const entry = hits.get(key);
      if (entry && entry.resetAt > Date.now() && entry.count > 0) entry.count -= 1;
    },
    /** Whether the key has used up its tries, without counting one more. */
    over(key: string): boolean {
      const entry = hits.get(key);
      return Boolean(entry && entry.resetAt > Date.now() && entry.count > max);
    },
    reset() {
      hits.clear();
    },
    /** How many keys are being counted right now. */
    get size() {
      return hits.size;
    },
  };
}

// Guessing passwords is slowed down per address: this many failed tries a minute, then a minute's
// wait. Successful sign-ins don't count, so a team signing in from one office isn't held up.
export const SIGN_IN_ATTEMPTS_PER_MINUTE = 10;
export const signInAttemptsPerIp = createLimiter(SIGN_IN_ATTEMPTS_PER_MINUTE, 60 * 1000);
// Changing a password asks for the current one, so guessing is slowed down the same way.
export const changePasswordAttemptsPerIp = createLimiter(SIGN_IN_ATTEMPTS_PER_MINUTE, 60 * 1000);

// The answers, so every route says the same thing.
export const TOO_MANY_SIGN_INS = "Too many sign-in attempts from your network. Wait a minute and try again.";
export const TOO_MANY_ATTEMPTS_1_MIN = "Too many attempts. Wait a minute and try again.";
export const TOO_MANY_ATTEMPTS_15_MIN = "Too many attempts. Wait 15 minutes and try again.";
export const TOO_MANY_REQUESTS_15_MIN = "Too many requests. Wait 15 minutes and try again.";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// Password guesses are also counted per account, whatever addresses they come from: this many
// failed tries in 15 minutes, then a 15-minute wait for that account.
export const SIGN_IN_FAILURES_PER_ACCOUNT = 20;
export const signInFailuresPerEmail = createLimiter(SIGN_IN_FAILURES_PER_ACCOUNT, 15 * MINUTE);
export const TOO_MANY_FOR_ACCOUNT = "Too many sign-in attempts for this account. Wait 15 minutes and try again.";
// First-run setup: per address, and in total across all addresses.
export const setupAttemptsPerIp = createLimiter(10, 15 * MINUTE);
export const setupAttemptsTotal = createLimiter(50, 15 * MINUTE);
// Invite links being opened and accepted.
export const acceptAttemptsPerIp = createLimiter(20, 15 * MINUTE);
// Password resets.
export const resetAttemptsPerIp = createLimiter(10, 15 * MINUTE);
export const resetRequestsPerIp = createLimiter(3, 15 * MINUTE);
export const resetRequestsPerEmail = createLimiter(3, 15 * MINUTE);
// Demo workspaces started.
export const demoStartsPerIp = createLimiter(5, HOUR);
// Pay now links.
export const payLinksPerIp = createLimiter(30, 10 * MINUTE);
/** New checkouts per invoice, so a leaked link can't make endless ones. */
export const checkoutsPerInvoice = createLimiter(20, HOUR);
/** Webhooks turned away, per address. Stripe's own signed ones are never counted. */
export const badWebhooksPerIp = createLimiter(30, 10 * MINUTE);
