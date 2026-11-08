// Manual check of the DNS guard from the Windows resolver: `npx tsx test/dns-guard.manual.ts`
import "../src/dns-guard.js";
import dns from "node:dns";
for (const h of ["maincloud.spacetimedb.com", "api.github.com", "scrabblebot.spacetimedb.com"]) {
  dns.lookup(h, (err, address, family) => console.log(h, "->", err ? err.code : `${String(address)} (v${family})`));
}
