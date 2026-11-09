// What the apps read: the signed-in player, event pages, event cards, live matches, discover.

import { formScore } from "../domain/form";
import { distanceMiles } from "../domain/recommend";
import { standings, type Standing } from "../domain/schedule";
import { db } from "../db";
import type { Club, Deps, Entry, EntryStatus, Invite, Match, PickleHeatEvent, Round, User } from "../ports";
import { isIndividual, priceFor } from "./events";
import { teamResults } from "./matches";
import { canManage, clubSummary, playerInfo, type ClubSummary, type PlayerInfo } from "./people";
import { unreadCounts } from "./social";

export async function meView(deps: Deps, user: User) {
  const link = await db(deps).dupr.get(user.id);
  const payout = await db(deps).payouts.get(user.id);
  const history = link ? (await db(deps).history.get(user.id))?.matches ?? [] : [];
  const form = formScore(history);
  return {
    user: { id: user.id, email: user.email, name: user.name, gender: user.gender, lat: user.lat, lng: user.lng, maxDistanceMiles: user.maxDistanceMiles, formats: user.formats },
    dupr: link
      ? { connected: true, duprId: link.duprId, doublesRating: link.doublesRating, singlesRating: link.singlesRating, doublesReliability: link.doublesReliability, ratingUpdatedAt: link.ratingUpdatedAt, matchesSyncedAt: link.matchesSyncedAt }
      : { connected: false, duprId: null, doublesRating: null, singlesRating: null, doublesReliability: null, ratingUpdatedAt: null, matchesSyncedAt: null },
    form: form ? { score: form.score, label: form.label, previousScore: form.previousScore } : null,
    payouts: { linked: !!payout, ready: !!payout?.chargesEnabled },
    unread: await unreadCounts(deps, user.id),
  };
}

export interface EventCard {
  event: PickleHeatEvent;
  clubName: string | null;
  entryCount: number;
  waitlistCount: number;
  myStatus: EntryStatus | null;
  myPriceCents: number;
  distanceMiles: number | null;
}

export async function eventCard(deps: Deps, ev: PickleHeatEvent, user: User): Promise<EventCard> {
  const entries = await db(deps).entries.find({ eventId: ev.id });
  const mine = entries.find((e) => e.playerIds.includes(user.id) && e.status !== "withdrawn" && e.status !== "refunded");
  const club = ev.clubId ? await db(deps).clubs.get(ev.clubId) : null;
  return {
    event: ev,
    clubName: club?.name ?? null,
    entryCount: entries.filter((e) => e.status === "confirmed" || e.status === "pending_payment").length,
    waitlistCount: entries.filter((e) => e.status === "waitlisted").length,
    myStatus: mine?.status ?? null,
    myPriceCents: await priceFor(deps, ev, user.id),
    distanceMiles: user.lat != null && user.lng != null && ev.lat != null && ev.lng != null ? Math.round(distanceMiles(user.lat, user.lng, ev.lat, ev.lng)) : null,
  };
}

export async function cards(deps: Deps, events: PickleHeatEvent[], user: User): Promise<EventCard[]> {
  const out: EventCard[] = [];
  for (const e of events) out.push(await eventCard(deps, e, user));
  return out.sort((a, b) => a.event.startDate.localeCompare(b.event.startDate));
}

export async function myEvents(deps: Deps, user: User): Promise<PickleHeatEvent[]> {
  const entryEvents = (await db(deps).entries.find({ playerIds: [user.id] })).filter((e) => e.status !== "withdrawn" && e.status !== "refunded").map((e) => e.eventId);
  const organizing = (await db(deps).events.find({ organizerId: user.id })).map((e) => e.id);
  const clubs = (await db(deps).members.find({ userId: user.id })).filter((m) => m.role !== "member").map((m) => m.clubId);
  const clubEvents: string[] = [];
  for (const c of clubs) clubEvents.push(...(await db(deps).events.find({ clubId: c })).map((e) => e.id));
  const ids = [...new Set([...entryEvents, ...organizing, ...clubEvents])];
  const out: PickleHeatEvent[] = [];
  for (const id of ids) {
    const e = await db(deps).events.get(id);
    if (e) out.push(e);
  }
  return out;
}

export interface EventDetail {
  event: PickleHeatEvent;
  club: { id: string; name: string } | null;
  isManager: boolean;
  myEntry: Entry | null;
  myPriceCents: number;
  entries: Entry[];
  waitlist: Entry[];
  players: Record<string, PlayerInfo>;
  matches: Match[];
  standings: { pool: number | null; table: Standing[] }[];
  rounds: Round[];
  currentRoundId: string | null;
  chatId: string | null;
  money: { collectedCents: number; paidEntries: number; pendingEntries: number } | null;
  invites: Invite[];
}

export async function eventDetail(deps: Deps, ev: PickleHeatEvent, user: User): Promise<EventDetail> {
  const entriesAll = (await db(deps).entries.find({ eventId: ev.id })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const manager = await canManage(deps, ev, user.id);
  const entries = entriesAll.filter((e) => e.status === "confirmed" || e.status === "pending_payment");
  const waitlist = entriesAll.filter((e) => e.status === "waitlisted");
  const myEntry = entriesAll.find((e) => e.playerIds.includes(user.id) && e.status !== "withdrawn" && e.status !== "refunded") ?? null;
  const individual = isIndividual(ev);
  const matches = individual ? [] : (await db(deps).matches.find({ eventId: ev.id })).filter((m) => !(m.homeDead && m.awayDead)).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const pools = [...new Set(matches.filter((m) => !m.bracket).map((m) => m.pool))];
  const table = pools.map((pool) => {
    const ms = matches.filter((m) => !m.bracket && m.pool === pool);
    const ids = [...new Set(ms.flatMap((m) => [m.homeEntryId!, m.awayEntryId!]))];
    return { pool, table: standings(ids, teamResults(ms)) };
  });
  const rounds = individual ? (await db(deps).rounds.find({ eventId: ev.id })).sort((a, b) => a.number - b.number).map((r) => ({ ...r, ranking: null })) : [];
  const chat = (await db(deps).chats.find({ eventId: ev.id, kind: "event" }))[0];
  let money: EventDetail["money"] = null;
  if (manager) {
    const pays = await db(deps).payments.find({ eventId: ev.id });
    money = {
      collectedCents: pays.filter((p) => p.status === "paid").reduce((s, p) => s + p.amountCents - p.applicationFeeCents, 0),
      paidEntries: pays.filter((p) => p.status === "paid").length,
      pendingEntries: entries.filter((e) => e.status === "pending_payment").length,
    };
  }
  const club = ev.clubId ? await db(deps).clubs.get(ev.clubId) : null;
  return {
    event: ev,
    club: club ? { id: club.id, name: club.name } : null,
    isManager: manager,
    myEntry,
    myPriceCents: await priceFor(deps, ev, user.id),
    entries,
    waitlist,
    players: await playerInfo(deps, [ev.organizerId, ...entriesAll.flatMap((e) => e.playerIds), ...matches.flatMap((m) => [...m.homePlayers, ...m.awayPlayers])]),
    matches,
    standings: table,
    rounds,
    currentRoundId: rounds.find((r) => r.status === "in_progress")?.id ?? rounds.find((r) => r.status === "upcoming")?.id ?? rounds[rounds.length - 1]?.id ?? null,
    chatId: chat && chat.memberIds.includes(user.id) ? chat.id : null,
    money,
    invites: manager ? await db(deps).invites.find({ eventId: ev.id }) : [],
  };
}

function sortKey(m: Match): string {
  const side = m.bracket ? { W: "1", L: "2", GF: "3" }[m.bracket.side] : "0";
  return `${side}-${String(m.round).padStart(3, "0")}-${String(m.pool ?? 0).padStart(3, "0")}-${String(m.bracket?.slot ?? 0).padStart(3, "0")}-${m.id}`;
}

export interface LiveItem {
  eventId: string;
  eventName: string;
  roundNumber: number | null;
  groupNumber: number | null;
  chatId: string | null;
  match: Match;
  needsMyConfirmation: boolean;
}

/** Matches I still have to play or confirm, across all my events. */
export async function liveMatches(deps: Deps, user: User): Promise<{ items: LiveItem[]; players: Record<string, PlayerInfo> }> {
  const items: LiveItem[] = [];
  const mine = [...(await db(deps).matches.find({ homePlayers: [user.id] })), ...(await db(deps).matches.find({ awayPlayers: [user.id] }))];
  for (const m of mine) {
    if (m.status === "confirmed") continue;
    const ev = await db(deps).events.get(m.eventId);
    if (!ev || ev.status === "completed") continue;
    let roundNumber: number | null = null, groupNumber: number | null = null, chatId: string | null = null;
    if (m.roundId) {
      const r = await db(deps).rounds.get(m.roundId);
      if (r?.status !== "in_progress") continue;
      roundNumber = r.number;
      const g = m.groupId ? await db(deps).groups.get(m.groupId) : null;
      groupNumber = g?.number ?? null;
      chatId = g?.chatId ?? null;
    }
    const mySide = m.homePlayers.includes(user.id) ? "home" : "away";
    const reporterSide = m.reportedBy ? (m.homePlayers.includes(m.reportedBy) ? "home" : "away") : null;
    items.push({ eventId: ev.id, eventName: ev.name, roundNumber, groupNumber, chatId, match: m, needsMyConfirmation: m.status === "reported" && reporterSide !== mySide });
  }
  items.sort((a, b) => Number(b.needsMyConfirmation) - Number(a.needsMyConfirmation) || a.match.id.localeCompare(b.match.id));
  return { items, players: await playerInfo(deps, items.flatMap((i) => [...i.match.homePlayers, ...i.match.awayPlayers])) };
}

export async function discover(deps: Deps, user: User): Promise<{ events: EventCard[]; clubs: ClubSummary[] }> {
  const open = await db(deps).events.find({ status: "open" });
  const evCards = (await cards(deps, open, user)).filter((c) => c.distanceMiles == null || c.distanceMiles <= user.maxDistanceMiles).sort((a, b) => (a.distanceMiles ?? 1e9) - (b.distanceMiles ?? 1e9));
  const clubs: ClubSummary[] = [];
  for (const c of await db(deps).clubs.find({})) clubs.push(await clubSummary(deps, c, user.id, user));
  clubs.sort((a, b) => (a.distanceMiles ?? 1e9) - (b.distanceMiles ?? 1e9));
  return { events: evCards.slice(0, 50), clubs: clubs.slice(0, 50) };
}

export async function clubDetail(deps: Deps, club: Club, user: User) {
  const members = await db(deps).members.find({ clubId: club.id });
  const players = await playerInfo(deps, members.map((m) => m.userId));
  const events = (await db(deps).events.find({ clubId: club.id })).filter((e) => e.status !== "draft" || members.some((m) => m.userId === user.id && m.role !== "member"));
  const chat = (await db(deps).chats.find({ clubId: club.id, kind: "club" }))[0];
  return {
    summary: await clubSummary(deps, club, user.id, user),
    members: members.map((m) => ({ userId: m.userId, role: m.role, joinedAt: m.joinedAt })).sort((a, b) => roleOrder(a.role) - roleOrder(b.role) || (players[a.userId]?.name ?? "").localeCompare(players[b.userId]?.name ?? "")),
    players,
    events: await cards(deps, events, user),
    chatId: chat && chat.memberIds.includes(user.id) ? chat.id : null,
  };
}

const roleOrder = (r: string) => (r === "owner" ? 0 : r === "admin" ? 1 : 2);
