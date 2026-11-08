// ScrabbleBot client: connects to the game's database, joins matches, and
// plays them with the strategy in ./strategy.ts.
//
// Settings come from .env (see .env.example):
//   BOT_NAME      name for the saved token file (.token-<BOT_NAME>)
//   BOT_TOKEN     first run only: the token from "Generate token" on /team
//   BOT_NONCE     alternative first-run credential from the CLI
//   TOURNAMENT_ID register for this tournament on connect
//   NO_TOURNAMENT set to 1 to skip auto-registering for open tournaments
//   NO_LOBBY      set to 1 to stay out of the open lobby
//
// The token is saved after the first connect, so later runs need only
// BOT_NAME. The client reconnects by itself if the connection drops.

import "./dns-guard.js"; // first: every connection below resolves through it
import * as fs from "node:fs";
import * as path from "node:path";
import { setFallbackLogger } from "./dns-guard.js";
import { Identity } from "spacetimedb";
import { DbConnection, type ErrorContext } from "./module_bindings/index.js";
import { ALPHABET, emptyRack, loadLexicon, type Rack } from "./lexicon.js";
import { Brain } from "./strategy.js";

try {
  process.loadEnvFile(path.join(process.cwd(), ".env"));
} catch {
  // no .env; use the real environment
}

const HOST = process.env.STDB_HOST || "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB || "scrabblebot";
const BOT_NAME = process.env.BOT_NAME || "bot";
const BOT_TOKEN = process.env.BOT_TOKEN || undefined;
const BOT_NONCE = process.env.BOT_NONCE || undefined;
const TOURNAMENT_ID = process.env.TOURNAMENT_ID || undefined;
const AUTO_TOURNAMENT = !process.env.NO_TOURNAMENT;
const USE_LOBBY = !process.env.NO_LOBBY;
// Once registered for a tournament, stay out of lobby matches so the admin
// can start it without waiting on us. LOBBY_WHILE_WAITING=1 keeps playing.
const LOBBY_WHILE_WAITING = !!process.env.LOBBY_WHILE_WAITING;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);
const LOG_DIR = path.join(process.cwd(), "logs");

fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = fs.createWriteStream(path.join(LOG_DIR, `${BOT_NAME}.log`), { flags: "a" });
function log(msg: string) {
  const d = new Date();
  const time = d.toLocaleTimeString("en-US", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
  const line = `${time} [${BOT_NAME}] ${msg}`;
  console.log(line);
  logFile.write(line + "\n");
}

setFallbackLogger(log);

// Touch this file to keep the bot out of new lobby matches without a
// restart (e.g. right before a tournament starts); delete it to resume.
const NO_LOBBY_FLAG = path.join(process.cwd(), ".no-lobby");

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

const t0 = performance.now();
const lex = loadLexicon();
const brain = new Brain(lex);
log(`loaded ${lex.words.length} words in ${(performance.now() - t0).toFixed(0)}ms`);

// ---------- Per-connection state ----------

let conn: DbConnection | null = null;
let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
// False until our game subscription has loaded, so rows replayed from
// history on connect aren't logged as news.
let live = false;
const bidAuctions = new Set<string>();
// Tiles promised to words we've sent but the server hasn't confirmed yet,
// per match, so we never spend a tile twice.
const inflight = new Map<string, Rack>();
const registered = new Set<string>();
const lastFailure = new Map<string, number>();

function failed(what: string) {
  return (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    // Some refusals repeat (lobby closed during a tournament): log each kind once a minute.
    const key = `${what.split(" ")[0]}:${msg}`;
    const now = Date.now();
    if (now - (lastFailure.get(key) ?? 0) > 60_000) {
      lastFailure.set(key, now);
      log(`${what} failed: ${msg}`);
    }
  };
}

function letterIndex(s: string): number {
  return s.toUpperCase().charCodeAt(0) - 65;
}

function rackFor(c: DbConnection, matchId: bigint): Rack {
  const r = emptyRack();
  for (const h of c.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    const i = letterIndex(h.letter);
    if (i >= 0 && i < 26) r[i]! += Number(h.count);
  }
  const pending = inflight.get(String(matchId));
  if (pending) for (let i = 0; i < 26; i++) r[i] = Math.max(0, r[i]! - pending[i]!);
  return r;
}

function rackString(r: Rack): string {
  let s = "";
  for (let i = 0; i < 26; i++) s += ALPHABET[i]!.repeat(r[i]!);
  return s;
}

function me(c: DbConnection, matchId: bigint) {
  if (myBotId === null) return undefined;
  for (const p of c.db.matchParticipant.iter()) {
    if (p.matchId === matchId && p.botId === myBotId) return p;
  }
  return undefined;
}

function viewFor(c: DbConnection, matchId: bigint) {
  const m = c.db.matchState.id.find(matchId);
  const p = me(c, matchId);
  if (!m || !p || m.status.tag !== "Running") return undefined;
  return {
    rack: rackFor(c, matchId),
    balance: Number(p.balance),
    bag: Number(m.bagTotal),
    firstPrice: m.auctionType.tag === "FirstPrice",
  };
}

function runningMatches(c: DbConnection): bigint[] {
  const out: bigint[] = [];
  if (myBotId === null) return out;
  for (const p of c.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    if (c.db.matchState.id.find(p.matchId)?.status.tag === "Running") out.push(p.matchId);
  }
  return out;
}

// ---------- Playing ----------

function bidOn(c: DbConnection, auctionId: bigint, matchId: bigint, letter: string) {
  const key = String(auctionId);
  if (bidAuctions.has(key)) return;
  const v = viewFor(c, matchId);
  if (!v) return;
  bidAuctions.add(key);
  const t = performance.now();
  const amount = brain.bid(v, letterIndex(letter));
  const ms = (performance.now() - t).toFixed(0);
  if (amount <= 0) {
    log(`m${matchId} '${letter}' pass (bag ${v.bag}, bal ${v.balance}, rack ${rackString(v.rack)}, ${ms}ms)`);
    return;
  }
  c.reducers.submitBid({ auctionId, amount: BigInt(amount) }).catch(failed(`bid on auction ${auctionId}`));
  log(`m${matchId} '${letter}' bid ${amount} (bag ${v.bag}, bal ${v.balance}, rack ${rackString(v.rack)}, ${ms}ms)`);
}

function playWords(c: DbConnection, matchId: bigint) {
  const v = viewFor(c, matchId);
  if (!v) return;
  const words = brain.wordsToPlay(v);
  if (words.length === 0) return;
  const key = String(matchId);
  for (const word of words) {
    const pending = inflight.get(key) ?? emptyRack();
    inflight.set(key, pending);
    for (const ch of word) pending[letterIndex(ch)]!++;
    const release = () => {
      for (const ch of word) pending[letterIndex(ch)] = Math.max(0, pending[letterIndex(ch)]! - 1);
    };
    log(`m${matchId} playing ${word} (bag ${v.bag}, rack ${rackString(v.rack)})`);
    c.reducers
      .submitWord({ matchId, word })
      .then(release, (err) => {
        release();
        failed(`playing ${word}`)(err);
      });
  }
}

function actAll(c: DbConnection) {
  for (const m of runningMatches(c)) playWords(c, m);
}

// ---------- Lobby and tournaments ----------

let saidWaiting = false;
function awaitingTournament(c: DbConnection): boolean {
  if (LOBBY_WHILE_WAITING) return false;
  const waiting = Array.from(c.db.tournament.iter()).some(
    (t) =>
      t.status.tag === "Registration" &&
      Array.from(c.db.tournamentEntry.iter()).some((e) => e.tournamentId === t.id && e.botId === myBotId),
  );
  if (waiting && !saidWaiting) log("registered for a tournament; staying out of the lobby until it starts");
  saidWaiting = waiting;
  return waiting;
}

let saidFlag = false;
function joinLobby(c: DbConnection) {
  if (!USE_LOBBY || myBotId === null) return;
  if (runningMatches(c).length > 0) return;
  const flagged = fs.existsSync(NO_LOBBY_FLAG);
  if (flagged !== saidFlag) {
    saidFlag = flagged;
    log(flagged ? ".no-lobby present: not joining lobby matches" : ".no-lobby removed: lobby matches again");
  }
  if (flagged) return;
  if (awaitingTournament(c)) return;
  if (Array.from(c.db.openLobbyMembers.iter()).some((lm) => lm.botId === myBotId)) return;
  c.reducers.joinLobby({}).catch(failed("joining the lobby"));
}

function register(c: DbConnection, tournamentId: bigint) {
  const key = String(tournamentId);
  if (registered.has(key) || myBotId === null) return;
  registered.add(key);
  c.reducers
    .registerForTournament({ tournamentId })
    .then(() => log(`registered for tournament ${tournamentId}`))
    .catch((err) => {
      registered.delete(key);
      failed(`registering for tournament ${tournamentId}`)(err);
    });
}

function checkTournaments(c: DbConnection) {
  if (TOURNAMENT_ID) register(c, BigInt(TOURNAMENT_ID));
  if (!AUTO_TOURNAMENT) return;
  for (const t of c.db.tournament.iter()) {
    if (t.status.tag !== "Registration") continue;
    const entered = Array.from(c.db.tournamentEntry.iter()).some((e) => e.tournamentId === t.id && e.botId === myBotId);
    if (!entered) register(c, t.id);
  }
}

// ---------- Connection ----------

function subscribeToMyGames(c: DbConnection, botId: bigint) {
  const id = String(botId);
  c.subscriptionBuilder()
    .onApplied(() => start(c))
    .onError((ctx) => log(`subscription error: ${ctx.event?.message ?? "unknown"}`))
    .subscribe([
      `SELECT * FROM bot WHERE id = ${id}`,
      `SELECT * FROM match_participant WHERE bot_id = ${id}`,
      `SELECT m.* FROM match_state m JOIN match_participant p ON m.id = p.match_id WHERE p.bot_id = ${id}`,
      `SELECT a.* FROM auction a JOIN match_participant p ON a.match_id = p.match_id WHERE p.bot_id = ${id}`,
      `SELECT * FROM word_play WHERE bot_id = ${id}`,
      `SELECT * FROM tournament_entry WHERE bot_id = ${id}`,
    ]);
}

// Everyone's seat in one match, for the standings line in the log.
const standings = new Map<string, { unsubscribe(): void }>();
function watchStandings(c: DbConnection, matchId: bigint) {
  const key = String(matchId);
  if (standings.has(key)) return;
  const handle = c
    .subscriptionBuilder()
    .onError(() => standings.delete(key))
    .subscribe([`SELECT * FROM match_participant WHERE match_id = ${matchId}`]);
  standings.set(key, handle);
}
function logStandings(c: DbConnection, matchId: bigint) {
  const scores = Array.from(c.db.matchParticipant.iter())
    .filter((p) => p.matchId === matchId)
    .sort((a, b) => Number(b.score - a.score));
  const mine = scores.find((p) => p.botId === myBotId);
  const place = mine ? 1 + scores.filter((p) => p.score > mine.score).length : 0;
  log(
    `m${matchId} ended: place ${place}/${scores.length}, scores ${scores
      .map((p) => (p.botId === myBotId ? `*${p.score}*` : String(p.score)))
      .join(" ")}`,
  );
  const handle = standings.get(String(matchId));
  standings.delete(String(matchId));
  try {
    handle?.unsubscribe();
  } catch {
    // already gone
  }
}

function start(c: DbConnection) {
  live = true;
  const bot = myBotId !== null ? c.db.bot.id.find(myBotId) : undefined;
  log(`playing as bot '${bot?.name ?? "?"}' (id ${myBotId})`);
  checkTournaments(c);
  joinLobby(c);
  for (const m of runningMatches(c)) watchStandings(c, m);
  for (const a of c.db.auction.iter()) {
    if (a.status.tag === "Open") bidOn(c, a.id, a.matchId, a.letter);
  }
  actAll(c);
}

function onConnect(c: DbConnection, identity: Identity, token: string) {
  const gen = generation;
  // Anything a dropped connection still delivers later is stale: ignore it.
  const alive = () => gen === generation;
  myIdentity = identity;
  log(`connected as ${identity.toHexString().slice(0, 16)}…`);
  retries = 0;
  const hex = identity.toHexString();

  // Subscribe narrowly: the game keeps every auction ever run (millions of
  // rows), so subscribing to whole tables runs a client out of memory.
  c.subscriptionBuilder()
    .onApplied(() => {
      myBotId = c.db.botCredential.identity.find(identity)?.botId ?? null;
      if (myBotId !== null) {
        fs.writeFileSync(TOKEN_PATH, token); // later runs need only BOT_NAME
        return subscribeToMyGames(c, myBotId);
      }
      if (!BOT_NONCE) {
        log("this token isn't a credential for any bot. Put a fresh token from /team in BOT_TOKEN.");
        process.exit(1);
      }
      log("claiming credential with nonce…");
      c.reducers
        .claimCredential({ code: BOT_NONCE })
        .then(() => {
          myBotId = c.db.botCredential.identity.find(identity)?.botId ?? null;
          if (myBotId === null) {
            log("couldn't claim the credential. Bad or expired nonce?");
            process.exit(1);
          }
          fs.writeFileSync(TOKEN_PATH, token);
          subscribeToMyGames(c, myBotId);
        })
        .catch((err) => {
          failed("claiming the credential")(err);
          process.exit(1);
        });
    })
    .onError((ctx) => log(`subscription error: ${ctx.event?.message ?? "unknown"}`))
    .subscribe([
      `SELECT * FROM bot_credential WHERE identity = 0x${hex}`,
      "SELECT * FROM tournament",
      "SELECT * FROM open_lobbies",
      "SELECT * FROM open_lobby_members",
      "SELECT * FROM my_rack",
    ]);

  c.db.auction.onInsert((_ctx, a) => {
    if (!alive()) return;
    lastAuctionAt = Date.now();
    if (myBotId === null || a.status.tag !== "Open") return;
    bidOn(c, a.id, a.matchId, a.letter);
    playWords(c, a.matchId);
  });
  c.db.myRack.onInsert((_ctx, h) => alive() && playWords(c, h.matchId));
  c.db.myRack.onUpdate((_ctx, _old, h) => alive() && playWords(c, h.matchId));
  c.db.botCredential.onInsert(() => {
    if (myBotId === null && myIdentity) myBotId = c.db.botCredential.identity.find(myIdentity)?.botId ?? null;
  });
  c.db.matchState.onUpdate((_ctx, old, neu) => {
    if (!alive() || myBotId === null || !me(c, neu.id)) return;
    if (old.status.tag !== "Running" && neu.status.tag === "Running") {
      log(`m${neu.id} started (${neu.auctionType.tag}, ${neu.auctionDurationMs}ms auctions)`);
    }
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      // Give the last score updates a moment to arrive.
      setTimeout(() => logStandings(c, neu.id), 500);
      inflight.delete(String(neu.id));
      setTimeout(() => joinLobby(c), 250);
    }
  });
  c.db.matchParticipant.onInsert((_ctx, p) => {
    if (!alive() || !live || p.botId !== myBotId) return;
    // The game subscription replays every match this bot ever played;
    // only a running one is news.
    if (c.db.matchState.id.find(p.matchId)?.status.tag !== "Running") return;
    log(`seated in match ${p.matchId}`);
    lastAuctionAt = Date.now();
    watchStandings(c, p.matchId);
    for (const a of c.db.auction.iter()) {
      if (a.matchId === p.matchId && a.status.tag === "Open") bidOn(c, a.id, a.matchId, a.letter);
    }
  });
  c.db.wordPlay.onInsert((_ctx, w) => {
    if (alive() && live && w.botId === myBotId && c.db.matchState.id.find(w.matchId)?.status.tag === "Running") log(`m${w.matchId} scored ${w.word} +${w.totalReward}`);
  });
  c.db.tournament.onInsert(() => alive() && checkTournaments(c));
  c.db.tournament.onUpdate((_ctx, _old, t) => {
    if (!alive()) return;
    log(`tournament ${t.id}: ${t.status.tag}`);
    checkTournaments(c);
  });
}

let retries = 0;
let heartbeat: NodeJS.Timeout | undefined;
let generation = 0;
let lastAuctionAt = 0;

function connect() {
  const gen = ++generation;
  bidAuctions.clear();
  inflight.clear();
  registered.clear();
  standings.clear();
  myBotId = null;
  live = false;
  log(`connecting to ${DB_NAME} at ${HOST}`);
  conn = DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect((c, identity, token) => {
      if (gen !== generation) return;
      onConnect(c, identity, token);
    })
    .onConnectError((_ctx: ErrorContext, err: Error) => {
      if (gen !== generation) return;
      log(`connect error: ${err.message}`);
      reconnect();
    })
    .onDisconnect(() => {
      if (gen !== generation) return;
      log("disconnected");
      reconnect();
    })
    .build();
}

let reconnecting = false;
function reconnect(immediate = false) {
  if (reconnecting) return;
  reconnecting = true;
  conn = null;
  const wait = immediate ? 200 : Math.min(15_000, 1000 * 2 ** retries++);
  log(`reconnecting in ${wait / 1000}s`);
  setTimeout(() => {
    reconnecting = false;
    connect();
  }, wait);
}

// Safety net: keep trying to get into the lobby and play words even if an
// event was missed.
heartbeat = setInterval(() => {
  if (!conn || myBotId === null) return;
  joinLobby(conn);
  checkTournaments(conn);
  actAll(conn);
}, 5000);

// Watchdog: on this network a connection can freeze for over a minute and
// then deliver every auction at once, all of them already closed (match
// 46975: 76 s frozen, scored 0). Auctions arrive about once a second in a
// running match, so a few seconds of silence means the socket is stuck:
// drop it and reconnect at once instead of waiting it out.
const STALL_MS = Number(process.env.STALL_MS || 4000);
setInterval(() => {
  if (!conn || myBotId === null || !live || lastAuctionAt === 0) return;
  const running = runningMatches(conn);
  if (running.length === 0) return;
  const m = conn.db.matchState.id.find(running[0]!);
  const limit = Math.max(STALL_MS, 3 * Number(m?.auctionDurationMs ?? 1000n));
  const quiet = Date.now() - lastAuctionAt;
  if (quiet < limit) return;
  log(`no auction for ${(quiet / 1000).toFixed(1)}s in match ${running[0]}: connection looks stuck, reconnecting now`);
  const old = conn;
  generation++; // ignore whatever the stuck connection delivers later
  lastAuctionAt = 0;
  try {
    (old as unknown as { disconnect?: () => void }).disconnect?.();
  } catch {
    // already closed
  }
  reconnecting = false;
  reconnect(true);
}, 1000);

// A crash should leave its reason in the log before the supervisor restarts us.
process.on("uncaughtException", (err) => {
  log(`uncaught exception: ${err?.stack ?? err}`);
  setTimeout(() => process.exit(1), 100);
});
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection: ${(reason as Error)?.stack ?? reason}`);
});
process.on("exit", (code) => log(`process exiting with code ${code}`));

process.on("SIGINT", () => {
  log("stopping");
  if (heartbeat) clearInterval(heartbeat);
  process.exit(0);
});

connect();
