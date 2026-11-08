// Splits a rack into the set of words worth the most, counting what the
// unplayed tiles are still worth (the "leave").

import { FACE, VOWEL, canSpell, removeWord, addWord, type Lexicon, type Rack } from "./lexicon.js";

export interface LeaveParams {
  // Points per face point for a tile kept for later. 0 at the end of a
  // match (an unplayed tile scores nothing); near 3 early on, when kept
  // tiles will probably end up in 7-letter words.
  alpha: number;
  // Penalty per tile of vowel/consonant imbalance in the leave, scaled by alpha.
  balance: number;
  // Face points added to every kept tile: in a 7-letter word even a 1-point
  // tile carries a share of the bonus, so common tiles are worth more than
  // their face value.
  glue?: number;
}

// How likely a tile is to make it into a long word. Hard letters are worth
// less than their face value suggests.
const USABILITY = new Float64Array(26).fill(1);
const setU = (c: string, u: number) => (USABILITY[c.charCodeAt(0) - 65] = u);
setU("Q", 0.35);
setU("J", 0.55);
setU("Z", 0.65);
setU("X", 0.75);
setU("K", 0.7);
setU("V", 0.65);
setU("W", 0.75);
setU("F", 0.85);
setU("H", 0.85);
setU("Y", 0.85);
setU("B", 0.85);
setU("C", 0.9);
setU("M", 0.9);
setU("P", 0.9);
setU("G", 0.9);

// More copies of a letter than this get discounted hard.
const COMFORTABLE = new Int32Array(26).fill(1);
for (const c of "AIO") COMFORTABLE[c.charCodeAt(0) - 65] = 2;
COMFORTABLE[4] = 3; // E
for (const c of "SRTNLD") COMFORTABLE[c.charCodeAt(0) - 65] = 2;

const Q = 16;
const U = 20;

export function leaveValue(r: Rack, p: LeaveParams): number {
  if (p.alpha <= 0) return 0;
  const glue = p.glue ?? 0;
  let v = 0;
  let vowels = 0;
  let n = 0;
  for (let c = 0; c < 26; c++) {
    const k = r[c]!;
    if (k <= 0) continue;
    n += k;
    if (VOWEL[c]) vowels += k;
    let u = USABILITY[c]!;
    if (c === Q && r[U]! > 0) u = 0.7;
    const ok = Math.min(k, COMFORTABLE[c]!);
    const worth = (FACE[c]! + glue) * u;
    v += worth * ok + worth * 0.35 * (k - ok);
  }
  v *= p.alpha;
  if (n >= 3 && p.balance > 0) {
    const off = Math.abs(vowels - 0.4 * n) - 1;
    if (off > 0) v -= p.balance * p.alpha * off;
  }
  return v;
}

export interface Plan {
  value: number; // total reward of the words + leave value
  words: number[]; // word indices, disjoint
  score: number; // reward of the words alone
}

export interface SolveOptions {
  leave: LeaveParams;
  timeMs?: number; // soft time budget
  branching?: number[]; // max children per depth
}

const DEFAULT_BRANCHING = [28, 14, 8, 5, 3, 2, 2, 2];

// Best split of `rack` into words from `candidates` (which must all be
// spellable from `rack`). Depth-first, widest near the root, cut off by a
// time budget.
export function solve(
  lex: Lexicon,
  rack: Rack,
  candidates: number[],
  opts: SolveOptions,
): Plan {
  const { leave } = opts;
  const branching = opts.branching ?? DEFAULT_BRANCHING;
  const deadline = performance.now() + (opts.timeMs ?? 40);
  const r = Int32Array.from(rack);

  // Order by gain over keeping the tiles: reward minus their leave value.
  const scored: { w: number; g: number }[] = [];
  for (const w of candidates) {
    let kept = 0;
    const ls = lex.letters[w]!;
    for (let j = 0; j < ls.length; j++) kept += (FACE[ls[j]!]! + (leave.glue ?? 0)) * USABILITY[ls[j]!]!;
    const g = lex.reward[w]! - leave.alpha * kept;
    if (g > 0 || leave.alpha <= 0) scored.push({ w, g });
  }
  scored.sort((a, b) => b.g - a.g || lex.reward[b.w]! - lex.reward[a.w]!);
  const root = scored.map((s) => s.w);

  let best: Plan = { value: leaveValue(r, leave), words: [], score: 0 };
  const chosen: number[] = [];
  let nodes = 0;

  const dfs = (list: number[], acc: number, depth: number) => {
    const here = acc + leaveValue(r, leave);
    if (here > best.value) {
      best = { value: here, words: chosen.slice(), score: acc };
    }
    const cap = branching[Math.min(depth, branching.length - 1)]!;
    let taken = 0;
    for (let i = 0; i < list.length && taken < cap; i++) {
      const w = list[i]!;
      if (!canSpell(lex, w, r)) continue;
      taken++;
      if ((++nodes & 63) === 0 && performance.now() > deadline) return;
      removeWord(lex, w, r);
      chosen.push(w);
      // Children: later words in the list still spellable after this one.
      const child: number[] = [];
      for (let j = i + 1; j < list.length; j++) {
        if (canSpell(lex, list[j]!, r)) child.push(list[j]!);
      }
      dfs(child, acc + lex.reward[w]!, depth + 1);
      chosen.pop();
      addWord(lex, w, r);
      if (performance.now() > deadline) return;
    }
  };
  dfs(root, 0, 0);
  return best;
}
