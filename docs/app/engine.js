// server/src/domain/form.ts
var FORM_WINDOW = 8;
var FORM_DECAY = 0.8;
var FORM_GAIN = 400;
var FORM_MIN_MATCHES = 3;
var POINT_SCALE = 4;
var MATCH_SCALE = 1;
function expectedPointShare(teamRating, opponentRating) {
  return 1 / (1 + Math.pow(10, -(teamRating - opponentRating) / POINT_SCALE));
}
function pointsFor(m) {
  let us = 0;
  let them = 0;
  for (const g of m.games) {
    us += g.us;
    them += g.them;
  }
  return { us, them };
}
function actualPointShare(m) {
  const { us, them } = pointsFor(m);
  return us + them === 0 ? 0.5 : us / (us + them);
}
function won(m) {
  let gw = 0;
  let gl = 0;
  for (const g of m.games) {
    if (g.us > g.them)
      gw++;
    else if (g.them > g.us)
      gl++;
  }
  if (gw !== gl)
    return gw > gl;
  const { us, them } = pointsFor(m);
  return us > them;
}
function formLabel(score) {
  if (score >= 75)
    return "Hot";
  if (score >= 60)
    return "Rising";
  if (score >= 40)
    return "Steady";
  if (score >= 25)
    return "Cooling";
  return "Cold";
}
function newestFirst(matches) {
  return [...matches].sort((a, b) => a.playedAt < b.playedAt ? 1 : a.playedAt > b.playedAt ? -1 : 0);
}
function scoreOf(window) {
  const residuals = window.map((m) => actualPointShare(m) - expectedPointShare(m.teamRating, m.opponentRating));
  let num = 0;
  let den = 0;
  let w = 1;
  for (const r of residuals) {
    num += w * r;
    den += w;
    w *= FORM_DECAY;
  }
  const weighted = den === 0 ? 0 : num / den;
  const score = Math.round(Math.min(100, Math.max(0, 50 + weighted * FORM_GAIN)));
  return { score, residuals, weighted };
}
function formScore(matches) {
  const sorted = newestFirst(matches);
  const window = sorted.slice(0, FORM_WINDOW);
  if (window.length < FORM_MIN_MATCHES)
    return null;
  const now = scoreOf(window);
  const older = sorted.slice(2, 2 + FORM_WINDOW);
  const previousScore = older.length >= FORM_MIN_MATCHES ? scoreOf(older).score : null;
  return {
    score: now.score,
    label: formLabel(now.score),
    matchesUsed: window.length,
    residuals: now.residuals,
    weightedResidual: now.weighted,
    previousScore
  };
}
function formRatingBoost(form) {
  if (form == null)
    return 0;
  const r = Math.min(0.45, Math.max(-0.45, (form - 50) / FORM_GAIN));
  return 0.5 * POINT_SCALE * Math.log10((0.5 + r) / (0.5 - r));
}
function winProbability(ratingA, ratingB, formA, formB) {
  const a = ratingA + formRatingBoost(formA);
  const b = ratingB + formRatingBoost(formB);
  return 1 / (1 + Math.pow(10, -(a - b) / MATCH_SCALE));
}
var pct = (r) => r.wins + r.losses === 0 ? 50 : Math.round(100 * r.wins / (r.wins + r.losses));
var clamp = (x) => Math.round(Math.min(100, Math.max(0, x)));
function insights(matches) {
  const window = newestFirst(matches).slice(0, FORM_WINDOW);
  const record = { wins: 0, losses: 0 };
  const closeGames = { wins: 0, losses: 0 };
  const vsHigherRated = { wins: 0, losses: 0 };
  let us = 0;
  let total = 0;
  for (const m of window) {
    const w = won(m);
    if (w)
      record.wins++;
    else
      record.losses++;
    if (m.opponentRating >= m.teamRating + 0.05) {
      if (w)
        vsHigherRated.wins++;
      else
        vsHigherRated.losses++;
    }
    for (const g of m.games) {
      us += g.us;
      total += g.us + g.them;
      if (Math.abs(g.us - g.them) <= 2 && g.us !== g.them) {
        if (g.us > g.them)
          closeGames.wins++;
        else
          closeGames.losses++;
      }
    }
  }
  const residuals = window.map((m) => actualPointShare(m) - expectedPointShare(m.teamRating, m.opponentRating));
  const mean = residuals.reduce((s, r) => s + r, 0) / Math.max(1, residuals.length);
  const sd = Math.sqrt(residuals.reduce((s, r) => s + (r - mean) * (r - mean), 0) / Math.max(1, residuals.length));
  const form = formScore(matches);
  const momentum = form && form.previousScore != null ? clamp(50 + (form.score - form.previousScore) * 2.5) : 50;
  const traits = {
    clutch: pct(closeGames),
    consistency: clamp(100 - sd * 1000),
    giantKiller: pct(vsHigherRated),
    momentum
  };
  return { record, pointShare: total === 0 ? 0.5 : us / total, closeGames, vsHigherRated, traits, tip: tipFor(traits, window.length) };
}
function tipFor(t, matchCount) {
  if (matchCount < FORM_MIN_MATCHES)
    return "Play a few more DUPR matches to unlock your insights.";
  const entries = [
    ["clutch", t.clutch],
    ["consistency", t.consistency],
    ["giantKiller", t.giantKiller],
    ["momentum", t.momentum]
  ];
  entries.sort((a, b) => a[1] - b[1]);
  const [weakest, value] = entries[0];
  if (value >= 60)
    return "Every part of your game is trending well. Time to try a higher bracket.";
  switch (weakest) {
    case "clutch":
      return "Tight games are slipping away. Play higher-percentage shots at 9-all and up.";
    case "consistency":
      return "Your results swing a lot match to match. A steady warm-up routine helps.";
    case "giantKiller":
      return "Stronger teams are getting the better of you. Book a few games one level up to adjust.";
    case "momentum":
      return "Your form dipped in the last two matches. Rest up and reset before the next one.";
  }
}
// server/src/domain/recommend.ts
var EARTH_RADIUS_MILES = 3958.8;
function distanceMiles(lat1, lng1, lat2, lng2) {
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}
function daysBetween(fromISODate, toISODate) {
  const a = Date.parse(fromISODate.slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(toISODate.slice(0, 10) + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}
var ratingText = (r) => r.toFixed(2);
function ratingFor(p, format) {
  return format === "singles" ? p.singlesRating ?? p.doublesRating : p.doublesRating ?? p.singlesRating;
}
function bracketFit(rating, ev) {
  const lo = ev.minRating ?? 0;
  const hi = ev.maxRating ?? 8;
  if (rating < lo - 0.05 || rating > hi + 0.0001)
    return 0;
  if (ev.minRating == null && ev.maxRating == null)
    return 0.5;
  const span = Math.max(0.25, hi - lo);
  const pos = (rating - lo) / span;
  return Math.max(0.2, 1 - Math.abs(pos - 0.6) * 1.2);
}
function recommend(player, listings, today, limit = 10) {
  const out = [];
  const hot = (player.form ?? 50) >= 75;
  for (const t of listings) {
    const days = daysBetween(today, t.startDate);
    if (days < 0 || !t.registrationOpen)
      continue;
    const dist = distanceMiles(player.lat, player.lng, t.lat, t.lng);
    if (dist > player.maxDistanceMiles)
      continue;
    let best = null;
    for (const ev of t.events) {
      const rating = ratingFor(player, ev.format);
      if (rating == null)
        continue;
      const fit = bracketFit(rating, ev) * (player.formats.includes(ev.format) ? 1 : 0.6);
      if (fit > 0 && (best == null || fit > best.fit))
        best = { ev, fit, rating };
    }
    if (best == null)
      continue;
    const distanceScore = 1 - dist / Math.max(1, player.maxDistanceMiles);
    const dateScore = days < 3 ? 0.3 : days <= 45 ? 1 : Math.max(0.2, 1 - (days - 45) / 120);
    const formatScore = player.formats.includes(best.ev.format) ? 1 : 0;
    const score = 0.45 * best.fit + 0.3 * distanceScore + 0.15 * dateScore + 0.1 * formatScore;
    const reasons = [];
    const base = ratingFor(player, best.ev.format);
    if (best.ev.minRating != null || best.ev.maxRating != null) {
      const lo = best.ev.minRating != null ? ratingText(best.ev.minRating) : "open";
      const hi = best.ev.maxRating != null ? ratingText(best.ev.maxRating) : "up";
      reasons.push(`Your ${ratingText(base)} fits the ${lo}–${hi} bracket`);
    } else {
      reasons.push("Open bracket, no rating cap");
    }
    reasons.push(`${Math.round(dist)} mi away`);
    if (days <= 14)
      reasons.push(days === 0 ? "Starts today" : `Starts in ${days} day${days === 1 ? "" : "s"}`);
    if (hot && best.ev.maxRating != null && best.rating + formRatingBoost(player.form) > best.ev.maxRating) {
      reasons.push("You're in hot form. Consider the next bracket up");
    }
    out.push({ tournament: t, event: best.ev, score: Math.round(score * 1000) / 1000, distanceMiles: Math.round(dist * 10) / 10, reasons });
  }
  out.sort((a, b) => b.score - a.score || a.distanceMiles - b.distanceMiles);
  return out.slice(0, limit);
}
// server/src/domain/schedule.ts
function roundRobin(entrants) {
  const list = [...entrants];
  if (list.length < 2)
    return [];
  const BYE = "\x00bye";
  if (list.length % 2 === 1)
    list.push(BYE);
  const n = list.length;
  const out = [];
  const rot = list.slice(1);
  for (let r = 0;r < n - 1; r++) {
    const ring = [list[0], ...rot];
    for (let i = 0;i < n / 2; i++) {
      const a = ring[i];
      const b = ring[n - 1 - i];
      if (a === BYE || b === BYE)
        continue;
      out.push(r % 2 === 0 ? { round: r + 1, home: a, away: b } : { round: r + 1, home: b, away: a });
    }
    rot.unshift(rot.pop());
  }
  return out;
}
function snakePools(seeded, count) {
  const pools = Array.from({ length: Math.max(1, count) }, () => []);
  seeded.forEach((e, i) => {
    const lap = Math.floor(i / pools.length);
    const k = i % pools.length;
    pools[lap % 2 === 0 ? k : pools.length - 1 - k].push(e);
  });
  return pools;
}
function eliminationFirstRound(seeded) {
  if (seeded.length < 2)
    return [];
  let size = 1;
  while (size < seeded.length)
    size *= 2;
  let order = [1];
  while (order.length < size) {
    const next = [];
    const m = order.length * 2 + 1;
    for (const s of order)
      next.push(s, m - s);
    order = next;
  }
  const at = (seed) => seed <= seeded.length ? seeded[seed - 1] : null;
  const out = [];
  for (let i = 0;i < order.length; i += 2) {
    out.push({ round: 1, slot: i / 2 + 1, top: at(order[i]), bottom: at(order[i + 1]) });
  }
  return out;
}
function standings(entrants, results) {
  const map = new Map;
  for (const e of entrants)
    map.set(e, { entrant: e, played: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, diff: 0 });
  const winnerOf = (r) => {
    let h = 0;
    let a = 0;
    let ph = 0;
    let pa = 0;
    for (const g of r.games) {
      ph += g.home;
      pa += g.away;
      if (g.home > g.away)
        h++;
      else if (g.away > g.home)
        a++;
    }
    return h !== a ? h > a ? r.home : r.away : ph >= pa ? r.home : r.away;
  };
  for (const r of results) {
    const h = map.get(r.home);
    const a = map.get(r.away);
    if (!h || !a)
      continue;
    const w = winnerOf(r);
    h.played++;
    a.played++;
    for (const g of r.games) {
      h.pointsFor += g.home;
      h.pointsAgainst += g.away;
      a.pointsFor += g.away;
      a.pointsAgainst += g.home;
    }
    if (w === r.home) {
      h.wins++;
      a.losses++;
    } else {
      a.wins++;
      h.losses++;
    }
  }
  const rows = [...map.values()].map((s) => ({ ...s, diff: s.pointsFor - s.pointsAgainst }));
  const h2h = (x, y) => {
    let xw = 0;
    let yw = 0;
    for (const r of results) {
      if (r.home === x && r.away === y || r.home === y && r.away === x) {
        if (winnerOf(r) === x)
          xw++;
        else
          yw++;
      }
    }
    return yw - xw;
  };
  rows.sort((a, b) => {
    if (b.wins !== a.wins)
      return b.wins - a.wins;
    const tied = rows.filter((r) => r.wins === a.wins);
    if (tied.length === 2) {
      const h = h2h(a.entrant, b.entrant);
      if (h !== 0)
        return h;
    }
    return b.diff - a.diff || b.pointsFor - a.pointsFor || a.entrant.localeCompare(b.entrant);
  });
  return rows;
}
// shared/sample-data.json
var sample_data_default = {
  _note: "Sample data for demo mode and the sample tournament feed. Not real people or events. Dates are relative to today (daysAgo / startInDays).",
  player: {
    id: "demo-jordan",
    name: "Jordan Reyes",
    duprId: "DEMO-JR42",
    doublesRating: 4.12,
    singlesRating: 3.86,
    lat: 30.5083,
    lng: -97.6789,
    homeArea: "Central Texas"
  },
  matches: [
    { id: "m1", daysAgo: 1, teamRating: 4.08, opponentRating: 4.15, games: [[11, 8], [11, 9]], partnerName: "Priya K.", opponentNames: ["Chen W.", "Ana A."], eventName: "Tuesday Night 4.0 Ladder" },
    { id: "m2", daysAgo: 4, teamRating: 4.1, opponentRating: 3.98, games: [[11, 6], [9, 11], [11, 7]], partnerName: "Sam O.", opponentNames: ["Marco D.", "Lena S."], eventName: "Sunday Mixed League" },
    { id: "m3", daysAgo: 6, teamRating: 4.05, opponentRating: 4.2, games: [[11, 9], [12, 10]], partnerName: "Priya K.", opponentNames: ["Brooks T.", "Hale R."], eventName: "Tuesday Night 4.0 Ladder" },
    { id: "m4", daysAgo: 9, teamRating: 4.12, opponentRating: 4.02, games: [[11, 5], [11, 7]], partnerName: "Dev P.", opponentNames: ["Okafor N.", "Patel R."], eventName: "Open play" },
    { id: "m5", daysAgo: 12, teamRating: 4.07, opponentRating: 4, games: [[8, 11], [11, 9], [9, 11]], partnerName: "Sam O.", opponentNames: ["Nguyen L.", "Ortiz J."], eventName: "Sunday Mixed League" },
    { id: "m6", daysAgo: 15, teamRating: 4.09, opponentRating: 4.11, games: [[11, 7], [11, 8]], partnerName: "Priya K.", opponentNames: ["Kim H.", "Lopez M."], eventName: "Tuesday Night 4.0 Ladder" },
    { id: "m7", daysAgo: 19, teamRating: 4.04, opponentRating: 3.95, games: [[11, 9], [11, 4]], partnerName: "Dev P.", opponentNames: ["Grant B.", "Shah A."], eventName: "Open play" },
    { id: "m8", daysAgo: 23, teamRating: 4.06, opponentRating: 4.01, games: [[7, 11], [10, 12]], partnerName: "Sam O.", opponentNames: ["Ruiz C.", "Ford E."], eventName: "Sunday Mixed League" },
    { id: "m9", daysAgo: 27, teamRating: 4.03, opponentRating: 4.08, games: [[9, 11], [11, 13]], partnerName: "Priya K.", opponentNames: ["Chen W.", "Ana A."], eventName: "Tuesday Night 4.0 Ladder" },
    { id: "m10", daysAgo: 31, teamRating: 4.02, opponentRating: 3.94, games: [[11, 8], [8, 11], [9, 11]], partnerName: "Dev P.", opponentNames: ["Marco D.", "Lena S."], eventName: "Open play" }
  ],
  tournaments: [
    {
      id: "s-fallslam",
      name: "Fall Slam Doubles",
      startInDays: 8,
      lengthDays: 1,
      venue: "Sample Racquet Center",
      city: "Round Rock",
      state: "TX",
      lat: 30.516,
      lng: -97.665,
      registrationOpen: true,
      events: [
        { id: "e1", name: "Men's Doubles 3.5–4.25", format: "doubles", minRating: 3.5, maxRating: 4.25, feeCents: 3500 },
        { id: "e2", name: "Mixed Doubles 4.0+", format: "mixed", minRating: 4, maxRating: null, feeCents: 3500 }
      ]
    },
    {
      id: "s-hillcountry",
      name: "Hill Country Classic",
      startInDays: 20,
      lengthDays: 2,
      venue: "Sample Sports Park",
      city: "Georgetown",
      state: "TX",
      lat: 30.6327,
      lng: -97.6772,
      registrationOpen: true,
      events: [
        { id: "e1", name: "Doubles 4.0", format: "doubles", minRating: 3.75, maxRating: 4.24, feeCents: 4500 },
        { id: "e2", name: "Doubles 4.5", format: "doubles", minRating: 4.25, maxRating: 4.74, feeCents: 4500 },
        { id: "e3", name: "Singles 3.5–4.0", format: "singles", minRating: 3.5, maxRating: 4, feeCents: 3000 }
      ]
    },
    {
      id: "s-capitol",
      name: "Capitol City Open",
      startInDays: 34,
      lengthDays: 3,
      venue: "Sample Tennis & Pickleball Club",
      city: "Austin",
      state: "TX",
      lat: 30.2672,
      lng: -97.7431,
      registrationOpen: true,
      events: [
        { id: "e1", name: "Open Doubles", format: "doubles", minRating: null, maxRating: null, feeCents: 6000 },
        { id: "e2", name: "Mixed 4.0–4.49", format: "mixed", minRating: 4, maxRating: 4.49, feeCents: 5500 }
      ]
    },
    {
      id: "s-bluebonnet",
      name: "Bluebonnet Shootout",
      startInDays: 13,
      lengthDays: 1,
      venue: "Sample Community Courts",
      city: "Temple",
      state: "TX",
      lat: 31.0982,
      lng: -97.3428,
      registrationOpen: true,
      events: [
        { id: "e1", name: "Doubles 3.0–3.49", format: "doubles", minRating: 3, maxRating: 3.49, feeCents: 2500 }
      ]
    },
    {
      id: "s-gulf",
      name: "Gulf Coast Championships",
      startInDays: 26,
      lengthDays: 3,
      venue: "Sample Bayfront Center",
      city: "Corpus Christi",
      state: "TX",
      lat: 27.8006,
      lng: -97.3964,
      registrationOpen: true,
      events: [
        { id: "e1", name: "Doubles 4.0", format: "doubles", minRating: 3.75, maxRating: 4.25, feeCents: 7000 }
      ]
    },
    {
      id: "s-closed",
      name: "Lakeway Invitational",
      startInDays: 5,
      lengthDays: 1,
      venue: "Sample Lake Club",
      city: "Lakeway",
      state: "TX",
      lat: 30.3638,
      lng: -97.9797,
      registrationOpen: false,
      events: [
        { id: "e1", name: "Doubles 4.0", format: "doubles", minRating: 3.75, maxRating: 4.25, feeCents: 4000 }
      ]
    }
  ],
  leagues: [
    { id: "l-tuesday", name: "Tuesday Night 4.0 Ladder", kind: "league", format: "doubles", weeks: 8, currentWeek: 6, players: 16, rank: 2, wins: 9, losses: 3, feeCents: 6000 },
    { id: "l-sunday", name: "Sunday Mixed League", kind: "league", format: "mixed", weeks: 10, currentWeek: 3, players: 24, rank: 5, wins: 4, losses: 2, feeCents: 5000 }
  ]
};

// server/src/adapters/sample.ts
function addDays(isoDate, days) {
  const d = new Date(isoDate.slice(0, 10) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function sampleMatches(today) {
  return sample_data_default.matches.map((x) => ({
    id: x.id,
    playedAt: `${addDays(today, -x.daysAgo)}T18:00:00Z`,
    teamRating: x.teamRating,
    opponentRating: x.opponentRating,
    games: x.games.map(([us, them]) => ({ us, them })),
    partnerName: x.partnerName,
    opponentNames: x.opponentNames,
    eventName: x.eventName
  }));
}
function sampleTournaments(today) {
  return sample_data_default.tournaments.map((t) => ({
    id: t.id,
    source: "sample",
    name: t.name,
    url: null,
    startDate: addDays(today, t.startInDays),
    endDate: addDays(today, t.startInDays + t.lengthDays - 1),
    venue: t.venue,
    city: t.city,
    state: t.state,
    lat: t.lat,
    lng: t.lng,
    registrationOpen: t.registrationOpen,
    events: t.events.map((e) => ({ ...e, format: e.format }))
  }));
}
var samplePlayer = sample_data_default.player;
var sampleLeagues = sample_data_default.leagues;
export {
  addDays,
  distanceMiles,
  eliminationFirstRound,
  formLabel,
  formScore,
  insights,
  recommend,
  roundRobin,
  sampleLeagues,
  sampleMatches,
  samplePlayer,
  sampleTournaments,
  snakePools,
  standings,
  winProbability
};
