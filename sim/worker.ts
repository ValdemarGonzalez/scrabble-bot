import { parentPort, workerData } from "node:worker_threads";
import { loadLexicon } from "../src/lexicon.js";
import { brainBot, fieldBot, playMatch, simBot, starterBot, whaleBot, type Agent } from "./match.js";

export type AgentSpec =
  | { kind: "brain"; name: string; params?: Record<string, number> }
  | { kind: "sim"; strategy: "Cheapskate" | "ValueBidder" | "Aggressive" }
  | { kind: "starter" }
  | { kind: "whale"; share?: number }
  | { kind: "field"; scale?: number };

const { specs, seeds, firstPrice } = workerData as { specs: AgentSpec[]; seeds: number[]; firstPrice: boolean };
const lex = loadLexicon();
const make = (s: AgentSpec): Agent =>
  s.kind === "brain"
    ? brainBot(lex, s.params ?? {}, s.name)
    : s.kind === "sim"
      ? simBot(lex, s.strategy)
      : s.kind === "whale"
        ? whaleBot(lex, s.share)
        : s.kind === "field"
          ? fieldBot(lex, s.scale)
          : starterBot(lex);
const agents = specs.map(make);
for (const seed of seeds) {
  const r = playMatch(lex, agents, seed, { firstPrice });
  parentPort!.postMessage({ seed, names: agents.map((a) => a.name), ...r });
}
