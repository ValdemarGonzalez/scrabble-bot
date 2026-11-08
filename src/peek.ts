// Read-only look at the live game: the open lobby, tournaments, and (with a
// bot id) that bot's recent matches. Connects anonymously; needs no token.
//   npm run peek            npm run peek -- <botId>

import { DbConnection } from "./module_bindings/index.js";

const HOST = process.env.STDB_HOST || "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB || "scrabblebot";
const botId = process.argv[2];

DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .onConnect((c, identity) => {
    const queries = [
      `SELECT * FROM bot_credential WHERE identity = 0x${identity.toHexString()}`,
      "SELECT * FROM bot",
      "SELECT * FROM bot_stats",
      "SELECT * FROM tournament",
      "SELECT * FROM tournament_entry",
      "SELECT * FROM open_lobbies",
      "SELECT * FROM open_lobby_members",
    ];
    if (botId) {
      queries.push(
        `SELECT * FROM match_participant WHERE bot_id = ${botId}`,
        `SELECT m.* FROM match_state m JOIN match_participant p ON m.id = p.match_id WHERE p.bot_id = ${botId}`,
        `SELECT * FROM word_play WHERE bot_id = ${botId}`,
        `SELECT q.* FROM match_participant q JOIN match_participant p ON q.match_id = p.match_id WHERE p.bot_id = ${botId}`,
      );
    }
    c.subscriptionBuilder()
      .onError((ctx) => {
        console.error("subscription error:", ctx.event?.message);
        process.exit(1);
      })
      .onApplied(() => {
        const bots = new Map(Array.from(c.db.bot.iter()).map((b) => [b.id, b]));
        const name = (id: bigint) => bots.get(id)?.name ?? String(id);
        for (const l of c.db.openLobbies.iter()) {
          const members = Array.from(c.db.openLobbyMembers.iter()).filter((m) => m.lobbyId === l.id);
          console.log(`open lobby ${l.id}: ${members.map((m) => name(m.botId)).join(", ") || "(empty)"}`);
        }
        for (const t of c.db.tournament.iter()) {
          const entries = Array.from(c.db.tournamentEntry.iter()).filter((e) => e.tournamentId === t.id);
          console.log(`tournament ${t.id}: ${t.status.tag}, ${entries.length} entrants, ${t.swissRoundsTotal} Swiss rounds, cut ${t.topCut}, match size ${t.matchSize}, ${t.auctionType.tag}${t.winnerBotId !== undefined ? `, won by ${name(t.winnerBotId)}` : ""}`);
        }
        const stats = Array.from(c.db.botStats.iter()).sort((a, b) => b.openskillMu - 3 * b.openskillSigma - (a.openskillMu - 3 * a.openskillSigma)).slice(0, 15);
        console.log("top bots (mu - 3 sigma):");
        for (const s of stats) {
          const b = bots.get(s.botId);
          console.log(`  ${String(s.botId).padStart(4)} ${name(s.botId).padEnd(22)} mu ${s.openskillMu.toFixed(1)} ±${s.openskillSigma.toFixed(1)}  matches ${s.matchesPlayed}  wins ${s.wins}  avg ${s.matchesPlayed ? (Number(s.totalScore) / s.matchesPlayed).toFixed(0) : "-"}${b?.isSimulated ? "  (sim)" : ""}`);
        }
        if (botId) {
          const mine = Array.from(c.db.matchParticipant.iter()).filter((p) => String(p.botId) === botId);
          console.log(`bot ${botId} (${name(BigInt(botId))}): ${mine.length} matches subscribed`);
          for (const p of mine.slice(-5)) {
            const field = Array.from(c.db.matchParticipant.iter()).filter((q) => q.matchId === p.matchId).sort((a, b) => Number(b.score - a.score));
            const words = Array.from(c.db.wordPlay.iter()).filter((w) => w.matchId === p.matchId).map((w) => `${w.word}+${w.totalReward}`);
            console.log(`  match ${p.matchId}: ${field.map((q) => `${name(q.botId)}=${q.score}`).join(" ")} | ${words.join(" ")}`);
          }
        }
        process.exit(0);
      })
      .subscribe(queries);
  })
  .onConnectError((_ctx, err) => {
    console.error("connect error:", err.message);
    process.exit(1);
  })
  .build();
