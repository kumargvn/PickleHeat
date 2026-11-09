// Team formats scored by "lines" (several doubles games between the same two teams).
//
// MLP: teams of 4 (2 men, 2 women): women's doubles, men's doubles, two mixed doubles.
//      If it's 2–2, a DreamBreaker (singles rotation, one game to 21) decides it.
// Trips: teams of 3: each pair of teammates plays one doubles game (3 lines).

import type { EventFormat } from "./types";

export interface LineSpec {
  label: string;
  homePlayers: string[];
  awayPlayers: string[];
}

export interface LineResult extends LineSpec {
  games: { us: number; them: number }[];
}

export const TEAM_SIZE: Record<EventFormat, number> = { singles: 1, doubles: 2, mixed: 2, trips: 3, mlp: 4 };

export function usesLines(format: EventFormat): boolean {
  return format === "mlp" || format === "trips";
}

function byGender(roster: string[], genderOf: (id: string) => "m" | "f" | null) {
  const men = roster.filter((p) => genderOf(p) === "m");
  const women = roster.filter((p) => genderOf(p) === "f");
  // Fill gaps in roster order if genders are missing, so a line can always be played.
  const rest = roster.filter((p) => !men.includes(p) && !women.includes(p));
  while (men.length < 2 && rest.length) men.push(rest.shift()!);
  while (women.length < 2 && rest.length) women.push(rest.shift()!);
  return { men, women };
}

export function lineTemplate(format: EventFormat, home: string[], away: string[], genderOf: (id: string) => "m" | "f" | null): LineSpec[] {
  if (format === "trips") {
    const pairs: [number, number][] = [[0, 1], [0, 2], [1, 2]];
    return pairs.map(([i, j], n) => ({ label: `Line ${n + 1}`, homePlayers: [home[i], home[j]], awayPlayers: [away[i], away[j]] }));
  }
  if (format === "mlp") {
    const h = byGender(home, genderOf);
    const a = byGender(away, genderOf);
    return [
      { label: "Women's doubles", homePlayers: h.women.slice(0, 2), awayPlayers: a.women.slice(0, 2) },
      { label: "Men's doubles", homePlayers: h.men.slice(0, 2), awayPlayers: a.men.slice(0, 2) },
      { label: "Mixed 1", homePlayers: [h.men[0], h.women[0]], awayPlayers: [a.men[0], a.women[0]] },
      { label: "Mixed 2", homePlayers: [h.men[1], h.women[1]], awayPlayers: [a.men[1], a.women[1]] },
    ];
  }
  return [];
}

function lineWinner(l: LineResult): "home" | "away" | null {
  let h = 0, a = 0, ph = 0, pa = 0;
  for (const g of l.games) {
    ph += g.us;
    pa += g.them;
    if (g.us > g.them) h++;
    else if (g.them > g.us) a++;
  }
  if (h === 0 && a === 0) return null;
  if (h !== a) return h > a ? "home" : "away";
  return ph === pa ? null : ph > pa ? "home" : "away";
}

/** Who won, and whether a DreamBreaker line still has to be added (MLP at 2–2). */
export function linesOutcome(format: EventFormat, lines: LineResult[]): { winner: "home" | "away" | null; needsDreamBreaker: boolean; home: number; away: number } {
  let home = 0, away = 0;
  for (const l of lines) {
    const w = lineWinner(l);
    if (w === "home") home++;
    else if (w === "away") away++;
  }
  const regular = format === "mlp" ? 4 : lines.length;
  const decidedRegular = lines.slice(0, regular).every((l) => lineWinner(l) !== null);
  if (format === "mlp" && decidedRegular && lines.length === 4 && home === 2 && away === 2) return { winner: null, needsDreamBreaker: true, home, away };
  if (!lines.every((l) => lineWinner(l) !== null)) return { winner: null, needsDreamBreaker: false, home, away };
  return { winner: home === away ? null : home > away ? "home" : "away", needsDreamBreaker: false, home, away };
}

export function dreamBreaker(home: string[], away: string[]): LineSpec {
  return { label: "DreamBreaker", homePlayers: [...home], awayPlayers: [...away] };
}
