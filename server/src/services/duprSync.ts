// Two-way DUPR sync.
//  DUPR → PickleHeat: link once (SSO), then ratings arrive by webhook; history refreshes on demand / hourly.
//  PickleHeat → DUPR: confirmed matches are uploaded (each MLP/trips line as its own doubles match),
//  retried until DUPR accepts them.

import { db } from "../db";
import { HttpError } from "../http";
import type { Deps, DuprLink, Match, PickleHeatEvent } from "../ports";
import { applyInvitesForUser } from "./invites";

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

/** Uploads a confirmed match. Records problems on the match instead of throwing, so the hourly job can retry. */
export async function uploadMatch(deps: Deps, ev: PickleHeatEvent, m: Match): Promise<Match> {
  if (!ev.submitToDupr || m.status !== "confirmed" || m.duprMatchId) return m;
  const parts = m.lines?.length
    ? m.lines.map((l, i) => ({ id: `${m.id}:${i}`, home: l.homePlayers, away: l.awayPlayers, games: l.games, singles: l.homePlayers.length === 1 }))
    : [{ id: m.id, home: m.homePlayers, away: m.awayPlayers, games: m.games, singles: m.homePlayers.length === 1 }];
  const uploaded: string[] = [];
  let saved: Match;
  try {
    for (const part of parts) {
      if (part.home.length > 2 || part.away.length > 2 || !part.games.length) continue; // DreamBreaker etc. aren't DUPR matches
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
    saved = { ...m, duprMatchId: uploaded.join(",") || "none", duprSyncedAt: deps.now().toISOString(), duprError: null };
  } catch (e) {
    for (const id of uploaded) await deps.dupr.deleteMatch(id).catch(() => undefined);
    saved = { ...m, duprError: (e as Error).message.slice(0, 300) };
  }
  await db(deps).matches.put(saved);
  return saved;
}

export async function removeFromDupr(deps: Deps, m: Match): Promise<Match> {
  if (!m.duprMatchId || m.duprMatchId === "none") return { ...m, duprMatchId: null, duprSyncedAt: null };
  for (const id of m.duprMatchId.split(",")) await deps.dupr.deleteMatch(id).catch(() => undefined);
  return { ...m, duprMatchId: null, duprSyncedAt: null };
}

/** Hourly job: refresh tokens that are about to expire and retry pending uploads. */
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
  for (const m of await db(deps).matches.find({ status: "confirmed", duprMatchId: null })) {
    const ev = await db(deps).events.get(m.eventId);
    if (!ev?.submitToDupr) continue;
    const r = await uploadMatch(deps, ev, m);
    if (r.duprMatchId) uploaded++;
    else failed++;
  }
  return { refreshed, uploaded, failed };
}
