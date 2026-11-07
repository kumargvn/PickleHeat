// Regenerates shared/vectors/*.json from the TypeScript domain code.
// The Swift unit tests replay these files, so the iOS engine must give the same answers.
// Run: bun run scripts/make-vectors.ts

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { formScore, insights, winProbability } from "../src/domain/form";
import { recommend } from "../src/domain/recommend";
import { eliminationFirstRound, roundRobin, snakePools, standings } from "../src/domain/schedule";
import { sampleMatches, sampleTournaments } from "../src/adapters/sample";
import type { PlayedMatch } from "../src/domain/types";

const out = join(import.meta.dir, "../../shared/vectors");
const TODAY = "2026-11-07";

function m(id: string, day: string, team: number, opp: number, games: [number, number][]): PlayedMatch {
  return { id, playedAt: `${day}T18:00:00Z`, teamRating: team, opponentRating: opp, games: games.map(([us, them]) => ({ us, them })) };
}

const cases: { name: string; matches: PlayedMatch[] }[] = [
  { name: "sample player", matches: sampleMatches(TODAY) },
  { name: "too few matches", matches: [m("a", "2026-11-01", 4, 4, [[11, 5]]), m("b", "2026-11-02", 4, 4, [[11, 5]])] },
  {
    name: "cold streak",
    matches: [1, 2, 3, 4, 5].map((i) => m(`c${i}`, `2026-10-0${i}`, 3.5, 3.4, [[5, 11], [7, 11]])),
  },
  {
    name: "exactly at rating",
    matches: [1, 2, 3, 4].map((i) => m(`e${i}`, `2026-10-1${i}`, 3.8, 3.8, [[11, 9], [9, 11]])),
  },
];

const form = cases.map((c) => ({ name: c.name, matches: c.matches, expected: formScore(c.matches), insights: insights(c.matches) }));

const win = [
  [4.12, 3.97, null, null],
  [4.12, 3.97, 78, 63],
  [3.5, 4.5, 50, 50],
  [4.0, 4.0, 90, 20],
].map(([a, b, fa, fb]) => ({ a, b, formA: fa, formB: fb, p: winProbability(a as number, b as number, fa as number | null, fb as number | null) }));

const player = { doublesRating: 4.12, singlesRating: 3.86, form: 78, lat: 30.5083, lng: -97.6789, maxDistanceMiles: 75, formats: ["doubles", "mixed"] as const };
const tournaments = sampleTournaments(TODAY);
const recs = recommend({ ...player, formats: [...player.formats] }, tournaments, TODAY).map((r) => ({
  tournamentId: r.tournament.id,
  eventId: r.event.id,
  score: r.score,
  distanceMiles: r.distanceMiles,
  reasons: r.reasons,
}));

const teams = ["A", "B", "C", "D", "E"];
const rr = roundRobin(teams);
const results = [
  { home: "A", away: "B", games: [{ home: 11, away: 7 }] },
  { home: "C", away: "A", games: [{ home: 11, away: 9 }] },
  { home: "B", away: "C", games: [{ home: 11, away: 3 }] },
  { home: "D", away: "E", games: [{ home: 4, away: 11 }] },
  { home: "A", away: "E", games: [{ home: 11, away: 10 }] },
];

writeFileSync(join(out, "form.json"), JSON.stringify({ form, win }, null, 2) + "\n");
writeFileSync(join(out, "recommend.json"), JSON.stringify({ today: TODAY, player, recommendations: recs }, null, 2) + "\n");
writeFileSync(
  join(out, "schedule.json"),
  JSON.stringify(
    {
      roundRobin: { entrants: teams, pairings: rr },
      pools: { seeded: ["1", "2", "3", "4", "5", "6", "7"], count: 3, pools: snakePools(["1", "2", "3", "4", "5", "6", "7"], 3) },
      bracket: { seeded: ["s1", "s2", "s3", "s4", "s5", "s6"], firstRound: eliminationFirstRound(["s1", "s2", "s3", "s4", "s5", "s6"]) },
      standings: { entrants: teams, results, table: standings(teams, results) },
    },
    null,
    2,
  ) + "\n",
);
console.log("vectors written to", out);
