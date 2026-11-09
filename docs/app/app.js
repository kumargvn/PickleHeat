// PickleHeat web app. Same API as the iPhone app. Entry fees and organizer payouts happen here
// (the iPhone app sends people to this website for payments).

const cfg = window.PICKLEHEAT_CONFIG ?? {};
const LIVE = !!cfg.PICKLEHEAT_API_URL;
const TOKEN_KEY = LIVE ? "pickleheat-token" : "pickleheat-demo-token";
const view = document.getElementById("view");
const state = { me: null, form: null, recs: null, discover: null, events: [], eventsTab: "discover", eventTab: {}, roundSel: {}, poll: null };

// ---------- transport ----------
let demoReady = null;
function loadDemo() {
  demoReady ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "demo-api.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Couldn't load the demo"));
    document.head.appendChild(s);
  });
  return demoReady;
}

const store = {
  get() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
};

class ApiError extends Error { constructor(msg, status, code) { super(msg); this.status = status; this.code = code; } }

async function api(method, path, body) {
  const token = store.get();
  let status, text;
  if (LIVE) {
    const res = await fetch(cfg.PICKLEHEAT_API_URL.replace(/\/$/, "") + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    status = res.status;
    text = await res.text();
  } else {
    await loadDemo();
    const r = await globalThis.PickleHeatDemo.call(method, path, body != null ? JSON.stringify(body) : null, token);
    status = r.status;
    text = r.body;
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (status < 200 || status >= 300) {
    if (status === 401) store.set(null);
    throw new ApiError(data?.error ?? `Something went wrong (${status})`, status, data?.code);
  }
  return data;
}

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const r2 = (x) => (x == null ? "—" : Number(x).toFixed(2));
const money = (c) => `$${(c / 100).toFixed(c % 100 === 0 ? 0 : 2)}`;
const pretty = (d) => (d ? new Date(d.slice(0, 10) + "T12:00:00Z").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "");
const ago = (iso) => {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const labelColor = (l) => (l === "Hot" || l === "Rising" ? "var(--lime)" : l === "Steady" ? "var(--text)" : "var(--coral)");
const STATUS = { draft: "Draft", open: "Registration open", closed: "Registration closed", in_progress: "In progress", completed: "Completed" };
const ENTRY = { pending_payment: "Payment due", confirmed: "Registered", waitlisted: "Waitlist", withdrawn: "Withdrawn", refunded: "Refunded" };
const STYLE = { flex_ladder: "Heat Climb", scramble: "Wildfire Mixer", round_robin: "Round robin", pools_playoffs: "Pools + playoffs", single_elim: "Single elimination", double_elim: "Double elimination" };
const BLURB = {
  flex_ladder: "Sign up solo. Each round you're placed in a heat of 4 near your level and play rotating partners. Win your heat to climb; last place drops a heat.",
  scramble: "Sign up solo. A new heat and new partners every round. Standings by total games won.",
  round_robin: "Fixed teams. Everyone plays everyone.",
  pools_playoffs: "Fixed teams. Pools first, then a playoff bracket.",
  single_elim: "Fixed teams. Lose once and you're out.",
  double_elim: "Fixed teams. Lose twice and you're out, with a grand final.",
};
const FORMAT = { doubles: "Doubles", mixed: "Mixed", singles: "Singles", mlp: "MLP teams", trips: "Trips" };
const TEAM_SIZE = { singles: 1, doubles: 2, mixed: 2, trips: 3, mlp: 4 };
const individual = (s) => s === "flex_ladder" || s === "scramble";
const teamSize = (e) => (individual(e.style) ? 1 : TEAM_SIZE[e.format]);
const isPaid = (e) => e.feeCents > 0 || (e.memberFeeCents ?? 0) > 0;
const range = (e) => (e.minRating != null && e.maxRating != null ? `${r2(e.minRating)}–${r2(e.maxRating)}` : e.minRating != null ? `${r2(e.minRating)}+` : e.maxRating != null ? `up to ${r2(e.maxRating)}` : "Open");
const first = (players, id) => (players[id]?.name ?? "Player").split(" ")[0];
const fullName = (players, id) => players[id]?.name ?? "Player";
const ratingLine = (p) => (p?.rating == null ? "No DUPR" : p.reliability != null ? `${r2(p.rating)} · ${Math.round(p.reliability)}%` : r2(p.rating));
const initials = (p) => (p?.name ?? "?").split(" ").slice(0, 2).map((x) => x[0]).join("");
const avatar = (p, size = 34) => `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${size * 0.38}px" aria-hidden="true">${esc(initials(p))}</span>`;
const tile = (txt, color) => `<span class="tile" style="background:${color}">${txt}</span>`;
const pill = (txt, fg = "var(--text)", bg = "var(--surface2)") => `<span class="pill" style="color:${fg};background:${bg}">${esc(txt)}</span>`;
const empty = (title, msg) => `<div class="card stack" style="gap:6px"><h3>${esc(title)}</h3><p class="muted small" style="margin:0">${esc(msg)}</p></div>`;
const tabs = (items, current, act) => `<div class="chips" role="tablist">${items.map(([k, label]) => `<button role="tab" aria-selected="${k === current}" class="${k === current ? "on" : ""}" data-act="${act}" data-k="${k}">${esc(label)}</button>`).join("")}</div>`;

function toast(msg, good = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.style.background = good ? "var(--lime)" : "var(--coral)";
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 4500);
}

async function run(fn) {
  try { return await fn(); } catch (e) {
    if (e.status === 401) { state.me = null; location.hash = "#/signin"; }
    toast(e.message || "Something went wrong");
    return undefined;
  }
}

const go = (hash) => (location.hash === hash ? route() : (location.hash = hash));

function ring(score, label, size = 128, color = "var(--ink)", track = "rgba(10,15,36,.14)") {
  const r = size * 0.375, c = 2 * Math.PI * r, w = size * 0.1;
  return `<div style="position:relative;width:${size}px;height:${size}px;color:${color}" role="img" aria-label="Form ${score}, ${esc(label)}">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${track}" stroke-width="${w}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-dasharray="${((c * score) / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center"><b style="font-family:var(--display);font-size:${size * 0.27}px;line-height:1">${score}</b><span class="tiny" style="font-size:${Math.max(9, size * 0.075)}px">${esc(label)}</span></div></div>`;
}


// ---------- routing ----------
const routes = { signin, handoff, dupr, home, events, entries: payEntry, payouts, clubs: clubPage, create, "new-club": newClub, chats, insights, profile, notifications };

async function route() {
  clearInterval(state.poll);
  const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  const name = parts[0] ?? "home";
  const params = new URLSearchParams(query ?? "");
  if (name === "handoff") return handoff(params);
  if (!state.me && store.get()) state.me = await api("GET", "/v1/me").catch(() => null);
  if (!state.me && name !== "signin") return go("#/signin");
  if (state.me && !state.me.dupr.connected && !["dupr", "signin", "profile"].includes(name)) return go("#/dupr");
  if (name === "dupr" && params.get("status") === "connected") state.me = await run(() => api("GET", "/v1/me"));
  document.getElementById("nav").hidden = !state.me?.dupr?.connected;
  const tab = name === "clubs" || name === "create" || name === "new-club" || name === "entries" ? "events" : name;
  for (const a of document.querySelectorAll("nav a")) a.classList.toggle("on", a.dataset.tab === tab);
  updateBadges();
  const fn = routes[name] ?? home;
  view.innerHTML = `<div class="spinner" role="status" aria-label="Loading"></div>`;
  await fn(parts.slice(1), params);
}
window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });

function updateBadges() {
  const u = state.me?.unread;
  const set = (tab, n) => {
    const a = document.querySelector(`nav a[data-tab="${tab}"]`);
    if (!a) return;
    a.querySelector(".badge")?.remove();
    if (n > 0) a.insertAdjacentHTML("beforeend", `<span class="badge">${n > 99 ? "99+" : n}</span>`);
  };
  set("chats", u?.chats ?? 0);
  set("notifications", u?.notifications ?? 0);
}

async function refreshMe() {
  const m = await api("GET", "/v1/me").catch(() => null);
  if (m) { state.me = m; updateBadges(); }
}

// ---------- sign in ----------
async function signin() {
  view.innerHTML = `<div class="stack" style="max-width:440px;margin:32px auto;text-align:center">
    <img src="../logo.png" alt="" style="width:112px;height:112px;border-radius:28px;margin:0 auto">
    <h1 style="font-size:44px">PickleHeat</h1>
    <p class="muted">Heat Climb leagues, tournaments and your DUPR form, all in one place.</p>
    ${LIVE ? `<div id="appleid-signin" data-color="white" data-border="false" data-type="sign in" style="height:52px;cursor:pointer"></div>
      <div class="muted small">or use email</div>
      <form class="stack" id="email-form" style="text-align:left">
        <label>Email<input name="email" type="email" autocomplete="email" required></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" minlength="8" required></label>
        <label id="name-field" hidden>Your name<input name="name" autocomplete="name"></label>
        <button class="btn block" type="submit" id="email-go">Sign in</button>
        <button class="btn secondary block" type="button" data-act="toggle-signup">New here? Create an account</button>
      </form>`
      : `<button class="btn block" data-act="demo-signin">Try the demo</button><p class="small muted">Demo mode: a sample club, Heat Climb league and tournaments. Nothing leaves your browser and nothing is charged.</p>`}
    <p class="small muted">By continuing you agree to the <a href="../privacy.html">Privacy Policy</a>.</p></div>`;
  if (LIVE) loadAppleJs();
}

let signupMode = false;
function loadAppleJs() {
  if (!cfg.APPLE_SERVICES_ID) return;
  const s = document.createElement("script");
  s.src = "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";
  s.onload = () => window.AppleID.auth.init({ clientId: cfg.APPLE_SERVICES_ID, scope: "name email", redirectURI: location.origin + location.pathname, usePopup: true });
  document.head.appendChild(s);
}
document.addEventListener("AppleIDSignInOnSuccess", async (e) => {
  const d = e.detail;
  const name = [d.user?.name?.firstName, d.user?.name?.lastName].filter(Boolean).join(" ") || undefined;
  await signedIn(await run(() => api("POST", "/v1/auth/apple", { identityToken: d.authorization.id_token, name })));
});
document.addEventListener("AppleIDSignInOnFailure", (e) => { if (e.detail?.error !== "popup_closed_by_user") toast("Sign in failed. Please try again."); });

async function signedIn(me, to) {
  if (!me) return;
  store.set(me.token);
  state.me = me;
  state.form = null;
  go(to ? `#/${to}` : me.dupr.connected ? "#/home" : "#/dupr");
}

/** One-time link from the iPhone app: signs in here and opens the page it asked for (payments, payouts). */
async function handoff(params) {
  const t = params.get("t");
  if (!t) return go("#/home");
  view.innerHTML = `<div class="spinner" role="status" aria-label="Signing you in"></div>`;
  const r = await run(() => api("POST", "/v1/auth/handoff/redeem", { token: t }));
  if (!r) return (view.innerHTML = empty("This link has expired", "Open it again from the PickleHeat app, or sign in here."));
  await signedIn(r, r.to);
}

// ---------- DUPR ----------
async function dupr() {
  if (state.me.dupr.connected) return go("#/home");
  view.innerHTML = `<div class="stack" style="max-width:520px;margin:24px auto">
    <div class="hero lime center"><div class="big" style="font-size:40px">Connect DUPR</div>
      <p>One time, about 30 seconds. PickleHeat then keeps your rating up to date and sends your league and tournament scores to DUPR for you.</p></div>
    <div class="card stack small">
      <div class="row">${tile("↓", "var(--lime)")} Your DUPR ratings and recent matches come in</div>
      <div class="row">${tile("↑", "var(--coral)")} Scores both teams confirm go to DUPR</div>
      <div class="row">${tile("🔒", "var(--sky)")} You log in on DUPR's own page. PickleHeat never sees your password</div>
    </div>
    <button class="btn block" data-act="connect-dupr">Connect my DUPR account</button>
    ${LIVE ? "" : `<p class="small muted center">Demo mode: this links a sample DUPR profile.</p>`}
    <button class="btn secondary block" data-act="signout">Sign out</button></div>`;
}

// ---------- data ----------
async function loadHome() {
  const [live, mine, disc] = await Promise.all([
    api("GET", "/v1/me/live").catch(() => ({ items: [], players: {} })),
    api("GET", "/v1/events").catch(() => ({ events: [] })),
    api("GET", "/v1/discover").catch(() => ({ events: [], clubs: [] })),
  ]);
  state.live = live;
  state.events = mine.events;
  state.discover = disc;
  if (!state.form) state.form = await api("GET", "/v1/me/form").catch(() => null);
  const u = state.me.user;
  if (u.lat != null && !state.recs) {
    const q = new URLSearchParams({ lat: u.lat, lng: u.lng, radius: Math.round(u.maxDistanceMiles) });
    state.recs = await api("GET", `/v1/tournaments/recommended?${q}`).catch(() => null);
  }
  await refreshMe();
}

// ---------- home ----------
async function home() {
  await loadHome();
  const me = state.me, f = me.form;
  const myClubs = state.discover.clubs.filter((c) => c.myRole);
  const live = state.events.filter((c) => c.event.status !== "completed");
  const open = state.discover.events.filter((c) => !c.myStatus).slice(0, 2);
  view.innerHTML = `<div class="stack">
    <div class="row between wrap"><div><div class="muted small">${new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div><h1 style="font-size:32px">Hey, ${esc(me.user.name.split(" ")[0])}</h1></div>
      <div class="row">${LIVE ? "" : pill("Demo", "var(--ink)", "var(--sky)")}<a class="btn secondary" href="#/notifications" aria-label="Notifications">🔔 ${me.unread.notifications || ""}</a></div></div>
    <div class="grid">
      <div class="hero lime row between">
        <div class="stack" style="gap:6px"><span class="tiny">DUPR Doubles</span><span class="big">${r2(me.dupr.doublesRating)}</span>
          ${me.dupr.doublesReliability != null ? `<span class="pill">Reliability ${Math.round(me.dupr.doublesReliability)}%</span>` : ""}
          <b class="small">Singles ${r2(me.dupr.singlesRating)} · ${esc(me.dupr.duprId)}</b></div>
        <a href="#/insights" aria-label="Open insights">${f ? ring(f.score, f.label) : `<b>Form after<br>3 matches</b>`}</a>
      </div>
      <div class="actions">
        <a class="card action" href="#/create/league">${tile("👥", "var(--lime)")}Create league</a>
        <a class="card action" href="#/create/tournament">${tile("🏆", "var(--coral)")}Create tournament</a>
        <a class="card action" href="#/events">${tile("🔍", "var(--sky)")}Find events</a>
        <a class="card action" href="#/insights">${tile("📊", "var(--text)")}My insights</a>
      </div>
    </div>
    ${state.live.items.length ? `<section class="stack"><h2>Live matches</h2><div class="grid">${state.live.items.slice(0, 4).map((it) => `<div class="stack" style="gap:6px">
      <div class="row between small"><a href="#/events/${esc(it.eventId)}" style="color:var(--coral)"><b>${esc(it.eventName)}${it.roundNumber ? ` · Round ${it.roundNumber}` : ""}${it.groupNumber ? ` · Heat ${it.groupNumber}` : ""}</b></a>${it.chatId ? `<a href="#/chats/${esc(it.chatId)}">💬 Chat</a>` : ""}</div>
      ${matchCard(it.match, state.live.players, {})}</div>`).join("")}</div></section>` : ""}
    <div class="grid">
      <section class="stack"><div class="row between"><h2>My leagues &amp; tournaments</h2><a href="#/events?tab=mine" class="small">See all</a></div>${live.length ? live.slice(0, 5).map(eventRow).join("") : empty("Nothing yet", "Join a Heat Climb near you or create one for your group.")}</section>
      <section class="stack"><div class="row between"><h2>My clubs</h2><a href="#/events?tab=clubs" class="small">All clubs</a></div>${myClubs.length ? myClubs.map(clubRow).join("") : empty("No clubs yet", "Join a club to see its leagues and tournaments, and get member prices.")}</section>
    </div>
    ${open.length || state.recs?.recommendations?.length ? `<section class="stack"><h2>Picked for you</h2><div class="grid">${open.map(eventRow).join("")}${(state.recs?.recommendations ?? []).slice(0, 2).map(recCard).join("")}</div></section>` : ""}
  </div>`;
}

const eventRow = (c) => {
  const e = c.event;
  const icon = individual(e.style) ? "🔥" : e.kind === "league" ? "👥" : "🏆";
  const tag = c.myStatus ? pill(ENTRY[c.myStatus], c.myStatus === "confirmed" ? "var(--lime)" : "var(--coral)") : e.status === "open" ? pill(c.myPriceCents > 0 ? money(c.myPriceCents) : "Free") : "";
  return `<a class="card row" href="#/events/${encodeURIComponent(e.id)}" style="color:var(--text)">${tile(icon, e.kind === "league" ? "var(--lime)" : "var(--coral)")}
  <span style="flex:1;min-width:0"><b>${esc(e.name)}</b><br><span class="small muted">${[STYLE[e.style], pretty(e.startDate), c.clubName].filter(Boolean).map(esc).join(" · ")}</span><br>
  <span class="row small" style="gap:6px;margin-top:4px">${tag}<span class="muted">${c.entryCount}/${e.capacity}${c.waitlistCount ? ` · ${c.waitlistCount} waitlist` : ""}${e.organizerId === state.me.user.id ? " · Organizer" : ""}</span></span></span><span class="muted">›</span></a>`;
};

const clubRow = (s) => `<a class="card row" href="#/clubs/${encodeURIComponent(s.club.id)}" style="color:var(--text)">${tile(esc(s.club.name[0]), "var(--sky)")}
  <span style="flex:1;min-width:0"><b>${esc(s.club.name)}</b> ${s.myRole && s.myRole !== "member" ? pill(s.myRole.toUpperCase(), "var(--ink)", "var(--lime)") : ""}<br><span class="small muted">${s.memberCount} members · ${s.leagueCount} leagues · ${s.tournamentCount} tournaments${s.distanceMiles != null ? ` · ${Math.round(s.distanceMiles)} mi` : ""}</span></span><span class="muted">›</span></a>`;

const recCard = (r) => `<div class="card stack" style="gap:8px">
  <div class="row between"><span class="tiny" style="color:var(--coral)">${esc(r.tournament.source === "sample" ? "Sample" : r.tournament.source)}</span><span class="small muted">${pretty(r.tournament.startDate)}</span></div>
  <h3>${esc(r.tournament.name)}</h3><span class="small muted">${esc(r.event.name)} · ${esc(r.tournament.city)}, ${esc(r.tournament.state)}</span>
  ${r.reasons.map((x) => `<span class="small" style="color:${x.includes("hot form") ? "var(--coral)" : "var(--text)"}">${x.includes("hot form") ? "🔥" : "✓"} ${esc(x)}</span>`).join("")}
  <div class="row between"><b>${r.event.feeCents != null ? money(r.event.feeCents) : ""}</b>${r.tournament.url ? `<a href="${esc(r.tournament.url)}" ${r.tournament.url.startsWith("http") ? `target="_blank" rel="noopener"` : ""}><b>View</b></a>` : `<b style="color:var(--lime)" class="small">${Math.round(r.score * 100)}% match</b>`}</div></div>`;

// ---------- matches ----------
function side(m, uid) { return m.homePlayers.includes(uid) ? "home" : m.awayPlayers.includes(uid) ? "away" : null; }
function scoreText(m) {
  if (m.lines?.length) return m.lines.filter((l) => l.games.length).map((l) => l.games.map((g) => `${g.us}–${g.them}`).join(" ")).join(" · ");
  return m.games.map((g) => `${g.us}–${g.them}`).join(", ");
}
function winner(m) {
  if (m.status !== "confirmed") return null;
  const tally = (games) => { let h = 0, a = 0; for (const g of games) { if (g.us > g.them) h++; else if (g.them > g.us) a++; } return [h, a]; };
  if (m.lines?.length) {
    let h = 0, a = 0;
    for (const l of m.lines) { const [x, y] = tally(l.games); if (x > y) h++; else if (y > x) a++; }
    return h === a ? null : h > a ? "home" : "away";
  }
  const [h, a] = tally(m.games);
  if (h !== a) return h > a ? "home" : "away";
  const ph = m.games.reduce((s, g) => s + g.us, 0), pa = m.games.reduce((s, g) => s + g.them, 0);
  return ph === pa ? null : ph > pa ? "home" : "away";
}

const matchIndex = new Map(); // id -> { match, players, opts } for score forms

/** opts: { home, away, tags, manager, gamesPerMatch } */
function matchCard(m, players, opts) {
  matchIndex.set(m.id, { m, players, opts });
  const me = state.me.user.id, mine = side(m, me), rep = m.reportedBy ? side(m, m.reportedBy) : null;
  const ready = m.homePlayers.length && m.awayPlayers.length;
  const canConfirm = m.status === "reported" && ((mine && mine !== rep) || opts.manager);
  const canEnter = ready && (mine || opts.manager) && (m.status !== "confirmed" || (opts.manager && !m.bracket));
  const w = winner(m);
  const names = (ids) => (ids.length ? ids.map((id) => esc(first(players, id))).join(" &amp; ") : m.homeDead || m.awayDead ? "Bye" : "TBD");
  const team = (s) => {
    const label = s === "home" ? (opts.home ?? names(m.homePlayers)) : (opts.away ?? names(m.awayPlayers));
    const games = m.lines?.length ? [] : m.games;
    return `<div class="row between"><span style="font-weight:${w === s || mine === s ? 700 : 400}">${opts.home && s === "home" || opts.away && s === "away" ? esc(label) : label} ${w === s ? "✓" : ""}</span>
      <span class="row" style="gap:10px">${games.map((g) => { const v = s === "home" ? g.us : g.them, o = s === "home" ? g.them : g.us; return `<b class="score" style="color:${v > o ? "var(--text)" : "var(--muted)"}">${v}</b>`; }).join("")}</span></div>`;
  };
  const status = m.duprError ? "DUPR: waiting on player links" : m.status === "scheduled" ? (ready ? "Not played" : "Waiting") : m.status === "reported" ? (canConfirm && mine ? "Confirm this score" : "Awaiting confirmation") : m.duprMatchId && m.duprMatchId !== "none" ? "Sent to DUPR ✓" : "Final";
  const tagHtml = (opts.tags ?? []).map((t) => `<span class="tag ${t}">${t.toUpperCase()}</span>`).join("");
  const lines = m.lines?.some((l) => l.games.length) ? `<div class="stack small" style="gap:2px">${m.lines.map((l) => `<div class="row between"><span class="muted">${esc(l.label)}</span><b>${l.games.map((g) => `${g.us}–${g.them}`).join(" ")}</b></div>`).join("")}</div>` : "";
  return `<div class="card stack match" style="gap:8px" id="m-${esc(m.id)}">
    <div class="row between"><span class="row" style="gap:6px"><span class="tiny muted">${esc(m.label ?? "Match")}</span>${tagHtml}</span><span class="small" style="color:${m.duprError ? "var(--coral)" : "var(--muted)"}">${status}</span></div>
    ${team("home")}${team("away")}${lines}
    ${canConfirm || canEnter ? `<div class="row wrap">${canConfirm ? `<button class="btn" data-act="confirm-score" data-id="${esc(m.id)}">Confirm ${esc(scoreText(m))}</button>` : ""}${canEnter ? `<button class="btn secondary" data-act="score-form" data-id="${esc(m.id)}">${m.games.length || m.lines?.some((l) => l.games.length) ? "Edit score" : "Enter score"}</button>` : ""}</div>` : ""}
    <div class="score-slot"></div></div>`;
}

function scoreForm(id) {
  const { m, players, opts } = matchIndex.get(id);
  const row = (name, g, i) => `<div class="row" style="gap:8px"><span class="small muted" style="width:70px">${esc(name)}</span><input class="score-in" type="number" min="0" max="30" inputmode="numeric" name="${i}-us" value="${g.us}" aria-label="${esc(name)}, first team"><span>–</span><input class="score-in" type="number" min="0" max="30" inputmode="numeric" name="${i}-them" value="${g.them}" aria-label="${esc(name)}, second team"></div>`;
  let body;
  if (m.lines?.length) {
    body = m.lines.map((l, i) => `<div class="stack" style="gap:4px"><b class="small">${esc(l.label)}</b><span class="small muted">${l.homePlayers.map((p) => esc(first(players, p))).join(" & ")} vs ${l.awayPlayers.map((p) => esc(first(players, p))).join(" & ")}</span>${row("Score", l.games[0] ?? { us: 21, them: 0 }, i)}</div>`).join("");
  } else {
    const n = Math.max(m.games.length, opts.gamesPerMatch ?? 1);
    const games = Array.from({ length: n }, (_, i) => m.games[i] ?? { us: 11, them: 0 });
    body = games.map((g, i) => row(`Game ${i + 1}`, g, i)).join("");
  }
  const slot = document.querySelector(`#m-${CSS.escape(id)} .score-slot`);
  slot.innerHTML = `<form class="stack" data-form="score" data-id="${esc(id)}" style="gap:8px;border-top:1px solid var(--line);padding-top:10px">
    <span class="small muted">Left number = ${opts.home ? esc(opts.home) : m.homePlayers.map((p) => esc(first(players, p))).join(" & ")}. The other side confirms, then it goes to DUPR.</span>
    ${body}<div class="row"><button class="btn" type="submit">Submit</button><button class="btn secondary" type="button" data-act="score-cancel" data-id="${esc(id)}">Cancel</button></div></form>`;
}

async function submitScore(form) {
  const id = form.dataset.id;
  const { m } = matchIndex.get(id);
  const fd = new FormData(form);
  const read = (i) => ({ us: Number(fd.get(`${i}-us`)), them: Number(fd.get(`${i}-them`)) });
  const body = m.lines?.length ? { lines: m.lines.map((_, i) => ({ games: [read(i)] })) } : { games: [...Array(form.querySelectorAll("input").length / 2).keys()].map(read) };
  const all = body.lines ? body.lines.flatMap((l) => l.games) : body.games;
  if (all.some((g) => g.us === g.them)) return toast("A game can't end in a tie.");
  const r = await run(() => api("POST", `/v1/matches/${encodeURIComponent(id)}/score`, body));
  if (!r) return;
  if (r.match.lines && r.match.lines.length > (m.lines?.length ?? 0) && r.match.status === "scheduled") toast("It's 2–2. Play the DreamBreaker, then enter its score.", true);
  else toast(r.match.status === "confirmed" ? "Score saved." : "Score sent. The other side confirms it.", true);
  route();
}

// ---------- events list ----------
async function events(parts, params) {
  if (parts[0]) return eventPage(parts[0], parts[1]);
  if (params.get("tab")) state.eventsTab = params.get("tab");
  await loadHome();
  const t = state.eventsTab;
  let body = "";
  if (t === "discover") {
    const open = state.discover.events.filter((c) => !c.myStatus);
    const recs = state.recs;
    body = (open.length ? `<h2 style="grid-column:1/-1">Open on PickleHeat</h2>${open.map(eventRow).join("")}` : "")
      + (recs?.recommendations?.length ? `<h2 style="grid-column:1/-1">Tournaments that fit your rating</h2>${recs.recommendations.map(recCard).join("")}<p class="small muted" style="grid-column:1/-1">Searched: ${recs.sources.filter((s) => s.ok).map((s) => esc(s.name)).join(", ")}.</p>`
        : state.me.user.lat == null ? `<div class="card stack"><h2>Where do you play?</h2><p class="muted">PickleHeat finds tournaments near you that fit your DUPR rating.</p><button class="btn" data-act="geo">Use my location</button></div>`
          : open.length ? "" : empty("Nothing open nearby", "Try a bigger search distance in Profile, or start a Heat Climb for your group."));
  } else if (t === "mine") {
    body = state.events.length ? state.events.map(eventRow).join("") : empty("No events yet", "Start a Heat Climb with your regular group, or run a tournament.");
  } else {
    const mine = state.discover.clubs.filter((c) => c.myRole), near = state.discover.clubs.filter((c) => !c.myRole);
    body = `<a class="btn secondary" href="#/new-club" style="grid-column:1/-1">Create a club</a>`
      + (mine.length ? `<h2 style="grid-column:1/-1">My clubs</h2>${mine.map(clubRow).join("")}` : "")
      + (near.length ? `<h2 style="grid-column:1/-1">Clubs near you</h2>${near.map(clubRow).join("")}` : "");
  }
  view.innerHTML = `<div class="stack"><div class="row between wrap"><h1>Events</h1><div class="row"><a class="btn secondary" href="#/create/league">New league</a><a class="btn" href="#/create/tournament">New tournament</a></div></div>
    ${tabs([["discover", "Discover"], ["mine", "My events"], ["clubs", "Clubs"]], t, "events-tab")}
    <div class="grid">${body}</div></div>`;
}

// ---------- event page ----------
async function eventPage(id, sub) {
  const d = await run(() => api("GET", `/v1/events/${encodeURIComponent(id)}`));
  if (!d) return (view.innerHTML = empty("Event not found", "It may have been removed, or it's private to its club."));
  state.detail = d;
  if (sub === "register") return registerPage(d);
  const e = d.event;
  const panes = individual(e.style)
    ? [["overview", "Overview"], ["heats", "Heats"], ["ranks", e.style === "flex_ladder" ? "Ladder" : "Standings"], ["stats", "Stats"], ["players", "Players"]]
    : [["overview", "Overview"], ["matches", "Matches"], ...(e.style === "single_elim" || e.style === "double_elim" ? [["bracket", "Bracket"]] : [["standings", "Standings"]]), ...(e.style === "pools_playoffs" ? [["bracket", "Playoffs"]] : []), ["players", "Teams"]];
  const pane = state.eventTab[id] ?? "overview";
  let body = "";
  if (pane === "overview") body = overview(d);
  else if (pane === "heats") body = await heatsPane(d);
  else if (pane === "ranks") body = await ranksPane(d);
  else if (pane === "stats") body = await statsPane(d);
  else if (pane === "matches") body = matchesPane(d);
  else if (pane === "standings") body = standingsPane(d);
  else if (pane === "bracket") body = bracketPane(d);
  else body = playersPane(d);
  view.innerHTML = `<div class="stack">
    <div class="card stack" style="gap:8px">
      <div class="row wrap" style="gap:6px">${pill(STYLE[e.style].toUpperCase(), "var(--ink)", e.kind === "league" ? "var(--lime)" : "var(--coral)")}${pill(STATUS[e.status])}<span style="flex:1"></span>
        ${d.chatId ? `<a class="btn secondary" href="#/chats/${esc(d.chatId)}">💬 Event chat</a>` : ""}<button class="btn secondary" data-act="share" data-name="${esc(e.name)}">Share</button></div>
      <h1>${esc(e.name)}</h1>
      ${d.club ? `<a href="#/clubs/${esc(d.club.id)}" style="color:var(--sky)"><b>🏠 ${esc(d.club.name)}</b></a>` : ""}
      <div class="small stack" style="gap:2px">
        <span>📅 ${pretty(e.startDate)}${e.kind === "league" && e.weeks ? ` · ${e.weeks} rounds, every ${e.roundDays} days` : e.endDate && e.endDate !== e.startDate ? ` – ${pretty(e.endDate)}` : ""}</span>
        ${e.venue || e.city ? `<span>📍 ${esc([e.venue, e.city].filter(Boolean).join(" · "))}${e.state ? ", " + esc(e.state) : ""}</span>` : ""}
        <span>📈 DUPR ${range(e)} · ${FORMAT[e.format]}</span>
        <span>👥 ${d.entries.length}/${e.capacity} ${teamSize(e) === 1 ? "players" : "teams"}${d.waitlist.length ? ` · ${d.waitlist.length} waitlist` : ""}</span>
        <span>💳 ${isPaid(e) ? `${money(e.feeCents)} per player${e.memberFeeCents != null && e.memberFeeCents !== e.feeCents ? ` · members ${money(e.memberFeeCents)}` : ""}` : "Free"}</span>
      </div>
    </div>
    ${tabs(panes, pane, "event-tab")}
    ${body}</div>`;
}

function overview(d) {
  const e = d.event, entry = d.myEntry;
  let mine = "";
  if (entry && entry.status !== "withdrawn") {
    mine = `<div class="card stack"><div class="row between"><h2>${entry.status === "waitlisted" ? "You're on the waitlist" : entry.status === "pending_payment" ? "Finish your registration" : "You're in"}</h2>${pill(ENTRY[entry.status], entry.status === "confirmed" ? "var(--lime)" : "var(--coral)")}</div>
      ${teamSize(e) > 1 ? `<span class="muted small">${esc(entry.teamName)}</span>` : ""}
      ${entry.status === "pending_payment" ? `<p class="small muted" style="margin:0">Entry fee ${money(d.myPriceCents)}, paid securely by card and sent to the organizer.</p><button class="btn" data-act="pay" data-id="${esc(entry.id)}">Pay ${money(d.myPriceCents)}</button>` : ""}
      ${["confirmed", "waitlisted", "pending_payment"].includes(entry.status) && e.status !== "completed" ? `<button class="btn secondary" data-act="withdraw" data-id="${esc(e.id)}">Withdraw</button>` : ""}</div>`;
  } else if (e.status === "open") {
    const full = d.entries.length >= e.capacity;
    mine = `<div class="card stack"><h2>${full ? "Full: join the waitlist" : "Registration is open"}</h2><span class="muted small">${d.myPriceCents > 0 ? `Your price: ${money(d.myPriceCents)}` : "Free to join"}</span><a class="btn" href="#/events/${esc(e.id)}/register">${full ? "Join waitlist" : "Register"}</a></div>`;
  }
  return `<div class="grid">${mine}
    ${e.description ? `<div class="card">${esc(e.description)}</div>` : ""}
    <div class="card stack" style="gap:6px"><h3>How it works</h3><span class="small muted">${BLURB[e.style]}</span>${e.submitToDupr ? `<span class="small" style="color:var(--lime)"><b>✓ Confirmed scores are sent to DUPR</b></span>` : ""}</div>
    ${d.isManager ? organizerCard(d) : ""}</div>`;
}

function organizerCard(d) {
  const e = d.event;
  const running = d.rounds.find((r) => r.status === "in_progress"), next = d.rounds.find((r) => r.status === "upcoming");
  const btns = [];
  if (e.status === "draft") {
    if (isPaid(e) && !state.me.payouts.ready) btns.push(`<p class="small muted" style="margin:0">Paid events need a payout account so entry fees reach you.</p><a class="btn secondary" href="#/payouts">Set up payouts</a>`);
    btns.push(`<button class="btn" data-act="ev" data-op="publish">Open registration</button>`);
  }
  if (individual(e.style)) {
    if (e.status !== "draft" && e.status !== "completed") {
      if (next) btns.push(`<button class="btn" data-act="ev" data-op="start-round">${running ? `Close round ${running.number} &amp; start ${next.number}` : `Start round ${next.number}`}</button>`);
      if (running && !next) btns.push(`<button class="btn" data-act="close-round" data-id="${esc(running.id)}">Close final round</button>`);
    }
  } else if (e.status === "open" || e.status === "closed") {
    btns.push(`<button class="btn" data-act="ev" data-op="schedule" ${d.entries.length < 2 ? "disabled" : ""}>${d.matches.length ? "Rebuild schedule" : "Build schedule"}</button>`);
  }
  if (e.status === "open") btns.push(`<button class="btn secondary" data-act="ev" data-op="close">Close registration</button>`);
  return `<div class="card stack"><h3>Organizer tools</h3>
    ${d.money && isPaid(e) ? `<div class="row between"><div><b class="num">${money(d.money.collectedCents)}</b><br><span class="small muted">collected</span></div><div><b class="num">${d.money.paidEntries}</b><br><span class="small muted">paid</span></div><div><b class="num">${d.money.pendingEntries}</b><br><span class="small muted">pending</span></div></div>` : ""}
    ${btns.join("")}
    <details><summary class="small"><b>Invite players (${d.invites.length})</b></summary>
      <form class="stack" data-form="invite" style="margin-top:10px"><label>One per line: name, email, DUPR ID<textarea name="csv" rows="5" placeholder="Sam Lee, sam@example.com, ABC123"></textarea></label><button class="btn secondary" type="submit">Invite</button></form>
      ${d.invites.map((i) => `<div class="row between small" style="padding:4px 0"><span>${esc(i.name)} <span class="muted">${esc([i.email, i.duprId].filter(Boolean).join(" · "))}</span></span><span class="muted">${esc(i.status)}</span></div>`).join("")}
    </details></div>`;
}

async function heatsPane(d) {
  if (!d.rounds.length) return empty("No rounds yet", "Rounds appear once registration opens.");
  const id = d.event.id;
  const sel = state.roundSel[id] ?? d.currentRoundId ?? [...d.rounds].reverse().find((r) => r.status !== "upcoming")?.id ?? d.rounds[0].id;
  const rv = await run(() => api("GET", `/v1/rounds/${encodeURIComponent(sel)}`));
  const picker = `<div class="chips">${d.rounds.map((r) => `<button class="${r.id === sel ? "on" : ""}" data-act="round-sel" data-k="${esc(r.id)}">R${r.number} <span class="tiny">${r.status === "in_progress" ? "LIVE" : r.status === "completed" ? "DONE" : pretty(r.startDate)}</span></button>`).join("")}</div>`;
  if (!rv) return picker;
  const me = state.me.user.id;
  const isPlayer = d.event.ladder.includes(me) || d.myEntry?.status === "confirmed";
  const myGroup = rv.groups.find((g) => g.group.id === rv.myGroupId);
  const heat = (g, mine) => `<div class="card stack" ${mine ? `style="border-color:var(--coral)"` : ""}>
    <div class="row between">${mine ? `<div><span class="tiny" style="color:var(--coral)">Your heat</span><h2>You're in Heat ${g.group.number}</h2></div>` : `<h3>Heat ${g.group.number}</h3>`}
      ${mine || d.isManager ? `<a href="#/chats/${esc(g.group.chatId)}" class="small">💬 Heat chat</a>` : ""}</div>
    <div class="row wrap" style="gap:6px">${g.group.playerIds.map((p) => `<span class="row small" style="gap:6px">${avatar(rv.players[p], 28)}${esc(first(rv.players, p))}</span>`).join("")}</div>
    ${mine || d.isManager ? g.matches.map((m) => matchCard(m, rv.players, { tags: rv.tags[m.id], manager: d.isManager, gamesPerMatch: d.event.gamesPerMatch })).join("") : ""}
    ${g.standings.length ? `<table><tbody>${g.standings.map((s, i) => `<tr><td style="width:24px;color:${i === 0 ? "var(--lime)" : "var(--muted)"}"><b>${i + 1}</b></td><td style="font-weight:${s.userId === me ? 700 : 400}">${esc(fullName(rv.players, s.userId))}</td><td>${s.wins}–${s.losses}</td><td class="muted">${s.pd >= 0 ? "+" : ""}${s.pd}</td></tr>`).join("")}</tbody></table>` : ""}
    ${mine && rv.round.status !== "completed" && !rv.subs.some((s) => s.userId === me && s.status === "open") ? `<button class="btn danger" data-act="sub-request" data-id="${esc(rv.round.id)}">I can't play: find a sub</button>` : ""}</div>`;
  const openSubs = rv.subs.filter((s) => s.status === "open");
  const others = rv.groups.filter((g) => g.group.id !== rv.myGroupId);
  return `${picker}
    <div class="row between"><h2>Round ${rv.round.number}</h2><span class="small muted">${pretty(rv.round.startDate)} – ${pretty(rv.round.endDate)}</span></div>
    ${rv.round.status === "upcoming" && isPlayer ? `<div class="card stack"><h3>${rv.myAttendance === "declined" ? "You're sitting this one out" : "Are you playing this round?"}</h3><span class="small muted">${d.event.style === "flex_ladder" ? "If you skip, you keep your ladder spot." : "Skipping is fine; you just won't score this round."}</span>
      <div class="row"><button class="btn ${rv.myAttendance === "declined" ? "secondary" : ""}" data-act="attend" data-id="${esc(rv.round.id)}" data-going="1">I'm in</button><button class="btn secondary" data-act="attend" data-id="${esc(rv.round.id)}" data-going="0">Can't make it</button></div></div>` : ""}
    ${rv.round.byes.includes(me) ? empty("You have a bye", "Odd numbers this round. You keep your spot.") : ""}
    ${myGroup ? heat(myGroup, true) : ""}
    ${openSubs.length ? `<h3>Subs needed</h3>${openSubs.map((s) => `<div class="card row between"><span class="row">${avatar(rv.players[s.userId])}<span><b>${esc(fullName(rv.players, s.userId))}</b> needs a sub<br><span class="small muted">Heat ${rv.groups.find((g) => g.group.id === s.groupId)?.group.number ?? ""}</span></span></span>
      ${s.userId === me ? `<button class="btn danger" data-act="sub-cancel" data-id="${esc(s.id)}">Cancel</button>` : rv.myGroupId !== s.groupId ? `<button class="btn" data-act="sub-accept" data-id="${esc(s.id)}">I'll sub</button>` : ""}</div>`).join("")}` : ""}
    ${others.length ? `<h3>${myGroup ? "Other heats" : "Heats"}</h3><div class="grid">${others.map((g) => heat(g, false)).join("")}</div>` : ""}
    ${!rv.groups.length && rv.round.status === "upcoming" ? empty("Heats aren't set yet", "The organizer starts the round, then everyone gets their heat and a heat chat.") : ""}
    ${d.isManager && rv.round.status === "in_progress" ? `<button class="btn secondary" data-act="close-round" data-id="${esc(rv.round.id)}">Close round ${rv.round.number}</button>` : ""}`;
}

async function ranksPane(d) {
  const r = await run(() => api("GET", `/v1/events/${encodeURIComponent(d.event.id)}/rankings`));
  if (!r) return "";
  if (!r.rows.length) return empty("No rankings yet", "Rankings appear after the first round closes.");
  const me = state.me.user.id;
  const mv = (row) => { const m = row.prevRank != null ? row.prevRank - row.rank : 0; return m > 0 ? `<span style="color:var(--lime)">▲${m}</span>` : m < 0 ? `<span style="color:var(--coral)">▼${-m}</span>` : `<span class="muted">–</span>`; };
  return `<span class="small muted">${r.round ? `After round ${r.round}` : "Starting order"}</span>
    <div class="card scroll" style="padding:6px 12px"><table><thead><tr><th>#</th><th></th><th>Player</th><th>W–L</th><th>PD</th>${d.event.style === "flex_ladder" ? "<th>Next</th>" : ""}</tr></thead><tbody>
    ${r.rows.map((row) => `<tr style="${row.userId === me ? "background:var(--surface2)" : ""}"><td><b>${row.rank}</b></td><td>${mv(row)}</td><td><span class="row" style="gap:8px">${avatar(r.players[row.userId], 28)}<span>${esc(fullName(r.players, row.userId))}<br><span class="small muted">${esc(ratingLine(r.players[row.userId]))}</span></span></span></td>
      <td>${row.played ? `${row.wins}–${row.losses}` : `<span class="muted">Sat out</span>`}</td><td>${row.pd >= 0 ? "+" : ""}${row.pd}</td>${d.event.style === "flex_ladder" ? `<td style="color:var(--sky)">${row.nextGroup ? `Heat ${row.nextGroup}` : ""}</td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}

async function statsPane(d) {
  const s = await run(() => api("GET", `/v1/events/${encodeURIComponent(d.event.id)}/stats`));
  if (!s) return "";
  if (!s.rows.length) return empty("No stats yet", "Stats build up as scores are confirmed.");
  const me = state.me.user.id;
  return `<div class="card scroll" style="padding:6px 12px"><table><thead><tr><th>Player</th><th>W–L</th><th>Win %</th><th>PF</th><th>PA</th><th>PD</th><th>DUPR ±</th></tr></thead><tbody>
    ${s.rows.map((r) => `<tr style="font-weight:${r.userId === me ? 700 : 400}"><td>${esc(fullName(s.players, r.userId))}</td><td>${r.wins}–${r.losses}</td><td>${Math.round(r.winPct * 100)}%</td><td>${r.pf}</td><td>${r.pa}</td><td>${r.pd >= 0 ? "+" : ""}${r.pd}</td>
      <td style="color:${(r.ratingChange ?? 0) > 0 ? "var(--lime)" : (r.ratingChange ?? 0) < 0 ? "var(--coral)" : "var(--muted)"}">${r.ratingChange == null ? "—" : (r.ratingChange > 0 ? "+" : "") + r.ratingChange.toFixed(2)}</td></tr>`).join("")}</tbody></table></div>`;
}

const teamName = (d, id) => (d.entries.find((e) => e.id === id) ?? d.waitlist.find((e) => e.id === id))?.teamName ?? "TBD";
const teamMatch = (d, m) => matchCard(m, d.players, { home: m.homeEntryId ? teamName(d, m.homeEntryId) : undefined, away: m.awayEntryId ? teamName(d, m.awayEntryId) : undefined, manager: d.isManager, gamesPerMatch: d.event.gamesPerMatch });

function matchesPane(d) {
  if (!d.matches.length) return empty("No matches yet", d.isManager ? "Build the schedule from Overview once teams are in." : "The organizer posts the schedule once registration closes.");
  const me = state.me.user.id;
  const mine = d.matches.filter((m) => side(m, me) && m.status !== "confirmed" && m.homePlayers.length && m.awayPlayers.length);
  const plain = d.matches.filter((m) => !m.bracket);
  const rounds = [...new Set(plain.map((m) => m.round))].sort((a, b) => a - b);
  const bracket = d.matches.filter((m) => m.bracket && !(m.homeDead && m.awayDead));
  return (mine.length ? `<h2>Your next matches</h2><div class="grid">${mine.map((m) => teamMatch(d, m)).join("")}</div>` : "")
    + rounds.map((r) => `<h3>${d.event.kind === "league" ? "Week" : "Round"} ${r}</h3><div class="grid">${plain.filter((m) => m.round === r).map((m) => teamMatch(d, m)).join("")}</div>`).join("")
    + (!rounds.length && bracket.length ? `<div class="grid">${bracket.map((m) => teamMatch(d, m)).join("")}</div>` : "");
}

function standingsPane(d) {
  if (!d.standings.some((p) => p.table.length)) return empty("No standings yet", "Standings fill in as scores are confirmed.");
  return `<div class="grid">${d.standings.map((p) => `<div class="card">${p.pool != null ? `<h3>Pool ${p.pool}</h3>` : ""}<table><thead><tr><th>Team</th><th>W–L</th><th>PD</th></tr></thead><tbody>
    ${p.table.map((s, i) => `<tr style="font-weight:${d.myEntry?.id === s.entrant ? 700 : 400}"><td>${i + 1}. ${esc(teamName(d, s.entrant))}</td><td>${s.wins}–${s.losses}</td><td>${s.diff >= 0 ? "+" : ""}${s.diff}</td></tr>`).join("")}</tbody></table></div>`).join("")}</div>`;
}

function bracketPane(d) {
  const b = d.matches.filter((m) => m.bracket);
  if (!b.length) return empty("No bracket yet", d.event.style === "pools_playoffs" ? "Playoffs are drawn when pool play finishes." : "The bracket is drawn when the organizer builds the schedule.");
  return ["W", "L", "GF"].map((s) => {
    const ms = b.filter((m) => m.bracket.side === s && !(m.homeDead && m.awayDead));
    if (!ms.length) return "";
    const rounds = [...new Set(ms.map((m) => m.bracket.round))].sort((a, b) => a - b);
    return `<h3>${s === "W" ? (d.event.style === "double_elim" ? "Winners bracket" : "Bracket") : s === "L" ? "Losers bracket" : "Grand final"}</h3>
      <div class="bracket">${rounds.map((r) => `<div class="col">${ms.filter((m) => m.bracket.round === r).sort((a, b) => a.bracket.slot - b.bracket.slot).map((m) => teamMatch(d, m)).join("")}</div>`).join("")}</div>`;
  }).join("");
}

function playersPane(d) {
  const e = d.event;
  const row = (en) => `<div class="card row between"><span class="row" style="gap:10px"><span class="row" style="gap:0">${en.playerIds.map((p) => avatar(d.players[p], 32)).join("")}</span>
    <span><b>${esc(teamSize(e) === 1 ? fullName(d.players, en.playerIds[0]) : en.teamName)}</b><br><span class="small muted">${en.playerIds.map((p) => esc(ratingLine(d.players[p]))).join(" · ")}</span></span></span>
    <span class="row">${en.status !== "confirmed" ? `<span class="small" style="color:var(--coral)">${ENTRY[en.status]}</span>` : ""}${en.comped ? `<span class="small muted">comped</span>` : ""}
    ${d.isManager && en.status === "confirmed" && isPaid(e) && !en.comped ? `<button class="btn danger" data-act="refund" data-id="${esc(en.id)}">Refund</button>` : ""}</span></div>`;
  return `<h2>${d.entries.length} ${teamSize(e) === 1 ? "players" : "teams"}</h2><div class="grid">${d.entries.map(row).join("")}</div>
    ${d.waitlist.length ? `<h2>Waitlist</h2><div class="grid">${d.waitlist.map(row).join("")}</div>` : ""}`;
}

// ---------- register & pay (the website is where entry fees are paid) ----------
function registerPage(d) {
  const e = d.event, size = teamSize(e);
  const myR = e.format === "singles" ? state.me.dupr.singlesRating ?? state.me.dupr.doublesRating : state.me.dupr.doublesRating;
  const fits = (e.minRating == null && e.maxRating == null) || (myR != null && (e.minRating == null || myR >= e.minRating) && (e.maxRating == null || myR <= e.maxRating));
  if (d.myEntry && d.myEntry.status !== "withdrawn") return go(`#/events/${e.id}`);
  view.innerHTML = `<div class="stack" style="max-width:560px;margin:0 auto">
    <a href="#/events/${esc(e.id)}" class="small">‹ Back to event</a>
    <div class="hero ${e.kind === "league" ? "lime" : "coral"} stack" style="gap:8px"><span class="tiny">${STYLE[e.style]} · ${FORMAT[e.format]}</span><h1 style="font-size:32px">${esc(e.name)}</h1><span>${pretty(e.startDate)} · DUPR ${range(e)}</span></div>
    <div class="card row">${fits ? "✅" : "⚠️"} Your DUPR ${r2(myR)} ${fits ? "fits" : "is outside this event's range"}</div>
    <form class="stack" data-form="register">
      ${size === 1 ? (individual(e.style) ? `<p class="card small muted">Sign up on your own. PickleHeat puts you in a heat each round and rotates your partners.</p>` : "")
        : `<div class="card stack"><b class="small muted">${size === 2 ? "Partner's DUPR ID" : "Teammates' DUPR IDs"}</b>${Array.from({ length: size - 1 }, (_, i) => `<input name="p${i}" required placeholder="${LIVE ? "DUPR ID" : `Try ${["DEMO-PR04", "DEMO-BR03", "DEMO-CH01"][i] ?? "a DUPR ID"}`}" autocapitalize="characters">`).join("")}
          <span class="small muted">Partners need PickleHeat with DUPR connected.</span><input name="teamName" placeholder="Team name (optional)"></div>`}
      ${d.myPriceCents > 0 ? `<div class="card row between"><span class="muted">Entry fee</span><b class="num">${money(d.myPriceCents)}</b></div><p class="small muted">Paid securely by card through Stripe, straight to the organizer's account. Refunds follow the organizer's policy.</p>` : ""}
      <button class="btn block" type="submit" ${fits ? "" : "disabled"}>${d.entries.length >= e.capacity ? "Join waitlist" : d.myPriceCents > 0 ? `Register &amp; pay ${money(d.myPriceCents)}` : "Register"}</button>
    </form></div>`;
}

async function submitRegister(form) {
  const d = state.detail, fd = new FormData(form);
  const partnerDuprIds = [...fd.keys()].filter((k) => /^p\d$/.test(k)).map((k) => String(fd.get(k)).trim().toUpperCase());
  const r = await run(() => api("POST", `/v1/events/${encodeURIComponent(d.event.id)}/register?client=web`, { partnerDuprIds, teamName: fd.get("teamName") || undefined }));
  if (!r) return;
  if (r.payOnWeb && r.entry.status === "pending_payment") return pay(r.entry.id, r.checkoutUrl);
  toast(r.entry.status === "waitlisted" ? "You're on the waitlist. We'll tell you if a spot opens." : "You're in!", true);
  go(`#/events/${d.event.id}`);
}

async function pay(entryId, checkoutUrl) {
  if (!LIVE) {
    const r = await run(() => api("POST", `/v1/demo/pay/${encodeURIComponent(entryId)}`));
    if (r) { toast("Demo payment complete. Nothing was charged.", true); go(`#/events/${r.entry.eventId}`); }
    return;
  }
  const url = checkoutUrl ?? (await run(() => api("POST", `/v1/entries/${encodeURIComponent(entryId)}/checkout`)))?.url;
  if (url) location.href = url;
}

/** #/entries/<id>/pay — the link the iPhone app and notifications open. */
async function payEntry(parts) {
  const id = parts[0];
  view.innerHTML = `<div class="stack" style="max-width:480px;margin:40px auto;text-align:center"><div class="spinner"></div><p class="muted">Opening secure checkout…</p></div>`;
  await pay(id);
}

// ---------- payouts (organizers) ----------
async function payouts(_parts, params) {
  const s = await run(() => api("GET", "/v1/payouts/status"));
  if (params.get("status") === "done") toast(s?.ready ? "Payouts are set up." : "Almost there: Stripe is still checking your details.", !!s?.ready);
  await refreshMe();
  view.innerHTML = `<div class="stack" style="max-width:560px;margin:0 auto"><h1>Getting paid</h1>
    <div class="card stack"><p class="muted" style="margin:0">Entry fees for your events are paid by card on this website and go straight to your own Stripe account. PickleHeat never holds your money.</p>
      ${s?.ready ? `<div class="row" style="color:var(--lime)"><b>✓ Payout account ready</b></div>${LIVE ? `<button class="btn secondary" data-act="payout-dashboard">Open Stripe dashboard</button>` : ""}`
        : `<button class="btn" data-act="payout-onboard">${s?.linked ? "Finish payout setup" : "Set up payouts with Stripe"}</button>`}
      ${LIVE ? "" : `<p class="small muted" style="margin:0">Demo mode: setup completes instantly and nothing is charged.</p>`}</div>
    <a class="btn secondary" href="#/events?tab=mine">Back to my events</a></div>`;
}

// ---------- clubs ----------
async function clubPage(parts) {
  const id = parts[0];
  const d = await run(() => api("GET", `/v1/clubs/${encodeURIComponent(id)}`));
  if (!d) return (view.innerHTML = empty("Club not found", ""));
  const s = d.summary, manager = s.myRole === "owner" || s.myRole === "admin";
  view.innerHTML = `<div class="stack">
    <div class="card stack"><div class="row">${tile(esc(s.club.name[0]), "var(--sky)")}<div><h1>${esc(s.club.name)}</h1><span class="muted small">${esc([s.club.city, s.club.state].filter(Boolean).join(", "))}</span></div></div>
      ${s.club.description ? `<p style="margin:0">${esc(s.club.description)}</p>` : ""}
      <div class="row wrap" style="gap:6px">${pill(`${s.memberCount} members`)}${pill(`${s.leagueCount} leagues`)}${pill(`${s.tournamentCount} tournaments`)}</div>
      ${s.myRole ? `<div class="row between"><b style="color:var(--lime)">✓ You're ${s.myRole === "member" ? "a member" : `an ${s.myRole}`}</b><span class="row">${d.chatId ? `<a class="btn secondary" href="#/chats/${esc(d.chatId)}">💬 Club chat</a>` : ""}${s.myRole !== "owner" ? `<button class="btn danger" data-act="club-leave" data-id="${esc(id)}">Leave</button>` : ""}</span></div>`
        : `<button class="btn" data-act="club-join" data-id="${esc(id)}">Join club</button><span class="small muted">Members see club events first and get member prices.</span>`}
    </div>
    ${manager ? `<div class="row"><a class="btn secondary" href="#/create/league?club=${esc(id)}">New league</a><a class="btn" href="#/create/tournament?club=${esc(id)}">New tournament</a></div>` : ""}
    <h2>Events</h2><div class="grid">${d.events.length ? d.events.map(eventRow).join("") : empty("No events yet", manager ? "Create the club's first league or tournament." : "Check back soon.")}</div>
    <h2>Members</h2><div class="card" style="padding:6px 12px"><table><tbody>${d.members.map((m) => `<tr><td><span class="row" style="gap:8px">${avatar(d.players[m.userId], 28)}<span>${esc(fullName(d.players, m.userId))}<br><span class="small muted">${esc(ratingLine(d.players[m.userId]))}</span></span></span></td>
      <td>${m.role !== "member" ? pill(m.role.toUpperCase(), "var(--ink)", "var(--lime)") : ""}</td>
      <td style="text-align:right">${s.myRole === "owner" && m.role !== "owner" ? `<button class="btn secondary" data-act="club-role" data-id="${esc(id)}" data-user="${esc(m.userId)}" data-role="${m.role === "admin" ? "member" : "admin"}">${m.role === "admin" ? "Make member" : "Make admin"}</button>` : ""}</td></tr>`).join("")}</tbody></table></div></div>`;
}

function newClub() {
  view.innerHTML = `<form class="stack" data-form="club" style="max-width:560px;margin:0 auto"><h1>New club</h1>
    <label>Club name<input name="name" required minlength="2" maxlength="80"></label>
    <label>What's your club about?<textarea name="description" rows="3"></textarea></label>
    <div class="form2"><label>City<input name="city"></label><label>State<input name="state"></label></div>
    <p class="small muted">You'll be the owner. Make others admins so they can run events too.</p>
    <button class="btn block" type="submit">Create club</button></form>`;
}

// ---------- create event ----------
const STYLE_OPTIONS = { league: ["flex_ladder", "scramble", "round_robin"], tournament: ["double_elim", "single_elim", "pools_playoffs", "round_robin", "scramble"] };

async function create(parts, params) {
  const kind = parts[0] === "league" ? "league" : "tournament";
  if (!state.discover) await loadHome();
  const clubs = state.discover.clubs.filter((c) => c.myRole === "owner" || c.myRole === "admin");
  const club = params.get("club");
  const d = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  view.innerHTML = `<form class="stack" data-form="create" style="max-width:720px;margin:0 auto">
    <h1>${kind === "league" ? "New league" : "New tournament"}</h1>
    <input type="hidden" name="kind" value="${kind}">
    <label>Name<input name="name" required maxlength="80"></label>
    <label>Description (optional)<textarea name="description" rows="2"></textarea></label>
    ${clubs.length ? `<label>Club<select name="clubId"><option value="">No club</option>${clubs.map((c) => `<option value="${esc(c.club.id)}" ${c.club.id === club ? "selected" : ""}>${esc(c.club.name)}</option>`).join("")}</select></label>` : ""}
    <div class="form2">
      <label>Style<select name="style" data-change="style">${STYLE_OPTIONS[kind].map((s) => `<option value="${s}">${STYLE[s]}</option>`).join("")}</select></label>
      <label>Format<select name="format">${Object.entries(FORMAT).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
    </div>
    <p class="small muted" id="style-blurb">${BLURB[STYLE_OPTIONS[kind][0]]}</p>
    <div class="form2">
      <label>${kind === "league" ? "First round" : "Date"}<input type="date" name="startDate" value="${d}" min="${new Date().toISOString().slice(0, 10)}" required></label>
      ${kind === "league" ? `<label>Rounds<input type="number" name="weeks" value="8" min="1" max="26"></label><label>Every (days)<input type="number" name="roundDays" value="7" min="1" max="31"></label>` : ""}
      <label>Games per match<input type="number" name="gamesPerMatch" value="${kind === "league" ? 2 : 1}" min="1" max="5"></label>
      <label>Capacity (players or teams)<input type="number" name="capacity" value="16" min="2" max="256"></label>
    </div>
    <div class="form2"><label>Venue<input name="venue"></label><label>City<input name="city"></label><label>State<input name="state"></label></div>
    <div class="form2"><label>Min DUPR (optional)<input type="number" step="0.05" min="1" max="8" name="minRating" value="3.0"></label><label>Max DUPR (optional)<input type="number" step="0.05" min="1" max="8" name="maxRating" value="4.0"></label></div>
    <label class="check"><input type="checkbox" name="submitToDupr" checked> Send results to DUPR</label>
    <label class="check"><input type="checkbox" name="requireDuprVerified" checked> DUPR-connected players only</label>
    <div class="form2"><label>Entry fee per player ($)<input type="number" step="1" min="0" name="fee" value="0"></label>${clubs.length ? `<label>Club member price ($, optional)<input type="number" step="1" min="0" name="memberFee"></label>` : ""}</div>
    ${state.me.payouts.ready ? `<p class="small" style="color:var(--lime)">✓ Entry fees go to your payout account.</p>` : `<p class="small muted">Charging a fee? <a href="#/payouts">Set up payouts</a> first so the money reaches you.</p>`}
    <label class="check"><input type="checkbox" name="openNow" checked> Open registration now</label>
    <button class="btn block" type="submit">Create</button></form>`;
}

async function submitCreate(form) {
  const fd = new FormData(form), num = (k) => (fd.get(k) === "" || fd.get(k) == null ? undefined : Number(fd.get(k)));
  const body = {
    kind: fd.get("kind"), style: fd.get("style"), format: fd.get("format"), name: fd.get("name"), description: fd.get("description"),
    clubId: fd.get("clubId") || undefined, startDate: fd.get("startDate"), weeks: num("weeks"), roundDays: num("roundDays"), gamesPerMatch: num("gamesPerMatch"),
    capacity: num("capacity"), venue: fd.get("venue"), city: fd.get("city"), state: fd.get("state"), minRating: num("minRating"), maxRating: num("maxRating"),
    feeCents: Math.round((num("fee") ?? 0) * 100), memberFeeCents: num("memberFee") != null ? Math.round(num("memberFee") * 100) : undefined,
    submitToDupr: fd.get("submitToDupr") === "on", requireDuprVerified: fd.get("requireDuprVerified") === "on",
  };
  const r = await run(() => api("POST", "/v1/events", body));
  if (!r) return;
  if (fd.get("openNow") === "on") {
    if (isPaid(r.event) && !state.me.payouts.ready) toast("Saved as a draft. Set up payouts, then open registration.", true);
    else await run(() => api("POST", `/v1/events/${r.event.id}/publish`));
  }
  go(`#/events/${r.event.id}`);
}

// ---------- chats ----------
async function chats(parts) {
  if (parts[0]) return chatPage(parts[0]);
  const p = await run(() => api("GET", "/v1/chats"));
  if (!p) return;
  const icon = { group: ["🔥", "var(--coral)"], club: ["🏠", "var(--sky)"], direct: ["👤", "var(--text)"], event: ["🏆", "var(--lime)"] };
  view.innerHTML = `<div class="stack" style="max-width:720px;margin:0 auto"><h1>Chats</h1>
    ${p.chats.length ? p.chats.map((c) => { const m = c.lastMessage, [ic, col] = icon[c.chat.kind] ?? icon.event;
      return `<a class="card row" href="#/chats/${esc(c.chat.id)}" style="color:var(--text)">${tile(ic, col)}<span style="flex:1;min-width:0"><span class="row between"><b>${esc(c.chat.title)}</b><span class="small muted">${ago(m?.createdAt ?? c.chat.lastMessageAt)}</span></span>
        <span class="row between"><span class="small muted ellipsis">${m ? `${m.userId ? (m.userId === state.me.user.id ? "You" : esc(first(p.players, m.userId))) : "PickleHeat"}: ${esc(m.text)}` : "No messages yet"}</span>${c.unread ? `<span class="badge">${c.unread}</span>` : ""}</span></span></a>`; }).join("")
      : empty("No chats yet", "Join a league or tournament and its chat shows up here. Each Heat Climb round also gets a heat chat.")}</div>`;
}

async function chatPage(id) {
  const render = async () => {
    const p = await api("GET", `/v1/chats/${encodeURIComponent(id)}/messages`).catch(() => null);
    if (!p) return;
    const list = document.getElementById("msgs");
    const atBottom = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    const me = state.me.user.id;
    const html = p.messages.map((m) => {
      if (!m.userId) return `<div class="bot">${esc(m.text)}</div>`;
      const mine = m.userId === me;
      const reacts = Object.entries(m.reactions).filter(([, v]) => v.length);
      return `<div class="msg ${mine ? "mine" : ""}">${mine ? "" : avatar(p.players[m.userId], 28)}<div><div class="small muted">${mine ? "" : esc(first(p.players, m.userId))}</div>
        <div class="bubble">${esc(m.text)}</div>
        <div class="row" style="gap:4px;margin-top:2px">${reacts.map(([e, v]) => `<button class="react ${v.includes(me) ? "on" : ""}" data-act="react" data-chat="${esc(id)}" data-id="${esc(m.id)}" data-emoji="${esc(e)}">${esc(e)} ${v.length}</button>`).join("")}
        <button class="react add" data-act="react-menu" data-chat="${esc(id)}" data-id="${esc(m.id)}" aria-label="React">＋</button><span class="tiny muted">${new Date(m.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></div></div></div>`;
    }).join("");
    if (!document.getElementById("msgs")) {
      view.innerHTML = `<div class="chat"><div class="row between"><h2>${esc(p.chat.title)}</h2>${p.chat.eventId ? `<a class="small" href="#/events/${esc(p.chat.eventId)}">Open event ›</a>` : ""}</div>
        <div id="msgs" class="msgs"></div>
        <form class="row" data-form="message" data-chat="${esc(id)}"><input name="text" placeholder="Message" autocomplete="off" style="flex:1" maxlength="2000"><button class="btn" type="submit" aria-label="Send">Send</button></form></div>`;
    }
    const el = document.getElementById("msgs");
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; if (atBottom) el.scrollTop = el.scrollHeight; }
  };
  await render();
  state.poll = setInterval(render, 4000);
  state.renderChat = render;
  refreshMe();
}

// ---------- notifications ----------
async function notifications() {
  const r = await run(() => api("GET", "/v1/notifications"));
  if (!r) return;
  view.innerHTML = `<div class="stack" style="max-width:640px;margin:0 auto"><h1>Notifications</h1>
    ${r.notifications.length ? r.notifications.map((n) => `<a class="card row" href="${n.link ? `#/${esc(n.link)}` : "#/notifications"}" style="color:var(--text);align-items:flex-start">
      <span style="width:8px;height:8px;border-radius:4px;margin-top:8px;background:${n.read ? "transparent" : "var(--coral)"}"></span><span><b>${esc(n.title)}</b><br><span class="small muted">${esc(n.body)}</span><br><span class="tiny muted">${ago(n.createdAt)}</span></span></a>`).join("")
      : empty("You're all caught up", "")}</div>`;
  await api("POST", "/v1/notifications/read", {}).catch(() => {});
  refreshMe();
}

// ---------- profile ----------
async function profile() {
  await refreshMe();
  const me = state.me, u = me.user;
  view.innerHTML = `<div class="stack" style="max-width:640px;margin:0 auto"><h1>Profile</h1>
    <div class="card stack"><div class="row">${avatar({ name: u.name }, 52)}<div><h2>${esc(u.name)}</h2><span class="small muted">${esc(u.email ?? "")}</span></div></div>
      <label>Gender (for mixed and MLP lines)<select data-change="gender"><option value="">Not set</option><option value="f" ${u.gender === "f" ? "selected" : ""}>Woman</option><option value="m" ${u.gender === "m" ? "selected" : ""}>Man</option></select></label></div>
    <div class="card stack"><h3>DUPR</h3>
      ${me.dupr.connected ? `<div class="row between"><span>DUPR ID</span><b>${esc(me.dupr.duprId)}</b></div><div class="row between"><span>Doubles</span><b>${r2(me.dupr.doublesRating)}</b></div><div class="row between"><span>Singles</span><b>${r2(me.dupr.singlesRating)}</b></div>
        <div class="row"><button class="btn secondary" data-act="dupr-sync">Sync now</button><button class="btn danger" data-act="dupr-disconnect">Disconnect</button></div>` : `<a class="btn" href="#/dupr">Connect DUPR</a>`}
      <span class="small muted">Ratings update automatically. Scores both sides confirm are sent to DUPR for you.</span></div>
    <div class="card stack"><h3>Tournament finder</h3>
      <button class="btn secondary" data-act="geo">Use my current location</button>
      <label>Search within <span id="dist-label">${Math.round(u.maxDistanceMiles)}</span> miles<input type="range" min="10" max="300" step="5" value="${u.maxDistanceMiles}" data-change="distance" style="height:auto;padding:0"></label>
      <span class="small muted">${u.lat != null ? "Home area set." : "Set your area to get tournament picks."}</span></div>
    <div class="card stack"><h3>Getting paid (organizers)</h3>${me.payouts.ready ? `<b style="color:var(--lime)">✓ Payout account linked</b>` : ""}<a class="btn secondary" href="#/payouts">${me.payouts.ready ? "Manage payouts" : "Set up payouts"}</a></div>
    <div class="card stack"><a href="../privacy.html">Privacy Policy</a><a href="../support.html">Support</a>
      ${LIVE ? "" : `<span class="small muted">Demo mode: sample data in this browser only. <button class="link" data-act="demo-reset">Reset the demo</button></span>`}
      <button class="btn secondary" data-act="signout">Sign out</button><button class="btn danger" data-act="delete-account">Delete account</button></div></div>`;
}

// ---------- actions ----------
async function evOp(op) {
  const d = state.detail, id = encodeURIComponent(d.event.id);
  const path = { publish: "publish", close: "close", schedule: "schedule", "start-round": "rounds/start" }[op];
  const ok = await run(() => api("POST", `/v1/events/${id}/${path}`));
  if (ok) {
    if (op === "start-round") { state.eventTab[d.event.id] = "heats"; delete state.roundSel[d.event.id]; }
    if (op === "schedule") state.eventTab[d.event.id] = "matches";
    route();
  }
}

const actions = {
  "demo-signin": async () => signedIn(await run(() => api("POST", "/v1/auth/apple", { identityToken: "dev:demo" }))),
  "toggle-signup": (el) => {
    signupMode = !signupMode;
    document.getElementById("name-field").hidden = !signupMode;
    document.getElementById("email-go").textContent = signupMode ? "Create account" : "Sign in";
    el.textContent = signupMode ? "Have an account? Sign in" : "New here? Create an account";
  },
  "connect-dupr": async () => {
    if (LIVE) {
      const r = await run(() => api("POST", "/v1/dupr/connect-session", { client: "web" }));
      if (r) location.href = r.url;
    } else {
      await run(() => api("POST", "/v1/dupr/link", { userToken: "mock-demo", refreshToken: "refresh-demo" }));
      state.me = await run(() => api("GET", "/v1/me"));
      go("#/home");
    }
  },
  signout: () => { store.set(null); state.me = null; state.form = null; state.recs = null; go("#/signin"); },
  "delete-account": async () => {
    if (!confirm("Delete your PickleHeat account? Results already sent to DUPR stay on DUPR.")) return;
    if (await run(() => api("DELETE", "/v1/me"))) actions.signout();
  },
  "demo-reset": async () => { await loadDemo(); await globalThis.PickleHeatDemo.reset(); actions.signout(); },
  geo: () => {
    if (!navigator.geolocation) return toast("Location isn't available in this browser.");
    navigator.geolocation.getCurrentPosition(async (p) => {
      state.me = await run(() => api("PATCH", "/v1/me", { lat: p.coords.latitude, lng: p.coords.longitude }));
      state.recs = null;
      route();
    }, () => toast("Location is off. Allow it in your browser settings."));
  },
  "events-tab": (el) => { state.eventsTab = el.dataset.k; route(); },
  "event-tab": (el) => { state.eventTab[state.detail.event.id] = el.dataset.k; route(); },
  "round-sel": (el) => { state.roundSel[state.detail.event.id] = el.dataset.k; route(); },
  share: async (el) => {
    const url = location.href.split("?")[0];
    if (navigator.share) navigator.share({ title: el.dataset.name, text: `Join ${el.dataset.name} on PickleHeat`, url }).catch(() => {});
    else { await navigator.clipboard?.writeText(url); toast("Link copied", true); }
  },
  pay: (el) => pay(el.dataset.id),
  withdraw: async (el) => { if (confirm("Withdraw? Refunds are up to the organizer.") && (await run(() => api("POST", `/v1/events/${encodeURIComponent(el.dataset.id)}/withdraw`)))) route(); },
  refund: async (el) => { if (confirm("Refund this entry and remove it from the event?") && (await run(() => api("POST", `/v1/events/${encodeURIComponent(state.detail.event.id)}/entries/${encodeURIComponent(el.dataset.id)}/refund`)))) route(); },
  ev: (el) => evOp(el.dataset.op),
  "close-round": async (el) => { if (await run(() => api("POST", `/v1/rounds/${encodeURIComponent(el.dataset.id)}/close`))) route(); },
  attend: async (el) => { if (await run(() => api("POST", `/v1/rounds/${encodeURIComponent(el.dataset.id)}/attendance`, { status: el.dataset.going === "1" ? "confirmed" : "declined" }))) route(); },
  "sub-request": async (el) => { if (await run(() => api("POST", `/v1/rounds/${encodeURIComponent(el.dataset.id)}/subs`))) { toast("We've asked the league for a sub.", true); route(); } },
  "sub-accept": async (el) => { if (await run(() => api("POST", `/v1/subs/${encodeURIComponent(el.dataset.id)}/accept`))) { toast("Thanks! You're in that heat now.", true); route(); } },
  "sub-cancel": async (el) => { if (await run(() => api("POST", `/v1/subs/${encodeURIComponent(el.dataset.id)}/cancel`))) route(); },
  "score-form": (el) => scoreForm(el.dataset.id),
  "score-cancel": (el) => { document.querySelector(`#m-${CSS.escape(el.dataset.id)} .score-slot`).innerHTML = ""; },
  "confirm-score": async (el) => { if (await run(() => api("POST", `/v1/matches/${encodeURIComponent(el.dataset.id)}/confirm`))) { toast("Confirmed.", true); route(); } },
  "club-join": async (el) => { if (await run(() => api("POST", `/v1/clubs/${encodeURIComponent(el.dataset.id)}/join`))) route(); },
  "club-leave": async (el) => { if (confirm("Leave this club?") && (await run(() => api("POST", `/v1/clubs/${encodeURIComponent(el.dataset.id)}/leave`)))) route(); },
  "club-role": async (el) => { if (await run(() => api("PATCH", `/v1/clubs/${encodeURIComponent(el.dataset.id)}/members/${encodeURIComponent(el.dataset.user)}`, { role: el.dataset.role }))) route(); },
  "payout-onboard": async () => {
    const r = await run(() => api("POST", "/v1/payouts/onboard"));
    if (!r) return;
    if (LIVE) location.href = r.url;
    else { await api("GET", "/v1/payouts/status"); toast("Payouts linked (demo).", true); route(); }
  },
  "payout-dashboard": async () => { const r = await run(() => api("POST", "/v1/payouts/dashboard")); if (r) window.open(r.url, "_blank", "noopener"); },
  "dupr-sync": async () => { if ((state.me = (await run(() => api("POST", "/v1/dupr/sync"))) ?? state.me)) { state.form = null; toast("Synced with DUPR.", true); route(); } },
  "dupr-disconnect": async () => { if (confirm("Disconnect DUPR? You'll need to connect again to join DUPR events.")) { state.me = (await run(() => api("DELETE", "/v1/dupr/link"))) ?? state.me; route(); } },
  react: async (el) => { await run(() => api("POST", `/v1/chats/${encodeURIComponent(el.dataset.chat)}/messages/${encodeURIComponent(el.dataset.id)}/react`, { emoji: el.dataset.emoji })); state.renderChat?.(); },
  "react-menu": (el) => {
    const pick = ["👍", "🔥", "😂", "🏓", "❤️", "👏"];
    el.outerHTML = pick.map((e) => `<button class="react" data-act="react" data-chat="${esc(el.dataset.chat)}" data-id="${esc(el.dataset.id)}" data-emoji="${e}">${e}</button>`).join("");
  },
};

const forms = {
  score: submitScore,
  register: submitRegister,
  create: submitCreate,
  club: async (form) => {
    const fd = new FormData(form);
    const r = await run(() => api("POST", "/v1/clubs", { name: fd.get("name"), description: fd.get("description"), city: fd.get("city"), state: fd.get("state") }));
    if (r) go(`#/clubs/${r.summary.club.id}`);
  },
  invite: async (form) => {
    const r = await run(() => api("POST", `/v1/events/${encodeURIComponent(state.detail.event.id)}/invites`, { csv: new FormData(form).get("csv") }));
    if (r) { toast(`Invited ${r.added}. ${r.joinedNow} joined right away.`, true); route(); }
  },
  message: async (form) => {
    const input = form.querySelector("input"), text = input.value.trim();
    if (!text) return;
    input.value = "";
    await run(() => api("POST", `/v1/chats/${encodeURIComponent(form.dataset.chat)}/messages`, { text }));
    state.renderChat?.();
  },
};

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-act]");
  if (!el || !actions[el.dataset.act]) return;
  ev.preventDefault();
  actions[el.dataset.act](el);
});

document.addEventListener("submit", async (ev) => {
  const form = ev.target;
  if (form.id === "email-form") {
    ev.preventDefault();
    const fd = new FormData(form);
    const body = { email: fd.get("email"), password: fd.get("password"), ...(signupMode ? { name: fd.get("name") || undefined } : {}) };
    return signedIn(await run(() => api("POST", signupMode ? "/v1/auth/signup" : "/v1/auth/login", body)));
  }
  const handler = forms[form.dataset.form];
  if (!handler) return;
  ev.preventDefault();
  const btn = form.querySelector("[type=submit]");
  if (btn) btn.disabled = true;
  try { await handler(form); } finally { if (btn) btn.disabled = false; }
});

document.addEventListener("change", async (ev) => {
  const el = ev.target.closest("[data-change]");
  if (!el) return;
  const k = el.dataset.change;
  if (k === "style") {
    document.getElementById("style-blurb").textContent = BLURB[el.value];
    const fmt = el.form.elements.format;
    for (const o of fmt.options) o.disabled = individual(el.value) && !["doubles", "mixed"].includes(o.value);
    if (fmt.selectedOptions[0]?.disabled) fmt.value = "doubles";
    el.form.elements.gamesPerMatch.value = individual(el.value) ? 2 : 1;
  } else if (k === "gender") {
    state.me = (await run(() => api("PATCH", "/v1/me", { gender: el.value || null }))) ?? state.me;
  } else if (k === "distance") {
    state.me = (await run(() => api("PATCH", "/v1/me", { maxDistanceMiles: Number(el.value) }))) ?? state.me;
    state.recs = null;
  }
});
document.addEventListener("input", (ev) => {
  if (ev.target.dataset?.change === "distance") document.getElementById("dist-label").textContent = ev.target.value;
});

// ---------- insights ----------
async function insights() {
  if (!state.form) state.form = await run(() => api("GET", "/v1/me/form"));
  const p = state.form;
  if (!p) return (view.innerHTML = `<p class="card">Couldn't load your insights.</p>`);
  const f = p.form, i = p.insights, t = i.traits;
  const headline = { Hot: "Hot streak", Rising: "Rising", Steady: "Steady", Cooling: "Cooling off", Cold: "Cold spell" };
  const pct = f ? Math.round(Math.abs(f.weightedResidual) * 100) : 0;
  const bars = f ? [...f.residuals].reverse().map((r) => { const h = Math.max(6, Math.round(Math.abs(r) * 480)); return `<div class="bar"><i style="height:${Math.min(60, h)}px;background:${r >= 0 ? "var(--lime)" : "var(--coral)"};${r >= 0 ? "bottom:60px" : "top:60px"}"></i></div>`; }).join("") : "";
  const meter = (name, note, v) => `<div class="stack" style="gap:6px"><div class="row between small"><b>${name}</b><span class="muted">${note}</span></div><div class="meter" role="img" aria-label="${name} ${v} of 100"><i style="width:${v}%;background:${v >= 60 ? "var(--lime)" : v >= 40 ? "var(--sky)" : "var(--coral)"}"></i></div></div>`;
  const stat = (k, v) => `<div class="card"><div class="small muted">${k}</div><div style="font-family:var(--display);font-size:28px;font-weight:700">${v}</div></div>`;
  view.innerHTML = `<div class="stack"><h1>Form &amp; Insights</h1><div class="grid">
    <div class="card stack">${f ? `<div class="row">${ring(f.score, "Form", 96, labelColor(f.label), "var(--line)")}<div><h2 style="color:${labelColor(f.label)}">${headline[f.label]}</h2>
      <p class="small muted">${pct === 0 ? "Playing right at your rating." : `Winning ${pct}% ${f.weightedResidual > 0 ? "more" : "fewer"} points than your rating predicts.`}${f.previousScore != null && f.previousScore !== f.score ? ` ${f.score > f.previousScore ? "Up" : "Down"} from ${f.previousScore} two matches ago.` : ""}</p></div></div>
      <div class="row between"><span class="tiny muted">Performance vs expected</span><span class="small muted">oldest → newest</span></div><div class="bars" role="img" aria-label="Point share vs expected per match">${bars}</div>` : `<p>Play at least 3 DUPR matches to unlock your Form score.</p>`}</div>
    <div class="stack"><div class="actions">${stat("Record", `${i.record.wins}–${i.record.losses}`)}${stat("Point share", Math.round(i.pointShare * 100) + "%")}${stat("Close games (±2)", `${i.closeGames.wins}–${i.closeGames.losses}`)}${stat("vs higher-rated", `${i.vsHigherRated.wins}–${i.vsHigherRated.losses}`)}</div>
      <div class="card stack"><span class="tiny muted">Player DNA</span>${meter("Clutch", "Wins tight games", t.clutch)}${meter("Consistency", "Low swing", t.consistency)}${meter("Giant-killer", "vs higher DUPR", t.giantKiller)}${meter("Momentum", "Form trend", t.momentum)}</div>
      <div class="card" style="background:rgba(92,200,255,.12);border-color:rgba(92,200,255,.35)">💡 ${esc(i.tip)}</div></div></div>
    <h2>Recent DUPR matches</h2><div class="grid">${p.matches.slice(0, 10).map((m) => { const w = won(m); return `<div class="card row"><span class="wl" style="background:${w ? "var(--lime)" : "var(--coral)"}">${w ? "W" : "L"}</span><span style="flex:1;min-width:0"><b>${m.games.map((g) => `${g.us}–${g.them}`).join(", ")}</b><br><span class="small muted">${[m.partnerName && "w/ " + esc(m.partnerName), m.opponentNames && "vs " + esc(m.opponentNames.join(" & "))].filter(Boolean).join(" · ")}</span></span><span class="small muted">${new Date(m.playedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></div>`; }).join("")}</div>
    <p class="small muted">How Form works: for each of your last 8 DUPR matches, PickleHeat compares the share of points you won with the share your team's rating gap predicts. Recent matches count more. 50 means playing exactly at your rating.</p></div>`;
}

function won(m) {
  let a = 0, b = 0, pa = 0, pb = 0;
  for (const g of m.games) { pa += g.us; pb += g.them; if (g.us > g.them) a++; else if (g.them > g.us) b++; }
  return a !== b ? a > b : pa > pb;
}


route();
