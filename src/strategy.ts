// The bot's decisions: how much to bid on a tile, and which words to play.
//
// The idea: a tile is worth what it adds to the rack. The rack's worth is
// the best split of its tiles into words, plus what the tiles kept back are
// still worth (alpha points per face point, falling to 0 as the bag empties,
// because an unplayed tile scores nothing at the end).
//
// Words of 7+ letters already earn the top 3x multiplier, so they're played
// as soon as the rack spells one. Everything else is held for longer words
// and played in one flush just before the match ends.

import { FACE, VOWEL, scan, rackSize, rackToString, type Lexicon, type Rack, type ScanResult } from "./lexicon.js";
import { solve, type Plan } from "./solver.js";

export interface Params {
  alphaMax: number; // leave value per face point, early in a match
  alphaRamp: number; // bag size below which alpha starts falling
  alphaFloor: number; // alpha just before the flush
  balance: number; // vowel/consonant balance penalty
  glue: number; // face points added to every kept tile (see LeaveParams)
  kappa: number; // money per point of value
  paceRef: number; // "normal" money per remaining auction
  paceMin: number;
  paceMax: number;
  flushAt: number; // play everything once the bag holds this many tiles or fewer
  playLen: number; // mid-match, play plan words at least this long
  lowCash: number; // below this balance, cash in 5+ letter words
  endgame: number; // bag size at which leftover money starts going to denial bids
  denial: number; // fraction of balance per remaining auction spent on denial
  firstPriceShade: number; // bid this fraction of value in first-price auctions
  heavy: number; // bid multiplier for tiles with face value 5+ (J K Q X Z)
  floorBid: number; // always bid at least this (x pace) on tiles with face value <= floorFace
  floorFace: number;
  vowel: number; // bid multiplier on vowels
  q1Pace: number; // bid multiplier while the bag holds 50+ tiles (first quarter)
  q2Pace: number; // ...and 33-49 tiles (second quarter)
  playReward: number; // mid-match, also play any plan word worth at least this many points
  timeMs: number; // solver budget per solve
}

export const DEFAULT_PARAMS: Params = {
  alphaMax: 2.2,
  alphaRamp: 30,
  alphaFloor: 0.6,
  balance: 1.5,
  glue: 1,
  kappa: 3,
  paceRef: 1.5,
  paceMin: 0.5,
  paceMax: 3,
  flushAt: 2,
  playLen: 7,
  lowCash: 15,
  endgame: 6,
  denial: 1.0,
  firstPriceShade: 0.8,
  heavy: 1,
  floorBid: 0,
  floorFace: 4,
  vowel: 1,
  q1Pace: 1,
  q2Pace: 1,
  playReward: 999,
  timeMs: 35,
};

export interface View {
  rack: Rack; // my tiles in this match
  balance: number;
  bag: number; // tiles left in the bag, not counting the one on auction
  firstPrice: boolean;
}

export class Brain {
  readonly lex: Lexicon;
  readonly p: Params;
  private scans = new Map<string, ScanResult>();

  constructor(lex: Lexicon, params: Partial<Params> = {}) {
    this.lex = lex;
    this.p = { ...DEFAULT_PARAMS, ...params };
  }

  alpha(bag: number): number {
    const { alphaMax, alphaRamp, alphaFloor, flushAt } = this.p;
    if (bag <= flushAt) return 0;
    if (bag >= alphaRamp) return alphaMax;
    const t = (bag - flushAt) / (alphaRamp - flushAt);
    return alphaFloor + (alphaMax - alphaFloor) * t;
  }

  private scanOf(rack: Rack): ScanResult {
    const key = rackToString(rack);
    let s = this.scans.get(key);
    if (!s) {
      s = scan(this.lex, rack);
      if (this.scans.size > 64) this.scans.clear();
      this.scans.set(key, s);
    }
    return s;
  }

  private plan(rack: Rack, candidates: number[], alpha: number): Plan {
    return solve(this.lex, rack, candidates, {
      leave: { alpha, balance: this.p.balance, glue: this.p.glue },
      timeMs: this.p.timeMs,
    });
  }

  // Points the tile `letter` (0-25) would add to the rack.
  tileValue(rack: Rack, letter: number, bag: number): number {
    const alpha = this.alpha(bag);
    const s = this.scanOf(rack);
    const without = this.plan(rack, s.exact, alpha).value;
    const plus = Int32Array.from(rack);
    plus[letter]!++;
    const withIt = this.plan(plus, s.exact.concat(s.oneAway[letter]!), alpha).value;
    return Math.max(0, withIt - without);
  }

  bid(v: View, letter: number): number {
    const p = this.p;
    // The last tile's auction closes the match: nobody can play it.
    if (v.bag <= 0 || v.balance <= 0) return 0;
    const value = this.tileValue(v.rack, letter, v.bag);
    const pace = Math.min(p.paceMax, Math.max(p.paceMin, v.balance / (v.bag + 1) / p.paceRef));
    let amount = value * p.kappa * pace;
    if (v.bag >= 50) amount *= p.q1Pace;
    else if (v.bag >= 33) amount *= p.q2Pace;
    if (FACE[letter]! >= 5) amount *= p.heavy;
    else if (p.floorBid > 0 && FACE[letter]! <= p.floorFace) amount = Math.max(amount, p.floorBid * pace);
    if (VOWEL[letter]) amount *= p.vowel;
    if (v.firstPrice) amount *= p.firstPriceShade;
    if (v.bag <= p.endgame) {
      // Money left at the end is worth nothing; spend it keeping tiles
      // from the others, and on anything that still helps.
      amount = Math.max(amount, (v.balance * p.denial) / (v.bag + 1));
      if (value > 0 && v.bag <= p.flushAt) amount = v.balance;
    }
    return Math.max(0, Math.min(v.balance, Math.floor(amount)));
  }

  // Words to play now, as uppercase strings, using disjoint tiles.
  wordsToPlay(v: View): string[] {
    const p = this.p;
    if (rackSize(v.rack) < 2) return [];
    const s = this.scanOf(v.rack);
    if (s.exact.length === 0) return [];
    if (v.bag <= p.flushAt) {
      const plan = solve(this.lex, v.rack, s.exact, {
        leave: { alpha: 0, balance: 0 },
        timeMs: Math.max(p.timeMs, 60),
      });
      return plan.words.map((w) => this.lex.words[w]!);
    }
    const plan = this.plan(v.rack, s.exact, this.alpha(v.bag));
    let words = plan.words.filter((w) => this.lex.len[w]! >= p.playLen || this.lex.reward[w]! >= p.playReward);
    if (words.length === 0 && v.balance < p.lowCash) {
      const cash = this.plan(v.rack, s.exact, Math.min(1.6, this.alpha(v.bag)));
      words = cash.words.filter((w) => this.lex.len[w]! >= 5);
    }
    return words.map((w) => this.lex.words[w]!);
  }
}
