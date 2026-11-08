// Runs many offline matches in parallel and prints each bot's average score,
// win rate and average place.
//
//   npm run sim -- <scenario> [matches]
//   scenarios: sims | starters | mixed | self | ab | firstprice
//   ab: SIM_A / SIM_B env vars hold JSON param overrides; 3 copies of each.

import { Worker } from "node:worker_threads";
import * as os from "node:os";
import type { AgentSpec } from "./worker.js";

const scenario = process.argv[2] ?? "mixed";
const matches = Number(process.argv[3] ?? 60);
const A = JSON.parse(process.env.SIM_A ?? "{}");
const B = JSON.parse(process.env.SIM_B ?? "{}");
const brain = (name: string, params: Record<string, number> = {}): AgentSpec => ({ kind: "brain", name, params });
const sim = (strategy: "Cheapskate" | "ValueBidder" | "Aggressive"): AgentSpec => ({ kind: "sim", strategy });
const starter: AgentSpec = { kind: "starter" };

const scenarios: Record<string, AgentSpec[]> = {
  sims: [brain("Brain", A), sim("Cheapskate"), sim("ValueBidder"), sim("Aggressive"), sim("Aggressive"), sim("ValueBidder")],
  starters: [brain("Brain", A), starter, starter, starter, starter, starter],
  mixed: [brain("Brain", A), starter, starter, sim("Aggressive"), sim("ValueBidder"), sim("Cheapskate")],
  firstprice: [brain("Brain", A), starter, starter, sim("Aggressive"), sim("ValueBidder"), sim("Cheapskate")],
  self: [brain("Brain", A), brain("Brain", A), starter, starter, sim("Aggressive"), sim("ValueBidder")],
  ab: [brain("A", A), brain("A", A), brain("A", A), brain("B", B), brain("B", B), brain("B", B)],
  whales: [brain("Brain", A), { kind: "whale", share: 4 }, { kind: "whale", share: 8 }, starter, sim("Aggressive"), sim("ValueBidder")],
  field: [brain("Brain", A), { kind: "field" }, { kind: "field" }, { kind: "field", scale: 1.2 }, { kind: "field", scale: 0.85 }, { kind: "field" }],
  abfield: [brain("A", A), brain("B", B), { kind: "field" }, { kind: "field" }, { kind: "field", scale: 1.2 }, { kind: "field", scale: 0.85 }],
  abfp: [brain("A", A), brain("A", A), brain("A", A), brain("B", B), brain("B", B), brain("B", B)],
  ab2: [brain("A", A), brain("B", B), starter, starter, sim("Aggressive"), sim("ValueBidder")],
};
const specs = scenarios[scenario];
if (!specs) throw new Error(`unknown scenario ${scenario}`);

const threads = Math.max(1, Math.min(Number(process.env.SIM_THREADS ?? os.cpus().length - 1), matches));
const seeds = Array.from({ length: matches }, (_, i) => 1000 + i);
const t0 = Date.now();
type Stat = { n: number; score: number; wins: number; place: number; tiles: number; words: number; bal: number; left: number };
const stats = new Map<string, Stat>();
let done = 0;
const examples: string[] = [];

await Promise.all(
  Array.from({ length: threads }, (_, k) => {
    const mine = seeds.filter((_, i) => i % threads === k);
    return new Promise<void>((resolve, reject) => {
      const w = new Worker(new URL("./worker.ts", import.meta.url), {
        workerData: { specs, seeds: mine, firstPrice: scenario === "firstprice" || scenario === "abfp" },
        execArgv: ["--import", "tsx"],
      });
      w.on("message", (m: { names: string[]; scores: number[]; places: number[]; tilesWon: number[]; wordsPlayed: string[][]; balances: number[]; leftover: number[] }) => {
        done++;
        m.names.forEach((name, i) => {
          const s = stats.get(name) ?? { n: 0, score: 0, wins: 0, place: 0, tiles: 0, words: 0, bal: 0, left: 0 };
          s.n++;
          s.score += m.scores[i]!;
          s.wins += m.places[i] === 1 ? 1 : 0;
          s.place += m.places[i]!;
          s.tiles += m.tilesWon[i]!;
          s.words += m.wordsPlayed[i]!.length;
          s.bal += m.balances[i]!;
          s.left += m.leftover[i]!;
          stats.set(name, s);
        });
        if (examples.length < 2) {
          examples.push(m.names.map((n, i) => `${n}=${m.scores[i]} [${m.wordsPlayed[i]!.join(" ")}]`).join("\n  "));
        }
      });
      w.on("error", reject);
      w.on("exit", () => resolve());
    });
  }),
);

console.log(`scenario=${scenario} matches=${done} threads=${threads} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`A=${JSON.stringify(A)} B=${JSON.stringify(B)}`);
console.log("bot          avgScore  winRate  avgPlace  tilesWon  words  endMoney  endTiles");
for (const [name, s] of [...stats].sort((a, b) => b[1].score / b[1].n - a[1].score / a[1].n)) {
  console.log(
    `${name.padEnd(12)} ${(s.score / s.n).toFixed(1).padStart(8)}  ${((100 * s.wins) / s.n).toFixed(0).padStart(6)}%  ${(s.place / s.n).toFixed(2).padStart(8)}  ${(s.tiles / s.n).toFixed(1).padStart(8)}  ${(s.words / s.n).toFixed(1).padStart(5)}  ${(s.bal / s.n).toFixed(0).padStart(8)}  ${(s.left / s.n).toFixed(1).padStart(8)}`,
  );
}
if (process.env.SIM_EXAMPLES) for (const e of examples) console.log("example:\n  " + e);
