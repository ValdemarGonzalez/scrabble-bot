# Vector Blast: a ScrabbleBot tournament bot

Our entry for the [ScrabbleBot tournament](https://scrabblebot.spacetimedb.com) at HackUTD 2026.
ScrabbleBot is a Scrabble-style auction game running on [Spacetime](https://spacetimedb.com).
One tile at a time leaves a shared bag and goes up for a 1-second sealed-bid auction. The winner
pays the runner-up's price (Vickrey). Bots spell words from their tiles, and longer words pay more:
1× for 3 letters or fewer, rising to 3× at 7+.

The bot is a Spacetime client written in TypeScript. It subscribes to its own matches, auctions and
rack, and calls the game's reducers (`submit_bid`, `submit_word`, `join_lobby`,
`register_for_tournament`) directly.

## How it plays

- **Values each tile by what it adds to the rack.** The rack's worth is the best split of its
  tiles into dictionary words, plus what the unplayed tiles are still worth later. Kept tiles are
  valued per face point with a flat bonus for every tile, so common letters count too. That value
  falls to zero as the bag empties, because an unplayed tile scores nothing. Hard letters (Q, J, Z,
  V...) and duplicates are discounted, and a vowel-starved or vowel-flooded rack is penalized.
- **Bids in proportion to that value.** In a second-price auction, bidding what a tile is worth is
  the right play. Bids scale with money left per remaining auction, since money left at the end of
  a match is worth nothing. Near the end, spare money goes to denial bids. On the last tile the bot
  passes: the match ends when that auction closes, so nobody can use the tile.
- **Holds every word until the end.** With two tiles left in the bag, it splits the whole rack
  into the highest-scoring set of words (depth-first search with a time budget) and plays them all
  at once. If money runs low mid-match, it cashes in a 5+ letter word to keep bidding.
- **Runs unattended.** Reconnects with backoff, rejoins the lobby after each match, registers
  itself for any tournament open for registration, and never spends the same tile twice while
  words are in flight.

## Tuning

`sim/` is an offline copy of the game rules (98-tile bag, 5-tile starting racks, Vickrey or
first-price, match ends on an empty bag). It plays thousands of matches in parallel against:

- the server's simulated bots (Cheapskate, ValueBidder, Aggressive),
- the starter bot that ships with the game,
- a "field" bot modelled on prices observed on the live server (about 10 for 1-point tiles,
  about 20 for 4-pointers, 35-50 for J/Q/X/Z),
- other versions of this bot.

Results (300 matches each, 6 bots per match):

| Field | Win rate | Avg score |
|---|---|---|
| vs 5 field-model bots | 64% (even share: 17%) | 84 vs ~57 |
| vs 2 starter bots + 3 server sims | 100% | ~350 |
| head-to-head, 3 tuned vs 3 untuned copies | 23% vs 10% | 84 vs 73 |

## Running it

Needs Node 20+ (tested on 24).

```bash
npm install
cp .env.example .env    # then put your token from scrabblebot.spacetimedb.com/team in BOT_TOKEN
npm start
```

After the first connect, the token is saved to `.token-<BOT_NAME>`, which git ignores. Logs go to
the console and `logs/<BOT_NAME>.log`.

Other scripts:

```bash
npm test                 # strategy and solver tests
npm run sim -- field 300 # simulate 300 matches (scenarios: field, mixed, sims, starters, whales, ab, abfield, ...)
npm run peek             # read-only look at the live lobby, tournaments and top bots
npm run peek -- 196      # ...plus one bot's recent matches
```

To try parameter changes in the simulator, pass JSON overrides:
`SIM_A='{"glue":1.5}' SIM_B='{"glue":1}' npm run sim -- ab 300`.

## Layout

| Path | What it is |
|---|---|
| `src/index.ts` | Spacetime client: subscriptions, bidding, word play, lobby, tournaments, reconnects |
| `src/strategy.ts` | Bid and word-play decisions (all tunable parameters are here) |
| `src/solver.ts` | Best split of a rack into words, with leave valuation |
| `src/lexicon.ts` | Wordlist packed for fast rack scans; scoring rules |
| `src/peek.ts` | Read-only view of the live game |
| `src/module_bindings/` | Generated Spacetime client bindings for the game module |
| `sim/` | Offline match simulator and opponent models |
| `data/wordlist.txt` | ENABLE wordlist, the game's dictionary (public domain) |

## Notes

- Subscribing to every table, as the starter bot does, ran this client out of memory at 3.3 GB.
  The game keeps every auction ever run (about 1.8 million rows). The bot subscribes only to its
  own matches, through joins on `match_participant`, and to the `open_lobbies` views.
- The game, its starter bot and the generated bindings are by Clockwork Labs, MIT licensed (see
  `LICENSE.upstream`).
