// PickleHeat web app: players and organizers, same API as the iPhone app.
import { DemoService, LiveService } from "./services.js";

const cfg = window.PICKLEHEAT_CONFIG ?? {};
const svc = cfg.PICKLEHEAT_API_URL ? new LiveService(cfg.PICKLEHEAT_API_URL) : new DemoService();
const state = { me: null, form: null, recs: null, events: [], tab: "foryou", detail: null, kind: "tournament" };
const view = document.getElementById("view");

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const r2 = (x) => (x == null ? "—" : Number(x).toFixed(2));
const money = (c) => `$${(c / 100).toFixed(c % 100 === 0 ? 0 : 2)}`;
const pretty = (d) => new Date(d.slice(0, 10) + "T12:00:00Z").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const labelColor = (l) => (l === "Hot" || l === "Rising" ? "var(--lime)" : l === "Steady" ? "var(--text)" : "var(--coral)");
const statusTitle = { draft: "Draft", open: "Registration open", closed: "Registration closed", in_progress: "In progress", completed: "Completed" };
const range = (e) => (e.minRating != null && e.maxRating != null ? `${r2(e.minRating)}–${r2(e.maxRating)}` : e.minRating != null ? `${r2(e.minRating)}+` : e.maxRating != null ? `up to ${r2(e.maxRating)}` : "Open");

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 4500);
}

async function run(fn) {
  try { return await fn(); } catch (e) {
    if (e.status === 401) { state.me = null; location.hash = "#/signin"; }
    toast(e.message || "Something went wrong");
  }
}

function ring(score, label, size = 128, color = "var(--ink)", track = "rgba(10,15,36,.14)") {
  const r = size * 0.375, c = 2 * Math.PI * r, w = size * 0.1;
  return `<div style="position:relative;width:${size}px;height:${size}px;color:${color}" role="img" aria-label="Form ${score}, ${esc(label)}">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${track}" stroke-width="${w}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-dasharray="${((c * score) / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center"><b style="font-family:var(--display);font-size:${size * 0.27}px;line-height:1">${score}</b><span class="tiny" style="font-size:${Math.max(9, size * 0.075)}px">${esc(label)}</span></div></div>`;
}

const tile = (txt, color) => `<span class="tile" style="background:${color}">${txt}</span>`;

// ---------- routing ----------
const routes = { signin, dupr, home, insights, events, event: eventPage, create, profile };

async function route() {
  const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
  const [name, arg] = path.split("/");
  const params = new URLSearchParams(query ?? "");
  if (!state.me) state.me = await run(() => svc.restore());
  if (!state.me && name !== "signin") return (location.hash = "#/signin");
  if (state.me && !state.me.dupr.connected && name !== "dupr" && name !== "signin") return (location.hash = "#/dupr");
  if (name === "dupr" && params.get("status") === "connected") state.me = await run(() => svc.completeDuprConnect());
  if (name === "events" && params.get("paid") != null && arg == null) location.hash = "#/events";
  document.getElementById("nav").hidden = !state.me?.dupr?.connected;
  for (const a of document.querySelectorAll("nav a")) a.classList.toggle("on", a.dataset.tab === (name === "event" || name === "create" ? "events" : name));
  const fn = routes[name] ?? home;
  view.innerHTML = `<div class="spinner" role="status" aria-label="Loading"></div>`;
  await fn(arg, params);
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

// ---------- sign in & DUPR ----------
async function signin() {
  view.innerHTML = `<div class="stack" style="max-width:460px;margin:40px auto;text-align:center">
    <img src="../logo.png" alt="" style="width:112px;height:112px;border-radius:28px;margin:0 auto">
    <h1 style="font-size:44px">PickleHeat</h1>
    <p class="muted">Leagues, tournaments and your DUPR form, all in one place.</p>
    ${svc.isDemo ? `<button class="btn block" data-act="demo">Try the demo</button><p class="small muted">Demo mode: sample data, nothing leaves your browser.</p>`
      : `<div id="appleid-signin" data-color="white" data-border="false" data-type="sign in" style="height:52px"></div>`}
    <p class="small muted">By continuing you agree to the <a href="../privacy.html">Privacy Policy</a>.</p></div>`;
  if (!svc.isDemo) loadAppleJs();
}

function loadAppleJs() {
  const s = document.createElement("script");
  s.src = "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";
  s.onload = () => {
    window.AppleID.auth.init({ clientId: cfg.APPLE_SERVICES_ID, scope: "name email", redirectURI: location.origin + location.pathname, usePopup: true });
  };
  document.head.appendChild(s);
  document.addEventListener("AppleIDSignInOnSuccess", async (e) => {
    const d = e.detail;
    const name = [d.user?.name?.firstName, d.user?.name?.lastName].filter(Boolean).join(" ") || undefined;
    state.me = await run(() => svc.signIn(d.authorization.id_token, name));
    location.hash = state.me?.dupr.connected ? "#/home" : "#/dupr";
  });
  document.addEventListener("AppleIDSignInOnFailure", (e) => { if (e.detail?.error !== "popup_closed_by_user") toast("Sign in failed. Please try again."); });
}

async function dupr() {
  view.innerHTML = `<div class="stack" style="max-width:520px;margin:24px auto">
    <div class="hero lime center"><div class="big" style="font-size:40px">Connect DUPR</div>
      <p>One time, about 30 seconds. PickleHeat then keeps your rating up to date and sends your league and tournament scores to DUPR for you.</p></div>
    <div class="card stack small">
      <div class="row">${tile("↓", "var(--lime)")} Your DUPR ratings and recent matches come in</div>
      <div class="row">${tile("↑", "var(--coral)")} Confirmed PickleHeat match scores go to DUPR</div>
      <div class="row">${tile("🔒", "var(--sky)")} You log in on DUPR's own page. PickleHeat never sees your password</div>
    </div>
    <button class="btn block" data-act="connect-dupr">Connect my DUPR account</button>
    ${svc.isDemo ? `<p class="small muted center">Demo mode: this links a sample DUPR profile.</p>` : ""}
    <button class="btn secondary block" data-act="signout">Sign out</button></div>`;
}

// ---------- home ----------
async function loadAll() {
  [state.form, state.events] = await Promise.all([run(() => svc.form()), run(() => svc.events())]);
  state.events ??= [];
  await loadRecs();
}

async function loadRecs() {
  const u = state.me.user;
  state.recs = u.lat != null ? await run(() => svc.recommended(u.lat, u.lng, u.maxDistanceMiles)) : null;
}

async function home() {
  if (!state.form) await loadAll();
  const me = state.me, f = me.form, i = state.form?.insights;
  const live = state.events.filter((e) => e.status !== "completed" && e.status !== "draft");
  view.innerHTML = `<div class="stack">
    <div class="row between wrap"><div><div class="muted small">${new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div><h1 style="font-size:32px">Hey, ${esc(me.user.name.split(" ")[0])}</h1></div>${svc.isDemo ? `<span class="pill" style="background:var(--sky);color:var(--ink)">Demo</span>` : ""}</div>
    <div class="grid">
      <div class="hero lime row between">
        <div class="stack" style="gap:6px"><span class="tiny">DUPR Doubles</span><span class="big">${r2(me.dupr.doublesRating)}</span>
          ${f?.previousScore != null ? `<span class="pill">${f.score >= f.previousScore ? "▲ form up " + (f.score - f.previousScore) : "▼ form down " + (f.previousScore - f.score)}</span>` : ""}
          <b class="small">Singles ${r2(me.dupr.singlesRating)} · ${esc(me.dupr.duprId)}</b></div>
        <a href="#/insights" aria-label="Open insights">${f ? ring(f.score, f.label) : `<b>Form after<br>3 matches</b>`}</a>
      </div>
      <div class="stack">
        ${i ? `<a class="card row" href="#/insights" style="color:var(--text)">${tile("↗", "var(--coral)")}<span><b>${i.record.wins} wins in your last ${i.record.wins + i.record.losses}.</b> <span class="muted">${(state.form.form?.weightedResidual ?? 0) >= 0 ? "You're playing above your rating. See why" : "A bit below your rating. See why"}</span></span></a>` : ""}
        <div class="actions">
          <a class="card action" href="#/create/league">${tile("👥", "var(--lime)")}Create league</a>
          <a class="card action" href="#/create/tournament">${tile("🏆", "var(--coral)")}Create tournament</a>
          <a class="card action" href="#/insights">${tile("📊", "var(--sky)")}My insights</a>
          <a class="card action" href="#/events">${tile("🔍", "var(--text)")}Find events</a>
        </div>
      </div>
    </div>
    <div class="grid">
      <section class="stack"><div class="row between"><h2>My events</h2><a href="#/events" class="small">See all</a></div>${live.length ? live.slice(0, 4).map(eventRow).join("") : `<p class="muted card">No events yet. Create one or join from Events.</p>`}</section>
      <section class="stack"><div class="row between"><h2>Picked for you</h2><a href="#/events" class="small">More</a></div>${(state.recs?.recommendations ?? []).slice(0, 2).map(recCard).join("") || `<p class="muted card">Set your area in Profile to get tournament picks.</p>`}</section>
    </div></div>`;
}

const eventRow = (e) => `<a class="card row" href="#/event/${encodeURIComponent(e.id)}" style="color:var(--text)">${tile(e.kind === "league" ? "👥" : "🏆", e.kind === "league" ? "var(--lime)" : "var(--coral)")}
  <span style="flex:1;min-width:0"><b>${esc(e.name)}</b><br><span class="small muted">${pretty(e.startDate)} · ${statusTitle[e.status]}${e.organizerId === state.me.user.id ? " · Organizer" : ""}</span></span><span class="muted">›</span></a>`;

const recCard = (r) => `<div class="card stack" style="gap:8px">
  <div class="row between"><span class="tiny" style="color:var(--coral)">${esc(r.tournament.source === "sample" ? "Sample" : r.tournament.source)}</span><span class="small muted">${pretty(r.tournament.startDate)}</span></div>
  <h3>${esc(r.tournament.name)}</h3><span class="small muted">${esc(r.event.name)} · ${esc(r.tournament.city)}, ${esc(r.tournament.state)}</span>
  ${r.reasons.map((x) => `<span class="small" style="color:${x.includes("hot form") ? "var(--coral)" : "var(--text)"}">${x.includes("hot form") ? "🔥" : "✓"} ${esc(x)}</span>`).join("")}
  <div class="row between"><b>${r.event.feeCents != null ? money(r.event.feeCents) : ""}</b>${r.tournament.url ? `<a href="${esc(r.tournament.url)}" target="_blank" rel="noopener"><b>Register</b></a>` : `<b style="color:var(--lime)" class="small">${Math.round(r.score * 100)}% match</b>`}</div></div>`;

// ---------- insights ----------
async function insights() {
  if (!state.form) await loadAll();
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

// ---------- events ----------
async function events() {
  if (!state.form) await loadAll();
  else state.events = (await run(() => svc.events())) ?? state.events;
  const recs = state.recs;
  const body = state.tab === "foryou"
    ? (recs ? (recs.recommendations.length ? recs.recommendations.map(recCard).join("") : `<p class="card muted">No open tournaments within ${state.me.user.maxDistanceMiles} miles fit your rating right now. Try a bigger distance in Profile.</p>`) + `<p class="small muted" style="grid-column:1/-1">Searched: ${recs.sources.filter((s) => s.ok).map((s) => esc(s.name)).join(", ")}. PickleballTournaments and FluidPB appear here once their data access is switched on.</p>`
      : `<div class="card stack"><h2>Where do you play?</h2><p class="muted">PickleHeat finds tournaments near you that fit your DUPR rating.</p><button class="btn" data-act="geo">Use my location</button></div>`)
    : state.events.length ? state.events.map(eventRow).join("") : `<div class="card stack"><h2>No events yet</h2><p class="muted">Start a league with your regular group, or run a tournament and collect entry fees.</p></div>`;
  view.innerHTML = `<div class="stack"><div class="row between wrap"><h1>Events</h1><div class="row"><a class="btn secondary" href="#/create/league">New league</a><a class="btn" href="#/create/tournament">New tournament</a></div></div>
    <div class="seg" role="tablist"><button role="tab" aria-selected="${state.tab === "foryou"}" class="${state.tab === "foryou" ? "on" : ""}" data-act="tab" data-tab="foryou">For you</button><button role="tab" aria-selected="${state.tab === "mine"}" class="${state.tab === "mine" ? "on" : ""}" data-act="tab" data-tab="mine">My events</button></div>
    <div class="grid">${body}</div></div>`;
}

async function eventPage(id) {
  const d = await run(() => svc.event(id));
  if (!d) return (view.innerHTML = `<p class="card">Event not found.</p>`);
  state.detail = d;
  const e = d.event, uid = state.me.user.id;
  const team = (eid) => d.entries.find((x) => x.id === eid)?.teamName ?? "TBD";
  const mine = d.entries.find((x) => x.playerIds.includes(uid) && x.status !== "withdrawn" && x.status !== "refunded");
  let actions = "";
  if (d.isOrganizer && e.status === "draft") actions += `${e.feeCents > 0 && !state.me.payouts.chargesEnabled ? `<button class="btn secondary" data-act="payouts">Link payout account</button>` : ""}<button class="btn" data-act="publish">Open registration</button>`;
  else if (d.isOrganizer && !d.matches.length && (e.status === "open" || e.status === "closed")) actions += `<button class="btn" data-act="schedule">${e.kind === "league" ? "Build season schedule" : "Build pools & schedule"}</button>`;
  if (!mine && e.status === "open" && !d.isOrganizer) {
    actions += `<div class="card stack" style="flex:1"><b>Register${e.feeCents > 0 ? ` · ${money(e.feeCents * (e.format === "singles" ? 1 : 2))}` : ""}</b>
      ${e.format !== "singles" ? `<label>Partner's DUPR ID<input id="partner" placeholder="${svc.isDemo ? "Try DEMO-PK01" : "e.g. ABC123"}" autocapitalize="characters"></label><label>Team name (optional)<input id="teamname"></label>` : ""}
      <button class="btn" data-act="register">${e.feeCents > 0 ? "Continue to payment" : "Register"}</button><span class="small muted">Paid through Stripe to the organizer's account.</span></div>`;
  } else if (mine) actions += `<div class="card"><b style="color:${mine.status === "pending_payment" ? "var(--coral)" : "var(--lime)"}">${mine.status === "pending_payment" ? "Payment pending" : "You're in"}: ${esc(mine.teamName)}</b></div>`;

  const standingsHtml = d.matches.length ? d.standings.map((p) => `<div class="card scroll">${p.pool != null ? `<div class="tiny muted">Pool ${p.pool}</div>` : ""}<table><thead><tr><th>#</th><th>Team</th><th>W–L</th><th>+/-</th></tr></thead><tbody>${p.table.map((s, k) => `<tr><td>${k + 1}</td><td>${esc(team(s.entrant))}</td><td>${s.wins}–${s.losses}</td><td>${s.diff >= 0 ? "+" : ""}${s.diff}</td></tr>`).join("")}</tbody></table></div>`).join("") : "";
  const matchesHtml = d.matches.map((m) => {
    const inMatch = [m.homeEntryId, m.awayEntryId].some((x) => d.entries.find((y) => y.id === x)?.playerIds.includes(uid));
    const canEnter = (inMatch || d.isOrganizer) && m.status !== "confirmed";
    const status = m.duprError ? "DUPR: waiting on player links" : m.status === "confirmed" ? (m.duprMatchId ? "Sent to DUPR ✓" : "Confirmed") : m.status === "reported" ? "Awaiting confirmation" : "Not played";
    return `<div class="card stack" style="gap:8px"><span class="tiny muted">${e.kind === "league" ? "Week" : "Round"} ${m.round}${m.pool != null ? ` · Pool ${m.pool}` : ""}${m.court ? ` · ${esc(m.court)}` : ""}</span>
      <b>${esc(team(m.homeEntryId))} vs ${esc(team(m.awayEntryId))}</b>
      <div class="row between wrap"><span class="small">${m.games.length ? m.games.map((g) => `${g.us}–${g.them}`).join(", ") : ""}</span><span class="small muted">${status}</span></div>
      ${canEnter && m.status === "scheduled" ? `<div class="row wrap"><input class="score-in" type="number" min="0" max="30" aria-label="${esc(team(m.homeEntryId))} score" data-home="${m.id}"><span>–</span><input class="score-in" type="number" min="0" max="30" aria-label="${esc(team(m.awayEntryId))} score" data-away="${m.id}"><button class="btn secondary" data-act="score" data-id="${m.id}">Submit</button></div>` : ""}
      ${m.status === "reported" && (d.isOrganizer || inMatch) ? `<button class="btn secondary" data-act="confirm" data-id="${m.id}">Confirm score</button>` : ""}</div>`;
  }).join("");

  view.innerHTML = `<div class="stack">
    <div class="hero ${e.kind === "league" ? "lime" : "coral"} stack" style="gap:10px"><span class="tiny">${e.kind} · ${e.format}</span><div class="big" style="font-size:40px">${esc(e.name)}</div>
      <div class="row wrap"><span class="pill light">${pretty(e.startDate)}</span><span class="pill light">DUPR ${range(e)}</span>${e.feeCents ? `<span class="pill light">${money(e.feeCents)}/player</span>` : ""}</div>
      <b class="small">${[e.venue, e.city].filter(Boolean).map(esc).join(" · ")}${e.venue || e.city ? " · " : ""}${statusTitle[e.status]}</b></div>
    <div class="row wrap">${actions}</div>
    ${d.money ? `<div class="card row between"><div><div class="small muted">Collected</div><div class="big" style="font-size:32px">${money(d.money.collectedCents)}</div></div><div style="text-align:right"><div class="small muted">Teams</div><div class="big" style="font-size:32px">${d.entries.filter((x) => x.status === "confirmed").length} / ${e.capacity}</div></div></div>` : ""}
    ${standingsHtml ? `<h2>Standings</h2><div class="grid">${standingsHtml}</div>` : ""}
    ${matchesHtml ? `<h2>${e.kind === "league" ? "Season" : "Matches"}</h2><div class="grid">${matchesHtml}</div>` : ""}
    <h2>Teams (${d.entries.filter((x) => x.status === "confirmed").length})</h2><div class="card stack">${d.entries.filter((x) => x.status !== "withdrawn").map((x) => `<div class="row between"><span>${esc(x.teamName)}</span><span class="muted small">${r2(x.teamRating)}${x.status === "pending_payment" ? " · payment pending" : ""}</span></div>`).join("") || `<span class="muted">No teams yet.</span>`}</div></div>`;
}

async function create(kind) {
  state.kind = kind === "league" ? "league" : "tournament";
  const k = state.kind;
  const d = new Date(Date.now() + 8 * 864e5).toISOString().slice(0, 10);
  view.innerHTML = `<form class="stack" style="max-width:720px;margin:0 auto" id="create-form">
    <h1>${k === "league" ? "New league" : "New tournament"}</h1>
    <div class="seg"><button type="button" class="${k === "league" ? "on" : ""}" data-act="kind" data-kind="league">League</button><button type="button" class="${k === "tournament" ? "on" : ""}" data-act="kind" data-kind="tournament">Tournament</button></div>
    <div class="card form2">
      <label style="grid-column:1/-1">Name<input name="name" required maxlength="80" placeholder="${k === "league" ? "Tuesday Night Ladder" : "Fall Slam Doubles"}"></label>
      <label>Format<select name="format"><option value="doubles">Doubles</option><option value="mixed">Mixed</option><option value="singles">Singles</option></select></label>
      <label>${k === "league" ? "First week" : "Date"}<input name="startDate" type="date" value="${d}" min="${new Date().toISOString().slice(0, 10)}" required></label>
      ${k === "league" ? `<label>Weeks<input name="weeks" type="number" min="1" max="26" value="8"></label>` : ""}
      <label>Teams<input name="capacity" type="number" min="2" max="128" value="${k === "league" ? 12 : 16}"></label>
    </div>
    <div class="card form2"><label>Venue<input name="venue"></label><label>City<input name="city"></label><label>State<input name="state" maxlength="40"></label></div>
    <div class="card form2"><label>Min DUPR<input name="minRating" type="number" step="0.25" min="1" max="8" value="3.5"></label><label>Max DUPR<input name="maxRating" type="number" step="0.25" min="1" max="8" value="4.25"></label>
      <label class="check" style="grid-column:1/-1"><input type="checkbox" name="submitToDupr" checked> Send results to DUPR</label>
      <label class="check" style="grid-column:1/-1"><input type="checkbox" name="requireDuprVerified" checked> DUPR-connected players only</label></div>
    <div class="card form2"><label>Entry fee per player (USD)<input name="fee" type="number" min="0" step="1" value="${k === "league" ? 60 : 35}"></label>
      <div class="stack small" style="justify-content:end">${state.me.payouts.chargesEnabled ? `<span style="color:var(--lime)">✓ Fees go to your linked account</span>` : `<button type="button" class="btn secondary" data-act="payouts">Link payout account</button>`}</div>
      <label class="check" style="grid-column:1/-1"><input type="checkbox" name="openNow" checked> Open registration now</label></div>
    <button class="btn block" type="submit">Create</button></form>`;
}

async function profile() {
  const me = state.me;
  view.innerHTML = `<div class="stack" style="max-width:720px;margin:0 auto"><h1>Profile</h1>
    <div class="card row"><span class="tile" style="background:var(--coral);width:52px;height:52px;border-radius:26px">${esc(me.user.name.split(" ").map((x) => x[0]).slice(0, 2).join(""))}</span><div><h2>${esc(me.user.name)}</h2><span class="small muted">${esc(me.user.email ?? "")}</span></div></div>
    <div class="card stack"><span class="tiny muted">DUPR</span><div class="row between"><span>DUPR ID</span><b>${esc(me.dupr.duprId)}</b></div><div class="row between"><span>Doubles / Singles</span><b>${r2(me.dupr.doublesRating)} / ${r2(me.dupr.singlesRating)}</b></div>
      <div class="row wrap"><button class="btn secondary" data-act="sync">Sync now</button><button class="btn danger" data-act="disconnect">Disconnect DUPR</button></div>
      <span class="small muted">Ratings update automatically. Confirmed PickleHeat matches are sent to DUPR for you.</span></div>
    <div class="card stack"><span class="tiny muted">Tournament finder</span><button class="btn secondary" data-act="geo">Use my current location</button>
      <label>Search within (miles)<input id="radius" type="number" min="5" max="1000" value="${me.user.maxDistanceMiles}"></label>
      <div class="row wrap">${["doubles", "mixed", "singles"].map((f) => `<label class="check"><input type="checkbox" data-format="${f}" ${me.user.formats.includes(f) ? "checked" : ""}> ${f[0].toUpperCase() + f.slice(1)}</label>`).join("")}</div>
      <button class="btn" data-act="save-prefs">Save</button><span class="small muted">${me.user.lat != null ? "Home area set." : "Set your area to get tournament picks."}</span></div>
    <div class="card stack"><span class="tiny muted">Getting paid</span>${me.payouts.chargesEnabled ? `<span style="color:var(--lime)">✓ Payout account linked</span>` : `<button class="btn secondary" data-act="payouts">Link payout account</button>`}</div>
    <div class="card stack">${svc.isDemo ? `<span class="small muted">Demo mode: sample data in this browser only. Nothing is charged or sent to DUPR.</span>` : ""}
      <a href="../privacy.html">Privacy Policy</a><a href="../support.html">Support</a>
      <div class="row wrap"><button class="btn secondary" data-act="signout">Sign out</button><button class="btn danger" data-act="delete">Delete account</button></div></div></div>`;
}

// ---------- actions ----------
const acts = {
  async demo() { state.me = await run(() => svc.signIn("demo")); location.hash = state.me?.dupr.connected ? "#/home" : "#/dupr"; },
  async signout() { svc.signOut(); Object.assign(state, { me: null, form: null, recs: null, events: [] }); location.hash = "#/signin"; },
  async "connect-dupr"() {
    const url = await run(() => svc.duprConnectURL());
    if (url) return (location.href = url);
    if (url === undefined && !svc.isDemo) return;
    state.me = await run(() => svc.completeDuprConnect());
    state.form = null;
    location.hash = "#/home";
  },
  async sync() { state.me = await run(() => svc.syncDupr()); state.form = null; toast("Synced with DUPR"); route(); },
  async disconnect() { if (confirm("Disconnect DUPR? You'll need to connect again to see your form.")) { state.me = await run(() => svc.disconnectDupr()); location.hash = "#/dupr"; } },
  async delete() { if (confirm("Delete your PickleHeat account? This can't be undone.")) { await run(() => svc.deleteAccount()); acts.signout(); } },
  async geo() {
    if (!navigator.geolocation) return toast("Location isn't available in this browser.");
    navigator.geolocation.getCurrentPosition(async (p) => {
      state.me = await run(() => svc.updateProfile({ lat: p.coords.latitude, lng: p.coords.longitude }));
      await loadRecs();
      route();
    }, () => toast("Location is off. Allow it in your browser settings."));
  },
  async "save-prefs"() {
    const formats = [...document.querySelectorAll("[data-format]")].filter((x) => x.checked).map((x) => x.dataset.format);
    if (!formats.length) return toast("Pick at least one format.");
    state.me = await run(() => svc.updateProfile({ maxDistanceMiles: Number(document.getElementById("radius").value), formats }));
    await loadRecs();
    toast("Saved");
  },
  async payouts() {
    const url = await run(() => svc.onboardPayouts());
    if (url) return (location.href = url);
    state.me = await run(() => svc.me());
    toast("Payout account linked");
    route();
  },
  async tab(el) { state.tab = el.dataset.tab; events(); },
  async kind(el) { location.hash = `#/create/${el.dataset.kind}`; },
  async publish() { await run(() => svc.publish(state.detail.event.id)); state.events = (await run(() => svc.events())) ?? state.events; route(); },
  async schedule() { await run(() => svc.generateSchedule(state.detail.event.id)); route(); },
  async register() {
    const partner = document.getElementById("partner")?.value ?? null;
    const team = document.getElementById("teamname")?.value || null;
    const r = await run(() => svc.register(state.detail.event.id, partner, team));
    if (!r) return;
    if (r.checkoutUrl) return (location.href = r.checkoutUrl);
    toast("You're registered!");
    route();
  },
  async score(el) {
    const id = el.dataset.id;
    const us = Number(document.querySelector(`[data-home="${id}"]`).value), them = Number(document.querySelector(`[data-away="${id}"]`).value);
    if (!Number.isInteger(us) || !Number.isInteger(them) || us === them) return toast("Enter two different scores.");
    await run(() => svc.reportScore(id, [{ us, them }]));
    route();
  },
  async confirm(el) { await run(() => svc.confirmScore(el.dataset.id)); route(); },
};

document.addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-act]");
  if (!el || !acts[el.dataset.act]) return;
  ev.preventDefault();
  el.disabled = true;
  try { await acts[el.dataset.act](el); } finally { el.disabled = false; }
});

document.addEventListener("submit", async (ev) => {
  if (ev.target.id !== "create-form") return;
  ev.preventDefault();
  const f = new FormData(ev.target);
  const num = (k) => (f.get(k) === "" || f.get(k) == null ? null : Number(f.get(k)));
  const draft = {
    kind: state.kind, name: String(f.get("name")).trim(), format: f.get("format"), startDate: f.get("startDate"),
    weeks: state.kind === "league" ? num("weeks") : null, venue: f.get("venue"), city: f.get("city"), state: f.get("state"),
    lat: state.me.user.lat, lng: state.me.user.lng, minRating: num("minRating"), maxRating: num("maxRating"), capacity: num("capacity"),
    feeCents: Math.round((num("fee") ?? 0) * 100), submitToDupr: f.get("submitToDupr") === "on", requireDuprVerified: f.get("requireDuprVerified") === "on",
  };
  const ev2 = await run(() => svc.createEvent(draft));
  if (!ev2) return;
  if (f.get("openNow") === "on") {
    if (draft.feeCents > 0 && !state.me.payouts.chargesEnabled) toast("Saved as a draft. Link your payout account, then open registration.");
    else await run(() => svc.publish(ev2.id));
  }
  state.events = (await run(() => svc.events())) ?? state.events;
  location.hash = `#/event/${encodeURIComponent(ev2.id)}`;
});

route();
