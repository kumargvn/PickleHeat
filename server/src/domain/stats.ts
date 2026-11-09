// Player stats for an event, and match tags for the Upsets / Nailbiters / Smackdowns filters.

import { tally, type GameResult } from "./ladder";

export interface StatRow {
  userId: string;
  wins: number;
  losses: number;
  winPct: number; // 0..100, one decimal
  pf: number;
  pa: number;
  pd: number;
  pdPct: number; // point differential as % of points played, one decimal
}

const r1 = (x: number) => Math.round(x * 10) / 10;

export function playerStats(results: GameResult[]): StatRow[] {
  const t = tally(results);
  return [...t.entries()]
    .map(([userId, x]) => {
      const played = x.wins + x.losses;
      const points = x.pf + x.pa;
      return {
        userId,
        wins: x.wins,
        losses: x.losses,
        winPct: played ? r1((100 * x.wins) / played) : 0,
        pf: x.pf,
        pa: x.pa,
        pd: x.pf - x.pa,
        pdPct: points ? r1((100 * (x.pf - x.pa)) / points) : 0,
      };
    })
    .sort((a, b) => b.wins - a.wins || b.pd - a.pd || a.userId.localeCompare(b.userId));
}

export type MatchTag = "upset" | "nailbiter" | "smackdown";

/**
 * - upset: the side with the lower average rating (by 0.2+) won.
 * - nailbiter: every game decided by 2 or fewer points.
 * - smackdown: winners outscored losers by 10+ points across the match.
 */
export function matchTags(r: GameResult, ratingOf: (id: string) => number | null): MatchTag[] {
  const games = r.games.filter((g) => g.us !== g.them);
  if (!games.length) return [];
  let hw = 0, aw = 0, hp = 0, ap = 0;
  for (const g of games) {
    hp += g.us;
    ap += g.them;
    if (g.us > g.them) hw++;
    else aw++;
  }
  const homeWon = hw !== aw ? hw > aw : hp > ap;
  const tags: MatchTag[] = [];
  const avg = (ids: string[]) => {
    const rs = ids.map(ratingOf).filter((x): x is number => x != null);
    return rs.length === ids.length && rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
  };
  const h = avg(r.home), a = avg(r.away);
  if (h != null && a != null && (homeWon ? a - h : h - a) >= 0.2) tags.push("upset");
  if (games.every((g) => Math.abs(g.us - g.them) <= 2)) tags.push("nailbiter");
  if (Math.abs(hp - ap) >= 10) tags.push("smackdown");
  return tags;
}
