// Calendar import (WRK-105): fetches a person's private iCal address, only when they ask for
// a week's events. Only https on the standard port, only public addresses (never this server,
// the host's private network or a cloud metadata address), at most 3 redirects, 15 seconds and
// 5 MB. The address is the person's own and is never logged.

import { request } from "node:https";
import { lookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { MAX_CALENDAR_BYTES } from "./calendar.ts";

const PRIVATE = new BlockList();
for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["::", 96], ["2002::", 16]] as const) PRIVATE.addSubnet(net, prefix, "ipv6");

/** Whether an address is somewhere a calendar can't be: loopback, private, link-local and the like. */
export function isPrivateAddress(address: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return PRIVATE.check(mapped[1]!, "ipv4");
  const family = isIP(address);
  if (family === 4) return PRIVATE.check(address, "ipv4");
  if (family === 6) return PRIVATE.check(address, "ipv6");
  return true;
}

const ADDRESS_ERROR = "Paste your calendar's private address in iCal format. It starts with https:// (or webcal://).";

/** The address to store and fetch, from what the person pasted: https only, on the standard port, no IP addresses of this network. */
export function readCalendarUrl(value: unknown): { url: string } | { error: string } {
  if (typeof value !== "string" || value.trim().length > 2000) return { error: ADDRESS_ERROR };
  let url: URL;
  try {
    url = new URL(value.trim().replace(/^webcals?:\/\//i, "https://"));
  } catch {
    return { error: ADDRESS_ERROR };
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return { error: ADDRESS_ERROR };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) ? isPrivateAddress(host) : !host.includes(".") || /\.(local|localhost|internal)$/i.test(host)) {
    return { error: "That address is on a private network. Use your calendar's public iCal address." };
  }
  return { url: url.toString() };
}

/** Resolves a host name, refusing it when any of its addresses is private. */
function publicLookup(hostname: string, options: { all?: boolean }, callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void) {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error, "");
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) return callback(new Error("private address"), "");
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}

const CANT_REACH = "Your calendar couldn't be reached. Check the address, or upload an .ics file instead.";

/** The whole request, from connecting to the last byte, may take this long. */
const DEADLINE_MS = 15_000;

function get(url: string): Promise<{ status: number; location?: string; body?: string } | { error: string }> {
  return new Promise((resolve) => {
    const req = request(url, { method: "GET", headers: { accept: "text/calendar, */*;q=0.5", "user-agent": "calendar-import" }, lookup: publicLookup as never, timeout: 15_000 }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return resolve({ status, location: res.headers.location });
      }
      if (status !== 200) {
        res.resume();
        return resolve({ error: status === 404 || status === 401 || status === 403 ? "Your calendar said that address doesn't work. Copy it again from your calendar's settings." : CANT_REACH });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_CALENDAR_BYTES) {
          req.destroy();
          resolve({ error: "That calendar is over 5 MB. Export a shorter range as an .ics file and upload it." });
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", () => resolve({ error: CANT_REACH }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    const deadline = setTimeout(() => req.destroy(new Error("deadline")), DEADLINE_MS);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", () => resolve({ error: CANT_REACH }));
    req.end();
  });
}

/** The calendar's text, following up to 3 redirects, each checked like the address itself. */
export async function fetchCalendar(address: string): Promise<{ text: string } | { error: string }> {
  let url = address;
  for (let hop = 0; hop <= 3; hop++) {
    const result = await get(url);
    if ("error" in result) return result;
    if (result.body !== undefined) return { text: result.body };
    if (!result.location) return { error: CANT_REACH };
    const next = readCalendarUrl(new URL(result.location, url).toString());
    if ("error" in next) return { error: CANT_REACH };
    url = next.url;
  }
  return { error: CANT_REACH };
}
