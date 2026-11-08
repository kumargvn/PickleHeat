// Round robins, pools, playoff brackets and standings for leagues and tournaments.
// Mirrored in ios/PickleHeat/Engine/Schedule.swift.

export interface Pairing {
  round: number; // 1-based
  home: string; // entrant id (team or player)
  away: string;
}

/** Circle-method round robin. Odd counts get a bye each round (no pairing emitted). */
export function roundRobin(entrants: string[]): Pairing[] {
  const list = [...entrants];
  if (list.length < 2) return [];
  const BYE = "\u0000bye";
  if (list.length % 2 === 1) list.push(BYE);
  const n = list.length;
  const out: Pairing[] = [];
  const rot = list.slice(1);
  for (let r = 0; r < n - 1; r++) {
    const ring = [list[0], ...rot];
    for (let i = 0; i < n / 2; i++) {
      const a = ring[i];
      const b = ring[n - 1 - i];
      if (a === BYE || b === BYE) continue;
      // Alternate home/away so the fixed seat doesn't always "host".
      out.push(r % 2 === 0 ? { round: r + 1, home: a, away: b } : { round: r + 1, home: b, away: a });
    }
    rot.unshift(rot.pop()!);
  }
  return out;
}

/** Snake-seeds entrants (already sorted strongest first) into `count` pools. */
export function snakePools<T>(seeded: T[], count: number): T[][] {
  const pools: T[][] = Array.from({ length: Math.max(1, count) }, () => []);
  seeded.forEach((e, i) => {
    const lap = Math.floor(i / pools.length);
    const k = i % pools.length;
    pools[lap % 2 === 0 ? k : pools.length - 1 - k].push(e);
  });
  return pools;
}

export interface BracketSlot {
  round: number;
  slot: number;
  top: string | null; // null = bye
  bottom: string | null;
}

/** First round of a single-elimination bracket, standard seeding (1 v N, byes to top seeds). */
export function eliminationFirstRound(seeded: string[]): BracketSlot[] {
  if (seeded.length < 2) return [];
  let size = 1;
  while (size < seeded.length) size *= 2;
  let order = [1];
  while (order.length < size) {
    const next: number[] = [];
    const m = order.length * 2 + 1;
    for (const s of order) next.push(s, m - s);
    order = next;
  }
  const at = (seed: number) => (seed <= seeded.length ? seeded[seed - 1] : null);
  const out: BracketSlot[] = [];
  for (let i = 0; i < order.length; i += 2) {
    out.push({ round: 1, slot: i / 2 + 1, top: at(order[i]), bottom: at(order[i + 1]) });
  }
  return out;
}

export interface Result {
  home: string;
  away: string;
  games: { home: number; away: number }[];
}

export interface Standing {
  entrant: string;
  played: number;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  diff: number;
}

/** Standings: wins, then head-to-head among two tied, then point differential, then points for. */
export function standings(entrants: string[], results: Result[]): Standing[] {
  const map = new Map<string, Standing>();
  for (const e of entrants) map.set(e, { entrant: e, played: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, diff: 0 });
  const winnerOf = (r: Result) => {
    let h = 0;
    let a = 0;
    let ph = 0;
    let pa = 0;
    for (const g of r.games) {
      ph += g.home;
      pa += g.away;
      if (g.home > g.away) h++;
      else if (g.away > g.home) a++;
    }
    return h !== a ? (h > a ? r.home : r.away) : ph >= pa ? r.home : r.away;
  };
  for (const r of results) {
    const h = map.get(r.home);
    const a = map.get(r.away);
    if (!h || !a) continue;
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
  const h2h = (x: string, y: string) => {
    let xw = 0;
    let yw = 0;
    for (const r of results) {
      if ((r.home === x && r.away === y) || (r.home === y && r.away === x)) {
        if (winnerOf(r) === x) xw++;
        else yw++;
      }
    }
    return yw - xw;
  };
  rows.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    const tied = rows.filter((r) => r.wins === a.wins);
    if (tied.length === 2) {
      const h = h2h(a.entrant, b.entrant);
      if (h !== 0) return h;
    }
    return b.diff - a.diff || b.pointsFor - a.pointsFor || a.entrant.localeCompare(b.entrant);
  });
  return rows;
}
