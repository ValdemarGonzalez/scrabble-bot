import { loadLexicon, rackFromString, scan } from "../src/lexicon.js";
import { solve } from "../src/solver.js";
import { Brain } from "../src/strategy.js";

let t = performance.now();
const lex = loadLexicon();
console.log(`lexicon: ${lex.words.length} words in ${(performance.now() - t).toFixed(0)}ms`);
const brain = new Brain(lex);
for (const r of ["AERTS", "AEIRSTNLD", "QUZAXEIRSTNLO", "AEEIORSTTNLDGPMCHU", "AAEEIIOORSTNLDGPMBCHUWY"]) {
  const rack = rackFromString(r);
  t = performance.now();
  const s = scan(lex, rack);
  const tScan = performance.now() - t;
  t = performance.now();
  const flush = solve(lex, rack, s.exact, { leave: { alpha: 0, balance: 0 }, timeMs: 80 });
  const tFlush = performance.now() - t;
  t = performance.now();
  const bidE = brain.tileValue(rack, 4, 40);
  const bidZ = brain.tileValue(rack, 25, 40);
  const tVal = performance.now() - t;
  console.log(`${r} (${r.length}): scan ${tScan.toFixed(1)}ms exact=${s.exact.length}; flush ${tFlush.toFixed(1)}ms -> ${flush.words.map(w=>lex.words[w]).join(" ")} = ${flush.score}; value E=${bidE.toFixed(1)} Z=${bidZ.toFixed(1)} (${tVal.toFixed(0)}ms)`);
}
