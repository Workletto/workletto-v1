import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { trustProxy } from "./env.ts";

// The visitor's address, for rate limiting and the address kept on sessions.
// Hosts such as Render, or a Caddy in front of Docker, put it in X-Forwarded-For.
// Anyone can send that header too, so only the entries added by the proxies the
// app is told about count (TRUST_PROXY): with one proxy in front, the visitor is
// the last entry, and anything before it was sent by the visitor and is ignored.
// With TRUST_PROXY=0 the header is ignored and the connection's own address is used.
export function clientIp(c: Context): string {
  const hops = trustProxy();
  if (hops > 0) {
    const chain = (c.req.header("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const ip = chain[chain.length - hops];
    if (ip) return ip;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // In tests there is no real connection.
  }
}

/**
 * The key a rate limit counts an address under. An IPv6 visitor usually has a whole /64 network
 * to pick addresses from, so IPv6 addresses count by that network; IPv4 addresses count as they are.
 */
export function limitKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  const [head = "", tail] = ip.toLowerCase().split("%")[0]!.split("::") as [string, string?];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** The visitor's address as the rate limits count it (limitKey). */
export const limitIp = (c: Context) => limitKey(clientIp(c));

/**
 * The request's headers with the visitor's address in the one header Better Auth reads it
 * from (auth.ts). Whatever the visitor sent under that name is replaced.
 */
export function headersWithClientIp(c: Context): Headers {
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-client-ip", clientIp(c));
  return headers;
}
