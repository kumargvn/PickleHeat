// Heat Climb (internally "flex_ladder") and Wildfire Mixer ("scramble"): rounds, heats, attendance, subs, rankings, stats.

import { formGroups, nextLadder, rotation, scrambleOrder, seededShuffle, type GameResult } from "../domain/ladder";
import { matchTags, playerStats, type MatchTag, type StatRow } from "../domain/stats";
import { db } from "../db";
import { HttpError } from "../http";
import type { Attendance, Deps, Match, PickleHeatEvent, PlayGroup, RankRow, Round, SubRequest } from "../ports";
import { uploadMatch } from "./duprSync";
import { isIndividual } from "./events";
import { canManage, clubRole, playerInfo, ratingOf, requireManager, type PlayerInfo } from "./people";
import { addChatMembers, createChat, notify, postMessage, removeChatMember } from "./social";

export async function requireRound(deps: Deps, id: string): Promise<Round> {
  const r = await db(deps).rounds.get(id);
  if (!r) throw new HttpError(404, "Round not found", "not_found");
  return r;
}

async function confirmedPlayers(deps: Deps, ev: PickleHeatEvent): Promise<string[]> {
  return (await db(deps).entries.find({ eventId: ev.id, status: "confirmed" })).flatMap((e) => e.playerIds);
}

/** Every confirmed game in a set of matches, one result per line (team formats) or per match. */
export function resultsOf(matches: Match[]): GameResult[] {
  const out: GameResult[] = [];
  for (const m of matches) {
    if (m.status !== "confirmed") continue;
    if (m.lines?.length) for (const l of m.lines) out.push({ home: l.homePlayers, away: l.awayPlayers, games: l.games });
    else if (m.games.length) out.push({ home: m.homePlayers, away: m.awayPlayers, games: m.games });
  }
  return out;
}

export async function startRound(deps: Deps, ev: PickleHeatEvent, actorId: string): Promise<Round> {
  await requireManager(deps, ev, actorId);
  if (!isIndividual(ev)) throw new HttpError(409, "Only Heat Climb and Wildfire Mixer leagues have rounds", "invalid");
  const rounds = (await db(deps).rounds.find({ eventId: ev.id })).sort((a, b) => a.number - b.number);
  const running = rounds.find((r) => r.status === "in_progress");
  if (running) await closeRound(deps, running, actorId);
  const round = rounds.find((r) => r.status === "upcoming");
  if (!round) throw new HttpError(409, "Every round has been played", "done");

  let fresh = (await db(deps).events.get(ev.id))!;
  const entrants = await confirmedPlayers(deps, fresh);
  if (round.number === 1 || !fresh.ladder.length) {
    const ratings = new Map<string, number>();
    for (const p of entrants) ratings.set(p, (await ratingOf(deps, p)) ?? 0);
    fresh = { ...fresh, ladder: [...entrants].sort((a, b) => (ratings.get(b) ?? 0) - (ratings.get(a) ?? 0)) };
  } else {
    fresh = { ...fresh, ladder: [...fresh.ladder.filter((p) => entrants.includes(p)), ...entrants.filter((p) => !fresh.ladder.includes(p))] };
  }
  await db(deps).events.put({ ...fresh, status: "in_progress" });

  const declined = new Set((await db(deps).attendance.find({ roundId: round.id, status: "declined" })).map((a) => a.userId));
  const available = fresh.ladder.filter((p) => !declined.has(p));
  const ordered = ev.style === "scramble" ? seededShuffle(available, round.number * 7919 + [...ev.id].reduce((s, c) => s + c.charCodeAt(0), 0)) : available;
  const { groups, byes } = formGroups(ordered);
  if (!groups.length) throw new HttpError(409, "Need at least 4 available players to start a round (one heat)", "too_few");

  const info = await playerInfo(deps, available);
  const start = `${round.startDate}T12:00:00Z`;
  for (const [gi, players] of groups.entries()) {
    const groupId = `${round.id}-g${gi + 1}`;
    const chat = await createChat(deps, { kind: "group", title: `Round ${round.number} · Heat ${gi + 1}`, memberIds: players, eventId: ev.id, groupId });
    const group: PlayGroup = { id: groupId, eventId: ev.id, roundId: round.id, number: gi + 1, playerIds: players, chatId: chat.id };
    await db(deps).groups.put(group);
    for (const [mi, pair] of rotation(players).entries()) {
      const m: Match = {
        id: `${groupId}-m${mi + 1}`, eventId: ev.id, roundId: round.id, groupId, round: round.number, pool: gi + 1, bracket: null,
        label: `Match ${mi + 1}`, homeEntryId: null, awayEntryId: null, homePlayers: [...pair.home], awayPlayers: [...pair.away],
        homeDead: false, awayDead: false, winnerTo: null, loserTo: null, scheduledAt: start, court: null, games: [], lines: null,
        status: "scheduled", reportedBy: null, confirmedBy: null, duprMatchId: null, duprSyncedAt: null, duprError: null,
      };
      await db(deps).matches.put(m);
    }
    await postMessage(deps, chat.id, null, `Hey all, you're in the same heat for Round ${round.number} of ${ev.name}. Use this chat to coordinate a time & place to play! Games: ${players.length === 4 ? 3 : 5} matches × ${ev.gamesPerMatch} game${ev.gamesPerMatch > 1 ? "s" : ""}, rotating partners.`);
    await notify(deps, players, { kind: "grouped", title: `Round ${round.number}: you're in Heat ${gi + 1}`, body: players.map((p) => info[p].name.split(" ")[0]).join(", "), link: `chats/${chat.id}` });
  }
  if (byes.length) await notify(deps, byes, { kind: "bye", title: `Round ${round.number}: you sit out`, body: "The player count didn't split into heats this round. You keep your spot.", link: `events/${ev.id}` });
  const started: Round = { ...round, status: "in_progress", byes };
  await db(deps).rounds.put(started);
  return started;
}

export async function closeRound(deps: Deps, round: Round, actorId: string): Promise<Round> {
  const ev = (await db(deps).events.get(round.eventId))!;
  await requireManager(deps, ev, actorId);
  if (round.status !== "in_progress") throw new HttpError(409, "This round isn't in progress", "invalid");
  // Reported scores count when the round closes.
  const matches = await db(deps).matches.find({ roundId: round.id });
  for (const m of matches) {
    if (m.status !== "reported") continue;
    const c = { ...m, status: "confirmed" as const, confirmedBy: actorId };
    await db(deps).matches.put(c);
    await uploadMatch(deps, ev, c);
  }
  const final = await db(deps).matches.find({ roundId: round.id });
  const groups = (await db(deps).groups.find({ roundId: round.id })).sort((a, b) => a.number - b.number);
  const subs = (await db(deps).subs.find({ roundId: round.id, status: "filled" }));
  // For ranking, a sub plays in place of the player they covered; that player counts as absent.
  const covered = new Map(subs.map((s) => [s.subUserId!, s.userId]));
  const rankGroups = groups.map((g) => g.playerIds.map((p) => covered.get(p) ?? p));
  const absent = new Set(subs.map((s) => s.userId));
  const results = resultsOf(final);
  let ranking: RankRow[];
  if (ev.style === "flex_ladder") {
    const r = nextLadder(ev.ladder, rankGroups, round.byes, results, absent);
    ranking = r.rows;
    await db(deps).events.put({ ...ev, ladder: r.order });
  } else {
    const all = resultsOf(await db(deps).matches.find({ eventId: ev.id }));
    const order = scrambleOrder(ev.ladder, all);
    const t = playerStats(all);
    const prevRanks = new Map((await previousRanking(deps, ev, round.number))?.map((x) => [x.userId, x.rank]) ?? []);
    ranking = order.map((userId, i) => {
      const s = t.find((x) => x.userId === userId);
      return { userId, rank: i + 1, prevRank: prevRanks.get(userId) ?? null, fromGroup: groups.find((g) => g.playerIds.includes(userId))?.number ?? null, nextGroup: null, wins: s?.wins ?? 0, losses: s?.losses ?? 0, pd: s?.pd ?? 0, played: !!groups.find((g) => g.playerIds.includes(userId)) };
    });
    await db(deps).events.put({ ...ev, ladder: order });
  }
  const closed: Round = { ...round, status: "completed", ranking };
  await db(deps).rounds.put(closed);
  const left = (await db(deps).rounds.find({ eventId: ev.id, status: "upcoming" })).length;
  if (!left) await db(deps).events.put({ ...((await db(deps).events.get(ev.id))!), status: "completed" });
  await notify(deps, rankGroups.flat(), { kind: "round_closed", title: `Round ${round.number} results are in`, body: `See where you landed in ${ev.name}.`, link: `events/${ev.id}` });
  return closed;
}

async function previousRanking(deps: Deps, ev: PickleHeatEvent, beforeNumber: number): Promise<RankRow[] | null> {
  const done = (await db(deps).rounds.find({ eventId: ev.id, status: "completed" })).filter((r) => r.number < beforeNumber).sort((a, b) => b.number - a.number);
  return done[0]?.ranking ?? null;
}

export async function setAttendance(deps: Deps, round: Round, userId: string, status: "confirmed" | "declined"): Promise<Attendance> {
  if (round.status !== "upcoming") throw new HttpError(409, "Heats are already set for this round. Request a sub instead.", "locked");
  const ev = (await db(deps).events.get(round.eventId))!;
  if (!(await confirmedPlayers(deps, ev)).includes(userId)) throw new HttpError(403, "You're not in this league", "forbidden");
  const a: Attendance = { id: `${round.id}:${userId}`, roundId: round.id, eventId: round.eventId, userId, status };
  await db(deps).attendance.put(a);
  return a;
}

export async function requestSub(deps: Deps, round: Round, userId: string): Promise<SubRequest> {
  if (round.status !== "in_progress") throw new HttpError(409, "Subs are for rounds in progress", "invalid");
  const group = (await db(deps).groups.find({ roundId: round.id, playerIds: [userId] }))[0];
  if (!group) throw new HttpError(403, "You're not playing in this round", "forbidden");
  const open = (await db(deps).subs.find({ roundId: round.id, userId })).find((s) => s.status === "open");
  if (open) return open;
  const ev = (await db(deps).events.get(round.eventId))!;
  const req: SubRequest = { id: deps.newId(), eventId: ev.id, roundId: round.id, groupId: group.id, userId, status: "open", subUserId: null, createdAt: deps.now().toISOString() };
  await db(deps).subs.put(req);
  const playing = new Set((await db(deps).groups.find({ roundId: round.id })).flatMap((g) => g.playerIds));
  const candidates = (await confirmedPlayers(deps, ev)).filter((p) => !playing.has(p));
  const name = (await playerInfo(deps, [userId]))[userId].name;
  await notify(deps, candidates, { kind: "sub_needed", title: "Sub needed", body: `${name} needs a sub for Round ${round.number}, Heat ${group.number} of ${ev.name}.`, link: `events/${ev.id}` });
  await postMessage(deps, group.chatId, null, `${name} asked for a sub. Anyone not playing this round can tap "Sub in" on the league page.`);
  return req;
}

export async function cancelSub(deps: Deps, subId: string, userId: string): Promise<SubRequest> {
  const s = await db(deps).subs.get(subId);
  if (!s || s.userId !== userId) throw new HttpError(404, "Sub request not found", "not_found");
  if (s.status !== "open") throw new HttpError(409, "Already filled", "invalid");
  const c = { ...s, status: "cancelled" as const };
  await db(deps).subs.put(c);
  return c;
}

export async function acceptSub(deps: Deps, subId: string, userId: string): Promise<SubRequest> {
  const s = await db(deps).subs.get(subId);
  if (!s || s.status !== "open") throw new HttpError(409, "This sub spot is no longer open", "invalid");
  const ev = (await db(deps).events.get(s.eventId))!;
  const round = await requireRound(deps, s.roundId);
  const groups = await db(deps).groups.find({ roundId: round.id });
  if (groups.some((g) => g.playerIds.includes(userId))) throw new HttpError(409, "You're already playing this round", "invalid");
  const inLeague = (await confirmedPlayers(deps, ev)).includes(userId);
  const inClub = !!(await clubRole(deps, ev.clubId, userId));
  if (!inLeague && !inClub) throw new HttpError(403, "Subs must be in this league or its club", "forbidden");
  const group = groups.find((g) => g.id === s.groupId)!;
  await db(deps).groups.put({ ...group, playerIds: group.playerIds.map((p) => (p === s.userId ? userId : p)) });
  for (const m of await db(deps).matches.find({ groupId: group.id, status: "scheduled" })) {
    const swap = (ids: string[]) => ids.map((p) => (p === s.userId ? userId : p));
    await db(deps).matches.put({ ...m, homePlayers: swap(m.homePlayers), awayPlayers: swap(m.awayPlayers) });
  }
  await removeChatMember(deps, group.chatId, s.userId);
  await addChatMembers(deps, group.chatId, [userId]);
  const filled = { ...s, status: "filled" as const, subUserId: userId };
  await db(deps).subs.put(filled);
  const names = await playerInfo(deps, [userId, s.userId]);
  await postMessage(deps, group.chatId, null, `${names[userId].name} is subbing in for ${names[s.userId].name}.`);
  await notify(deps, [s.userId], { kind: "sub_filled", title: "Your sub is set", body: `${names[userId].name} is covering Round ${round.number} for you.`, link: `events/${ev.id}` });
  return filled;
}

// ---------- views ----------

export interface GroupView {
  group: PlayGroup;
  matches: Match[];
  standings: StatRow[];
}

export interface RoundView {
  round: Round;
  groups: GroupView[];
  myGroupId: string | null;
  myAttendance: "confirmed" | "declined" | null;
  subs: SubRequest[];
  tags: Record<string, MatchTag[]>;
  players: Record<string, PlayerInfo>;
}

export async function roundView(deps: Deps, round: Round, userId: string): Promise<RoundView> {
  const ev = (await db(deps).events.get(round.eventId))!;
  const groups = (await db(deps).groups.find({ roundId: round.id })).sort((a, b) => a.number - b.number);
  const matches = await db(deps).matches.find({ roundId: round.id });
  const subs = (await db(deps).subs.find({ roundId: round.id })).filter((s) => s.status !== "cancelled");
  const ids = new Set([...groups.flatMap((g) => g.playerIds), ...subs.flatMap((s) => [s.userId, s.subUserId ?? s.userId]), ...round.byes]);
  if (round.status === "upcoming") for (const p of await confirmedPlayers(deps, ev)) ids.add(p);
  const players = await playerInfo(deps, ids);
  const tags: Record<string, MatchTag[]> = {};
  for (const m of matches) {
    const t = resultsOf([m])[0];
    if (t) tags[m.id] = matchTags(t, (id) => players[id]?.rating ?? null);
  }
  const att = await db(deps).attendance.get(`${round.id}:${userId}`);
  const inLeague = (await confirmedPlayers(deps, ev)).includes(userId);
  return {
    round,
    groups: groups.map((g) => {
      const ms = matches.filter((m) => m.groupId === g.id).sort((a, b) => a.id.localeCompare(b.id));
      return { group: g, matches: ms, standings: playerStats(resultsOf(ms)) };
    }),
    myGroupId: groups.find((g) => g.playerIds.includes(userId))?.id ?? null,
    myAttendance: att?.status ?? (inLeague ? "confirmed" : null),
    subs,
    tags,
    players,
  };
}

export async function rankings(deps: Deps, ev: PickleHeatEvent, roundNumber?: number): Promise<{ round: number | null; rows: RankRow[]; players: Record<string, PlayerInfo> }> {
  const done = (await db(deps).rounds.find({ eventId: ev.id, status: "completed" })).sort((a, b) => b.number - a.number);
  const pick = roundNumber ? done.find((r) => r.number === roundNumber) : done[0];
  const rows: RankRow[] = pick?.ranking ?? ev.ladder.map((userId, i) => ({ userId, rank: i + 1, prevRank: null, fromGroup: null, nextGroup: null, wins: 0, losses: 0, pd: 0, played: false }));
  return { round: pick?.number ?? null, rows, players: await playerInfo(deps, rows.map((r) => r.userId)) };
}

export interface StatsView {
  rows: (StatRow & { ratingChange: number | null })[];
  tags: Record<string, MatchTag[]>;
  players: Record<string, PlayerInfo>;
}

/** Season stats. ratingChange compares today's DUPR with the rating when the player joined. */
export async function eventStats(deps: Deps, ev: PickleHeatEvent): Promise<StatsView> {
  const matches = await db(deps).matches.find({ eventId: ev.id });
  const results = resultsOf(matches);
  const rows = playerStats(results);
  const players = await playerInfo(deps, rows.map((r) => r.userId));
  const entries = await db(deps).entries.find({ eventId: ev.id });
  const tags: Record<string, MatchTag[]> = {};
  for (const m of matches) {
    const t = resultsOf([m])[0];
    if (t) tags[m.id] = matchTags(t, (id) => players[id]?.rating ?? null);
  }
  return {
    rows: rows.map((r) => {
      const e = entries.find((x) => x.playerIds.length === 1 && x.playerIds[0] === r.userId);
      const now = players[r.userId]?.rating;
      return { ...r, ratingChange: e?.teamRating != null && now != null ? Math.round((now - e.teamRating) * 1000) / 1000 : null };
    }),
    tags,
    players,
  };
}

export async function canViewRound(deps: Deps, round: Round, userId: string): Promise<boolean> {
  const ev = await db(deps).events.get(round.eventId);
  return !!ev && (ev.status !== "draft" || (await canManage(deps, ev, userId)));
}
