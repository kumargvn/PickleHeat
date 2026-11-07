// Two-way DUPR sync.
//  DUPR → Pickora: link once (SSO), then ratings arrive by webhook and history is refreshed on demand / nightly.
//  Pickora → DUPR: confirmed league & tournament matches are uploaded; retried until DUPR accepts them.

import type { Deps, DuprLink, Match, PickoraEvent } from "../ports";
import { HttpError } from "../http";

export async function linkDupr(deps: Deps, userId: string, accessToken: string, refreshToken: string): Promise<DuprLink> {
  const profile = await deps.dupr.verifyUser(accessToken).catch((e) => {
    throw new HttpError(400, `DUPR did not accept that login: ${(e as Error).message}`, "dupr_rejected");
  });
  if (!profile.duprId) throw new HttpError(400, "DUPR login returned no DUPR ID", "dupr_rejected");
  const existing = await deps.store.getDuprLinkByDuprId(profile.duprId);
  if (existing && existing.userId !== userId) {
    throw new HttpError(409, "That DUPR account is already connected to another Pickora account", "dupr_taken");
  }
  const now = deps.now();
  const link: DuprLink = {
    userId,
    duprId: profile.duprId,
    duprUserId: profile.duprUserId,
    accessToken,
    refreshToken,
    // DUPR production tokens last 30 days (7 in UAT). Refresh early to stay safe.
    accessExpiresAt: new Date(now.getTime() + 6 * 86_400_000).toISOString(),
    doublesRating: profile.doublesRating,
    singlesRating: profile.singlesRating,
    ratingUpdatedAt: now.toISOString(),
    matchesSyncedAt: null,
    linkedAt: existing?.linkedAt ?? now.toISOString(),
  };
  await deps.store.saveDuprLink(link);
  const user = await deps.store.getUser(userId);
  if (user && (!user.name || user.name === "Player") && profile.name) await deps.store.saveUser({ ...user, name: profile.name });
  await pullHistory(deps, link).catch(() => undefined); // best effort; the app can retry with /v1/dupr/sync
  return (await deps.store.getDuprLink(userId)) ?? link;
}

export async function pullHistory(deps: Deps, link: DuprLink): Promise<DuprLink> {
  const fresh = await ensureFreshToken(deps, link);
  const matches = await deps.dupr.matchHistory(fresh);
  await deps.store.saveDuprMatches(fresh.userId, matches);
  const updated = { ...fresh, matchesSyncedAt: deps.now().toISOString() };
  await deps.store.saveDuprLink(updated);
  return updated;
}

export async function ensureFreshToken(deps: Deps, link: DuprLink): Promise<DuprLink> {
  if (link.accessExpiresAt > new Date(deps.now().getTime() + 86_400_000).toISOString()) return link;
  const t = await deps.dupr.refresh(link.refreshToken);
  const updated = { ...link, accessToken: t.accessToken, refreshToken: t.refreshToken, accessExpiresAt: t.accessExpiresAt };
  await deps.store.saveDuprLink(updated);
  return updated;
}

export async function applyRatingWebhook(deps: Deps, body: unknown): Promise<number> {
  const updates = deps.dupr.parseWebhook(body);
  if (!updates) return 0;
  let n = 0;
  for (const u of updates) {
    const link = await deps.store.getDuprLinkByDuprId(u.duprId);
    if (!link) continue;
    await deps.store.saveDuprLink({
      ...link,
      doublesRating: u.doublesRating ?? link.doublesRating,
      singlesRating: u.singlesRating ?? link.singlesRating,
      ratingUpdatedAt: deps.now().toISOString(),
    });
    n++;
  }
  return n;
}

/** Uploads one confirmed match. Records the error on the match instead of throwing, so a cron can retry. */
export async function uploadMatch(deps: Deps, ev: PickoraEvent, m: Match): Promise<Match> {
  if (!ev.submitToDupr || m.status !== "confirmed" || m.duprMatchId) return m;
  const home = await deps.store.getEntry(m.homeEntryId);
  const away = await deps.store.getEntry(m.awayEntryId);
  if (!home || !away) return m;
  const duprIds = async (playerIds: string[]) => {
    const ids: string[] = [];
    for (const p of playerIds) {
      const l = await deps.store.getDuprLink(p);
      if (!l) return null;
      ids.push(l.duprId);
    }
    return ids;
  };
  const a = await duprIds(home.playerIds);
  const b = await duprIds(away.playerIds);
  let saved: Match;
  if (!a || !b) {
    saved = { ...m, duprError: "Every player needs a connected DUPR account before this match can be submitted" };
  } else {
    try {
      const id = await deps.dupr.uploadMatch({
        externalId: m.id,
        eventName: ev.name,
        playedAt: m.scheduledAt ?? deps.now().toISOString(),
        location: [ev.venue, ev.city, ev.state].filter(Boolean).join(", "),
        format: ev.format,
        teamA: { duprIds: a, games: m.games.map((g) => g.us) },
        teamB: { duprIds: b, games: m.games.map((g) => g.them) },
      });
      saved = { ...m, duprMatchId: id, duprSyncedAt: deps.now().toISOString(), duprError: null };
    } catch (e) {
      saved = { ...m, duprError: (e as Error).message.slice(0, 300) };
    }
  }
  await deps.store.saveMatch(saved);
  return saved;
}

/** Nightly / hourly job: refresh tokens that are about to expire and retry pending uploads. */
export async function runSyncJob(deps: Deps): Promise<{ refreshed: number; uploaded: number; failed: number }> {
  let refreshed = 0;
  const soon = new Date(deps.now().getTime() + 2 * 86_400_000).toISOString();
  for (const link of await deps.store.listDuprLinksExpiringBefore(soon)) {
    try {
      await ensureFreshToken(deps, link);
      refreshed++;
    } catch {
      /* the player will be asked to reconnect next time they open the app */
    }
  }
  let uploaded = 0;
  let failed = 0;
  for (const m of await deps.store.listMatchesNeedingDuprSync()) {
    const ev = await deps.store.getEvent(m.eventId);
    if (!ev) continue;
    const r = await uploadMatch(deps, ev, m);
    if (r.duprMatchId) uploaded++;
    else if (ev.submitToDupr) failed++;
  }
  return { refreshed, uploaded, failed };
}
