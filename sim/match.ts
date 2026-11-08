// Offline copy of the game rules (spacetimedb/src/game.ts in the game repo)
// for testing strategies without the server: 98-tile bag, 5-tile starting
// racks, one sealed-bid auction per tile, Vickrey by default, match ends
// when the bag is empty.

import { BAG, FACE, VOWEL, emptyRack, canSpell, removeWord, rackFromString, type Lexicon, type Rack } from "../src/lexicon.js";
import { Brain, type Params } from "../src/strategy.js";

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Seat {
  rack: Rack;
  balance: number;
  score: number;
}

export interface MatchInfo {
  bag: number; // tiles left in the bag (not counting the one on auction)
  firstPrice: boolean;
  rng: Rng;
}

export interface Agent {
  name: string;
  bid(seat: Seat, letter: number, info: MatchInfo): number;
  // Words to play right now (called when a new auction opens).
  play(seat: Seat, info: MatchInfo): string[];
  // Sims only play right after winning a tile.
  afterWin?(seat: Seat, info: MatchInfo): string[];
}

// ---- Server sim bots ----

export function simBot(lex: Lexicon, kind: "Cheapskate" | "ValueBidder" | "Aggressive"): Agent {
  const byLength = longestFirst(lex);
  return {
    name: kind,
    bid(seat, letter, info) {
      const v = FACE[letter]!;
      const base = kind === "Cheapskate" ? v - 1 : kind === "ValueBidder" ? v : v + (VOWEL[letter] ? 4 : 2);
      const jitter = Math.floor(info.rng() * 5) - 2;
      return Math.max(Math.min(Math.max(base + jitter, 1), seat.balance), 0);
    },
    play: () => [],
    afterWin(seat) {
      const w = firstSpellable(lex, byLength, seat.rack, 3);
      return w === undefined ? [] : [lex.words[w]!];
    },
  };
}

// ---- The starter bot that ships with the game ----

export function starterBot(lex: Lexicon): Agent {
  const byLength = longestFirst(lex);
  return {
    name: "Starter",
    bid(seat, letter) {
      const v = FACE[letter]!;
      const want = seat.rack[letter]! === 0 ? v + 2 : Math.max(1, v);
      return Math.min(want, Math.max(0, seat.balance));
    },
    play(seat) {
      const r = Int32Array.from(seat.rack);
      const out: string[] = [];
      for (;;) {
        const w = firstSpellable(lex, byLength, r, 2);
        if (w === undefined) break;
        out.push(lex.words[w]!);
        removeWord(lex, w, r);
      }
      return out;
    },
  };
}

// ---- A blunt rival: bids big on everything, holds for 6+ letter words,
// then plays whatever it can at the end ----

export function whaleBot(lex: Lexicon, share = 6): Agent {
  const byLength = longestFirst(lex);
  return {
    name: "Whale",
    bid(seat, letter, info) {
      if (info.bag <= 0) return 0;
      return Math.min(seat.balance, Math.max(FACE[letter]! + 3, Math.floor(seat.balance / share)));
    },
    play(seat, info) {
      const r = Int32Array.from(seat.rack);
      const out: string[] = [];
      const minLen = info.bag <= 2 ? 2 : 6;
      for (;;) {
        const w = firstSpellable(lex, byLength, r, minLen);
        if (w === undefined) break;
        out.push(lex.words[w]!);
        removeWord(lex, w, r);
      }
      return out;
    },
  };
}

// ---- A rival modelled on the live field (prices seen on the server:
// ~10 for 1-point tiles, ~20 for 4-pointers, 35-50 for J/Q/X/Z): bids about
// 7 + 4 x face, holds for 7-letter words, flushes greedily at the end ----

export function fieldBot(lex: Lexicon, scale = 1): Agent {
  const byLength = longestFirst(lex);
  return {
    name: "Field",
    bid(seat, letter, info) {
      if (info.bag <= 0) return 0;
      const jitter = 0.75 + info.rng() * 0.5;
      const pace = Math.min(2, Math.max(0.5, seat.balance / (info.bag + 1) / 1.5));
      const want = (7 + 4 * FACE[letter]!) * jitter * scale * Math.sqrt(pace);
      return Math.min(seat.balance, Math.floor(want));
    },
    play(seat, info) {
      const r = Int32Array.from(seat.rack);
      const out: string[] = [];
      const minLen = info.bag <= 2 ? 2 : seat.balance < 10 ? 5 : 7;
      for (;;) {
        const w = firstSpellable(lex, byLength, r, minLen);
        if (w === undefined) break;
        out.push(lex.words[w]!);
        removeWord(lex, w, r);
      }
      return out;
    },
  };
}

// ---- Our bot ----

export function brainBot(lex: Lexicon, params: Partial<Params> = {}, name = "Brain"): Agent {
  const brain = new Brain(lex, params);
  return {
    name,
    bid(seat, letter, info) {
      return brain.bid({ rack: seat.rack, balance: seat.balance, bag: info.bag, firstPrice: info.firstPrice }, letter);
    },
    play(seat, info) {
      return brain.wordsToPlay({ rack: seat.rack, balance: seat.balance, bag: info.bag, firstPrice: info.firstPrice });
    },
  };
}

// ---- Helpers ----

const longestCache = new WeakMap<Lexicon, number[]>();
function longestFirst(lex: Lexicon): number[] {
  let order = longestCache.get(lex);
  if (!order) {
    order = lex.words.map((_, i) => i);
    order.sort((a, b) => lex.len[b]! - lex.len[a]! || (lex.words[a]! < lex.words[b]! ? -1 : 1));
    longestCache.set(lex, order);
  }
  return order;
}

function firstSpellable(lex: Lexicon, order: number[], r: Rack, minLen: number): number | undefined {
  let total = 0;
  for (let c = 0; c < 26; c++) total += r[c]!;
  for (const w of order) {
    const L = lex.len[w]!;
    if (L < minLen) return undefined;
    if (L > total) continue;
    if (canSpell(lex, w, r)) return w;
  }
  return undefined;
}

// ---- One match ----

export interface MatchResult {
  scores: number[];
  places: number[]; // 1 = best; ties share the better place
  wordsPlayed: string[][];
  tilesWon: number[];
  balances: number[]; // money left at the end
  leftover: number[]; // tiles left unplayed at the end
}

export function playMatch(
  lex: Lexicon,
  agents: Agent[],
  seed: number,
  opts: { firstPrice?: boolean; startRack?: number } = {},
): MatchResult {
  const rng = mulberry32(seed);
  const bag: number[] = [];
  for (let c = 0; c < 26; c++) for (let k = 0; k < BAG[c]!; k++) bag.push(c);
  const draw = (): number | undefined => {
    if (bag.length === 0) return undefined;
    const i = Math.floor(rng() * bag.length);
    const c = bag[i]!;
    bag[i] = bag[bag.length - 1]!;
    bag.pop();
    return c;
  };
  const seats: Seat[] = agents.map(() => ({ rack: emptyRack(), balance: 100, score: 0 }));
  const words: string[][] = agents.map(() => []);
  const tilesWon = agents.map(() => 0);
  for (const s of seats) {
    for (let k = 0; k < (opts.startRack ?? 5); k++) {
      const c = draw();
      if (c !== undefined) s.rack[c]!++;
    }
  }
  const firstPrice = !!opts.firstPrice;
  const doPlay = (i: number, list: string[]) => {
    for (const w of list) {
      const r = rackFromString(w);
      const seat = seats[i]!;
      let ok = isWord(lex, w);
      for (let c = 0; c < 26 && ok; c++) if (r[c]! > seat.rack[c]!) ok = false;
      if (!ok) continue; // the server would refuse it
      for (let c = 0; c < 26; c++) seat.rack[c]! -= r[c]!;
      let base = 0;
      for (let c = 0; c < 26; c++) base += r[c]! * FACE[c]!;
      const len = w.length;
      const rew = len <= 3 ? base : len === 4 ? Math.floor((base * 3) / 2) : len === 5 ? base * 2 : len === 6 ? Math.floor((base * 5) / 2) : base * 3;
      seat.balance += rew;
      seat.score += rew;
      words[i]!.push(w);
    }
  };

  let letter = draw();
  while (letter !== undefined) {
    const info: MatchInfo = { bag: bag.length, firstPrice, rng };
    // Bots react to the new auction: play words, then bid.
    agents.forEach((a, i) => doPlay(i, a.play(seats[i]!, info)));
    const bids = agents.map((a, i) => Math.max(0, Math.min(seats[i]!.balance, Math.floor(a.bid(seats[i]!, letter!, info)))));
    // Highest bid wins; ties broken at random.
    const order = bids.map((b, i) => ({ b, i, t: rng() })).filter((x) => x.b > 0);
    order.sort((x, y) => y.b - x.b || x.t - y.t);
    if (order.length > 0) {
      const win = order[0]!;
      const paid = firstPrice ? win.b : order.length > 1 ? order[1]!.b : Math.min(1, win.b);
      const seat = seats[win.i]!;
      if (seat.balance >= paid) {
        seat.balance -= paid;
        seat.rack[letter]!++;
        tilesWon[win.i]!++;
        const after = agents[win.i]!.afterWin;
        if (after) doPlay(win.i, after(seat, info));
      }
    }
    letter = draw();
  }

  const scores = seats.map((s) => s.score);
  const places = scores.map((s) => 1 + scores.filter((o) => o > s).length);
  const leftover = seats.map((s) => s.rack.reduce((a, b) => a + b, 0));
  return { scores, places, wordsPlayed: words, tilesWon, balances: seats.map((s) => s.balance), leftover };
}

const wordSets = new WeakMap<Lexicon, Set<string>>();
function isWord(lex: Lexicon, w: string): boolean {
  let s = wordSets.get(lex);
  if (!s) {
    s = new Set(lex.words);
    wordSets.set(lex, s);
  }
  return s.has(w);
}
