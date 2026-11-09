// Scores: report, confirm, corrections, bracket advancement, playoffs, DUPR upload.

import { dreamBreaker, linesOutcome } from "../domain/lines";
import { standings, type Result } from "../domain/schedule";
import { db } from "../db";
import { HttpError } from "../http";
import type { Deps, Line, Match, PickleHeatEvent } from "../ports";
import { removeFromDupr, uploadMatch } from "./duprSync";
import { advanceBracket, buildPlayoffs, isIndividual } from "./events";
import { canManage, playerInfo } from "./people";
import { notify } from "./social";

function validGames(games: unknown, max: number): { us: number; them: number }[] {
  if (!Array.isArray(games) || games.length < 1 || games.length > max) throw new HttpError(422, `Enter 1 to ${max} game${max > 1 ? "s" : ""}`, "invalid");
  return games.map((g: any, i) => {
    const us = Number(g?.us), them = Number(g?.them);
    if (!Number.isInteger(us) || !Number.isInteger(them) || us < 0 || them < 0 || us > 99 || them > 99 || us === them) {
      throw new HttpError(422, `Game ${i + 1} needs two different whole-number scores`, "invalid");
    }
    return { us, them };
  });
}

/** "home" | "away" once decided, else null. */
export function matchWinner(ev: PickleHeatEvent, m: Match): "home" | "away" | null {
  if (m.lines?.length) return linesOutcome(ev.format, m.lines).winner;
  let h = 0, a = 0, ph = 0, pa = 0;
  for (const g of m.games) {
    ph += g.us;
    pa += g.them;
    if (g.us > g.them) h++;
    else if (g.them > g.us) a++;
  }
  if (!m.games.length) return null;
  if (h !== a) return h > a ? "home" : "away";
  return ph === pa ? null : ph > pa ? "home" : "away";
}

const sideOf = (m: Match, userId: string): "home" | "away" | null => (m.homePlayers.includes(userId) ? "home" : m.awayPlayers.includes(userId) ? "away" : null);

export async function requireMatch(deps: Deps, id: string): Promise<{ m: Match; ev: PickleHeatEvent }> {
  const m = await db(deps).matches.get(id);
  if (!m) throw new HttpError(404, "Match not found", "not_found");
  const ev = await db(deps).events.get(m.eventId);
  if (!ev) throw new HttpError(404, "Event not found", "not_found");
  return { m, ev };
}

export async function reportScore(deps: Deps, matchId: string, userId: string, body: { games?: unknown; lines?: unknown }): Promise<Match> {
  const { m, ev } = await requireMatch(deps, matchId);
  const manager = await canManage(deps, ev, userId);
  const side = sideOf(m, userId);
  if (!side && !manager) throw new HttpError(403, "Only players in this match or the organizer can enter scores", "forbidden");
  if (!m.homePlayers.length || !m.awayPlayers.length) throw new HttpError(409, "Both teams aren't known yet", "invalid");
  if (m.status === "confirmed") {
    if (!manager) throw new HttpError(409, "This score is already confirmed", "locked");
    if (m.bracket) throw new HttpError(409, "Bracket results can't be changed after they're confirmed", "locked");
  }
  let next: Match = { ...m };
  if (m.lines?.length) {
    const input = Array.isArray(body.lines) ? body.lines : null;
    if (!input || input.length < m.lines.length || input.length > m.lines.length + 1) throw new HttpError(422, `Enter scores for all ${m.lines.length} lines`, "invalid");
    const lines: Line[] = m.lines.map((l, i) => ({ ...l, games: validGames((input[i] as any)?.games, 3) }));
    const outcome = linesOutcome(ev.format, lines);
    if (outcome.needsDreamBreaker) {
      const extra = input[m.lines.length] as any;
      const db_ = dreamBreaker(m.homePlayers, m.awayPlayers);
      if (extra?.games) lines.push({ ...db_, games: validGames(extra.games, 1) });
      else {
        lines.push({ ...db_, games: [] });
        next = { ...next, lines, status: "scheduled", reportedBy: userId };
        await db(deps).matches.put(next);
        return next; // tied 2–2: play the DreamBreaker, then report again
      }
    }
    next.lines = lines;
  } else {
    next.games = validGames(body.games, isIndividual(ev) ? ev.gamesPerMatch : Math.max(ev.gamesPerMatch, 3));
  }
  next = { ...next, status: manager ? "confirmed" : "reported", reportedBy: userId, confirmedBy: manager ? userId : null };
  if (m.status === "confirmed" && m.duprMatchId) next = await removeFromDupr(deps, next);
  await db(deps).matches.put(next);
  if (next.status === "confirmed") return onConfirmed(deps, ev, next);
  const opponents = side === "home" ? m.awayPlayers : m.homePlayers;
  const name = (await playerInfo(deps, [userId]))[userId].name;
  await notify(deps, opponents, { kind: "confirm_score", title: "Confirm a score", body: `${name} reported ${scoreText(next)} in ${ev.name}.`, link: `events/${ev.id}` });
  return next;
}

export function scoreText(m: Match): string {
  if (m.lines?.length) return m.lines.map((l) => l.games.map((g) => `${g.us}-${g.them}`).join(" ")).join(" · ");
  return m.games.map((g) => `${g.us}-${g.them}`).join(", ");
}

export async function confirmScore(deps: Deps, matchId: string, userId: string): Promise<Match> {
  const { m, ev } = await requireMatch(deps, matchId);
  if (m.status !== "reported" || !m.reportedBy) throw new HttpError(409, "There's no reported score to confirm", "invalid");
  const manager = await canManage(deps, ev, userId);
  const side = sideOf(m, userId);
  if (!manager && (!side || side === sideOf(m, m.reportedBy))) throw new HttpError(403, "The other team confirms the score", "forbidden");
  const c: Match = { ...m, status: "confirmed", confirmedBy: userId };
  await db(deps).matches.put(c);
  return onConfirmed(deps, ev, c);
}

async function onConfirmed(deps: Deps, ev: PickleHeatEvent, m: Match): Promise<Match> {
  if (m.bracket) {
    const w = matchWinner(ev, m);
    const winnerEntry = w === "home" ? m.homeEntryId : w === "away" ? m.awayEntryId : null;
    if (winnerEntry) await advanceBracket(deps, ev, m, winnerEntry);
  }
  const uploaded = await uploadMatch(deps, ev, m);
  if (!isIndividual(ev)) await afterTeamResult(deps, ev);
  return uploaded;
}

/** Team-style results for standings: each line counts as one game. */
export function teamResults(matches: Match[]): Result[] {
  return matches
    .filter((m) => m.status === "confirmed" && m.homeEntryId && m.awayEntryId && (m.games.length || m.lines?.some((l) => l.games.length)))
    .map((m) => ({
      home: m.homeEntryId!,
      away: m.awayEntryId!,
      games: m.lines?.length
        ? m.lines.filter((l) => l.games.length).map((l) => l.games.reduce((s, g) => ({ home: s.home + g.us, away: s.away + g.them }), { home: 0, away: 0 }))
        : m.games.map((g) => ({ home: g.us, away: g.them })),
    }));
}

async function afterTeamResult(deps: Deps, ev: PickleHeatEvent): Promise<void> {
  const all = await db(deps).matches.find({ eventId: ev.id });
  const poolMatches = all.filter((m) => !m.bracket);
  if (ev.style === "pools_playoffs" && poolMatches.length && poolMatches.every((m) => m.status === "confirmed") && !all.some((m) => m.bracket)) {
    const pools = [...new Set(poolMatches.map((m) => m.pool ?? 1))].sort((a, b) => a - b);
    const qualifiers: { id: string; wins: number; diff: number }[] = [];
    for (const p of pools) {
      const ms = poolMatches.filter((m) => (m.pool ?? 1) === p);
      const ids = [...new Set(ms.flatMap((m) => [m.homeEntryId!, m.awayEntryId!]))];
      const table = standings(ids, teamResults(ms));
      qualifiers.push(...table.slice(0, pools.length === 1 ? 4 : 2).map((r) => ({ id: r.entrant, wins: r.wins, diff: r.diff })));
    }
    qualifiers.sort((a, b) => b.wins - a.wins || b.diff - a.diff);
    await buildPlayoffs(deps, ev, qualifiers.map((q) => q.id));
    const ids = (await db(deps).entries.find({ eventId: ev.id, status: "confirmed" })).flatMap((e) => e.playerIds);
    await notify(deps, ids, { kind: "playoffs", title: "Playoffs are set", body: `${ev.name}: check the bracket.`, link: `events/${ev.id}` });
    return;
  }
  const fresh = await db(deps).matches.find({ eventId: ev.id });
  const live = fresh.filter((m) => !(m.homeDead && m.awayDead));
  if (live.length && live.every((m) => m.status === "confirmed")) await db(deps).events.put({ ...ev, status: "completed" });
}
