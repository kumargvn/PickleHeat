// The PickleHeat API. Pure request → response; all outside services come in through Deps.

import { formScore, insights } from "./domain/form";
import { recommend } from "./domain/recommend";
import type { TournamentListing } from "./domain/types";
import { signJwt, verifyJwt } from "./adapters/crypto";
import { MockPaymentProvider } from "./adapters/payments";
import { db } from "./db";
import { CORS_HEADERS, HttpError, Router, html, json, numIn, oneOf, optNumIn, optStr, readJson, redirect, str } from "./http";
import type { Deps, User } from "./ports";
import { deleteAccount, handoffLink, redeemHandoff, session, signInWithApple, signInWithPassword, signUpWithPassword, userFromRequest } from "./services/auth";
import { applyRatingWebhook, linkDupr, pullHistory } from "./services/duprSync";
import { canSeeEvent, createEvent, eventFromBody, FORMATS, generateSchedule, markFailed, markPaid, publishEvent, refundEntry, register, requireEvent, startCheckout, withdraw } from "./services/events";
import { addInvites, parseInviteCsv } from "./services/invites";
import { acceptSub, cancelSub, closeRound, eventStats, rankings, requestSub, requireRound, roundView, setAttendance, startRound } from "./services/leagues";
import { confirmScore, reportScore } from "./services/matches";
import { createClub, joinClub, leaveClub, playerInfo, requireManager, setRole } from "./services/people";
import { createChat, listNotifications, markRead, messages, myChats, postMessage, react } from "./services/social";
import { cards, clubDetail, discover, eventDetail, liveMatches, meView, myEvents } from "./services/views";
import { duprConnectPage, page } from "./web/pages";

interface Ctx {
  deps: Deps;
}

const auth = (req: Request, deps: Deps) => userFromRequest(deps, req);

export function buildRouter(): Router<Ctx> {
  const r = new Router<Ctx>();

  r.on("GET", "/v1/health", async (_q, { deps }) =>
    json({ ok: true, dupr: deps.dupr.name, payments: deps.payments.name, tournamentSources: deps.tournamentSources.map((s) => ({ name: s.name, enabled: s.enabled })) }),
  );

  // ----- accounts -----
  r.on("POST", "/v1/auth/apple", async (req, { deps }) => {
    const b = await readJson<{ identityToken?: string; name?: string }>(req);
    const user = await signInWithApple(deps, str(b.identityToken, "identityToken", 4000), b.name ?? null);
    return json({ token: await session(deps, user.id), ...(await meView(deps, user)) });
  });

  r.on("POST", "/v1/auth/signup", async (req, { deps }) => {
    const b = await readJson<{ email?: string; password?: string; name?: string }>(req);
    const user = await signUpWithPassword(deps, str(b.email, "email", 200), String(b.password ?? ""), str(b.name, "name", 80));
    return json({ token: await session(deps, user.id), ...(await meView(deps, user)) }, 201);
  });

  r.on("POST", "/v1/auth/login", async (req, { deps }) => {
    const b = await readJson<{ email?: string; password?: string }>(req);
    const user = await signInWithPassword(deps, str(b.email, "email", 200), String(b.password ?? ""));
    return json({ token: await session(deps, user.id), ...(await meView(deps, user)) });
  });

  // App → web, already signed in (payments and payouts live on the web).
  r.on("POST", "/v1/auth/handoff", async (req, { deps }) => {
    const user = await auth(req, deps);
    const b = await readJson<{ to?: string }>(req);
    return json({ url: await handoffLink(deps, user.id, str(b.to, "to", 120)) });
  });

  r.on("POST", "/v1/auth/handoff/redeem", async (req, { deps }) => {
    const b = await readJson<{ token?: string }>(req);
    const { user, to } = await redeemHandoff(deps, str(b.token, "token", 4000));
    return json({ token: await session(deps, user.id), to, ...(await meView(deps, user)) });
  });

  r.on("GET", "/v1/me", async (req, { deps }) => json(await meView(deps, await auth(req, deps))));

  r.on("PATCH", "/v1/me", async (req, { deps }) => {
    const user = await auth(req, deps);
    const b = await readJson<any>(req);
    const updated: User = {
      ...user,
      name: b.name != null ? str(b.name, "name", 80) : user.name,
      gender: b.gender === undefined ? user.gender : b.gender === null ? null : oneOf(b.gender, "gender", ["m", "f"] as const),
      lat: b.lat !== undefined ? optNumIn(b.lat, "lat", -90, 90) : user.lat,
      lng: b.lng !== undefined ? optNumIn(b.lng, "lng", -180, 180) : user.lng,
      maxDistanceMiles: b.maxDistanceMiles != null ? numIn(b.maxDistanceMiles, "maxDistanceMiles", 5, 1000) : user.maxDistanceMiles,
      formats: Array.isArray(b.formats) ? b.formats.map((f: unknown) => oneOf(f, "formats", FORMATS)) : user.formats,
    };
    await db(deps).users.put(updated);
    return json(await meView(deps, updated));
  });

  r.on("DELETE", "/v1/me", async (req, { deps }) => {
    const user = await auth(req, deps);
    await deleteAccount(deps, user.id);
    return json({ deleted: true });
  });

  // ----- DUPR -----
  r.on("POST", "/v1/dupr/connect-session", async (req, { deps }) => {
    const user = await auth(req, deps);
    const b = await readJson<{ client?: string }>(req).catch(() => ({ client: "app" }));
    const t = await signJwt({ sub: user.id, purpose: "dupr_connect" }, deps.config.jwtSecret, 15 * 60, deps.now().getTime());
    const client = b.client === "web" ? "web" : "app";
    return json({ url: `${deps.config.publicBaseUrl}/v1/dupr/connect?t=${encodeURIComponent(t)}&client=${client}`, callbackScheme: deps.config.appScheme });
  });

  r.on("GET", "/v1/dupr/connect", async (_req, { deps }, _p, url) => {
    const t = url.searchParams.get("t") ?? "";
    const claims = await verifyJwt(t, deps.config.jwtSecret, "dupr_connect", deps.now().getTime());
    if (!claims) return html(page("Link expired", `<div class="card"><p>This link has expired. Go back to PickleHeat and tap Connect DUPR again.</p></div>`), 401);
    const done = url.searchParams.get("client") === "web" ? `${deps.config.webAppUrl}#/dupr` : `${deps.config.appScheme}://dupr`;
    return html(duprConnectPage(deps.dupr.ssoUrl(), t, done, deps.config.publicBaseUrl));
  });

  r.on("GET", "/v1/dupr/mock-login", async () =>
    html(
      page(
        "DUPR (test)",
        `<div class="card"><p><b>Test DUPR login</b></p><p class="muted">PickleHeat is not connected to real DUPR yet, so this stands in for it. You'll get sample ratings and matches.</p></div><button id="go">Log in and allow access</button>`,
        `<script>document.getElementById('go').onclick=function(){var n=Math.random().toString(36).slice(2,8);parent.postMessage({userToken:'mock-'+n,refreshToken:'refresh-'+n,id:'mock-'+n,duprId:'MOCK'},location.origin);};</script>`,
      ),
      200,
      { frameable: true },
    ),
  );

  r.on("POST", "/v1/dupr/link", async (req, { deps }) => {
    const h = req.headers.get("authorization") ?? "";
    const claims = await verifyJwt(h.replace(/^Bearer /, ""), deps.config.jwtSecret, "dupr_connect", deps.now().getTime());
    const userId = claims?.sub ?? (await auth(req, deps)).id;
    const b = await readJson<{ userToken?: string; refreshToken?: string }>(req);
    const link = await linkDupr(deps, userId, str(b.userToken, "userToken", 4000), str(b.refreshToken, "refreshToken", 4000));
    return json({ connected: true, duprId: link.duprId, doublesRating: link.doublesRating, singlesRating: link.singlesRating });
  });

  r.on("DELETE", "/v1/dupr/link", async (req, { deps }) => {
    const user = await auth(req, deps);
    await db(deps).dupr.delete(user.id);
    await db(deps).history.delete(user.id);
    return json(await meView(deps, user));
  });

  r.on("POST", "/v1/dupr/sync", async (req, { deps }) => {
    const user = await auth(req, deps);
    const link = await db(deps).dupr.get(user.id);
    if (!link) throw new HttpError(409, "Connect DUPR first", "dupr_required");
    try {
      await pullHistory(deps, link);
    } catch (e) {
      throw new HttpError(502, `DUPR sync failed: ${(e as Error).message}`, "dupr_unavailable");
    }
    return json(await meView(deps, user));
  });

  r.on("POST", "/v1/webhooks/dupr", async (req, { deps }) => json({ received: true, updated: await applyRatingWebhook(deps, await readJson<unknown>(req)) }));

  // ----- form, insights, live matches, discover -----
  r.on("GET", "/v1/me/form", async (req, { deps }) => {
    const user = await auth(req, deps);
    const matches = (await db(deps).history.get(user.id))?.matches ?? [];
    return json({ form: formScore(matches), insights: insights(matches), matches: [...matches].sort((a, b) => b.playedAt.localeCompare(a.playedAt)) });
  });

  r.on("GET", "/v1/me/live", async (req, { deps }) => json(await liveMatches(deps, await auth(req, deps))));

  r.on("GET", "/v1/discover", async (req, { deps }) => json(await discover(deps, await auth(req, deps))));

  r.on("GET", "/v1/tournaments/recommended", async (req, { deps }, _p, url) => {
    const user = await auth(req, deps);
    const lat = optNumIn(url.searchParams.get("lat"), "lat", -90, 90) ?? user.lat;
    const lng = optNumIn(url.searchParams.get("lng"), "lng", -180, 180) ?? user.lng;
    if (lat == null || lng == null) throw new HttpError(422, "Set your location first", "location_required");
    const radius = optNumIn(url.searchParams.get("radius"), "radius", 5, 1000) ?? user.maxDistanceMiles;
    const today = deps.now().toISOString().slice(0, 10);
    const listings: TournamentListing[] = [];
    const sources: { name: string; ok: boolean; count: number; error: string | null }[] = [];
    await Promise.all(
      deps.tournamentSources.filter((s) => s.enabled).map(async (s) => {
        try {
          const rows = await s.search({ lat, lng, radiusMiles: radius, today });
          listings.push(...rows);
          sources.push({ name: s.name, ok: true, count: rows.length, error: null });
        } catch (e) {
          sources.push({ name: s.name, ok: false, count: 0, error: (e as Error).message });
        }
      }),
    );
    const link = await db(deps).dupr.get(user.id);
    const form = formScore((await db(deps).history.get(user.id))?.matches ?? []);
    const recs = recommend({ doublesRating: link?.doublesRating ?? null, singlesRating: link?.singlesRating ?? null, form: form?.score ?? null, lat, lng, maxDistanceMiles: radius, formats: user.formats.filter((f) => f === "doubles" || f === "mixed" || f === "singles") }, listings, today, 20);
    return json({ recommendations: recs, sources: sources.sort((a, b) => a.name.localeCompare(b.name)) });
  });

  // ----- clubs -----
  r.on("POST", "/v1/clubs", async (req, { deps }) => {
    const user = await auth(req, deps);
    const b = await readJson<any>(req);
    const club = await createClub(deps, user.id, { name: str(b.name, "name", 80), description: optStr(b.description, "description", 2000) ?? "", city: optStr(b.city, "city", 80) ?? "", state: optStr(b.state, "state", 40) ?? "", lat: optNumIn(b.lat, "lat", -90, 90), lng: optNumIn(b.lng, "lng", -180, 180) });
    return json(await clubDetail(deps, club, user), 201);
  });

  r.on("GET", "/v1/clubs", async (req, { deps }) => {
    const user = await auth(req, deps);
    const d = await discover(deps, user);
    return json({ mine: d.clubs.filter((c) => c.myRole), nearby: d.clubs.filter((c) => !c.myRole) });
  });

  r.on("GET", "/v1/clubs/:id", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    const club = await db(deps).clubs.get(p.id);
    if (!club) throw new HttpError(404, "Club not found", "not_found");
    return json(await clubDetail(deps, club, user));
  });

  r.on("PATCH", "/v1/clubs/:id", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    const club = await db(deps).clubs.get(p.id);
    if (!club) throw new HttpError(404, "Club not found", "not_found");
    const role = (await db(deps).members.get(`${club.id}:${user.id}`))?.role;
    if (role !== "owner" && role !== "admin") throw new HttpError(403, "Only club owners and admins can edit the club", "forbidden");
    const b = await readJson<any>(req);
    const updated = { ...club, name: b.name != null ? str(b.name, "name", 80) : club.name, description: b.description != null ? optStr(b.description, "description", 2000) ?? "" : club.description, city: b.city != null ? optStr(b.city, "city", 80) ?? "" : club.city, state: b.state != null ? optStr(b.state, "state", 40) ?? "" : club.state, lat: b.lat !== undefined ? optNumIn(b.lat, "lat", -90, 90) : club.lat, lng: b.lng !== undefined ? optNumIn(b.lng, "lng", -180, 180) : club.lng };
    await db(deps).clubs.put(updated);
    return json(await clubDetail(deps, updated, user));
  });

  r.on("POST", "/v1/clubs/:id/join", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    await joinClub(deps, p.id, user.id);
    return json(await clubDetail(deps, (await db(deps).clubs.get(p.id))!, user));
  });

  r.on("POST", "/v1/clubs/:id/leave", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    await leaveClub(deps, p.id, user.id);
    return json(await clubDetail(deps, (await db(deps).clubs.get(p.id))!, user));
  });

  r.on("PATCH", "/v1/clubs/:id/members/:userId", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    const b = await readJson<{ role?: string }>(req);
    await setRole(deps, p.id, user.id, p.userId, oneOf(b.role, "role", ["owner", "admin", "member"] as const));
    return json(await clubDetail(deps, (await db(deps).clubs.get(p.id))!, user));
  });

  // ----- events -----
  r.on("POST", "/v1/events", async (req, { deps }) => {
    const user = await auth(req, deps);
    return json({ event: await createEvent(deps, user, await readJson<any>(req)) }, 201);
  });

  r.on("GET", "/v1/events", async (req, { deps }) => {
    const user = await auth(req, deps);
    return json({ events: await cards(deps, await myEvents(deps, user), user) });
  });

  r.on("GET", "/v1/events/:id", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    const ev = await requireEvent(deps, p.id);
    if (!(await canSeeEvent(deps, ev, user.id))) throw new HttpError(404, "Event not found", "not_found");
    return json(await eventDetail(deps, ev, user));
  });

  r.on("PATCH", "/v1/events/:id", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    const ev = await requireEvent(deps, p.id);
    await requireManager(deps, ev, user.id);
    if (ev.status !== "draft") throw new HttpError(409, "Published events can't be edited", "locked");
    const merged = await eventFromBody(deps, { ...ev, ...(await readJson<any>(req)) }, ev.organizerId, ev.id, ev.createdAt, ev);
    await db(deps).events.put(merged);
    return json({ event: merged });
  });

  r.on("POST", "/v1/events/:id/publish", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    const ev = await requireEvent(deps, p.id);
    await requireManager(deps, ev, user.id);
    return json({ event: await publishEvent(deps, ev) });
  });

  r.on("POST", "/v1/events/:id/close", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    const ev = await requireEvent(deps, p.id);
    await requireManager(deps, ev, user.id);
    const updated = { ...ev, status: "closed" as const };
    await db(deps).events.put(updated);
    return json({ event: updated });
  });

  r.on("POST", "/v1/events/:id/schedule", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    const ev = await requireEvent(deps, p.id);
    await requireManager(deps, ev, user.id);
    return json({ matches: await generateSchedule(deps, ev) });
  });

  r.on("POST", "/v1/events/:id/register", async (req, { deps }, p, url) => {
    const user = await auth(req, deps);
    const ev = await requireEvent(deps, p.id);
    const b = await readJson<{ partnerDuprIds?: string[]; partnerUserIds?: string[]; partnerDuprId?: string; teamName?: string }>(req);
    const duprIds = [...(Array.isArray(b.partnerDuprIds) ? b.partnerDuprIds : []), ...(b.partnerDuprId ? [b.partnerDuprId] : [])].map(String).filter((s) => s.trim());
    const userIds = (Array.isArray(b.partnerUserIds) ? b.partnerUserIds : []).map(String);
    const client = url.searchParams.get("client") === "web" ? "web" : "app";
    return json(await register(deps, ev, user, { userIds, duprIds }, b.teamName ?? null, client), 201);
  });

  r.on("POST", "/v1/events/:id/withdraw", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    return json({ entry: await withdraw(deps, await requireEvent(deps, p.id), user.id) });
  });

  r.on("POST", "/v1/events/:id/entries/:entryId/refund", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    const ev = await requireEvent(deps, p.id);
    await requireManager(deps, ev, user.id);
    return json({ entry: await refundEntry(deps, ev, p.entryId) });
  });

  r.on("POST", "/v1/events/:id/invites", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    const ev = await requireEvent(deps, p.id);
    await requireManager(deps, ev, user.id);
    const b = await readJson<{ csv?: string; rows?: { name?: string; email?: string; duprId?: string }[] }>(req);
    const rows = b.csv ? parseInviteCsv(b.csv) : (b.rows ?? []).map((x) => ({ name: String(x.name ?? "").slice(0, 80), email: x.email ? String(x.email).toLowerCase() : null, duprId: x.duprId ? String(x.duprId).toUpperCase() : null })).filter((x) => x.name);
    return json(await addInvites(deps, ev.id, rows));
  });

  r.on("GET", "/v1/events/:id/rankings", async (req, { deps }, p, url) => {
    await auth(req, deps);
    const n = url.searchParams.get("round");
    return json(await rankings(deps, await requireEvent(deps, p.id), n ? Number(n) : undefined));
  });

  r.on("GET", "/v1/events/:id/stats", async (req, { deps }, p) => {
    await auth(req, deps);
    return json(await eventStats(deps, await requireEvent(deps, p.id)));
  });

  // ----- rounds (Heat Climb & Wildfire Mixer) -----
  r.on("POST", "/v1/events/:id/rounds/start", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    const round = await startRound(deps, await requireEvent(deps, p.id), user.id);
    return json(await roundView(deps, round, user.id));
  });

  r.on("GET", "/v1/rounds/:id", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    return json(await roundView(deps, await requireRound(deps, p.id), user.id));
  });

  r.on("POST", "/v1/rounds/:id/close", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    const round = await closeRound(deps, await requireRound(deps, p.id), user.id);
    return json(await roundView(deps, round, user.id));
  });

  r.on("POST", "/v1/rounds/:id/attendance", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    const b = await readJson<{ status?: string }>(req);
    const round = await requireRound(deps, p.id);
    await setAttendance(deps, round, user.id, oneOf(b.status, "status", ["confirmed", "declined"] as const));
    return json(await roundView(deps, round, user.id));
  });

  r.on("POST", "/v1/rounds/:id/subs", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    const round = await requireRound(deps, p.id);
    await requestSub(deps, round, user.id);
    return json(await roundView(deps, round, user.id));
  });

  r.on("POST", "/v1/subs/:id/accept", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    const s = await acceptSub(deps, p.id, user.id);
    return json(await roundView(deps, await requireRound(deps, s.roundId), user.id));
  });

  r.on("POST", "/v1/subs/:id/cancel", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    const s = await cancelSub(deps, p.id, user.id);
    return json(await roundView(deps, await requireRound(deps, s.roundId), user.id));
  });

  // ----- matches -----
  r.on("POST", "/v1/matches/:id/score", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    return json({ match: await reportScore(deps, p.id, user.id, await readJson<{ games?: unknown; lines?: unknown }>(req)) });
  });

  r.on("POST", "/v1/matches/:id/confirm", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    return json({ match: await confirmScore(deps, p.id, user.id) });
  });

  // ----- chat -----
  r.on("GET", "/v1/chats", async (req, { deps }) => {
    const user = await auth(req, deps);
    const list = await myChats(deps, user.id);
    return json({ chats: list, players: await playerInfo(deps, list.flatMap((c) => [...c.chat.memberIds.slice(0, 6), ...(c.lastMessage?.userId ? [c.lastMessage.userId] : [])])) });
  });

  r.on("POST", "/v1/chats", async (req, { deps }) => {
    const user = await auth(req, deps);
    const b = await readJson<{ userIds?: string[]; title?: string }>(req);
    const ids = (b.userIds ?? []).map(String).filter((x) => x !== user.id).slice(0, 30);
    if (!ids.length) throw new HttpError(422, "Pick at least one player", "invalid");
    for (const id of ids) if (!(await db(deps).users.get(id))) throw new HttpError(404, "Player not found", "not_found");
    const chat = await createChat(deps, { kind: "direct", title: optStr(b.title, "title", 80) ?? "", memberIds: [user.id, ...ids] });
    return json({ chat }, 201);
  });

  r.on("GET", "/v1/chats/:id/messages", async (req, { deps }, p, url) => {
    const user = await auth(req, deps);
    const list = await messages(deps, p.id, user.id, url.searchParams.get("after"));
    const chat = (await db(deps).chats.get(p.id))!;
    return json({ chat, messages: list, players: await playerInfo(deps, [...chat.memberIds, ...list.map((m) => m.userId).filter((x): x is string => !!x)]) });
  });

  r.on("POST", "/v1/chats/:id/messages", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    const b = await readJson<{ text?: string }>(req);
    return json({ message: await postMessage(deps, p.id, user.id, String(b.text ?? "")) }, 201);
  });

  r.on("POST", "/v1/chats/:id/messages/:mid/react", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    const b = await readJson<{ emoji?: string }>(req);
    return json({ message: await react(deps, p.id, p.mid, user.id, String(b.emoji ?? "")) });
  });

  // ----- notifications -----
  r.on("GET", "/v1/notifications", async (req, { deps }) => {
    const user = await auth(req, deps);
    return json({ notifications: await listNotifications(deps, user.id) });
  });

  r.on("POST", "/v1/notifications/read", async (req, { deps }) => {
    const user = await auth(req, deps);
    const b = await readJson<{ ids?: string[] }>(req).catch(() => ({ ids: undefined }));
    return json({ updated: await markRead(deps, user.id, Array.isArray(b.ids) ? b.ids.map(String) : null) });
  });

  // ----- payments & payouts (web) -----
  r.on("POST", "/v1/entries/:id/checkout", async (req, { deps }, p) => {
    const user = await auth(req, deps);
    const entry = await db(deps).entries.get(p.id);
    if (!entry || !entry.playerIds.includes(user.id)) throw new HttpError(404, "Entry not found", "not_found");
    const ev = await requireEvent(deps, entry.eventId);
    return json({ url: await startCheckout(deps, ev, entry, user) });
  });

  r.on("POST", "/v1/payouts/onboard", async (req, { deps }) => {
    const user = await auth(req, deps);
    let acct = await db(deps).payouts.get(user.id);
    if (!acct) {
      const id = await deps.payments.createAccount(user);
      acct = { id: user.id, userId: user.id, provider: deps.payments.name, providerAccountId: id, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false };
      await db(deps).payouts.put(acct);
    }
    const back = `${deps.config.webAppUrl}#/payouts`;
    return json({ url: await deps.payments.onboardingLink(acct.providerAccountId, `${back}?status=done`, `${back}?status=retry`) });
  });

  r.on("GET", "/v1/payouts/status", async (req, { deps }) => {
    const user = await auth(req, deps);
    const acct = await db(deps).payouts.get(user.id);
    if (!acct) return json({ linked: false, ready: false });
    const status = await deps.payments.accountStatus(acct.providerAccountId);
    await db(deps).payouts.put({ ...acct, ...status });
    return json({ linked: true, ready: status.chargesEnabled });
  });

  r.on("POST", "/v1/payouts/dashboard", async (req, { deps }) => {
    const user = await auth(req, deps);
    const acct = await db(deps).payouts.get(user.id);
    if (!acct) throw new HttpError(409, "No payout account yet", "payouts_required");
    return json({ url: await deps.payments.dashboardLink(acct.providerAccountId) });
  });

  r.on("POST", "/v1/webhooks/payments", async (req, { deps }) => {
    const raw = await req.text();
    const ev = await deps.payments.parseWebhook(raw, req.headers.get("stripe-signature")).catch((e) => {
      throw new HttpError(400, (e as Error).message, "bad_signature");
    });
    if (ev?.type === "checkout_paid") await markPaid(deps, ev.providerRef);
    else if (ev?.type === "checkout_failed") await markFailed(deps, ev.providerRef);
    else if (ev?.type === "account_updated") {
      const acct = (await db(deps).payouts.find({ providerAccountId: ev.providerAccountId }))[0];
      if (acct) await db(deps).payouts.put({ ...acct, chargesEnabled: ev.chargesEnabled, payoutsEnabled: ev.payoutsEnabled, detailsSubmitted: ev.detailsSubmitted });
    }
    return json({ received: true });
  });

  // Demo / test only (mock payments): pays an entry the way the website would, without leaving the app.
  r.on("POST", "/v1/demo/pay/:entryId", async (req, { deps }, p) => {
    if (!(deps.payments instanceof MockPaymentProvider)) throw new HttpError(404, "Not found", "not_found");
    const user = await auth(req, deps);
    const entry = await db(deps).entries.get(p.entryId);
    if (!entry || !entry.playerIds.includes(user.id)) throw new HttpError(404, "Entry not found", "not_found");
    const ev = await requireEvent(deps, entry.eventId);
    const url = new URL(await startCheckout(deps, ev, entry, user));
    await markPaid(deps, url.searchParams.get("session") ?? "");
    return json({ entry: await db(deps).entries.get(entry.id) });
  });

  // Stand-in checkout for MockPaymentProvider: marks the payment paid and follows the success link.
  r.on("GET", "/v1/payments/mock-pay", async (_req, { deps }, _p, url) => {
    if (!(deps.payments instanceof MockPaymentProvider)) throw new HttpError(404, "Not found", "not_found");
    const sessionId = url.searchParams.get("session") ?? "";
    const payment = (await db(deps).payments.find({ providerRef: sessionId }))[0];
    if (!payment) throw new HttpError(404, "Unknown checkout", "not_found");
    await markPaid(deps, sessionId);
    return redirect(deps.payments.sessions.get(sessionId)?.successUrl ?? `${deps.config.webAppUrl}#/events/${payment.eventId}`);
  });

  return r;
}

const router = buildRouter();

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  const url = new URL(req.url);
  try {
    const m = router.match(req.method, url.pathname);
    if (!m) return json({ error: "Not found", code: "not_found" }, 404);
    return await m.handler(req, { deps }, m.params, url);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    console.error(e);
    return json({ error: "Something went wrong", code: "internal" }, 500);
  }
}
