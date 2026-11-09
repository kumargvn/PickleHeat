// Heat Climb and Wildfire Mixer: heats of 4–5, rotating partners, climbing up or dropping down.

export interface Pair {
  home: [string, string];
  away: [string, string];
}

/**
 * Splits n players into groups of 4 and 5 (as many 4s as possible).
 * Returns the sizes, plus how many players sit out when n can't be split (e.g. 6, 7, 11).
 */
export function groupSizes(n: number): { sizes: number[]; byes: number } {
  for (let byes = 0; byes <= 3 && n - byes >= 4; byes++) {
    const m = n - byes;
    const fives = m % 4;
    const fours = (m - 5 * fives) / 4;
    if (fours >= 0 && Number.isInteger(fours)) return { sizes: [...Array(fours + fives)].map((_, i) => (i < fours ? 4 : 5)), byes };
  }
  return { sizes: [], byes: n };
}

/**
 * Chunks players (already in ladder order, best first) into groups. The bottom players
 * take the byes, and 5-player groups go to the bottom of the ladder.
 */
export function formGroups(ordered: string[]): { groups: string[][]; byes: string[] } {
  const { sizes, byes } = groupSizes(ordered.length);
  const playing = ordered.slice(0, ordered.length - byes);
  const groups: string[][] = [];
  let i = 0;
  for (const s of sizes) {
    groups.push(playing.slice(i, i + s));
    i += s;
  }
  return { groups, byes: ordered.slice(ordered.length - byes) };
}

/** Every player partners every other player once. 4 players: 3 matches; 5: 5 matches (one sits out each). */
export function rotation(group: string[]): Pair[] {
  const [a, b, c, d, e] = group;
  if (group.length === 4) {
    return [
      { home: [a, b], away: [c, d] },
      { home: [a, c], away: [b, d] },
      { home: [a, d], away: [b, c] },
    ];
  }
  if (group.length === 5) {
    return [
      { home: [a, b], away: [c, d] },
      { home: [a, c], away: [b, e] },
      { home: [a, d], away: [c, e] },
      { home: [a, e], away: [b, d] },
      { home: [b, c], away: [d, e] },
    ];
  }
  return [];
}

/** Deterministic shuffle (Wildfire Mixer reshuffles by round number, so results are reproducible). */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  let s = seed >>> 0 || 1;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface GameResult {
  home: string[];
  away: string[];
  games: { us: number; them: number }[];
}

export interface PlayerTally {
  wins: number;
  losses: number;
  pf: number;
  pa: number;
}

/** Wins and losses count games, as on most ladder sites (a 2-game match can be 1–1). */
export function tally(results: GameResult[]): Map<string, PlayerTally> {
  const t = new Map<string, PlayerTally>();
  const get = (p: string) => {
    let x = t.get(p);
    if (!x) t.set(p, (x = { wins: 0, losses: 0, pf: 0, pa: 0 }));
    return x;
  };
  for (const r of results) {
    for (const g of r.games) {
      if (g.us === g.them) continue;
      for (const p of r.home) {
        const x = get(p);
        x.pf += g.us;
        x.pa += g.them;
        if (g.us > g.them) x.wins++;
        else x.losses++;
      }
      for (const p of r.away) {
        const x = get(p);
        x.pf += g.them;
        x.pa += g.us;
        if (g.them > g.us) x.wins++;
        else x.losses++;
      }
    }
  }
  return t;
}

export interface LadderRow {
  userId: string;
  rank: number;
  prevRank: number | null;
  fromGroup: number | null;
  nextGroup: number | null;
  wins: number;
  losses: number;
  pd: number;
  played: boolean;
}

/**
 * New ladder after a round. Inside each group players sort by wins, then point differential,
 * then previous rank; players who didn't play sort last. Then the top of each group swaps with
 * the bottom of the group above (one up, one down). Byes keep their place at the bottom.
 */
export function nextLadder(prevOrder: string[], groups: string[][], byes: string[], results: GameResult[], absent: Set<string> = new Set()): { order: string[]; rows: LadderRow[] } {
  const t = tally(results);
  const prevRank = new Map(prevOrder.map((p, i) => [p, i + 1]));
  const fromGroup = new Map<string, number>();
  groups.forEach((g, gi) => g.forEach((p) => fromGroup.set(p, gi + 1)));
  const played = (p: string) => !absent.has(p) && ((t.get(p)?.wins ?? 0) + (t.get(p)?.losses ?? 0) > 0);

  const sorted = groups.map((g) =>
    [...g].sort((a, b) => {
      const pa = played(a), pb = played(b);
      if (pa !== pb) return pa ? -1 : 1;
      const ta = t.get(a) ?? { wins: 0, losses: 0, pf: 0, pa: 0 };
      const tb = t.get(b) ?? { wins: 0, losses: 0, pf: 0, pa: 0 };
      return tb.wins - ta.wins || (tb.pf - tb.pa) - (ta.pf - ta.pa) || (prevRank.get(a) ?? 1e9) - (prevRank.get(b) ?? 1e9);
    }),
  );
  // One up, one down between neighbouring groups (decided on the pre-swap order).
  const swapped = sorted.map((g) => [...g]);
  for (let gi = 0; gi + 1 < sorted.length; gi++) {
    const bottomOfUpper = sorted[gi][sorted[gi].length - 1];
    const topOfLower = sorted[gi + 1][0];
    swapped[gi][swapped[gi].length - 1] = topOfLower;
    swapped[gi + 1][0] = bottomOfUpper;
  }
  // Players who sat this round out (declined) keep their previous spot.
  const order = [...swapped.flat(), ...byes];
  for (const p of prevOrder) {
    if (fromGroup.has(p) || byes.includes(p)) continue;
    order.splice(Math.min((prevRank.get(p) ?? order.length + 1) - 1, order.length), 0, p);
  }
  const nextGroups = formGroups(order).groups;
  const nextGroup = new Map<string, number>();
  nextGroups.forEach((g, gi) => g.forEach((p) => nextGroup.set(p, gi + 1)));
  const rows = order.map((userId, i) => {
    const x = t.get(userId) ?? { wins: 0, losses: 0, pf: 0, pa: 0 };
    return {
      userId,
      rank: i + 1,
      prevRank: prevRank.get(userId) ?? null,
      fromGroup: fromGroup.get(userId) ?? null,
      nextGroup: nextGroup.get(userId) ?? null,
      wins: x.wins,
      losses: x.losses,
      pd: x.pf - x.pa,
      played: played(userId),
    };
  });
  return { order, rows };
}

/** Scramble standings: total wins, then point differential, then name order for stability. */
export function scrambleOrder(players: string[], results: GameResult[]): string[] {
  const t = tally(results);
  return [...players].sort((a, b) => {
    const ta = t.get(a) ?? { wins: 0, losses: 0, pf: 0, pa: 0 };
    const tb = t.get(b) ?? { wins: 0, losses: 0, pf: 0, pa: 0 };
    return tb.wins - ta.wins || (tb.pf - tb.pa) - (ta.pf - ta.pa) || a.localeCompare(b);
  });
}
