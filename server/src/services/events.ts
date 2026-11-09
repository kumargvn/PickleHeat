// Leagues and tournaments: create, publish, register (payment happens on the web), waitlists,
// refunds, and schedules for team styles (round robin, pools + playoffs, single/double elimination).

import { advance, buildBracket, resolve, type BNode } from "../domain/bracket";
import { lineTemplate, TEAM_SIZE, usesLines } from "../domain/lines";
import { roundRobin, snakePools } from "../domain/schedule";
import type { EventFormat } from "../domain/types";
import { db } from "../db";
import { HttpError, isoDate, numIn, oneOf, optNumIn, optStr, str } from "../http";
import { INDIVIDUAL_STYLES, type Deps, type Entry, type EventStyle, type Match, type Payment, type PickleHeatEvent, type User } from "../ports";
import { canManage, clubRole, playerInfo } from "./people";
import { addChatMembers, createChat, notify, removeChatMember } from "./social";

export const FORMATS = ["doubles", "mixed", "singles", "mlp", "trips"] as const;
export const STYLES = ["flex_ladder", "scramble", "round_robin", "pools_playoffs", "single_elim", "double_elim"] as const;

export const isIndividual = (ev: Pick<PickleHeatEvent, "style">) => INDIVIDUAL_STYLES.includes(ev.style);

export function platformFee(deps: Deps, amountCents: number): number {
  return Math.round((amountCents * deps.config.platformFeeBps) / 10_000);
}

export async function requireEvent(deps: Deps, id: string): Promise<PickleHeatEvent> {
  const e = await db(deps).events.get(id);
  if (!e) throw new HttpError(404, "Event not found", "not_found");
  return e;
}

// ---------- create / edit ----------

export async function eventFromBody(deps: Deps, b: any, organizerId: string, id: string, now: string, existing?: PickleHeatEvent): Promise<PickleHeatEvent> {
  const kind = oneOf(b.kind, "kind", ["league", "tournament"] as const);
  const style: EventStyle = b.style ? oneOf(b.style, "style", STYLES) : kind === "league" ? "round_robin" : "pools_playoffs";
  const format: EventFormat = oneOf(b.format ?? "doubles", "format", FORMATS);
  if (INDIVIDUAL_STYLES.includes(style) && format !== "doubles" && format !== "mixed") {
    throw new HttpError(422, "Heat Climb and Wildfire Mixer are doubles: players sign up alone and rotate partners", "invalid");
  }
  if (style === "flex_ladder" && kind !== "league") throw new HttpError(422, "A Heat Climb is a league", "invalid");
  const minRating = optNumIn(b.minRating, "minRating", 1, 8);
  const maxRating = optNumIn(b.maxRating, "maxRating", 1, 8);
  if (minRating != null && maxRating != null && minRating > maxRating) throw new HttpError(422, "Minimum DUPR is above maximum DUPR", "invalid");
  const clubId = b.clubId ? str(b.clubId, "clubId", 64) : null;
  if (clubId) {
    if (!(await db(deps).clubs.get(clubId))) throw new HttpError(404, "Club not found", "not_found");
    const role = await clubRole(deps, clubId, organizerId);
    if (role !== "owner" && role !== "admin" && existing?.clubId !== clubId) throw new HttpError(403, "Only club owners and admins can create club events", "forbidden");
  }
  const feeCents = Math.round(numIn(b.feeCents ?? 0, "feeCents", 0, 100_000));
  const memberFeeCents = b.memberFeeCents == null || b.memberFeeCents === "" ? null : Math.round(numIn(b.memberFeeCents, "memberFeeCents", 0, 100_000));
  return {
    id,
    organizerId,
    clubId,
    kind,
    style,
    name: str(b.name, "name", 80),
    description: optStr(b.description, "description", 2000) ?? "",
    format,
    startDate: isoDate(b.startDate, "startDate"),
    endDate: b.endDate ? isoDate(b.endDate, "endDate") : null,
    weeks: kind === "league" ? numIn(b.weeks ?? 8, "weeks", 1, 52) : null,
    roundDays: numIn(b.roundDays ?? 7, "roundDays", 1, 31),
    gamesPerMatch: numIn(b.gamesPerMatch ?? (INDIVIDUAL_STYLES.includes(style) ? 2 : 1), "gamesPerMatch", 1, 5),
    venue: optStr(b.venue, "venue", 120) ?? "",
    city: optStr(b.city, "city", 80) ?? "",
    state: optStr(b.state, "state", 40) ?? "",
    lat: optNumIn(b.lat, "lat", -90, 90),
    lng: optNumIn(b.lng, "lng", -180, 180),
    minRating,
    maxRating,
    capacity: numIn(b.capacity ?? 16, "capacity", 2, 512),
    feeCents,
    memberFeeCents: clubId ? memberFeeCents : null,
    currency: "usd",
    requireDuprVerified: b.requireDuprVerified !== false,
    submitToDupr: b.submitToDupr !== false,
    status: existing?.status ?? "draft",
    ladder: existing?.ladder ?? [],
    createdAt: now,
  };
}

export async function createEvent(deps: Deps, user: User, body: any): Promise<PickleHeatEvent> {
  const ev = await eventFromBody(deps, body, user.id, deps.newId(), deps.now().toISOString());
  await db(deps).events.put(ev);
  return ev;
}

export async function publishEvent(deps: Deps, ev: PickleHeatEvent): Promise<PickleHeatEvent> {
  if (ev.status !== "draft") return ev;
  if (ev.feeCents > 0 || (ev.memberFeeCents ?? 0) > 0) {
    const acct = await db(deps).payouts.get(ev.organizerId);
    const ready = acct && (acct.chargesEnabled || (await deps.payments.accountStatus(acct.providerAccountId)).chargesEnabled);
    if (!ready) throw new HttpError(409, "Set up payouts on the PickleHeat website before opening a paid event", "payouts_required");
  }
  const updated: PickleHeatEvent = { ...ev, status: "open" };
  await db(deps).events.put(updated);
  const confirmed = (await db(deps).entries.find({ eventId: ev.id, status: "confirmed" })).flatMap((e) => e.playerIds);
  await createChat(deps, { kind: "event", title: ev.name, memberIds: [ev.organizerId, ...confirmed], eventId: ev.id });
  if (isIndividual(ev) && ev.kind === "league") await createRounds(deps, updated);
  return updated;
}

/** Leagues with rounds: one round per `roundDays` for `weeks` rounds. */
export async function createRounds(deps: Deps, ev: PickleHeatEvent): Promise<void> {
  if ((await db(deps).rounds.find({ eventId: ev.id })).length) return;
  const start = Date.parse(`${ev.startDate}T00:00:00Z`);
  const n = ev.weeks ?? 8;
  for (let i = 0; i < n; i++) {
    const s = new Date(start + i * ev.roundDays * 86_400_000).toISOString().slice(0, 10);
    const e = new Date(start + (i + 1) * ev.roundDays * 86_400_000).toISOString().slice(0, 10);
    await db(deps).rounds.put({ id: `${ev.id}-r${i + 1}`, eventId: ev.id, number: i + 1, startDate: s, endDate: e, status: "upcoming", byes: [], ranking: null });
  }
}

// ---------- registration ----------

export async function priceFor(deps: Deps, ev: PickleHeatEvent, userId: string): Promise<number> {
  if (ev.clubId && ev.memberFeeCents != null && (await clubRole(deps, ev.clubId, userId))) return ev.memberFeeCents;
  return ev.feeCents;
}

const active = (e: Entry) => e.status === "confirmed" || e.status === "pending_payment";

async function onConfirmed(deps: Deps, ev: PickleHeatEvent, entry: Entry): Promise<void> {
  const chat = (await db(deps).chats.find({ eventId: ev.id, kind: "event" }))[0];
  if (chat) await addChatMembers(deps, chat.id, entry.playerIds);
  if (isIndividual(ev)) {
    const fresh = (await db(deps).events.get(ev.id)) ?? ev;
    const add = entry.playerIds.filter((p) => !fresh.ladder.includes(p));
    if (add.length) await db(deps).events.put({ ...fresh, ladder: [...fresh.ladder, ...add] });
  }
}

export interface RegisterResult {
  entry: Entry;
  amountCents: number;
  /** The app never takes payment: when true, finish on the web (see /v1/auth/handoff). */
  payOnWeb: boolean;
  checkoutUrl: string | null;
}

export async function register(deps: Deps, ev: PickleHeatEvent, user: User, partners: { userIds: string[]; duprIds: string[] }, teamName: string | null, client: "app" | "web"): Promise<RegisterResult> {
  if (ev.status !== "open") throw new HttpError(409, "Registration is not open", "closed");
  const size = isIndividual(ev) ? 1 : TEAM_SIZE[ev.format];
  const partnerIds = [...partners.userIds];
  for (const d of partners.duprIds) {
    const link = (await db(deps).dupr.find({ duprId: d.trim().toUpperCase() }))[0];
    if (!link) throw new HttpError(404, `No PickleHeat player has connected DUPR ID ${d.trim().toUpperCase()} yet`, "partner_not_found");
    partnerIds.push(link.userId);
  }
  const playerIds = [user.id, ...partnerIds];
  if (playerIds.length !== size) throw new HttpError(422, size === 1 ? "This event takes one player per entry" : `This event needs teams of ${size}: add ${size - 1} partner${size > 2 ? "s" : ""}`, "partner_required");
  if (new Set(playerIds).size !== playerIds.length) throw new HttpError(422, "Each player can only be on the team once", "invalid");

  const entries = await db(deps).entries.find({ eventId: ev.id });
  if (entries.some((e) => (active(e) || e.status === "waitlisted") && e.playerIds.some((p) => playerIds.includes(p)))) throw new HttpError(409, "Already registered", "duplicate");

  const info = await playerInfo(deps, playerIds);
  for (const id of playerIds) {
    const p = info[id];
    if (!(await db(deps).users.get(id))) throw new HttpError(404, "Partner not found", "not_found");
    if ((ev.requireDuprVerified || ev.submitToDupr) && !p.duprId) throw new HttpError(409, `${id === user.id ? "Connect your DUPR account" : `${p.name} needs to connect DUPR`} first`, "dupr_required");
    const r = ev.format === "singles" ? p.singlesRating ?? p.rating : p.rating;
    if (r != null && ((ev.minRating != null && r < ev.minRating - 0.0001) || (ev.maxRating != null && r > ev.maxRating + 0.0001))) {
      throw new HttpError(409, `${p.name}'s DUPR ${r.toFixed(2)} is outside this event's range`, "rating_out_of_range");
    }
  }
  const genders = playerIds.map((id) => info[id].gender);
  if (genders.every((g) => g)) {
    const men = genders.filter((g) => g === "m").length;
    if (ev.format === "mixed" && !isIndividual(ev) && men !== 1) throw new HttpError(422, "Mixed doubles teams need one man and one woman", "invalid");
    if (ev.format === "mlp" && men !== 2) throw new HttpError(422, "MLP teams need two men and two women", "invalid");
  }

  const ratings = playerIds.map((id) => (ev.format === "singles" ? info[id].singlesRating ?? info[id].rating : info[id].rating));
  const teamRating = ratings.every((r) => r != null) ? Math.round((ratings.reduce((a, b) => a! + b!, 0)! / ratings.length) * 1000) / 1000 : null;
  const full = entries.filter(active).length >= ev.capacity;
  let amount = 0;
  for (const id of playerIds) amount += await priceFor(deps, ev, id);

  const entry: Entry = {
    id: deps.newId(),
    eventId: ev.id,
    playerIds,
    teamName: teamName?.trim().slice(0, 60) || (size === 1 ? info[user.id].name : playerIds.map((id) => info[id].name.split(" ")[0]).join(" / ")),
    teamRating,
    status: full ? "waitlisted" : amount > 0 ? "pending_payment" : "confirmed",
    comped: false,
    createdAt: deps.now().toISOString(),
  };
  await db(deps).entries.put(entry);
  if (entry.status === "confirmed") await onConfirmed(deps, ev, entry);
  if (partnerIds.length) {
    await notify(deps, partnerIds, { kind: "registered", title: `${info[user.id].name} registered you`, body: `${ev.name}: team ${entry.teamName}${entry.status === "waitlisted" ? " (waitlist)" : ""}.`, link: `events/${ev.id}` });
  }
  const checkoutUrl = entry.status === "pending_payment" && client === "web" ? await startCheckout(deps, ev, entry, user) : null;
  return { entry, amountCents: entry.status === "waitlisted" ? 0 : amount, payOnWeb: entry.status === "pending_payment", checkoutUrl };
}

/** Stripe Checkout for an entry (web only). Money goes to the organizer's linked account. */
export async function startCheckout(deps: Deps, ev: PickleHeatEvent, entry: Entry, payer: User): Promise<string> {
  if (entry.status !== "pending_payment") throw new HttpError(409, "Nothing to pay for this entry", "invalid");
  const acct = await db(deps).payouts.get(ev.organizerId);
  if (!acct) throw new HttpError(409, "The organizer hasn't set up payouts yet", "payouts_required");
  let amount = 0;
  for (const id of entry.playerIds) amount += await priceFor(deps, ev, id);
  const paymentId = deps.newId();
  const back = `${deps.config.webAppUrl}#/events/${ev.id}`;
  const session = await deps.payments.createCheckout({
    amountCents: amount,
    applicationFeeCents: platformFee(deps, amount),
    currency: ev.currency,
    destinationAccountId: acct.providerAccountId,
    description: `${ev.name}: ${entry.teamName}`,
    successUrl: `${back}?paid=1`,
    cancelUrl: `${back}?paid=0`,
    metadata: { event_id: ev.id, entry_id: entry.id, payment_id: paymentId },
    customerEmail: payer.email,
  });
  const payment: Payment = { id: paymentId, entryId: entry.id, eventId: ev.id, userId: payer.id, amountCents: amount, applicationFeeCents: platformFee(deps, amount), currency: ev.currency, provider: deps.payments.name, providerRef: session.id, status: "pending", createdAt: deps.now().toISOString() };
  await db(deps).payments.put(payment);
  return session.url;
}

export async function markPaid(deps: Deps, providerRef: string): Promise<void> {
  const p = (await db(deps).payments.find({ providerRef }))[0];
  if (!p || p.status === "paid") return;
  await db(deps).payments.put({ ...p, status: "paid" });
  const e = await db(deps).entries.get(p.entryId);
  const ev = await db(deps).events.get(p.eventId);
  if (e && ev && e.status === "pending_payment") {
    const confirmed = { ...e, status: "confirmed" as const };
    await db(deps).entries.put(confirmed);
    await onConfirmed(deps, ev, confirmed);
    await notify(deps, e.playerIds, { kind: "paid", title: "You're registered", body: `${ev.name}: payment received.`, link: `events/${ev.id}` });
  }
}

export async function markFailed(deps: Deps, providerRef: string): Promise<void> {
  const p = (await db(deps).payments.find({ providerRef }))[0];
  if (p && p.status === "pending") await db(deps).payments.put({ ...p, status: "failed" });
}

/** Fills open spots from the waitlist, oldest first. */
export async function promoteWaitlist(deps: Deps, ev: PickleHeatEvent): Promise<void> {
  const entries = (await db(deps).entries.find({ eventId: ev.id })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let open = ev.capacity - entries.filter(active).length;
  for (const e of entries.filter((x) => x.status === "waitlisted")) {
    if (open <= 0) break;
    let amount = 0;
    if (!e.comped) for (const id of e.playerIds) amount += await priceFor(deps, ev, id);
    const next = { ...e, status: amount > 0 ? ("pending_payment" as const) : ("confirmed" as const) };
    await db(deps).entries.put(next);
    if (next.status === "confirmed") await onConfirmed(deps, ev, next);
    await notify(deps, e.playerIds, {
      kind: "waitlist",
      title: "A spot opened up",
      body: amount > 0 ? `${ev.name}: pay on the PickleHeat website to confirm your spot.` : `${ev.name}: you're off the waitlist and confirmed.`,
      link: amount > 0 ? `entries/${e.id}/pay` : `events/${ev.id}`,
    });
    open--;
  }
}

export async function withdraw(deps: Deps, ev: PickleHeatEvent, userId: string): Promise<Entry> {
  const entry = (await db(deps).entries.find({ eventId: ev.id, playerIds: [userId] })).find((e) => active(e) || e.status === "waitlisted");
  if (!entry) throw new HttpError(404, "You're not registered", "not_found");
  const updated = { ...entry, status: "withdrawn" as const };
  await db(deps).entries.put(updated);
  const chat = (await db(deps).chats.find({ eventId: ev.id, kind: "event" }))[0];
  if (chat) for (const p of entry.playerIds) if (p !== ev.organizerId) await removeChatMember(deps, chat.id, p);
  if (isIndividual(ev)) await db(deps).events.put({ ...((await db(deps).events.get(ev.id)) ?? ev), ladder: ev.ladder.filter((p) => !entry.playerIds.includes(p)) });
  await promoteWaitlist(deps, ev);
  return updated;
}

export async function refundEntry(deps: Deps, ev: PickleHeatEvent, entryId: string): Promise<Entry> {
  const entry = await db(deps).entries.get(entryId);
  if (!entry || entry.eventId !== ev.id) throw new HttpError(404, "Entry not found", "not_found");
  const payment = (await db(deps).payments.find({ entryId: entry.id, status: "paid" }))[0];
  if (payment) {
    await deps.payments.refund(payment.providerRef);
    await db(deps).payments.put({ ...payment, status: "refunded" });
  }
  const updated = { ...entry, status: payment ? ("refunded" as const) : ("withdrawn" as const) };
  await db(deps).entries.put(updated);
  if (isIndividual(ev)) await db(deps).events.put({ ...((await db(deps).events.get(ev.id)) ?? ev), ladder: ev.ladder.filter((p) => !entry.playerIds.includes(p)) });
  await notify(deps, entry.playerIds, { kind: "refund", title: payment ? "Entry refunded" : "Entry removed", body: `${ev.name}: ${entry.teamName}.`, link: `events/${ev.id}` });
  await promoteWaitlist(deps, ev);
  return updated;
}

// ---------- schedules for team styles ----------

function blankMatch(ev: PickleHeatEvent, id: string, extra: Partial<Match>): Match {
  return {
    id, eventId: ev.id, roundId: null, groupId: null, round: 1, pool: null, bracket: null, label: null,
    homeEntryId: null, awayEntryId: null, homePlayers: [], awayPlayers: [], homeDead: false, awayDead: false,
    winnerTo: null, loserTo: null, scheduledAt: null, court: null, games: [], lines: null, status: "scheduled",
    reportedBy: null, confirmedBy: null, duprMatchId: null, duprSyncedAt: null, duprError: null, ...extra,
  };
}

async function linesFor(deps: Deps, ev: PickleHeatEvent, home: string[], away: string[]) {
  if (!usesLines(ev.format) || !home.length || !away.length) return null;
  const info = await playerInfo(deps, [...home, ...away]);
  return lineTemplate(ev.format, home, away, (id) => info[id]?.gender ?? null).map((l) => ({ ...l, games: [] }));
}

const seeded = (entries: Entry[]) => [...entries].sort((a, b) => (b.teamRating ?? 0) - (a.teamRating ?? 0) || a.createdAt.localeCompare(b.createdAt));

export async function generateSchedule(deps: Deps, ev: PickleHeatEvent): Promise<Match[]> {
  if (isIndividual(ev)) throw new HttpError(409, "Heat Climb and Wildfire Mixer are scheduled one round at a time (Start round)", "invalid");
  const existing = await db(deps).matches.find({ eventId: ev.id });
  if (existing.length) return existing;
  const entries = seeded(await db(deps).entries.find({ eventId: ev.id, status: "confirmed" }));
  if (entries.length < 2) throw new HttpError(409, "Need at least two confirmed teams", "too_few");
  const byId = new Map(entries.map((e) => [e.id, e]));
  const out: Match[] = [];
  const start = Date.parse(`${ev.startDate}T09:00:00Z`);

  if (ev.style === "single_elim" || ev.style === "double_elim") {
    out.push(...(await bracketMatches(deps, ev, buildBracket(entries.map((e) => e.id), ev.style === "double_elim"), byId, "")));
  } else {
    const groups = ev.style === "pools_playoffs" ? snakePools(entries.map((e) => e.id), Math.max(1, Math.round(entries.length / 4))) : [entries.map((e) => e.id)];
    for (const [pi, g] of groups.entries()) {
      for (const p of roundRobin(g)) {
        const home = byId.get(p.home)!, away = byId.get(p.away)!;
        out.push(blankMatch(ev, deps.newId(), {
          round: p.round,
          pool: ev.style === "pools_playoffs" ? pi + 1 : null,
          label: ev.kind === "league" ? `Week ${p.round}` : ev.style === "pools_playoffs" ? `Pool ${pi + 1} · Round ${p.round}` : `Round ${p.round}`,
          homeEntryId: home.id, awayEntryId: away.id, homePlayers: home.playerIds, awayPlayers: away.playerIds,
          scheduledAt: new Date(ev.kind === "league" ? start + (p.round - 1) * 7 * 86_400_000 : start + (p.round - 1) * 45 * 60_000).toISOString(),
          lines: await linesFor(deps, ev, home.playerIds, away.playerIds),
        }));
      }
    }
  }
  for (const m of out) await db(deps).matches.put(m);
  await db(deps).events.put({ ...ev, status: "in_progress" });
  return out;
}

/** Pools + playoffs: once every pool match is confirmed, seed the top two of each pool into a bracket. */
export async function buildPlayoffs(deps: Deps, ev: PickleHeatEvent, qualifiers: string[]): Promise<Match[]> {
  const matches = await db(deps).matches.find({ eventId: ev.id });
  if (matches.some((m) => m.bracket)) return matches.filter((m) => m.bracket);
  const entries = await db(deps).entries.find({ eventId: ev.id });
  const byId = new Map(entries.map((e) => [e.id, e]));
  const list = await bracketMatches(deps, ev, buildBracket(qualifiers, false), byId, "po-");
  for (const m of list) await db(deps).matches.put(m);
  return list;
}

const bracketLabel = (n: BNode, maxW: number) =>
  n.key === "GF1-1" ? "Grand final" : n.key === "GF2-1" ? "Grand final reset" : n.side === "L" ? `Losers round ${n.round}` : n.round === maxW ? "Final" : n.round === maxW - 1 ? "Semifinal" : `Round ${n.round}`;

async function bracketMatches(deps: Deps, ev: PickleHeatEvent, nodes: BNode[], byId: Map<string, Entry>, prefix: string): Promise<Match[]> {
  const id = (k: string) => `${ev.id}-${prefix}${k}`;
  const maxW = Math.max(...nodes.filter((n) => n.side === "W").map((n) => n.round));
  const out: Match[] = [];
  for (const n of nodes) {
    const home = n.home ? byId.get(n.home) : undefined, away = n.away ? byId.get(n.away) : undefined;
    out.push(blankMatch(ev, id(n.key), {
      round: n.round,
      bracket: { side: n.side, round: n.round, slot: n.slot },
      label: bracketLabel(n, maxW),
      homeEntryId: n.home, awayEntryId: n.away,
      homePlayers: home?.playerIds ?? [], awayPlayers: away?.playerIds ?? [],
      homeDead: n.homeDead, awayDead: n.awayDead,
      winnerTo: n.winnerTo ? { matchId: id(n.winnerTo.key), side: n.winnerTo.side } : null,
      loserTo: n.loserTo ? { matchId: id(n.loserTo.key), side: n.loserTo.side } : null,
      status: n.decided ? "confirmed" : "scheduled",
      lines: home && away ? await linesFor(deps, ev, home.playerIds, away.playerIds) : null,
    }));
  }
  return out;
}

/** Re-reads a bracket from its matches, applies a result, and writes back every slot that changed. */
export async function advanceBracket(deps: Deps, ev: PickleHeatEvent, played: Match, winnerEntryId: string): Promise<void> {
  const all = (await db(deps).matches.find({ eventId: ev.id })).filter((m) => m.bracket);
  const prefixOf = (m: Match) => m.id.slice(ev.id.length + 1).replace(/(W|L|GF)\d+-\d+$/, "");
  const prefix = prefixOf(played);
  const mine = all.filter((m) => prefixOf(m) === prefix);
  const keyOf = (m: Match) => m.id.slice(ev.id.length + 1 + prefix.length);
  const keyFromId = (id: string) => id.slice(ev.id.length + 1 + prefix.length);
  const nodes: BNode[] = mine.map((m) => ({
    key: keyOf(m), side: m.bracket!.side, round: m.bracket!.round, slot: m.bracket!.slot,
    home: m.homeEntryId, away: m.awayEntryId, homeDead: m.homeDead, awayDead: m.awayDead,
    winnerTo: m.winnerTo ? { key: keyFromId(m.winnerTo.matchId), side: m.winnerTo.side } : null,
    loserTo: m.loserTo ? { key: keyFromId(m.loserTo.matchId), side: m.loserTo.side } : null,
    decided: m.id !== played.id && m.status === "confirmed",
    winner: null,
  }));
  advance(nodes, keyOf(played), winnerEntryId);
  resolve(nodes);
  const entries = new Map((await db(deps).entries.find({ eventId: ev.id })).map((e) => [e.id, e]));
  for (const n of nodes) {
    const m = mine.find((x) => keyOf(x) === n.key)!;
    if (m.id === played.id) continue;
    const changed = m.homeEntryId !== n.home || m.awayEntryId !== n.away || m.homeDead !== n.homeDead || m.awayDead !== n.awayDead || (n.decided && m.status !== "confirmed");
    if (!changed) continue;
    const homeP = n.home ? entries.get(n.home)?.playerIds ?? [] : [];
    const awayP = n.away ? entries.get(n.away)?.playerIds ?? [] : [];
    const next: Match = {
      ...m,
      homeEntryId: n.home, awayEntryId: n.away, homePlayers: homeP, awayPlayers: awayP, homeDead: n.homeDead, awayDead: n.awayDead,
      status: n.decided ? "confirmed" : m.status,
      lines: m.lines ?? (n.home && n.away ? await linesFor(deps, ev, homeP, awayP) : null),
    };
    await db(deps).matches.put(next);
    if (n.home && n.away && !n.decided && (m.homeEntryId !== n.home || m.awayEntryId !== n.away)) {
      await notify(deps, [...homeP, ...awayP], { kind: "next_match", title: "You're up next", body: `${ev.name}: ${next.label ?? "bracket match"} is ready.`, link: `events/${ev.id}` });
    }
  }
}

export async function canSeeEvent(deps: Deps, ev: PickleHeatEvent, userId: string): Promise<boolean> {
  return ev.status !== "draft" || (await canManage(deps, ev, userId));
}
