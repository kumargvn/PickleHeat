// Two-way DUPR sync.
//  DUPR → PickleHeat: link once (SSO), then ratings arrive by webhook; history refreshes on demand / hourly.
//  PickleHeat → DUPR: confirmed results wait in the organizer's review queue. Only when the organizer
//  submits one is it uploaded (each MLP/trips line as its own doubles match) and retried until DUPR
//  accepts it. Two-team confirmation never sends anything to DUPR by itself.

import { db } from "../db";
import { HttpError } from "../http";
import type { Deps, DuprLink, DuprStatus, Match, PickleHeatEvent } from "../ports";
import { applyInvitesForUser } from "./invites";
import { playerInfo, requireManager, type PlayerInfo } from "./people";
import { notify } from "./social";

export async function linkDupr(deps: Deps, userId: string, accessToken: string, refreshToken: string): Promise<DuprLink> {
  const profile = await deps.dupr.verifyUser(accessToken).catch((e) => {
    throw new HttpError(400, `DUPR did not accept that login: ${(e as Error).message}`, "dupr_rejected");
  });
  if (!profile.duprId) throw new HttpError(400, "DUPR login returned no DUPR ID", "dupr_rejected");
  const existing = (await db(deps).dupr.find({ duprId: profile.duprId }))[0];
  if (existing && existing.userId !== userId) throw new HttpError(409, "That DUPR account is already connected to another PickleHeat account", "dupr_taken");
  const now = deps.now();
  const link: DuprLink = {
    id: userId,
    userId,
    duprId: profile.duprId,
    duprUserId: profile.duprUserId,
    accessToken,
    refreshToken,
    accessExpiresAt: new Date(now.getTime() + 6 * 86_400_000).toISOString(),
    doublesRating: profile.doublesRating,
    singlesRating: profile.singlesRating,
    doublesReliability: profile.doublesReliability,
    singlesReliability: profile.singlesReliability,
    ratingUpdatedAt: now.toISOString(),
    matchesSyncedAt: null,
    linkedAt: existing?.linkedAt ?? now.toISOString(),
  };
  await db(deps).dupr.put(link);
  const user = await db(deps).users.get(userId);
  if (user && (!user.name || user.name === "Player") && profile.name) await db(deps).users.put({ ...user, name: profile.name });
  await pullHistory(deps, link).catch(() => undefined);
  await applyInvitesForUser(deps, userId);
  return (await db(deps).dupr.get(userId)) ?? link;
}

export async function pullHistory(deps: Deps, link: DuprLink): Promise<DuprLink> {
  const fresh = await ensureFreshToken(deps, link);
  const matches = await deps.dupr.matchHistory(fresh);
  await db(deps).history.put({ id: fresh.userId, matches });
  const updated = { ...fresh, matchesSyncedAt: deps.now().toISOString() };
  await db(deps).dupr.put(updated);
  return updated;
}

export async function ensureFreshToken(deps: Deps, link: DuprLink): Promise<DuprLink> {
  if (link.accessExpiresAt > new Date(deps.now().getTime() + 86_400_000).toISOString()) return link;
  const t = await deps.dupr.refresh(link.refreshToken);
  const updated = { ...link, accessToken: t.accessToken, refreshToken: t.refreshToken, accessExpiresAt: t.accessExpiresAt };
  await db(deps).dupr.put(updated);
  return updated;
}

export async function applyRatingWebhook(deps: Deps, body: unknown): Promise<number> {
  const updates = deps.dupr.parseWebhook(body);
  if (!updates) return 0;
  let n = 0;
  for (const u of updates) {
    const link = (await db(deps).dupr.find({ duprId: u.duprId }))[0];
    if (!link) continue;
    await db(deps).dupr.put({
      ...link,
      doublesRating: u.doublesRating ?? link.doublesRating,
      singlesRating: u.singlesRating ?? link.singlesRating,
      doublesReliability: u.doublesReliability ?? link.doublesReliability,
      singlesReliability: u.singlesReliability ?? link.singlesReliability,
      ratingUpdatedAt: deps.now().toISOString(),
    });
    n++;
  }
  return n;
}

async function duprIds(deps: Deps, players: string[]): Promise<string[] | null> {
  const ids: string[] = [];
  for (const p of players) {
    const l = await db(deps).dupr.get(p);
    if (!l) return null;
    ids.push(l.duprId);
  }
  return ids;
}

/** Which parts of a match DUPR can rate: singles and doubles games (not a DreamBreaker, not trips). */
function ratedParts(m: Match) {
  const parts = m.lines?.length
    ? m.lines.map((l, i) => ({ id: `${m.id}:${i}`, home: l.homePlayers, away: l.awayPlayers, games: l.games, singles: l.homePlayers.length === 1 }))
    : [{ id: m.id, home: m.homePlayers, away: m.awayPlayers, games: m.games, singles: m.homePlayers.length === 1 }];
  return parts.filter((p) => p.home.length <= 2 && p.away.length <= 2 && p.games.length);
}

/** Called when a result is confirmed: it joins the review queue. Never uploads. */
export async function queueForReview(deps: Deps, ev: PickleHeatEvent, m: Match): Promise<Match> {
  if (!ev.submitToDupr || m.status !== "confirmed") return m;
  const queued: Match = { ...m, duprStatus: "ready", duprError: null, duprSubmittedBy: null, duprSubmittedAt: null };
  await db(deps).matches.put(queued);
  // Nudge the organizer when players confirm a score, but only once until they've read the last nudge.
  const link = `events/${ev.id}`;
  const pending = (await db(deps).notifications.find({ userId: ev.organizerId, kind: "dupr_review", read: false })).some((n) => n.link === link);
  if (!pending && m.confirmedBy !== ev.organizerId) {
    await notify(deps, [ev.organizerId], { kind: "dupr_review", title: "Results ready to review", body: `${ev.name}: confirmed scores are waiting for you to review and send to DUPR.`, link });
  }
  return queued;
}

/** Uploads a match the organizer has submitted. Records problems on the match instead of throwing, so the hourly job can retry. */
async function upload(deps: Deps, ev: PickleHeatEvent, m: Match): Promise<Match> {
  const uploaded: string[] = [];
  let saved: Match;
  try {
    for (const part of ratedParts(m)) {
      const a = await duprIds(deps, part.home);
      const b = await duprIds(deps, part.away);
      if (!a || !b) throw new Error("Every player needs a connected DUPR account before this match can be submitted");
      uploaded.push(
        await deps.dupr.uploadMatch({
          externalId: part.id,
          eventName: ev.name,
          playedAt: m.scheduledAt ?? deps.now().toISOString(),
          location: [ev.venue, ev.city, ev.state].filter(Boolean).join(", "),
          format: part.singles ? "singles" : "doubles",
          teamA: { duprIds: a, games: part.games.map((g) => g.us) },
          teamB: { duprIds: b, games: part.games.map((g) => g.them) },
        }),
      );
    }
    saved = uploaded.length
      ? { ...m, duprMatchId: uploaded.join(","), duprSyncedAt: deps.now().toISOString(), duprError: null, duprStatus: "submitted" }
      : { ...m, duprMatchId: null, duprSyncedAt: null, duprError: null, duprStatus: "not_rated" };
  } catch (e) {
    for (const id of uploaded) await deps.dupr.deleteMatch(id).catch(() => undefined);
    saved = { ...m, duprError: (e as Error).message.slice(0, 300), duprStatus: "failed" };
  }
  await db(deps).matches.put(saved);
  return saved;
}

/**
 * The organizer submits reviewed results to DUPR: the listed matches, or everything that's ready
 * (optionally one round). A skipped match can be submitted by naming it.
 */
export async function submitToDupr(deps: Deps, ev: PickleHeatEvent, userId: string, pick: { matchIds?: string[] | null; roundId?: string | null }): Promise<{ submitted: number; failed: number; matches: Match[] }> {
  await requireManager(deps, ev, userId);
  if (!ev.submitToDupr) throw new HttpError(409, "This event doesn't send results to DUPR", "invalid");
  const all = await db(deps).matches.find({ eventId: ev.id });
  let chosen: Match[];
  if (pick.matchIds?.length) {
    const ids = new Set(pick.matchIds);
    chosen = all.filter((m) => ids.has(m.id));
    if (chosen.length !== ids.size) throw new HttpError(404, "Match not found", "not_found");
    const bad = chosen.find((m) => m.status !== "confirmed" || !(m.duprStatus === "ready" || m.duprStatus === "failed" || m.duprStatus === "skipped"));
    if (bad) throw new HttpError(409, bad.duprStatus === "submitted" ? "That result is already on DUPR" : "Only confirmed results can be sent to DUPR", "invalid");
  } else {
    chosen = all.filter((m) => m.status === "confirmed" && (m.duprStatus === "ready" || m.duprStatus === "failed") && (!pick.roundId || m.roundId === pick.roundId));
  }
  const now = deps.now().toISOString();
  const out: Match[] = [];
  for (const m of chosen) out.push(await upload(deps, ev, { ...m, duprSubmittedBy: userId, duprSubmittedAt: now }));
  return { submitted: out.filter((m) => m.duprStatus === "submitted" || m.duprStatus === "not_rated").length, failed: out.filter((m) => m.duprStatus === "failed").length, matches: out };
}

/** The organizer keeps a result out of DUPR, or takes back one that was already sent. The score itself stays. */
export async function withdrawFromDupr(deps: Deps, ev: PickleHeatEvent, m: Match, userId: string): Promise<Match> {
  await requireManager(deps, ev, userId);
  if (m.status !== "confirmed" || !m.duprStatus) throw new HttpError(409, "There's no confirmed result here", "invalid");
  const cleared = await removeFromDupr(deps, m);
  const saved: Match = { ...cleared, duprStatus: "skipped", duprError: null, duprSubmittedBy: null, duprSubmittedAt: null };
  await db(deps).matches.put(saved);
  return saved;
}

/** Deletes every DUPR match made from this result. Throws if DUPR refuses, so we never claim a removal that didn't happen. */
export async function removeFromDupr(deps: Deps, m: Match): Promise<Match> {
  if (m.duprMatchId && m.duprMatchId !== "none") {
    for (const id of m.duprMatchId.split(",")) {
      await deps.dupr.deleteMatch(id).catch((e) => {
        throw new HttpError(502, `DUPR didn't remove the match: ${(e as Error).message}. Try again in a moment.`, "dupr_unavailable");
      });
    }
  }
  return { ...m, duprMatchId: null, duprSyncedAt: null };
}

export interface ReviewItem {
  match: Match;
  status: DuprStatus;
  roundNumber: number | null;
  groupNumber: number | null;
  /** Players who still need to connect DUPR before this can be sent. */
  missingDupr: string[];
}

export interface ReviewQueue {
  enabled: boolean;
  counts: Record<DuprStatus, number>;
  items: ReviewItem[];
  players: Record<string, PlayerInfo>;
}

const ORDER: Record<DuprStatus, number> = { failed: 0, ready: 1, skipped: 2, submitted: 3, not_rated: 4 };

/** Everything the organizer needs to review results: what's waiting, what failed, what's already on DUPR. */
export async function reviewQueue(deps: Deps, ev: PickleHeatEvent, userId: string): Promise<ReviewQueue> {
  await requireManager(deps, ev, userId);
  const matches = (await db(deps).matches.find({ eventId: ev.id })).filter((m) => m.status === "confirmed" && m.duprStatus);
  const players = await playerInfo(deps, matches.flatMap((m) => [...m.homePlayers, ...m.awayPlayers]));
  const rounds = new Map((await db(deps).rounds.find({ eventId: ev.id })).map((r) => [r.id, r.number]));
  const groups = new Map((await db(deps).groups.find({ eventId: ev.id })).map((g) => [g.id, g.number]));
  const counts: Record<DuprStatus, number> = { ready: 0, submitted: 0, failed: 0, skipped: 0, not_rated: 0 };
  const items = matches.map((match) => {
    const status = match.duprStatus!;
    counts[status]++;
    const need = new Set(ratedParts(match).flatMap((p) => [...p.home, ...p.away]));
    return {
      match,
      status,
      roundNumber: match.roundId ? rounds.get(match.roundId) ?? match.round : match.round,
      groupNumber: match.groupId ? groups.get(match.groupId) ?? null : null,
      missingDupr: [...need].filter((id) => !players[id]?.duprId),
    };
  });
  items.sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.roundNumber ?? 0) - (b.roundNumber ?? 0) || (a.groupNumber ?? 0) - (b.groupNumber ?? 0) || a.match.id.localeCompare(b.match.id));
  return { enabled: ev.submitToDupr, counts, items, players };
}

/** Hourly job: refresh tokens that are about to expire and retry uploads the organizer submitted that DUPR hasn't accepted yet. */
export async function runSyncJob(deps: Deps): Promise<{ refreshed: number; uploaded: number; failed: number }> {
  let refreshed = 0;
  const soon = new Date(deps.now().getTime() + 2 * 86_400_000).toISOString();
  for (const link of await db(deps).dupr.find({})) {
    if (link.accessExpiresAt >= soon) continue;
    try {
      await ensureFreshToken(deps, link);
      refreshed++;
    } catch {
      /* the player will be asked to reconnect next time they open the app */
    }
  }
  let uploaded = 0;
  let failed = 0;
  // Only results an organizer already submitted are retried. Results still in review are never sent from here.
  for (const m of await db(deps).matches.find({ status: "confirmed", duprStatus: "failed" })) {
    const ev = await db(deps).events.get(m.eventId);
    if (!ev?.submitToDupr || !m.duprSubmittedBy) continue;
    const r = await upload(deps, ev, m);
    if (r.duprStatus === "failed") failed++;
    else uploaded++;
  }
  return { refreshed, uploaded, failed };
}
