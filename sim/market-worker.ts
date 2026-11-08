import { parentPort, workerData } from "node:worker_threads";
import { loadLexicon } from "../src/lexicon.js";
import { Brain } from "../src/strategy.js";
import { loadMarket, playMarketMatch } from "./market.js";

const { tasks, candidates } = workerData as { tasks: [number, number][]; candidates: Record<string, number>[] };
const lex = loadLexicon();
const mk = loadMarket();
const brains = candidates.map((p) => new Brain(lex, p));
for (const [ci, seed] of tasks) {
  const r = playMarketMatch(lex, brains[ci]!, mk, seed);
  parentPort!.postMessage({ ci, ...r });
}
