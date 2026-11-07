// The Pickora API. Pure request → response; all outside services come in through Deps.

import { formScore, insights } from "./domain/form";
import { recommend } from "./domain/recommend";
import type { TournamentListing } from "./domain/types";
import { signJwt, verifyJwt } from "./adapters/crypto";
import { CORS_HEADERS, HttpError, Router, escapeHtml, html, isoDate, json, numIn, oneOf, optNumIn, optStr, readJson, redirect, str } from "./http";
import type { Deps, PickoraEvent, User } from "./ports";
import { applyRatingWebhook, linkDupr, pullHistory } from "./services/duprSync";
import { confirmScore, eventDetail, generateSchedule, markFailed, markPaid, publishEvent, refundEntry, register, reportScore, requireEvent, requireOrganizer } from "./services/events";

const SESSION_TTL = 60 * 60 * 24 * 60; // 60 days
const FORMATS = ["doubles", "mixed", "singles"] as const;

interface Ctx {
  deps: Deps;
}

async function authUser(req: Request, deps: Deps): Promise<User> {
  const h = req.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const claims = token ? await verifyJwt(token, deps.config.jwtSecret, "session", deps.now().getTime()) : null;
  if (!claims) throw new HttpError(401, "Sign in again", "unauthorized");
  const user = await deps.store.getUser(claims.sub);
  if (!user) throw new HttpError(401, "Account not found", "unauthorized");
  return user;
}

async function meView(deps: Deps, user: User) {
  const link = await deps.store.getDuprLink(user.id);
  const payout = await deps.store.getPayoutAccount(user.id);
  const matches = link ? await deps.store.getDuprMatches(user.id) : [];
  const form = formScore(matches);
  return {
    user,
    dupr: link
      ? { connected: true, duprId: link.duprId, doublesRating: link.doublesRating, singlesRating: link.singlesRating, ratingUpdatedAt: link.ratingUpdatedAt, matchesSyncedAt: link.matchesSyncedAt }
      : { connected: false },
    form: form ? { score: form.score, label: form.label, previousScore: form.previousScore } : null,
    payouts: payout ? { linked: true, chargesEnabled: payout.chargesEnabled, payoutsEnabled: payout.payoutsEnabled } : { linked: false },
  };
}

function eventFromBody(b: any, organizerId: string, id: string, now: string): PickoraEvent {
  const kind = oneOf(b.kind, "kind", ["league", "tournament"] as const);
  const minRating = optNumIn(b.minRating, "minRating", 1, 8);
  const maxRating = optNumIn(b.maxRating, "maxRating", 1, 8);
  if (minRating != null && maxRating != null && minRating > maxRating) throw new HttpError(422, "minRating is above maxRating", "invalid");
  return {
    id,
    organizerId,
    kind,
    name: str(b.name, "name", 80),
    format: oneOf(b.format, "format", FORMATS),
    startDate: isoDate(b.startDate, "startDate"),
    endDate: b.endDate ? isoDate(b.endDate, "endDate") : null,
    weeks: kind === "league" ? numIn(b.weeks ?? 8, "weeks", 1, 52) : null,
    venue: optStr(b.venue, "venue", 120) ?? "",
    city: optStr(b.city, "city", 80) ?? "",
    state: optStr(b.state, "state", 40) ?? "",
    lat: optNumIn(b.lat, "lat", -90, 90),
    lng: optNumIn(b.lng, "lng", -180, 180),
    minRating,
    maxRating,
    capacity: numIn(b.capacity ?? 16, "capacity", 2, 512),
    feeCents: Math.round(numIn(b.feeCents ?? 0, "feeCents", 0, 100_000)),
    currency: "usd",
    requireDuprVerified: b.requireDuprVerified !== false,
    submitToDupr: b.submitToDupr !== false,
    status: "draft",
    createdAt: now,
  };
}

function returnUrls(deps: Deps, client: string | null, eventId: string) {
  const base = client === "web" ? `${deps.config.webAppUrl}#/events/${eventId}` : `${deps.config.appScheme}://events/${eventId}`;
  return { success: `${base}${client === "web" ? "?" : "?"}paid=1`, cancel: `${base}?paid=0` };
}

// ---------- HTML pages hosted by the API ----------

function page(title: string, body: string, script = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{margin:0;background:#0A0F24;color:#F4F6FF;font:16px/1.45 -apple-system,system-ui,Inter,sans-serif;min-height:100vh;display:flex;flex-direction:column}
header{padding:16px 20px;font-weight:700;font-size:20px;letter-spacing:-.3px}header b{color:#D4FF3A}
main{flex:1;display:flex;flex-direction:column;padding:0 16px 24px;gap:12px}
iframe{flex:1;width:100%;min-height:640px;border:0;border-radius:18px;background:#fff}
.card{background:#141B38;border:1px solid #2A3466;border-radius:18px;padding:18px}
button,a.btn{display:block;width:100%;height:52px;border:0;border-radius:16px;background:#D4FF3A;color:#0A0F24;font-weight:700;font-size:17px;text-align:center;line-height:52px;text-decoration:none}
.muted{color:#A9B1D6}.err{color:#FF8A6E}
</style></head><body><header>Pick<b>ora</b></header><main>${body}</main>${script}</body></html>`;
}

function duprConnectPage(ssoUrl: string, connectToken: string, doneUrl: string, apiBase: string): string {
  const origin = new URL(ssoUrl).origin;
  return page(
    "Connect DUPR",
    `<p class="muted" id="msg">Log in to DUPR to connect it to Pickora. You only do this once.</p>
<iframe id="dupr" src="${escapeHtml(ssoUrl)}" allow="payment" title="DUPR login"></iframe>`,
    `<script>
(function(){
  var msg=document.getElementById('msg');
  window.addEventListener('message', function(ev){
    if (ev.origin !== ${JSON.stringify(origin)}) return;
    var d = ev.data || {};
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    var token = d.userToken || d.accessToken; var refresh = d.refreshToken;
    if (!token || !refresh) return;
    msg.textContent='Connecting your DUPR account…';
    fetch(${JSON.stringify(apiBase + "/v1/dupr/link")}, {method:'POST', headers:{'content-type':'application/json','authorization':'Bearer '+${JSON.stringify(connectToken)}}, body: JSON.stringify({userToken: token, refreshToken: refresh})})
      .then(function(r){ return r.json().then(function(b){ if(!r.ok) throw new Error(b.error||'Could not connect'); return b; }); })
      .then(function(){ location.replace(${JSON.stringify(doneUrl)} + '?status=connected'); })
      .catch(function(e){ msg.className='err'; msg.textContent=e.message+' Try again.'; });
  }, false);
})();
</script>`,
  );
}

// ---------- routes ----------

export function buildRouter(): Router<Ctx> {
  const r = new Router<Ctx>();

  r.on("GET", "/v1/health", async (_q, { deps }) =>
    json({ ok: true, dupr: deps.dupr.name, payments: deps.payments.name, tournamentSources: deps.tournamentSources.map((s) => ({ name: s.name, enabled: s.enabled })) }),
  );

  // ----- sign in -----
  r.on("POST", "/v1/auth/apple", async (req, { deps }) => {
    const b = await readJson<{ identityToken?: string; name?: string }>(req);
    const id = await deps.identity.verify(str(b.identityToken, "identityToken", 4000)).catch((e) => {
      throw new HttpError(401, `Sign in failed: ${(e as Error).message}`, "unauthorized");
    });
    let user = await deps.store.getUserByAppleSub(id.subject);
    if (!user) {
      user = {
        id: deps.newId(),
        appleSub: id.subject,
        email: id.email,
        name: (b.name && b.name.trim().slice(0, 80)) || "Player",
        lat: null,
        lng: null,
        maxDistanceMiles: 75,
        formats: ["doubles", "mixed"],
        createdAt: deps.now().toISOString(),
      };
      await deps.store.saveUser(user);
    }
    const token = await signJwt({ sub: user.id, purpose: "session" }, deps.config.jwtSecret, SESSION_TTL, deps.now().getTime());
    return json({ token, ...(await meView(deps, user)) });
  });

  // ----- me -----
  r.on("GET", "/v1/me", async (req, { deps }) => json(await meView(deps, await authUser(req, deps))));

  r.on("PATCH", "/v1/me", async (req, { deps }) => {
    const user = await authUser(req, deps);
    const b = await readJson<any>(req);
    const updated: User = {
      ...user,
      name: b.name != null ? str(b.name, "name", 80) : user.name,
      lat: b.lat !== undefined ? optNumIn(b.lat, "lat", -90, 90) : user.lat,
      lng: b.lng !== undefined ? optNumIn(b.lng, "lng", -180, 180) : user.lng,
      maxDistanceMiles: b.maxDistanceMiles != null ? numIn(b.maxDistanceMiles, "maxDistanceMiles", 5, 1000) : user.maxDistanceMiles,
      formats: Array.isArray(b.formats) ? b.formats.map((f: unknown) => oneOf(f, "formats", FORMATS)) : user.formats,
    };
    await deps.store.saveUser(updated);
    return json(await meView(deps, updated));
  });

  r.on("DELETE", "/v1/me", async (req, { deps }) => {
    const user = await authUser(req, deps);
    await deps.store.deleteUser(user.id);
    return json({ deleted: true });
  });

  // ----- DUPR -----
  r.on("POST", "/v1/dupr/connect-session", async (req, { deps }) => {
    const user = await authUser(req, deps);
    const b = await readJson<{ client?: string }>(req).catch(() => ({ client: "app" }));
    const t = await signJwt({ sub: user.id, purpose: "dupr_connect" }, deps.config.jwtSecret, 15 * 60, deps.now().getTime());
    const client = b.client === "web" ? "web" : "app";
    return json({ url: `${deps.config.publicBaseUrl}/v1/dupr/connect?t=${encodeURIComponent(t)}&client=${client}`, callbackScheme: deps.config.appScheme });
  });

  r.on("GET", "/v1/dupr/connect", async (_req, { deps }, _p, url) => {
    const t = url.searchParams.get("t") ?? "";
    const claims = await verifyJwt(t, deps.config.jwtSecret, "dupr_connect", deps.now().getTime());
    if (!claims) return html(page("Link expired", `<div class="card"><p>This link has expired. Go back to Pickora and tap Connect DUPR again.</p></div>`), 401);
    const done = url.searchParams.get("client") === "web" ? `${deps.config.webAppUrl}#/dupr` : `${deps.config.appScheme}://dupr`;
    return html(duprConnectPage(deps.dupr.ssoUrl(), t, done, deps.config.publicBaseUrl));
  });

  // Stand-in DUPR login used by MockDuprProvider (sends the same kind of message DUPR's page does).
  r.on("GET", "/v1/dupr/mock-login", async () =>
    html(
      page(
        "DUPR (test)",
        `<div class="card"><p><b>Test DUPR login</b></p><p class="muted">Pickora is not connected to real DUPR yet, so this stands in for it. You'll get sample ratings and matches.</p></div><button id="go">Log in and allow access</button>`,
        `<script>document.getElementById('go').onclick=function(){var n=Math.random().toString(36).slice(2,8);parent.postMessage({userToken:'mock-'+n,refreshToken:'refresh-'+n,id:'mock-'+n,duprId:'MOCK'},location.origin);};</script>`,
      ).replace("x-frame-options", "x-frame"),
    ),
  );

  r.on("POST", "/v1/dupr/link", async (req, { deps }) => {
    const h = req.headers.get("authorization") ?? "";
    const claims = await verifyJwt(h.replace(/^Bearer /, ""), deps.config.jwtSecret, "dupr_connect", deps.now().getTime());
    const userId = claims?.sub ?? (await authUser(req, deps)).id;
    const b = await readJson<{ userToken?: string; refreshToken?: string }>(req);
    const link = await linkDupr(deps, userId, str(b.userToken, "userToken", 4000), str(b.refreshToken, "refreshToken", 4000));
    return json({ connected: true, duprId: link.duprId, doublesRating: link.doublesRating, singlesRating: link.singlesRating });
  });

  r.on("DELETE", "/v1/dupr/link", async (req, { deps }) => {
    const user = await authUser(req, deps);
    await deps.store.deleteDuprLink(user.id);
    return json({ connected: false });
  });

  r.on("POST", "/v1/dupr/sync", async (req, { deps }) => {
    const user = await authUser(req, deps);
    const link = await deps.store.getDuprLink(user.id);
    if (!link) throw new HttpError(409, "Connect DUPR first", "dupr_required");
    try {
      await pullHistory(deps, link);
    } catch (e) {
      throw new HttpError(502, `DUPR sync failed: ${(e as Error).message}`, "dupr_unavailable");
    }
    return json(await meView(deps, user));
  });

  r.on("POST", "/v1/webhooks/dupr", async (req, { deps }) => {
    const body = await readJson<unknown>(req);
    const updated = await applyRatingWebhook(deps, body);
    return json({ received: true, updated });
  });

  // ----- form & insights -----
  r.on("GET", "/v1/me/form", async (req, { deps }) => {
    const user = await authUser(req, deps);
    const matches = await deps.store.getDuprMatches(user.id);
    return json({ form: formScore(matches), insights: insights(matches), matches });
  });

  // ----- tournament recommendations -----
  r.on("GET", "/v1/tournaments/recommended", async (req, { deps }, _p, url) => {
    const user = await authUser(req, deps);
    const lat = optNumIn(url.searchParams.get("lat"), "lat", -90, 90) ?? user.lat;
    const lng = optNumIn(url.searchParams.get("lng"), "lng", -180, 180) ?? user.lng;
    if (lat == null || lng == null) throw new HttpError(422, "Set your location first", "location_required");
    const radius = optNumIn(url.searchParams.get("radius"), "radius", 5, 1000) ?? user.maxDistanceMiles;
    const today = deps.now().toISOString().slice(0, 10);
    const listings: TournamentListing[] = [];
    const sources: { name: string; ok: boolean; count: number; error?: string }[] = [];
    await Promise.all(
      deps.tournamentSources
        .filter((s) => s.enabled)
        .map(async (s) => {
          try {
            const rows = await s.search({ lat, lng, radiusMiles: radius, today });
            listings.push(...rows);
            sources.push({ name: s.name, ok: true, count: rows.length });
          } catch (e) {
            sources.push({ name: s.name, ok: false, count: 0, error: (e as Error).message });
          }
        }),
    );
    const link = await deps.store.getDuprLink(user.id);
    const form = formScore(await deps.store.getDuprMatches(user.id));
    const recs = recommend(
      { doublesRating: link?.doublesRating ?? null, singlesRating: link?.singlesRating ?? null, form: form?.score ?? null, lat, lng, maxDistanceMiles: radius, formats: user.formats },
      listings,
      today,
      20,
    );
    return json({ recommendations: recs, sources });
  });

  // ----- events (leagues & tournaments) -----
  r.on("POST", "/v1/events", async (req, { deps }) => {
    const user = await authUser(req, deps);
    const ev = eventFromBody(await readJson<any>(req), user.id, deps.newId(), deps.now().toISOString());
    await deps.store.saveEvent(ev);
    return json({ event: ev }, 201);
  });

  r.on("GET", "/v1/events", async (req, { deps }, _p, url) => {
    const user = await authUser(req, deps);
    const scope = url.searchParams.get("scope") ?? "mine";
    if (scope === "organizing") return json({ events: await deps.store.listEventsByOrganizer(user.id) });
    if (scope === "open") return json({ events: await deps.store.listOpenEvents() });
    const playing = await deps.store.listEventsForPlayer(user.id);
    const organizing = await deps.store.listEventsByOrganizer(user.id);
    const all = new Map([...organizing, ...playing].map((e) => [e.id, e]));
    return json({ events: [...all.values()].sort((a, b) => a.startDate.localeCompare(b.startDate)) });
  });

  r.on("GET", "/v1/events/:id", async (req, { deps }, p) => {
    const user = await authUser(req, deps);
    const ev = await requireEvent(deps, p.id);
    if (ev.status === "draft" && ev.organizerId !== user.id) throw new HttpError(404, "Event not found", "not_found");
    const detail = await eventDetail(deps, ev);
    const isOrganizer = ev.organizerId === user.id;
    const payments = isOrganizer ? await deps.store.listPaymentsForEvent(ev.id) : [];
    const collected = payments.filter((x) => x.status === "paid").reduce((s, x) => s + x.amountCents - x.applicationFeeCents, 0);
    // Player names for display.
    const names: Record<string, string> = {};
    for (const e of detail.entries) for (const pid of e.playerIds) names[pid] ??= (await deps.store.getUser(pid))?.name ?? "Player";
    return json({ ...detail, isOrganizer, names, money: isOrganizer ? { collectedCents: collected, paidEntries: payments.filter((x) => x.status === "paid").length } : null });
  });

  r.on("PATCH", "/v1/events/:id", async (req, { deps }, p) => {
    const user = await authUser(req, deps);
    const ev = await requireOrganizer(deps, p.id, user.id);
    if (ev.status !== "draft") throw new HttpError(409, "Published events can't be edited here", "locked");
    const merged = eventFromBody({ ...ev, ...(await readJson<any>(req)) }, ev.organizerId, ev.id, ev.createdAt);
    await deps.store.saveEvent(merged);
    return json({ event: merged });
  });

  r.on("POST", "/v1/events/:id/publish", async (req, { deps }, p) => {
    const user = await authUser(req, deps);
    return json({ event: await publishEvent(deps, await requireOrganizer(deps, p.id, user.id)) });
  });

  r.on("POST", "/v1/events/:id/close", async (req, { deps }, p) => {
    const user = await authUser(req, deps);
    const ev = await requireOrganizer(deps, p.id, user.id);
    const updated = { ...ev, status: "closed" as const };
    await deps.store.saveEvent(updated);
    return json({ event: updated });
  });

  r.on("POST", "/v1/events/:id/schedule", async (req, { deps }, p) => {
    const user = await authUser(req, deps);
    const ev = await requireOrganizer(deps, p.id, user.id);
    return json({ matches: await generateSchedule(deps, ev) });
  });

  r.on("POST", "/v1/events/:id/register", async (req, { deps }, p, url) => {
    const user = await authUser(req, deps);
    const ev = await requireEvent(deps, p.id);
    const b = await readJson<{ partnerUserId?: string; partnerDuprId?: string; teamName?: string }>(req);
    let partner = b.partnerUserId ?? null;
    if (!partner && b.partnerDuprId) partner = (await deps.store.getDuprLinkByDuprId(b.partnerDuprId.trim().toUpperCase()))?.userId ?? null;
    if (!partner && b.partnerDuprId) throw new HttpError(404, "No Pickora player has connected that DUPR ID yet", "partner_not_found");
    const urls = returnUrls(deps, url.searchParams.get("client"), ev.id);
    const result = await register(deps, ev, user, partner, b.teamName ? str(b.teamName, "teamName", 60) : null, urls.success, urls.cancel);
    return json(result, 201);
  });

  r.on("POST", "/v1/events/:id/entries/:entryId/refund", async (req, { deps }, p) => {
    const user = await authUser(req, deps);
    const ev = await requireOrganizer(deps, p.id, user.id);
    return json({ entry: await refundEntry(deps, ev, p.entryId) });
  });

  r.on("POST", "/v1/matches/:id/score", async (req, { deps }, p) => {
    const user = await authUser(req, deps);
    const b = await readJson<{ games?: unknown }>(req);
    return json({ match: await reportScore(deps, p.id, user.id, b.games) });
  });

  r.on("POST", "/v1/matches/:id/confirm", async (req, { deps }, p) => {
    const user = await authUser(req, deps);
    return json({ match: await confirmScore(deps, p.id, user.id) });
  });

  // ----- payouts (organizer's linked account) -----
  r.on("POST", "/v1/payouts/onboard", async (req, { deps }, _p, url) => {
    const user = await authUser(req, deps);
    let acct = await deps.store.getPayoutAccount(user.id);
    if (!acct) {
      const id = await deps.payments.createAccount(user);
      acct = { userId: user.id, provider: deps.payments.name, providerAccountId: id, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false };
      await deps.store.savePayoutAccount(acct);
    }
    const back = url.searchParams.get("client") === "web" ? `${deps.config.webAppUrl}#/payouts` : `${deps.config.appScheme}://payouts`;
    const link = await deps.payments.onboardingLink(acct.providerAccountId, `${back}?status=done`, `${back}?status=retry`);
    return json({ url: link, callbackScheme: deps.config.appScheme });
  });

  r.on("GET", "/v1/payouts/status", async (req, { deps }) => {
    const user = await authUser(req, deps);
    const acct = await deps.store.getPayoutAccount(user.id);
    if (!acct) return json({ linked: false });
    const status = await deps.payments.accountStatus(acct.providerAccountId);
    const updated = { ...acct, ...status };
    await deps.store.savePayoutAccount(updated);
    return json({ linked: true, ...status });
  });

  r.on("POST", "/v1/payouts/dashboard", async (req, { deps }) => {
    const user = await authUser(req, deps);
    const acct = await deps.store.getPayoutAccount(user.id);
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
      const acct = await deps.store.getPayoutAccountByProviderId(ev.providerAccountId);
      if (acct) await deps.store.savePayoutAccount({ ...acct, chargesEnabled: ev.chargesEnabled, payoutsEnabled: ev.payoutsEnabled, detailsSubmitted: ev.detailsSubmitted });
    }
    return json({ received: true });
  });

  // Stand-in checkout used by MockPaymentProvider: marks the payment paid and returns to the app.
  r.on("GET", "/v1/payments/mock-pay", async (_req, { deps }, _p, url) => {
    if (deps.payments.name !== "mock") throw new HttpError(404, "Not found", "not_found");
    const session = url.searchParams.get("session") ?? "";
    const payment = await deps.store.getPaymentByProviderRef(session);
    if (!payment) throw new HttpError(404, "Unknown checkout", "not_found");
    await markPaid(deps, session);
    const ev = await deps.store.getEvent(payment.eventId);
    return redirect(`${deps.config.appScheme}://events/${ev?.id ?? ""}?paid=1`);
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
