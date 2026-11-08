// The wordlist, packed for fast "what can this rack spell" scans, plus the
// game's scoring rules (mirrors spacetimedb/src/letters.ts in the game repo).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Standard Scrabble face values, indexed A..Z.
export const FACE = Int32Array.from([
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10,
]);

// 98-tile bag, no blanks, indexed A..Z.
export const BAG = Int32Array.from([
  9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1,
]);

export const VOWEL = Uint8Array.from(
  ALPHABET.split("").map((c) => ("AEIOU".includes(c) ? 1 : 0)),
);

// reward = floor(base * num / den), by word length.
export function reward(base: number, len: number): number {
  if (len <= 3) return base;
  if (len === 4) return Math.floor((base * 3) / 2);
  if (len === 5) return base * 2;
  if (len === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

export function multiplier(len: number): number {
  if (len <= 3) return 1;
  if (len === 4) return 1.5;
  if (len === 5) return 2;
  if (len === 6) return 2.5;
  return 3;
}

export interface Lexicon {
  words: string[];
  len: Uint8Array;
  base: Int32Array; // sum of face values
  reward: Int32Array; // base x length multiplier
  mask: Uint32Array; // bit i set if the word uses letter i
  letters: Uint8Array[]; // letter indices of each word
  counts: Uint8Array; // 26 per word: how many of each letter
  // Anagrams spend the same tiles for the same reward, so scans keep only
  // one word per set of letters, the one with canonical[w] set.
  canonical: Uint8Array;
}

export function buildLexicon(rawWords: string[]): Lexicon {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of rawWords) {
    const w = raw.trim().toUpperCase();
    if (w.length < 2 || w.length > 15 || !/^[A-Z]+$/.test(w) || seen.has(w)) continue;
    seen.add(w);
    words.push(w);
  }
  const n = words.length;
  const len = new Uint8Array(n);
  const base = new Int32Array(n);
  const rew = new Int32Array(n);
  const mask = new Uint32Array(n);
  const letters: Uint8Array[] = new Array(n);
  const counts = new Uint8Array(n * 26);
  const canonical = new Uint8Array(n);
  const firstByLetters = new Set<string>();
  for (let i = 0; i < n; i++) {
    const w = words[i]!;
    const ls = new Uint8Array(w.length);
    let b = 0;
    let m = 0;
    for (let j = 0; j < w.length; j++) {
      const c = w.charCodeAt(j) - 65;
      ls[j] = c;
      b += FACE[c]!;
      m |= 1 << c;
      counts[i * 26 + c]!++;
    }
    len[i] = w.length;
    base[i] = b;
    rew[i] = reward(b, w.length);
    mask[i] = m >>> 0;
    letters[i] = ls;
    const key = w.split("").sort().join("");
    if (!firstByLetters.has(key)) {
      firstByLetters.add(key);
      canonical[i] = 1;
    }
  }
  return { words, len, base, reward: rew, mask, letters, counts, canonical };
}

let cached: Lexicon | undefined;

export function defaultWordlistPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "data", "wordlist.txt");
}

export function loadLexicon(file = defaultWordlistPath()): Lexicon {
  if (cached) return cached;
  if (!fs.existsSync(file)) {
    throw new Error(`wordlist not found at ${file}`);
  }
  cached = buildLexicon(fs.readFileSync(file, "utf8").split("\n"));
  return cached;
}

// ---- Racks as 26-slot count arrays ----

export type Rack = Int32Array; // length 26

export function emptyRack(): Rack {
  return new Int32Array(26);
}

export function rackFromString(s: string): Rack {
  const r = emptyRack();
  for (const ch of s.toUpperCase()) {
    const c = ch.charCodeAt(0) - 65;
    if (c >= 0 && c < 26) r[c]!++;
  }
  return r;
}

export function rackFromMap(m: Map<string, number>): Rack {
  const r = emptyRack();
  for (const [ch, n] of m) {
    const c = ch.toUpperCase().charCodeAt(0) - 65;
    if (c >= 0 && c < 26 && n > 0) r[c]! += n;
  }
  return r;
}

export function rackToString(r: Rack): string {
  let s = "";
  for (let c = 0; c < 26; c++) s += ALPHABET[c]!.repeat(Math.max(0, r[c]!));
  return s;
}

export function rackSize(r: Rack): number {
  let n = 0;
  for (let c = 0; c < 26; c++) n += r[c]!;
  return n;
}

export function rackMask(r: Rack): number {
  let m = 0;
  for (let c = 0; c < 26; c++) if (r[c]! > 0) m |= 1 << c;
  return m >>> 0;
}

export function canSpell(lex: Lexicon, w: number, r: Rack): boolean {
  const off = w * 26;
  const ls = lex.letters[w]!;
  for (let j = 0; j < ls.length; j++) {
    const c = ls[j]!;
    if (lex.counts[off + c]! > r[c]!) return false;
  }
  return true;
}

export function removeWord(lex: Lexicon, w: number, r: Rack): void {
  const ls = lex.letters[w]!;
  for (let j = 0; j < ls.length; j++) r[ls[j]!]!--;
}

export function addWord(lex: Lexicon, w: number, r: Rack): void {
  const ls = lex.letters[w]!;
  for (let j = 0; j < ls.length; j++) r[ls[j]!]!++;
}

function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export interface ScanResult {
  exact: number[]; // words the rack spells now
  oneAway: number[][]; // [letter] -> words the rack spells with that one extra letter
}

// One pass over the wordlist: every word the rack can spell, and every word
// it could spell with exactly one more tile (grouped by the missing letter).
export function scan(lex: Lexicon, r: Rack, minLen = 2): ScanResult {
  const total = rackSize(r);
  const rm = rackMask(r);
  const exact: number[] = [];
  const oneAway: number[][] = Array.from({ length: 26 }, () => []);
  const n = lex.words.length;
  const { len, mask, letters, counts, canonical } = lex;
  for (let w = 0; w < n; w++) {
    if (!canonical[w]) continue;
    const L = len[w]!;
    if (L > total + 1 || L < minLen) continue;
    const missingMask = (mask[w]! & ~rm) >>> 0;
    if (missingMask !== 0 && popcount(missingMask) > 1) continue;
    const off = w * 26;
    const ls = letters[w]!;
    let deficit = 0;
    let missing = -1;
    // Count each distinct letter once.
    let doneMask = 0;
    for (let j = 0; j < ls.length; j++) {
      const c = ls[j]!;
      const bit = 1 << c;
      if (doneMask & bit) continue;
      doneMask |= bit;
      const need = counts[off + c]! - r[c]!;
      if (need > 0) {
        deficit += need;
        if (deficit > 1) break;
        missing = c;
      }
    }
    if (deficit === 0) exact.push(w);
    else if (deficit === 1) oneAway[missing]!.push(w);
  }
  return { exact, oneAway };
}
