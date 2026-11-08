// Replays our bot against the real market: for each tile, the highest
// opponent bid is drawn from live auctions of the same letter at about the
// same point in a match (data/live/market.json, pulled from the server).
// Our score is then ranked against the real scores of 5 bots from a random
// live match.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BAG, FACE, emptyRack, rackFromString, type Lexicon } from "../src/lexicon.js";
import { Brain } from "../src/strategy.js";
import { mulberry32 } from "./match.js";

export interface LiveMatch {
  id: number;
  auctions: [string, number, number, number][]; // letter, top bid, paid, had a winner
  scores: number[];
}

export interface Market {
  // [letter][k] -> top bids seen for that letter at auction k (0-67)
  tops: number[][][];
  scores: number[][];
}

export function loadMarket(file?: string): Market {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const f = file ?? path.join(here, "..", "data", "live", "market.json");
  const matches: LiveMatch[] = JSON.parse(fs.readFileSync(f, "utf8"));
  const tops: number[][][] = Array.from({ length: 26 }, () => Array.from({ length: 68 }, () => []));
  for (const m of matches) {
    m.auctions.forEach(([l, top], k) => {
      if (k < 68) tops[l.charCodeAt(0) - 65]![k]!.push(top);
    });
  }
  return { tops, scores: matches.map((m) => m.scores) };
}

function sampleTop(mk: Market, letter: number, k: number, rng: () => number): number {
  const byK = mk.tops[letter]!;
  for (let w = 3; w <= 128; w *= 2) {
    let n = 0;
    const lo = Math.max(0, k - w);
    const hi = Math.min(67, k + w);
    for (let j = lo; j <= hi; j++) n += byK[j]!.length;
    if (n >= 12 || w >= 64) {
      if (n === 0) return 0;
      let pick = Math.floor(rng() * n);
      for (let j = lo; j <= hi; j++) {
        const arr = byK[j]!;
        if (pick < arr.length) return arr[pick]!;
        pick -= arr.length;
      }
    }
  }
  return 0;
}

export interface MarketResult {
  score: number;
  place: number;
  win: number;
  tiles: number;
  endMoney: number;
  leftover: number;
}

const wordSets = new WeakMap<Lexicon, Set<string>>();

export function playMarketMatch(lex: Lexicon, brain: Brain, mk: Market, seed: number): MarketResult {
  const rng = mulberry32(seed);
  const mrng = mulberry32(seed ^ 0x9e3779b9); // market draws
  let words = wordSets.get(lex);
  if (!words) {
    words = new Set(lex.words);
    wordSets.set(lex, words);
  }
  const bag: number[] = [];
  for (let c = 0; c < 26; c++) for (let k = 0; k < BAG[c]!; k++) bag.push(c);
  const draw = () => {
    const i = Math.floor(rng() * bag.length);
    const c = bag[i]!;
    bag[i] = bag[bag.length - 1]!;
    bag.pop();
    return c;
  };
  const rack = emptyRack();
  for (let i = 0; i < 5; i++) rack[draw()]!++;
  for (let i = 0; i < 25; i++) draw(); // the other five racks
  let balance = 100;
  let score = 0;
  let tiles = 0;
  const play = (list: string[]) => {
    for (const w of list) {
      if (!words!.has(w)) continue;
      const r = rackFromString(w);
      let ok = true;
      for (let c = 0; c < 26; c++) if (r[c]! > rack[c]!) ok = false;
      if (!ok) continue;
      let base = 0;
      for (let c = 0; c < 26; c++) {
        rack[c]! -= r[c]!;
        base += r[c]! * FACE[c]!;
      }
      const L = w.length;
      const rew =
        L <= 3 ? base : L === 4 ? Math.floor((base * 3) / 2) : L === 5 ? base * 2 : L === 6 ? Math.floor((base * 5) / 2) : base * 3;
      score += rew;
      balance += rew;
    }
  };
  for (let k = 0; k < 68; k++) {
    const letter = draw();
    play(brain.wordsToPlay({ rack, balance, bag: bag.length, firstPrice: false }));
    const x = Math.max(0, Math.min(balance, brain.bid({ rack, balance, bag: bag.length, firstPrice: false }, letter)));
    const top = sampleTop(mk, letter, k, mrng);
    const tieWin = mrng() < 0.5;
    if (x > 0 && (x > top || (x === top && tieWin))) {
      const paid = top > 0 ? top : 1;
      if (balance >= paid) {
        balance -= paid;
        rack[letter]!++;
        tiles++;
      }
    }
  }
  const real = mk.scores[Math.floor(mrng() * mk.scores.length)]!.slice();
  real.splice(Math.floor(mrng() * real.length), 1);
  const place = 1 + real.filter((s) => s > score).length;
  let leftover = 0;
  for (let c = 0; c < 26; c++) leftover += rack[c]!;
  return { score, place, win: place === 1 ? 1 : 0, tiles, endMoney: balance, leftover };
}
