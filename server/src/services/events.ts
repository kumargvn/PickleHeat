// Leagues and tournaments: create, register (with payment), schedule, scores, standings.

import { eliminationFirstRound, roundRobin, snakePools, standings, type Standing } from "../domain/schedule";
import { HttpError } from "../http";
import type { Deps, Entry, Match, Payment, PickleHeatEvent, User } from "../ports";
import { uploadMatch } from "./duprSync";

export function platformFee(deps: Deps, amountCents: number): number {
  return Math.round((amountCents * deps.config.platformFeeBps) / 10_000);
}

export async function requireEvent(deps: Deps, id: string): Promise<PickleHeatEvent> {
  const e = await deps.store.getEvent(id);
  if (!e) throw new HttpError(404, "Event not found", "not_found");
  return e;
}

export async function requireOrganizer(deps: Deps, id: string, userId: string): Promise<PickleHeatEvent> {
  const e = await requireEvent(deps, id);
  if (e.organizerId !== userId) throw new HttpError(403, "Only the organizer can do that", "forbidden");
  return e;
}

export async function publishEvent(deps: Deps, ev: PickleHeatEvent): Promise<PickleHeatEvent> {
  if (ev.feeCents > 0) {
    let acct = await deps.store.getPayoutAccount(ev.organizerId);
    if (acct && !acct.chargesEnabled) {
      acct = { ...acct, ...(await deps.payments.accountStatus(acct.providerAccountId)) };
      await deps.store.savePayoutAccount(acct);
    }
    if (!acct || !acct.chargesEnabled) {
      throw new HttpError(409, "Link a payout account before opening a paid event", "payouts_required");
    }
  }
  const updated = { ...ev, status: "open" as const };
  await deps.store.saveEvent(updated);
  return updated;
}

async function teamRating(deps: Deps, playerIds: string[], singles: boolean): Promise<number | null> {
  const rs: number[] = [];
  for (const id of playerIds) {
    const l = await deps.store.getDuprLink(id);
    const r = singles ? l?.singlesRating ?? l?.doublesRating : l?.doublesRating ?? l?.singlesRating;
    if (r == null) return null;
    rs.push(r);
  }
  return rs.length ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 1000) / 1000 : null;
}

export interface RegisterResult {
  entry: Entry;
  checkoutUrl: string | null;
}

export async function register(deps: Deps, ev: PickleHeatEvent, user: User, partnerUserId: string | null, teamName: string | null, successUrl: string, cancelUrl: string): Promise<RegisterResult> {
  if (ev.status !== "open") throw new HttpError(409, "Registration is not open", "closed");
  const singles = ev.format === "singles";
  if (!singles && !partnerUserId) throw new HttpError(422, "Doubles events need a partner", "partner_required");
  if (singles && partnerUserId) throw new HttpError(422, "Singles events take one player", "invalid");
  const playerIds = singles ? [user.id] : [user.id, partnerUserId!];
  if (new Set(playerIds).size !== playerIds.length) throw new HttpError(422, "Pick a different partner", "invalid");

  const entries = (await deps.store.listEntries(ev.id)).filter((e) => e.status !== "withdrawn" && e.status !== "refunded");
  if (entries.some((e) => e.playerIds.some((p) => playerIds.includes(p)))) throw new HttpError(409, "Already registered", "duplicate");
  if (entries.length >= ev.capacity) throw new HttpError(409, "This event is full", "full");

  const names: string[] = [];
  for (const id of playerIds) {
    const u = await deps.store.getUser(id);
    if (!u) throw new HttpError(404, "Partner not found", "not_found");
    const link = await deps.store.getDuprLink(id);
    if ((ev.requireDuprVerified || ev.submitToDupr) && !link) {
      throw new HttpError(409, `${id === user.id ? "Connect your DUPR account" : `${u.name} needs to connect DUPR`} first`, "dupr_required");
    }
    const r = singles ? link?.singlesRating ?? link?.doublesRating : link?.doublesRating ?? link?.singlesRating;
    if (r != null && ((ev.minRating != null && r < ev.minRating - 0.0001) || (ev.maxRating != null && r > ev.maxRating + 0.0001))) {
      throw new HttpError(409, `${u.name}'s DUPR ${r.toFixed(2)} is outside this event's range`, "rating_out_of_range");
    }
    names.push(u.name.split(" ")[0]);
  }

  const entry: Entry = {
    id: deps.newId(),
    eventId: ev.id,
    playerIds,
    teamName: teamName ?? names.join(" / "),
    teamRating: await teamRating(deps, playerIds, singles),
    status: ev.feeCents > 0 ? "pending_payment" : "confirmed",
    createdAt: deps.now().toISOString(),
  };
  await deps.store.saveEntry(entry);
  if (ev.feeCents === 0) return { entry, checkoutUrl: null };

  const acct = await deps.store.getPayoutAccount(ev.organizerId);
  if (!acct) throw new HttpError(409, "The organizer has not linked a payout account", "payouts_required");
  // The registering player pays for the whole team.
  const amount = ev.feeCents * playerIds.length;
  const paymentId = deps.newId();
  const session = await deps.payments.createCheckout({
    amountCents: amount,
    applicationFeeCents: platformFee(deps, amount),
    currency: ev.currency,
    destinationAccountId: acct.providerAccountId,
    description: `${ev.name}: ${entry.teamName}`,
    successUrl,
    cancelUrl,
    metadata: { event_id: ev.id, entry_id: entry.id, payment_id: paymentId },
    customerEmail: user.email,
  });
  const payment: Payment = {
    id: paymentId,
    entryId: entry.id,
    eventId: ev.id,
    userId: user.id,
    amountCents: amount,
    applicationFeeCents: platformFee(deps, amount),
    currency: ev.currency,
    provider: deps.payments.name,
    providerRef: session.id,
    status: "pending",
    createdAt: deps.now().toISOString(),
  };
  await deps.store.savePayment(payment);
  return { entry, checkoutUrl: session.url };
}

export async function markPaid(deps: Deps, providerRef: string): Promise<void> {
  const p = await deps.store.getPaymentByProviderRef(providerRef);
  if (!p || p.status === "paid") return;
  await deps.store.savePayment({ ...p, status: "paid" });
  const e = await deps.store.getEntry(p.entryId);
  if (e && e.status === "pending_payment") await deps.store.saveEntry({ ...e, status: "confirmed" });
}

export async function markFailed(deps: Deps, providerRef: string): Promise<void> {
  const p = await deps.store.getPaymentByProviderRef(providerRef);
  if (!p || p.status !== "pending") return;
  await deps.store.savePayment({ ...p, status: "failed" });
  const e = await deps.store.getEntry(p.entryId);
  if (e && e.status === "pending_payment") await deps.store.saveEntry({ ...e, status: "withdrawn" });
}

export async function refundEntry(deps: Deps, ev: PickleHeatEvent, entryId: string): Promise<Entry> {
  const entry = await deps.store.getEntry(entryId);
  if (!entry || entry.eventId !== ev.id) throw new HttpError(404, "Entry not found", "not_found");
  const payment = (await deps.store.listPaymentsForEvent(ev.id)).find((p) => p.entryId === entry.id && p.status === "paid");
  if (payment) {
    await deps.payments.refund(payment.providerRef);
    await deps.store.savePayment({ ...payment, status: "refunded" });
  }
  const updated = { ...entry, status: payment ? ("refunded" as const) : ("withdrawn" as const) };
  await deps.store.saveEntry(updated);
  return updated;
}

/** Builds the match schedule. Leagues: full round robin. Tournaments: snake-seeded pools of ~4, round robin in each. */
export async function generateSchedule(deps: Deps, ev: PickleHeatEvent): Promise<Match[]> {
  const existing = await deps.store.listMatches(ev.id);
  if (existing.some((m) => m.status !== "scheduled")) throw new HttpError(409, "Scores are already in; the schedule can't be rebuilt", "locked");
  const entries = (await deps.store.listEntries(ev.id))
    .filter((e) => e.status === "confirmed")
    .sort((a, b) => (b.teamRating ?? 0) - (a.teamRating ?? 0) || a.createdAt.localeCompare(b.createdAt));
  if (entries.length < 2) throw new HttpError(409, "Need at least two confirmed entries", "too_few");

  const ids = entries.map((e) => e.id);
  const groups: string[][] = ev.kind === "league" ? [ids] : snakePools(ids, Math.max(1, Math.round(ids.length / 4)));
  const matches: Match[] = [];
  const start = new Date(`${ev.startDate}T09:00:00Z`).getTime();
  groups.forEach((group, poolIdx) => {
    for (const p of roundRobin(group)) {
      const when = ev.kind === "league" ? start + (p.round - 1) * 7 * 86_400_000 : start + (p.round - 1) * 45 * 60_000;
      matches.push({
        id: deps.newId(),
        eventId: ev.id,
        round: p.round,
        pool: ev.kind === "league" ? null : poolIdx + 1,
        homeEntryId: p.home,
        awayEntryId: p.away,
        scheduledAt: new Date(when).toISOString(),
        court: null,
        games: [],
        status: "scheduled",
        reportedBy: null,
        confirmedBy: null,
        duprMatchId: null,
        duprSyncedAt: null,
        duprError: null,
      });
    }
  });
  // Generating twice is a no-op: the first schedule stands (ids stay stable for the apps).
  if (existing.length) return existing;
  for (const m of matches) await deps.store.saveMatch(m);
  await deps.store.saveEvent({ ...ev, status: ev.status === "open" ? "in_progress" : ev.status });
  return matches;
}

function validGames(games: unknown): { us: number; them: number }[] {
  if (!Array.isArray(games) || games.length < 1 || games.length > 5) throw new HttpError(422, "Enter 1 to 5 games", "invalid");
  return games.map((g: any, i) => {
    const us = Number(g?.us);
    const them = Number(g?.them);
    if (!Number.isInteger(us) || !Number.isInteger(them) || us < 0 || them < 0 || us > 99 || them > 99 || us === them) {
      throw new HttpError(422, `Game ${i + 1} needs two different whole-number scores`, "invalid");
    }
    return { us, them };
  });
}

async function sideOf(deps: Deps, m: Match, userId: string): Promise<"home" | "away" | null> {
  const h = await deps.store.getEntry(m.homeEntryId);
  if (h?.playerIds.includes(userId)) return "home";
  const a = await deps.store.getEntry(m.awayEntryId);
  if (a?.playerIds.includes(userId)) return "away";
  return null;
}

/** A player (or the organizer) reports the score. Games are from the home team's point of view. */
export async function reportScore(deps: Deps, matchId: string, userId: string, games: unknown): Promise<Match> {
  const m = await deps.store.getMatch(matchId);
  if (!m) throw new HttpError(404, "Match not found", "not_found");
  const ev = await requireEvent(deps, m.eventId);
  const side = await sideOf(deps, m, userId);
  const isOrganizer = ev.organizerId === userId;
  if (!side && !isOrganizer) throw new HttpError(403, "Only players in this match or the organizer can enter scores", "forbidden");
  if (m.status === "confirmed" && !isOrganizer) throw new HttpError(409, "This score is already confirmed", "locked");
  const updated: Match = { ...m, games: validGames(games), status: isOrganizer ? "confirmed" : "reported", reportedBy: userId, confirmedBy: isOrganizer ? userId : null };
  if (m.duprMatchId && isOrganizer) {
    // Corrections: DUPR has no reliable update, so delete and re-upload.
    await deps.dupr.deleteMatch(m.duprMatchId).catch(() => undefined);
    updated.duprMatchId = null;
    updated.duprSyncedAt = null;
  }
  await deps.store.saveMatch(updated);
  return updated.status === "confirmed" ? uploadMatch(deps, ev, updated) : updated;
}

/** The other team (or the organizer) confirms a reported score. Confirmed matches go to DUPR. */
export async function confirmScore(deps: Deps, matchId: string, userId: string): Promise<Match> {
  const m = await deps.store.getMatch(matchId);
  if (!m) throw new HttpError(404, "Match not found", "not_found");
  if (m.status !== "reported" || !m.reportedBy) throw new HttpError(409, "There is no reported score to confirm", "invalid");
  const ev = await requireEvent(deps, m.eventId);
  const side = await sideOf(deps, m, userId);
  const reporterSide = await sideOf(deps, m, m.reportedBy);
  const isOrganizer = ev.organizerId === userId;
  if (!isOrganizer && (!side || side === reporterSide)) throw new HttpError(403, "The other team confirms the score", "forbidden");
  const updated: Match = { ...m, status: "confirmed", confirmedBy: userId };
  await deps.store.saveMatch(updated);
  return uploadMatch(deps, ev, updated);
}

export interface EventDetail {
  event: PickleHeatEvent;
  entries: Entry[];
  matches: Match[];
  standings: { pool: number | null; table: Standing[] }[];
  playoffs: ReturnType<typeof eliminationFirstRound>;
}

export async function eventDetail(deps: Deps, ev: PickleHeatEvent): Promise<EventDetail> {
  const entries = await deps.store.listEntries(ev.id);
  const matches = await deps.store.listMatches(ev.id);
  const pools = [...new Set(matches.map((m) => m.pool))];
  const confirmed = matches.filter((m) => m.status === "confirmed");
  const live = entries.filter((e) => e.status === "confirmed");
  const tables = (pools.length ? pools : [null]).map((pool) => {
    const ms = matches.filter((m) => m.pool === pool);
    const ids = pools.length ? [...new Set(ms.flatMap((m) => [m.homeEntryId, m.awayEntryId]))] : live.map((e) => e.id);
    const results = confirmed.filter((m) => m.pool === pool).map((m) => ({ home: m.homeEntryId, away: m.awayEntryId, games: m.games.map((g) => ({ home: g.us, away: g.them })) }));
    return { pool, table: standings(ids, results) };
  });
  // Playoffs: top two from each pool, seeded by wins then differential.
  let playoffs: ReturnType<typeof eliminationFirstRound> = [];
  if (ev.kind === "tournament" && tables.length && matches.length && matches.every((m) => m.status === "confirmed")) {
    const qualifiers = tables.flatMap((t) => t.table.slice(0, 2)).sort((a, b) => b.wins - a.wins || b.diff - a.diff).map((s) => s.entrant);
    playoffs = eliminationFirstRound(qualifiers);
  }
  return { event: ev, entries, matches, standings: tables, playoffs };
}
