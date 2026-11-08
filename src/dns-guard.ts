// The router on tonight's network sometimes answers a public hostname with
// 10.0.0.1 (a filter placeholder or a bug), and flips back minutes later.
// A bot that can't resolve the game server can't reconnect, so any such
// answer is re-resolved through public DNS instead. Import this before
// anything that opens a connection.

import dns from "node:dns";
import { Resolver } from "node:dns/promises";

const BOGUS = /^(10\.|0\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const fallback = new Resolver();
fallback.setServers(["1.1.1.1", "8.8.8.8"]);

type LookupCallback = (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void;
type LookupOptions = { all?: boolean; family?: number } & Record<string, unknown>;

export let onFallback: (message: string) => void = (m) => console.log(m);
export function setFallbackLogger(fn: (message: string) => void) {
  onFallback = fn;
}

const originalLookup = dns.lookup;

function patchedLookup(hostname: string, options: unknown, callback?: unknown): void {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  const cb = callback as LookupCallback;
  const opts: LookupOptions = typeof options === "number" ? { family: options } : ((options as LookupOptions) ?? {});
  const isPublicName = !BOGUS.test(hostname) && !/^(localhost|[^.]+|.*\.(local|localhost|test))$/.test(hostname) && !/^[\d.]+$/.test(hostname) && !hostname.includes(":");

  (originalLookup as unknown as (h: string, o: LookupOptions, c: LookupCallback) => void).call(
    dns,
    hostname,
    opts,
    (err, address, family) => {
      const first = Array.isArray(address)
        ? (address[0] as { address?: string } | undefined)?.address
        : (address as string | undefined);
      const bogus = typeof first === "string" && BOGUS.test(first) && isPublicName;
      if (!err && !bogus) return cb(err, address, family);
      if (!isPublicName || opts.family === 6) return cb(err, address, family);
      fallback
        .resolve4(hostname)
        .then((addrs) => {
          if (!addrs.length) return cb(err ?? new Error(`no address for ${hostname}`), address, family);
          onFallback(`DNS: system resolver gave ${first ?? err?.code ?? "an error"} for ${hostname}; using ${addrs[0]} from public DNS`);
          if (opts.all) return cb(null, addrs.map((a) => ({ address: a, family: 4 })), undefined);
          cb(null, addrs[0], 4);
        })
        .catch(() => cb(err, address, family));
    },
  );
}

(dns as unknown as { lookup: unknown }).lookup = patchedLookup;
