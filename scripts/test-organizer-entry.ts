// Offline check of the organizer→Lichess-team→tournament matcher.
//   node scripts/test-organizer.mjs <team-swiss.ndjson>
// where the ndjson is a saved `GET https://lichess.org/api/team/{id}/swiss?max=N` dump
// (e.g. curl -s "https://lichess.org/api/team/dmv-chess-tournaments/swiss?max=2500" > dmv.ndjson).
import { readFileSync } from "node:fs";
import { organizerKeysFor, matchEventToTournaments, type OrganizerTournament } from "../src/lib/identity/organizerDiscovery";
import type { GraphEvent } from "../src/lib/identity/graphTypes";

const ev = (name: string, sectionName: string, startDate: string, players: number, roundCount: number, timeControl: string): GraphEvent => ({
  eventId: name + sectionName + startDate, name, sectionName, startDate, endDate: startDate, ratingSystem: "OR", timeControl, roundCount,
  players: Array.from({ length: players }, (_, i) => ({ uscfId: String(i), name: `P${i}`, games: [] })),
});
const events = [
  ev("DMVCHESS.COM JUNE PREMIER SCHOLASTIC", "K-5", "2022-06-18", 7, 4, "G/25;+5"),
  ev("DMVCHESS.COM JUNE PREMIER SCHOLASTIC", "K-12", "2022-06-18", 8, 4, "G/25;+5"),
  ev("DMVCHESS.COM LATE-SUMMER SCHOLASTIC", "K-12", "2022-08-19", 16, 4, "G/25;+5"),
  ev("CHESS KINGS AND QUEENS SEPTEMBER OPEN", "OPEN", "2022-09-10", 20, 4, "G/30;+5"),
  ev("2021 US JUNIOR CHESS CONGRESS", "U1200", "2021-11-20", 30, 5, "G/60;+5"),
  ev("PNWCC ONLINE OCTOBER SWISS", "U1600", "2022-10-08", 24, 4, "G/45;+15"),
  ev("PNWCC ONLINE NOVEMBER SWISS", "OPEN", "2022-11-12", 30, 4, "G/45;+15"),
];
const { organizerOf, termsOf } = organizerKeysFor(events);
for (const e of events) console.log(`${e.name} → key="${organizerOf.get(e.eventId)}" terms=${JSON.stringify(termsOf.get(organizerOf.get(e.eventId) || ""))}`);

const rows = readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => JSON.parse(l));
const hist: OrganizerTournament[] = rows.map((r: any) => ({
  platform: "lichess", kind: "lichess-swiss", id: r.id, teamId: "dmv-chess-tournaments", name: r.name, startsAtMs: Date.parse(r.startsAt),
  nbPlayers: r.nbPlayers, nbRounds: r.nbRounds, clock: r.clock ? { limit: r.clock.limit, increment: r.clock.increment } : undefined, variant: r.variant, status: r.status,
}));
for (const e of events.slice(0, 3)) {
  const m = matchEventToTournaments(e, hist, "dmvchess");
  console.log(`\n${e.name} — ${e.sectionName} (${e.players.length}p): ${m.map((x) => `${x.tournament.id} "${x.tournament.name}" score=${x.score.toFixed(2)} ambiguous=${x.ambiguous} [${x.reasons.join(", ")}]`).join(" | ") || "NO MATCH"}`);
}
