// Evaluates parameter sets against the replayed live market.
//   npm run market -- [matches]               defaults (+ SIM_CANDIDATES)
//   npm run market -- [matches] search [N]    + N random sets around the defaults
// SIM_CANDIDATES (a JSON array of param overrides) adds specific sets.
// Every candidate plays the same seeds, so differences aren't luck of the draw.

import { Worker } from "node:worker_threads";
import * as os from "node:os";
import { DEFAULT_PARAMS } from "../src/strategy.js";

const matches = Number(process.argv[2] ?? 400);
const searchN = process.argv[3] === "search" ? Number(process.argv[4] ?? 30) : 0;
const extra: Record<string, number>[] = JSON.parse(process.env.SIM_CANDIDATES ?? "[]");
const seedBase = Number(process.env.SIM_SEED ?? 7000);
let rngState = Number(process.env.SEARCH_SEED ?? 12345);
const rand = () => (rngState = (rngState * 1103515245 + 12345) % 2147483648) / 2147483648;
const ranges: Record<string, [number, number]> = {
  kappa: [1.5, 6],
  glue: [0, 3],
  alphaMax: [1.4, 3],
  alphaRamp: [15, 50],
  alphaFloor: [0.2, 1.4],
  balance: [0, 3],
  paceRef: [0.8, 2.5],
  paceMax: [2, 6],
  lowCash: [5, 30],
  endgame: [2, 14],
  denial: [0, 2],
  floorBid: [0, 14],
  vowel: [0.8, 1.3],
  q1Pace: [0.6, 1.2],
  q2Pace: [0.7, 1.2],
  playReward: [20, 80],
};
const base: Record<string, number> = JSON.parse(process.env.SEARCH_BASE ?? "{}");
const candidates: Record<string, number>[] = [{}, ...extra];
if (Object.keys(base).length) candidates.push(base);
for (let i = 0; i < searchN; i++) {
  const c: Record<string, number> = { ...base };
  for (const [k, [lo, hi]] of Object.entries(ranges)) {
    if (rand() < 0.6) continue; // keep the base value for most parameters
    c[k] = Math.round((lo + (hi - lo) * rand()) * 100) / 100;
  }
  candidates.push(c);
}
const tasks: [number, number][] = [];
for (let s = 0; s < matches; s++) for (let ci = 0; ci < candidates.length; ci++) tasks.push([ci, seedBase + s]);
const threads = Math.min(Number(process.env.SIM_THREADS ?? os.cpus().length), tasks.length);
type Acc = { n: number; score: number; win: number; place: number; tiles: number; money: number; left: number; cls: number[] };
const acc: Acc[] = candidates.map(() => ({ n: 0, score: 0, win: 0, place: 0, tiles: 0, money: 0, left: 0, cls: [0, 0, 0, 0, 0, 0, 0, 0] }));
const t0 = Date.now();
await Promise.all(
  Array.from(
    { length: threads },
    (_, k) =>
      new Promise<void>((resolve, reject) => {
        const w = new Worker(new URL("./market-worker.ts", import.meta.url), {
          workerData: { tasks: tasks.filter((_, i) => i % threads === k), candidates },
          execArgv: ["--import", "tsx"],
        });
        w.on("message", (m: { ci: number; score: number; win: number; place: number; tiles: number; endMoney: number; leftover: number; byClass: [number, number][] }) => {
          const a = acc[m.ci]!;
          a.n++;
          a.score += m.score;
          a.win += m.win;
          a.place += m.place;
          a.tiles += m.tiles;
          a.money += m.endMoney;
          a.left += m.leftover;
          m.byClass.forEach(([n, paid], i) => {
            a.cls[2 * i]! += n;
            a.cls[2 * i + 1]! += paid;
          });
        });
        w.on("error", reject);
        w.on("exit", () => resolve());
      }),
  ),
);
const rows = candidates.map((c, i) => ({ c, a: acc[i]! }));
rows.sort((x, y) => y.a.win / y.a.n - x.a.win / x.a.n || x.a.place / x.a.n - y.a.place / y.a.n);
console.log(`${tasks.length} matches, ${candidates.length} candidates, ${threads} threads, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(" win%  place   score  tiles  endMoney  left  params");
for (const { c, a } of rows.slice(0, Number(process.env.SHOW ?? 12))) {
  console.log(
    `${((100 * a.win) / a.n).toFixed(1).padStart(5)}  ${(a.place / a.n).toFixed(2)}  ${(a.score / a.n).toFixed(1).padStart(6)}  ${(a.tiles / a.n).toFixed(1).padStart(5)}  ${(a.money / a.n).toFixed(0).padStart(8)}  ${(a.left / a.n).toFixed(1).padStart(4)}  ${Object.keys(c).length ? JSON.stringify(c) : "(defaults)"}`,
  );
  if (process.env.PROFILE)
    console.log(`        bought: ${["vowel", "cons1", "cons2-4", "heavy"].map((k, i) => `${k} ${(a.cls[2 * i]! / a.n).toFixed(1)}@${(a.cls[2 * i + 1]! / Math.max(1, a.cls[2 * i]!)).toFixed(1)}`).join("  ")}`);
}
const d = rows.find((r) => Object.keys(r.c).length === 0)!;
console.log(`defaults: win ${((100 * d.a.win) / d.a.n).toFixed(1)}%, place ${(d.a.place / d.a.n).toFixed(2)}, score ${(d.a.score / d.a.n).toFixed(1)}`);
console.log(`(defaults = ${JSON.stringify(DEFAULT_PARAMS)})`);
