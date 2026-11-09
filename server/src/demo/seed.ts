// A believable demo world, built through the real services so it's always valid:
// a club, a Heat Climb in week 4, an open Wildfire Mixer, a double-elimination tournament,
// an MLP event and a team league. Used by the iPhone/web demo and by the API tests.
// Every player is invented. Sign in as anyone with the dev token "dev:<first name>", e.g. "dev:demo", "dev:chen".

import { db } from "../db";
import type { Deps, Entry, PickleHeatEvent, User } from "../ports";
import { createEvent, generateSchedule, publishEvent } from "../services/events";
import { requestSub, startRound } from "../services/leagues";
import { reportScore } from "../services/matches";
import { createClub, joinClub } from "../services/people";
import { notify, postMessage } from "../services/social";
import sample from "../../../shared/sample-data.json";

export const DEMO_USER_ID = "u-demo";

const PEOPLE: [string, string, "m" | "f", number, number][] = [
  // id slug, name, gender, doubles rating, reliability
  ["chen", "Chen Wei", "m", 4.38, 100], ["ana", "Ana Alvarez", "f", 4.31, 100], ["brooks", "Brooks Taylor", "m", 4.27, 90],
  ["priya", "Priya Kapoor", "f", 4.04, 100], ["hale", "Hale Rivera", "m", 4.19, 100], ["sam", "Sam Okafor", "m", 4.06, 80],
  ["dev", "Dev Patel", "m", 4.1, 100], ["nina", "Nina Park", "f", 3.98, 70], ["marco", "Marco Diaz", "m", 3.95, 100],
  ["lena", "Lena Schultz", "f", 3.99, 100], ["omar", "Omar Haddad", "m", 3.88, 90], ["grace", "Grace Lin", "f", 3.84, 100],
  ["tyler", "Tyler Brooks", "m", 3.79, 60], ["maya", "Maya Singh", "f", 3.75, 100], ["leo", "Leo Carter", "m", 3.71, 100],
  ["ivy", "Ivy Nguyen", "f", 3.66, 80], ["raj", "Raj Mehta", "m", 3.6, 100], ["sofia", "Sofia Rossi", "f", 3.55, 100],
  ["ben", "Ben Ortiz", "m", 3.49, 70], ["kara", "Kara Jones", "f", 3.44, 100], ["luis", "Luis Romero", "m", 3.38, 100],
  ["emma", "Emma Clark", "f", 3.31, 90], ["noah", "Noah Kim", "m", 3.22, 100],
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uid = (slug: string) => `u-${slug}`;

export async function seedDemo(deps: Deps): Promise<void> {
  const d = db(deps);
  if (await d.users.get(DEMO_USER_ID)) return;
  const now = deps.now();
  const iso = now.toISOString();
  const day = (offset: number) => new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  const rand = rng(20261107);

  // ----- people -----
  const me: User = { id: DEMO_USER_ID, appleSub: "dev-demo", email: "demo@example.com", name: sample.player.name, gender: "m", lat: sample.player.lat, lng: sample.player.lng, maxDistanceMiles: 75, formats: ["doubles", "mixed"], createdAt: iso };
  await d.users.put(me);
  const ratings = new Map<string, number>();
  for (const [slug, name, gender, rating, rel] of PEOPLE) {
    const id = uid(slug);
    ratings.set(id, rating);
    await d.users.put({ id, appleSub: `dev-${slug}`, email: `${slug}@example.com`, name, gender, lat: sample.player.lat + (rand() - 0.5) * 0.2, lng: sample.player.lng + (rand() - 0.5) * 0.2, maxDistanceMiles: 75, formats: ["doubles", "mixed"], createdAt: iso });
    await d.dupr.put({ id, userId: id, duprId: `DEMO-${slug.slice(0, 2).toUpperCase()}${String(PEOPLE.findIndex((p) => p[0] === slug) + 1).padStart(2, "0")}`, duprUserId: `demo-${slug}`, accessToken: `mock-${slug}`, refreshToken: `refresh-${slug}`, accessExpiresAt: day(30) + "T00:00:00.000Z", doublesRating: rating, singlesRating: Math.round((rating - 0.25) * 100) / 100, doublesReliability: rel, singlesReliability: Math.max(40, rel - 30), ratingUpdatedAt: iso, matchesSyncedAt: null, linkedAt: iso });
  }
  const others = PEOPLE.map((p) => uid(p[0]));
  const as = (slug: string) => ({ ...me, id: uid(slug) }) as User;
  const payout = async (userId: string) => d.payouts.put({ id: userId, userId, provider: deps.payments.name, providerAccountId: await deps.payments.createAccount((await d.users.get(userId))!), chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true });

  // ----- clubs -----
  const club = await createClub(deps, uid("chen"), { name: "Sample Pickleball Club", description: "Early-morning doubles, weekly ladders and monthly tournaments. All levels welcome.", city: "Round Rock", state: "TX", lat: 30.516, lng: -97.665 });
  for (const id of [...others.filter((x) => x !== uid("chen")), DEMO_USER_ID]) await joinClub(deps, club.id, id);
  await d.members.put({ ...(await d.members.get(`${club.id}:${uid("ana")}`))!, role: "admin" });
  const club2 = await createClub(deps, uid("omar"), { name: "Riverside Paddle Club", description: "Evening open play and a Sunday mixed league by the river.", city: "Georgetown", state: "TX", lat: 30.6327, lng: -97.6772 });
  for (const s of ["grace", "leo", "ivy", "raj"]) await joinClub(deps, club2.id, uid(s));
  await payout(uid("chen"));
  await payout(uid("hale"));

  const entry = async (ev: PickleHeatEvent, players: string[], teamName?: string) => {
    const e: Entry = { id: deps.newId(), eventId: ev.id, playerIds: players, teamName: teamName ?? players.map((p) => (p === DEMO_USER_ID ? me.name : PEOPLE.find((x) => uid(x[0]) === p)![1]).split(" ")[0]).join(" / "), teamRating: players.reduce((s, p) => s + (ratings.get(p) ?? 3.9), 0) / players.length, status: "confirmed", comped: false, createdAt: iso };
    await d.entries.put(e);
    return e;
  };
  const scoreFor = (home: string[], away: string[]) => {
    const r = (ids: string[]) => ids.reduce((s, p) => s + (ratings.get(p) ?? 3.9), 0) / ids.length;
    const pHome = 1 / (1 + Math.pow(10, -(r(home) - r(away)) * 2));
    const homeWins = rand() < pHome;
    const loser = Math.floor(rand() * 8) + 3;
    return homeWins ? { us: 11, them: loser } : { us: loser, them: 11 };
  };

  // ----- 1. Flex ladder, week 4 in progress -----
  const ladderPlayers = [...others, DEMO_USER_ID];
  let ladder = await createEvent(deps, as("chen"), {
    kind: "league", style: "flex_ladder", format: "doubles", name: "Sunrise Heat Climb", clubId: club.id,
    description: "Every week you're placed in a heat with three players near your level. Set a time in your heat's chat and play 3 matches with rotating partners. Win your heat to climb; last place drops a heat.",
    startDate: day(-22), weeks: 8, roundDays: 7, gamesPerMatch: 2, venue: "Sample Racquet Center", city: "Round Rock", state: "TX", lat: 30.516, lng: -97.665,
    minRating: 3.0, maxRating: 4.5, capacity: 32, feeCents: 0,
  });
  for (const p of ladderPlayers) await entry(ladder, [p]);
  ladder = await publishEvent(deps, ladder);
  // The demo player joined with a 3.9 rating (their DUPR link comes when they connect in the app).
  ratings.set(DEMO_USER_ID, 3.9);
  for (let r = 1; r <= 4; r++) {
    const round = await startRound(deps, (await d.events.get(ladder.id))!, uid("chen"));
    const matches = (await d.matches.find({ roundId: round.id })).sort((a, b) => a.id.localeCompare(b.id));
    for (const m of matches) {
      const mine = m.homePlayers.includes(DEMO_USER_ID) || m.awayPlayers.includes(DEMO_USER_ID);
      if (r === 4 && mine) continue; // the demo player's current matches: see below
      if (r === 4 && rand() < 0.55) continue; // the rest of the league is mid-week
      await reportScore(deps, m.id, uid("chen"), { games: [scoreFor(m.homePlayers, m.awayPlayers), scoreFor(m.homePlayers, m.awayPlayers)] });
    }
    if (r === 4) {
      const myGroup = (await d.groups.find({ roundId: round.id, playerIds: [DEMO_USER_ID] }))[0];
      const myMatches = matches.filter((m) => m.groupId === myGroup.id);
      const first = myMatches[0];
      const opp = first.homePlayers.includes(DEMO_USER_ID) ? first.awayPlayers[0] : first.homePlayers[0];
      const iAmHome = first.homePlayers.includes(DEMO_USER_ID);
      await reportScore(deps, first.id, opp, { games: iAmHome ? [{ us: 11, them: 8 }, { us: 9, them: 11 }] : [{ us: 8, them: 11 }, { us: 11, them: 9 }] });
      const mate = myGroup.playerIds.find((p) => p !== DEMO_USER_ID && p !== opp)!;
      await postMessage(deps, myGroup.chatId, opp, "Thursday 6pm at Sample Racquet Center works for me. Courts 3–4 are usually open.");
      await postMessage(deps, myGroup.chatId, mate, "Thursday works! I'll bring balls 🎾");
      const otherGroup = (await d.groups.find({ roundId: round.id })).find((g) => g.id !== myGroup.id && g.number > myGroup.number) ?? (await d.groups.find({ roundId: round.id })).find((g) => g.id !== myGroup.id)!;
      await requestSub(deps, round, otherGroup.playerIds[1]);
    }
  }

  // ----- 2. Scramble league, open, club member pricing -----
  const scramble = await createEvent(deps, as("chen"), {
    kind: "league", style: "scramble", format: "doubles", name: "Friday Wildfire Mixer", clubId: club.id,
    description: "New heat, new partners every week. Heats are reshuffled each round; standings by total games won.",
    startDate: day(12), weeks: 6, roundDays: 7, gamesPerMatch: 2, venue: "Sample Racquet Center", city: "Round Rock", state: "TX", lat: 30.516, lng: -97.665,
    minRating: 3.0, maxRating: 4.75, capacity: 24, feeCents: 4000, memberFeeCents: 3000,
  });
  for (const p of others.slice(4, 16)) await entry(scramble, [p]);
  await publishEvent(deps, scramble);

  // ----- 3. Double elimination tournament, open -----
  const slam = await createEvent(deps, as("hale"), {
    kind: "tournament", style: "double_elim", format: "doubles", name: "Fall Slam Doubles",
    description: "Double elimination: lose twice and you're out. Grand final with a reset match if needed.",
    startDate: day(9), venue: "Sample Racquet Center", city: "Round Rock", state: "TX", lat: 30.516, lng: -97.665,
    minRating: 3.5, maxRating: 4.35, capacity: 8, feeCents: 3500,
  });
  for (const [a, b] of [["sam", "dev"], ["marco", "lena"], ["omar", "grace"], ["tyler", "maya"], ["leo", "ivy"], ["nina", "raj"]]) await entry(slam, [uid(a), uid(b)]);
  await publishEvent(deps, slam);

  // ----- 4. MLP showdown, open -----
  const mlp = await createEvent(deps, as("ana"), {
    kind: "tournament", style: "round_robin", format: "mlp", name: "Club MLP Showdown", clubId: club.id,
    description: "Teams of four (two men, two women). Women's, men's and two mixed doubles games; DreamBreaker at 2–2.",
    startDate: day(16), venue: "Sample Racquet Center", city: "Round Rock", state: "TX", lat: 30.516, lng: -97.665,
    capacity: 6, feeCents: 0,
  });
  await entry(mlp, [uid("chen"), uid("brooks"), uid("ana"), uid("nina")], "Dink Dynasty");
  await entry(mlp, [uid("hale"), uid("omar"), uid("lena"), uid("grace")], "Kitchen Crew");
  await entry(mlp, [uid("leo"), uid("raj"), uid("ivy"), uid("sofia")], "Third Shot Drop");
  await publishEvent(deps, mlp);

  // ----- 5. Team league in progress (the demo player and Priya) -----
  const team = await createEvent(deps, as("ana"), {
    kind: "league", style: "round_robin", format: "doubles", name: "Tuesday Team League", clubId: club.id,
    description: "Fixed doubles teams, one match a week.",
    startDate: day(-8), weeks: 3, venue: "Sample Community Courts", city: "Round Rock", state: "TX", lat: 30.51, lng: -97.67,
    capacity: 8, feeCents: 0,
  });
  await entry(team, [DEMO_USER_ID, uid("priya")]);
  await entry(team, [uid("ben"), uid("kara")]);
  await entry(team, [uid("luis"), uid("emma")]);
  await entry(team, [uid("noah"), uid("sofia")]);
  await publishEvent(deps, team);
  const teamMatches = await generateSchedule(deps, (await d.events.get(team.id))!);
  for (const m of teamMatches.filter((x) => x.round === 1)) await reportScore(deps, m.id, uid("ana"), { games: [scoreFor(m.homePlayers, m.awayPlayers)] });

  await notify(deps, [DEMO_USER_ID], { kind: "welcome", title: "Welcome to PickleHeat", body: "Connect DUPR, check your Round 4 heat chat, and confirm the score your opponent reported.", link: `events/${ladder.id}` });
}
