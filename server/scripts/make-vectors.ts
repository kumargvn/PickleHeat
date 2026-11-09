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
import { mkdirSync } from "node:fs";
import { handle } from "../src/app";
import { buildDeps } from "../src/deps";
import { MemoryStore } from "../src/adapters/memoryStore";
import { seedDemo } from "../src/demo/seed";

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

// ---------- API responses: the Swift tests decode each one into the app's models ----------
// Fixed clock and ids so the files only change when the API shape or the demo world changes.
const apiOut = join(out, "api");
mkdirSync(apiOut, { recursive: true });
let n = 0;
const deps = buildDeps({ PUBLIC_BASE_URL: "https://demo.pickleheat.app", WEB_APP_URL: "https://demo.pickleheat.app/app/", JWT_SECRET: "v".repeat(40), ALLOW_DEV_AUTH: "true", PLATFORM_FEE_BPS: "0" }, new MemoryStore());
const clock = Date.parse("2026-11-07T15:00:00Z");
deps.now = () => new Date(clock + n * 1000);
deps.newId = () => `id${String(++n).padStart(5, "0")}`;
await seedDemo(deps);
async function api(method: string, path: string, token?: string, body?: unknown) {
  const res = await handle(new Request("https://demo.pickleheat.app" + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), deps);
  const json = await res.json();
  if (res.status >= 400) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json as any;
}
const save = (name: string, body: unknown) => writeFileSync(join(apiOut, `api-${name}.json`), JSON.stringify(body, null, 1) + "\n");
const signIn = await api("POST", "/v1/auth/apple", undefined, { identityToken: "dev:demo" });
save("auth", signIn);
const t = signIn.token as string;
const cs = await api("POST", "/v1/dupr/connect-session", t, { client: "app" });
await api("POST", "/v1/dupr/link", new URL(cs.url).searchParams.get("t")!, { userToken: "mock-demo", refreshToken: "refresh-demo" });
save("me", await api("GET", "/v1/me", t));
save("form", await api("GET", "/v1/me/form", t));
save("live", await api("GET", "/v1/me/live", t));
save("discover", await api("GET", "/v1/discover", t));
const events = await api("GET", "/v1/events", t);
save("events", events);
const byName = (name: string) => [...events.events, ...(await_discover.events as any[])].find((c: any) => c.event.name === name).event;
const await_discover = await api("GET", "/v1/discover", t);
const ladder = byName("Sunrise Heat Climb");
const ladderDetail = await api("GET", `/v1/events/${ladder.id}`, t);
save("event-ladder", ladderDetail);
save("round", await api("GET", `/v1/rounds/${ladderDetail.currentRoundId}`, t));
save("rankings", await api("GET", `/v1/events/${ladder.id}/rankings`, t));
save("stats", await api("GET", `/v1/events/${ladder.id}/stats`, t));
save("event-scramble", await api("GET", `/v1/events/${byName("Friday Wildfire Mixer").id}`, t));
save("register", await api("POST", `/v1/events/${byName("Friday Wildfire Mixer").id}/register?client=app`, t, {}));
save("handoff", await api("POST", "/v1/auth/handoff", t, { to: "payouts" }));
save("event-team", await api("GET", `/v1/events/${byName("Tuesday Team League").id}`, t));
const hale = (await api("POST", "/v1/auth/apple", undefined, { identityToken: "dev:hale" })).token;
const slam = byName("Fall Slam Doubles");
await api("POST", `/v1/events/${slam.id}/schedule`, hale);
save("event-bracket", await api("GET", `/v1/events/${slam.id}`, t));
const ana = (await api("POST", "/v1/auth/apple", undefined, { identityToken: "dev:ana" })).token;
const mlp = byName("Club MLP Showdown");
await api("POST", `/v1/events/${mlp.id}/schedule`, ana);
save("event-mlp", await api("GET", `/v1/events/${mlp.id}`, t));
const chats = await api("GET", "/v1/chats", t);
save("chats", chats);
save("messages", await api("GET", `/v1/chats/${chats.chats[0].chat.id}/messages`, t));
save("notifications", await api("GET", "/v1/notifications", t));
const clubs = await api("GET", "/v1/clubs", t);
save("clubs", clubs);
save("club", await api("GET", `/v1/clubs/${clubs.mine[0].club.id}`, t));
save("recommended", await api("GET", "/v1/tournaments/recommended", t));
console.log("vectors written to", out);
