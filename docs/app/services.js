// Backends for the web app: LiveService (the Pickora API) and DemoService (sample data in the browser).
// Same surface as ios/Pickora/Services/PickoraService.swift.
import * as E from "./engine.js";

const today = () => new Date().toISOString().slice(0, 10);

export class ServiceError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class LiveService {
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/$/, "");
    this.isDemo = false;
    try { this.token = localStorage.getItem("pickora.token"); } catch { this.token = null; }
  }
  setToken(t) {
    this.token = t;
    try { t ? localStorage.setItem("pickora.token", t) : localStorage.removeItem("pickora.token"); } catch {}
  }
  async req(method, path, body, query) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v != null) url.searchParams.set(k, String(v));
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) this.setToken(null);
      throw new ServiceError(data.error ?? `Something went wrong (${res.status})`, data.code, res.status);
    }
    return data;
  }
  async signIn(identityToken, name) {
    const me = await this.req("POST", "/v1/auth/apple", { identityToken, name });
    this.setToken(me.token);
    return me;
  }
  async restore() {
    if (!this.token) return null;
    try { return await this.me(); } catch (e) { if (e.status === 401) return null; throw e; }
  }
  me() { return this.req("GET", "/v1/me"); }
  updateProfile(p) { return this.req("PATCH", "/v1/me", p); }
  async deleteAccount() { await this.req("DELETE", "/v1/me"); this.setToken(null); }
  signOut() { this.setToken(null); }
  async duprConnectURL() { return (await this.req("POST", "/v1/dupr/connect-session", { client: "web" })).url; }
  completeDuprConnect() { return this.me(); }
  syncDupr() { return this.req("POST", "/v1/dupr/sync"); }
  async disconnectDupr() { await this.req("DELETE", "/v1/dupr/link"); return this.me(); }
  form() { return this.req("GET", "/v1/me/form"); }
  recommended(lat, lng, radius) { return this.req("GET", "/v1/tournaments/recommended", undefined, { lat, lng, radius }); }
  async events() { return (await this.req("GET", "/v1/events", undefined, { scope: "mine" })).events; }
  async createEvent(d) { return (await this.req("POST", "/v1/events", d)).event; }
  async publish(id) { return (await this.req("POST", `/v1/events/${id}/publish`)).event; }
  async generateSchedule(id) { return (await this.req("POST", `/v1/events/${id}/schedule`)).matches; }
  event(id) { return this.req("GET", `/v1/events/${id}`); }
  register(id, partnerDuprId, teamName) { return this.req("POST", `/v1/events/${id}/register`, { partnerDuprId, teamName }, { client: "web" }); }
  async reportScore(id, games) { return (await this.req("POST", `/v1/matches/${id}/score`, { games })).match; }
  async confirmScore(id) { return (await this.req("POST", `/v1/matches/${id}/confirm`)).match; }
  async onboardPayouts() { return (await this.req("POST", "/v1/payouts/onboard", undefined, { client: "web" })).url; }
  payoutStatus() { return this.req("GET", "/v1/payouts/status"); }
}

const OTHERS = [
  ["demo-pk", "Priya K.", "DEMO-PK01", 4.04], ["demo-md", "Marco D.", "DEMO-MD02", 3.95], ["demo-ls", "Lena S.", "DEMO-LS03", 3.99],
  ["demo-cw", "Chen W.", "DEMO-CW04", 4.18], ["demo-aa", "Ana A.", "DEMO-AA05", 4.12], ["demo-so", "Sam O.", "DEMO-SO06", 4.06],
  ["demo-dp", "Dev P.", "DEMO-DP07", 4.1], ["demo-bt", "Brooks T.", "DEMO-BT08", 4.21], ["demo-hr", "Hale R.", "DEMO-HR09", 4.19],
].map(([id, name, dupr, rating]) => ({ id, name, dupr, rating }));

export class DemoService {
  constructor() {
    this.isDemo = true;
    const p = E.samplePlayer;
    this.user = { id: "demo-me", name: p.name, email: null, lat: p.lat, lng: p.lng, maxDistanceMiles: 75, formats: ["doubles", "mixed"] };
    this.signedIn = false;
    this.dupr = false;
    this.payouts = false;
    this.events_ = new Map();
    this.entries = new Map();
    this.matches = new Map();
    this.names = { "demo-me": p.name, ...Object.fromEntries(OTHERS.map((o) => [o.id, o.name])) };
    this.n = 0;
    this.seed();
  }
  id(prefix) { return `${prefix}-${++this.n}`; }
  rating(id) { return id === "demo-me" ? E.samplePlayer.doublesRating : OTHERS.find((o) => o.id === id)?.rating ?? 4; }
  playedMatches() { return this.dupr ? E.sampleMatches(today()) : []; }
  currentMe() {
    const f = E.formScore(this.playedMatches());
    const p = E.samplePlayer;
    return {
      user: this.user,
      dupr: this.dupr ? { connected: true, duprId: p.duprId, doublesRating: p.doublesRating, singlesRating: p.singlesRating, matchesSyncedAt: new Date().toISOString() } : { connected: false },
      form: f ? { score: f.score, label: f.label, previousScore: f.previousScore } : null,
      payouts: { linked: this.payouts, chargesEnabled: this.payouts, payoutsEnabled: this.payouts },
    };
  }
  async signIn(_t, name) { this.signedIn = true; if (name) { this.user.name = name; this.names["demo-me"] = name; } return this.currentMe(); }
  async restore() { return this.signedIn ? this.currentMe() : null; }
  async me() { return this.currentMe(); }
  async updateProfile(p) { Object.assign(this.user, Object.fromEntries(Object.entries(p).filter(([, v]) => v != null))); return this.currentMe(); }
  async deleteAccount() { this.signOut(); }
  signOut() { this.signedIn = false; this.dupr = false; this.payouts = false; }
  async duprConnectURL() { return null; }
  async completeDuprConnect() { await new Promise((r) => setTimeout(r, 500)); this.dupr = true; return this.currentMe(); }
  async syncDupr() { return this.currentMe(); }
  async disconnectDupr() { this.dupr = false; return this.currentMe(); }
  async form() { const m = this.playedMatches(); return { form: E.formScore(m), insights: E.insights(m), matches: [...m].sort((a, b) => b.playedAt.localeCompare(a.playedAt)) }; }
  async recommended(lat, lng, radius) {
    const me = this.currentMe();
    const listings = E.sampleTournaments(today());
    const recs = E.recommend({ doublesRating: me.dupr.doublesRating ?? null, singlesRating: me.dupr.singlesRating ?? null, form: me.form?.score ?? null, lat: lat ?? this.user.lat, lng: lng ?? this.user.lng, maxDistanceMiles: radius ?? this.user.maxDistanceMiles, formats: this.user.formats }, listings, today(), 20);
    return { recommendations: recs, sources: [{ name: "sample", ok: true, count: listings.length }, { name: "pickleball.com", ok: false, count: 0 }, { name: "fluidpb", ok: false, count: 0 }] };
  }
  async events() { return [...this.events_.values()].sort((a, b) => a.startDate.localeCompare(b.startDate)); }
  async createEvent(d) {
    if (!d.name?.trim()) throw new ServiceError("Give your event a name.");
    const ev = { ...d, id: this.id("ev"), organizerId: "demo-me", endDate: null, currency: "usd", status: "draft", createdAt: new Date().toISOString() };
    this.events_.set(ev.id, ev);
    const pairs = [[OTHERS[1], OTHERS[2]], [OTHERS[3], OTHERS[4]], [OTHERS[7], OTHERS[8]]];
    this.entries.set(ev.id, pairs.map(([a, b]) => ({ id: this.id("en"), eventId: ev.id, playerIds: [a.id, b.id], teamName: `${a.name.split(" ")[0]} / ${b.name.split(" ")[0]}`, teamRating: (a.rating + b.rating) / 2, status: "confirmed", createdAt: ev.createdAt })));
    return ev;
  }
  async publish(id) {
    const ev = this.events_.get(id);
    if (ev.feeCents > 0 && !this.payouts) throw new ServiceError("Link a payout account before opening a paid event", "payouts_required");
    ev.status = "open";
    return ev;
  }
  async generateSchedule(id) {
    const ev = this.events_.get(id);
    if (this.matches.get(id)?.length) return this.matches.get(id);
    const entries = (this.entries.get(id) ?? []).filter((e) => e.status === "confirmed").sort((a, b) => (b.teamRating ?? 0) - (a.teamRating ?? 0));
    if (entries.length < 2) throw new ServiceError("Need at least two confirmed entries");
    const ids = entries.map((e) => e.id);
    const groups = ev.kind === "league" ? [ids] : E.snakePools(ids, Math.max(1, Math.round(ids.length / 4)));
    const out = [];
    groups.forEach((g, i) => {
      for (const p of E.roundRobin(g)) out.push({ id: this.id("m"), eventId: id, round: p.round, pool: ev.kind === "league" ? null : i + 1, homeEntryId: p.home, awayEntryId: p.away, court: `Ct ${(out.length % 6) + 1}`, games: [], status: "scheduled" });
    });
    this.matches.set(id, out);
    ev.status = "in_progress";
    return out;
  }
  async event(id) {
    const ev = this.events_.get(id);
    if (!ev) throw new ServiceError("Event not found");
    const entries = this.entries.get(id) ?? [];
    const ms = this.matches.get(id) ?? [];
    const pools = [...new Set(ms.map((m) => m.pool))];
    const live = entries.filter((e) => e.status === "confirmed");
    const standings = (pools.length ? pools : [null]).map((pool) => {
      const inPool = ms.filter((m) => m.pool === pool);
      const ids = pools.length ? [...new Set(inPool.flatMap((m) => [m.homeEntryId, m.awayEntryId]))] : live.map((e) => e.id);
      const results = inPool.filter((m) => m.status === "confirmed").map((m) => ({ home: m.homeEntryId, away: m.awayEntryId, games: m.games.map((g) => ({ home: g.us, away: g.them })) }));
      return { pool, table: E.standings(ids, results) };
    });
    const mine = ev.organizerId === "demo-me";
    const paid = live.filter((e) => !e.playerIds.includes("demo-me")).length;
    return { event: ev, entries, matches: ms, standings, playoffs: [], isOrganizer: mine, names: this.names, money: mine ? { collectedCents: paid * ev.feeCents * (ev.format === "singles" ? 1 : 2), paidEntries: paid } : null };
  }
  async register(id, partnerDuprId, teamName) {
    const ev = this.events_.get(id);
    if (ev.status !== "open") throw new ServiceError("Registration is not open");
    if (!this.dupr) throw new ServiceError("Connect your DUPR account first");
    const players = ["demo-me"];
    if (ev.format !== "singles") {
      const p = OTHERS.find((o) => o.dupr === (partnerDuprId ?? "").trim().toUpperCase());
      if (!p) throw new ServiceError("No Pickora player has connected that DUPR ID yet. In the demo, try DEMO-PK01.");
      players.push(p.id);
    }
    const entry = { id: this.id("en"), eventId: id, playerIds: players, teamName: teamName || players.map((x) => this.names[x].split(" ")[0]).join(" / "), teamRating: players.reduce((s, x) => s + this.rating(x), 0) / players.length, status: "confirmed", createdAt: new Date().toISOString() };
    this.entries.get(id).push(entry);
    return { entry, checkoutUrl: null };
  }
  findMatch(id) {
    for (const [eid, list] of this.matches) { const m = list.find((x) => x.id === id); if (m) return [eid, m]; }
    throw new ServiceError("Match not found");
  }
  async reportScore(id, games) {
    const [eid, m] = this.findMatch(id);
    if (!games.length || games.some((g) => g.us === g.them)) throw new ServiceError("Each game needs two different scores");
    m.games = games;
    m.status = this.events_.get(eid).organizerId === "demo-me" ? "confirmed" : "reported";
    m.reportedBy = "demo-me";
    if (m.status === "confirmed") m.duprMatchId = `demo-${m.id}`;
    return m;
  }
  async confirmScore(id) { const [, m] = this.findMatch(id); m.status = "confirmed"; m.duprMatchId = `demo-${m.id}`; return m; }
  async onboardPayouts() { await new Promise((r) => setTimeout(r, 400)); this.payouts = true; return null; }
  async payoutStatus() { return { linked: this.payouts, chargesEnabled: this.payouts, payoutsEnabled: this.payouts }; }

  seed() {
    for (const lg of E.sampleLeagues) {
      const ev = { id: lg.id, organizerId: "demo-cw", kind: "league", name: lg.name, format: lg.format, startDate: E.addDays(today(), -7 * (lg.currentWeek - 1)), endDate: null, weeks: lg.weeks, venue: "Sample Community Courts", city: "Round Rock", state: "TX", lat: 30.51, lng: -97.67, minRating: 3.75, maxRating: 4.49, capacity: lg.players / 2, feeCents: lg.feeCents, currency: "usd", requireDuprVerified: true, submitToDupr: true, status: "in_progress", createdAt: new Date().toISOString() };
      this.events_.set(ev.id, ev);
      const teams = [["demo-me", "demo-pk"], ["demo-md", "demo-ls"], ["demo-cw", "demo-aa"], ["demo-so", "demo-dp"]];
      const entries = teams.map((ps) => ({ id: `${lg.id}-${ps[0]}`, eventId: ev.id, playerIds: ps, teamName: ps.map((x) => this.names[x].split(" ")[0]).join(" / "), teamRating: ps.reduce((s, x) => s + this.rating(x), 0) / 2, status: "confirmed", createdAt: ev.createdAt }));
      this.entries.set(ev.id, entries);
      const scores = [[{ us: 11, them: 7 }], [{ us: 9, them: 11 }], [{ us: 11, them: 8 }], [{ us: 11, them: 5 }]];
      this.matches.set(ev.id, E.roundRobin(entries.map((e) => e.id)).map((p, k) => {
        const done = p.round <= 2;
        return { id: `${lg.id}-m${k}`, eventId: ev.id, round: p.round, pool: null, homeEntryId: p.home, awayEntryId: p.away, court: `Ct ${(k % 4) + 1}`, games: done ? scores[k % 4] : [], status: done ? "confirmed" : "scheduled", duprMatchId: done ? "demo" : null };
      }));
    }
  }
}
