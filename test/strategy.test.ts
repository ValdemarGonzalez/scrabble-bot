// Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadLexicon, rackFromString, scan } from "../src/lexicon.js";
import { solve } from "../src/solver.js";
import { Brain } from "../src/strategy.js";
import { playMatch, brainBot, starterBot } from "../sim/match.js";

const lex = loadLexicon();
const brain = new Brain(lex);
const view = (rack: string, bag: number, balance = 100) => ({ rack: rackFromString(rack), balance, bag, firstPrice: false });
const L = (c: string) => c.charCodeAt(0) - 65;

test("the last auction's tile is worthless, so the bot passes", () => {
  assert.equal(brain.bid(view("AERST", 0), L("E")), 0);
});

test("bids never exceed the balance", () => {
  for (const c of "AEQZXJS") assert.ok(brain.bid(view("AEIRST", 30, 7), L(c)) <= 7);
});

test("a vowel is worth more to a rack short of vowels", () => {
  const short = brain.bid(view("RSTNLDC", 40), L("E"));
  const flooded = brain.bid(view("AEIOUAE", 40), L("E"));
  assert.ok(short > flooded, `short ${short} vs flooded ${flooded}`);
});

test("late in a match, completing a 7-letter word is worth its bonus", () => {
  // AEIRST alone makes AIREST (6 letters, 15 points); + N makes ANESTRI (21).
  // Kept as a plain tile, an N would be worth under 2 points this late.
  const n = brain.tileValue(rackFromString("AEIRST"), L("N"), 5);
  assert.ok(n >= 6, `N worth ${n}`);
});

test("mid-match it holds words shorter than 7 letters", () => {
  // AEIRST spells 6-letter words (SATIRE, AIREST) but nothing longer.
  assert.deepEqual(brain.wordsToPlay(view("AEIRST", 40)), []);
});

test("mid-match it plays a 7-letter word worth more than its tiles are to keep", () => {
  // FLEXION is 51 points; RETAINS (21) is held in the hope of an 8-letter upgrade.
  assert.deepEqual(brain.wordsToPlay(view("EFILNOX", 40)), ["FLEXION"]);
  assert.deepEqual(brain.wordsToPlay(view("AEINRST", 40)), []);
});

test("near the end it plays everything it can, with disjoint tiles", () => {
  const rack = "AEINRSTDOGL";
  const words = brain.wordsToPlay(view(rack, 2));
  assert.ok(words.length > 0);
  const left = rackFromString(rack);
  for (const w of words) {
    assert.ok(lex.words.includes(w), `${w} is a word`);
    for (const ch of w) {
      left[L(ch)]!--;
      assert.ok(left[L(ch)]! >= 0, `tile ${ch} used twice`);
    }
  }
});

test("the solver splits a rack into high-scoring words quickly", () => {
  const rack = rackFromString("AEEIORSTTNLDGPMCHU");
  const t = performance.now();
  const s = scan(lex, rack);
  const plan = solve(lex, rack, s.exact, { leave: { alpha: 0, balance: 0 }, timeMs: 80 });
  assert.ok(performance.now() - t < 500);
  assert.ok(plan.score >= 60, `score ${plan.score}`);
});

test("beats the starter bot in simulated matches", () => {
  let wins = 0;
  for (let seed = 1; seed <= 5; seed++) {
    const r = playMatch(lex, [brainBot(lex), starterBot(lex), starterBot(lex), starterBot(lex)], seed);
    if (r.places[0] === 1) wins++;
  }
  assert.ok(wins >= 4, `won ${wins}/5`);
});
