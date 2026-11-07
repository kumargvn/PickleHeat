import { describe, expect, test } from "bun:test";
import { expectedPointShare, formLabel, formScore, insights, winProbability } from "../src/domain/form";
import { bracketFit, distanceMiles, recommend } from "../src/domain/recommend";
import { eliminationFirstRound, roundRobin, snakePools, standings } from "../src/domain/schedule";
import { sampleMatches, sampleTournaments } from "../src/adapters/sample";
import { ratingRangeFrom } from "../src/adapters/tournamentSources";
import { stripeForm } from "../src/adapters/payments";
import type { PlayedMatch } from "../src/domain/types";

const TODAY = "2026-11-07";
const m = (id: string, day: string, team: number, opp: number, games: [number, number][]): PlayedMatch => ({
  id,
  playedAt: `${day}T18:00:00Z`,
  teamRating: team,
  opponentRating: opp,
  games: games.map(([us, them]) => ({ us, them })),
});

describe("form score", () => {
  test("even teams expect half the points", () => {
    expect(expectedPointShare(4, 4)).toBeCloseTo(0.5, 10);
    expect(expectedPointShare(4.5, 4)).toBeGreaterThan(0.5);
  });

  test("needs three matches", () => {
    expect(formScore([m("a", "2026-11-01", 4, 4, [[11, 5]])])).toBeNull();
  });

  test("playing exactly at rating scores 50", () => {
    const ms = [1, 2, 3, 4].map((i) => m(`e${i}`, `2026-10-1${i}`, 3.8, 3.8, [[11, 9], [9, 11]]));
    expect(formScore(ms)!.score).toBe(50);
    expect(formScore(ms)!.label).toBe("Steady");
  });

  test("the sample player is in hot form", () => {
    const f = formScore(sampleMatches(TODAY))!;
    expect(f.matchesUsed).toBe(8);
    expect(f.score).toBeGreaterThanOrEqual(60);
    expect(f.previousScore).not.toBeNull();
  });

  test("losing badly to weaker teams is cold", () => {
    const ms = [1, 2, 3, 4, 5].map((i) => m(`c${i}`, `2026-10-0${i}`, 3.5, 3.4, [[5, 11], [7, 11]]));
    expect(formScore(ms)!.label).toBe("Cold");
  });

  test("recent matches weigh more", () => {
    const old = [1, 2, 3].map((i) => m(`o${i}`, `2026-09-0${i}`, 4, 4, [[3, 11]]));
    const recentWin = m("n", "2026-10-30", 4, 4, [[11, 3]]);
    const recentLoss = m("n", "2026-10-30", 4, 4, [[3, 11]]);
    expect(formScore([...old, recentWin])!.score).toBeGreaterThan(formScore([...old, recentLoss])!.score);
  });

  test("labels", () => {
    expect(formLabel(80)).toBe("Hot");
    expect(formLabel(60)).toBe("Rising");
    expect(formLabel(40)).toBe("Steady");
    expect(formLabel(25)).toBe("Cooling");
    expect(formLabel(10)).toBe("Cold");
  });
});

describe("win probability", () => {
  test("higher rating is favoured; form shifts it", () => {
    expect(winProbability(4.12, 3.97)).toBeGreaterThan(0.5);
    expect(winProbability(4, 4)).toBeCloseTo(0.5, 10);
    expect(winProbability(4, 4, 80, 50)).toBeGreaterThan(0.5);
    expect(winProbability(4, 4, 50, 80)).toBeLessThan(0.5);
  });
});

describe("insights", () => {
  test("record and close games from the sample", () => {
    const i = insights(sampleMatches(TODAY));
    expect(i.record.wins + i.record.losses).toBe(8);
    expect(i.pointShare).toBeGreaterThan(0.5);
    expect(i.tip.length).toBeGreaterThan(10);
  });
});

describe("recommendations", () => {
  const player = { doublesRating: 4.12, singlesRating: 3.86, form: 78, lat: 30.5083, lng: -97.6789, maxDistanceMiles: 75, formats: ["doubles", "mixed"] as ("doubles" | "mixed" | "singles")[] };

  test("distance is sensible", () => {
    expect(distanceMiles(30.5083, -97.6789, 30.2672, -97.7431)).toBeGreaterThan(15);
    expect(distanceMiles(30.5083, -97.6789, 30.2672, -97.7431)).toBeLessThan(20);
  });

  test("skips closed, far and out-of-range tournaments", () => {
    const recs = recommend(player, sampleTournaments(TODAY), TODAY);
    const ids = recs.map((r) => r.tournament.id);
    expect(ids).not.toContain("s-closed"); // registration closed
    expect(ids).not.toContain("s-gulf"); // ~190 miles away
    expect(ids).not.toContain("s-bluebonnet"); // 3.0–3.49 bracket only
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(recs[0].reasons[0]).toContain("bracket");
  });

  test("bracket fit prefers upper-middle", () => {
    const ev = { id: "x", name: "", format: "doubles" as const, minRating: 3.5, maxRating: 4.0, feeCents: null };
    expect(bracketFit(3.8, ev)).toBeGreaterThan(bracketFit(3.5, ev));
    expect(bracketFit(4.3, ev)).toBe(0);
  });

  test("hot players are nudged up a bracket", () => {
    const recs = recommend(player, sampleTournaments(TODAY), TODAY);
    expect(recs.some((r) => r.reasons.some((x) => x.includes("hot form")))).toBe(true);
  });
});

describe("schedule", () => {
  test("round robin: everyone plays everyone once", () => {
    for (const n of [2, 3, 4, 5, 8]) {
      const teams = Array.from({ length: n }, (_, i) => `t${i}`);
      const p = roundRobin(teams);
      expect(p.length).toBe((n * (n - 1)) / 2);
      const seen = new Set(p.map((x) => [x.home, x.away].sort().join("-")));
      expect(seen.size).toBe(p.length);
      for (let r = 1; r <= Math.max(...p.map((x) => x.round)); r++) {
        const inRound = p.filter((x) => x.round === r).flatMap((x) => [x.home, x.away]);
        expect(new Set(inRound).size).toBe(inRound.length); // nobody plays twice in a round
      }
    }
  });

  test("snake pools balance strength", () => {
    expect(snakePools(["1", "2", "3", "4", "5", "6"], 2)).toEqual([["1", "4", "5"], ["2", "3", "6"]]);
  });

  test("bracket gives byes to top seeds", () => {
    const b = eliminationFirstRound(["s1", "s2", "s3", "s4", "s5", "s6"]);
    expect(b.length).toBe(4);
    expect(b[0]).toEqual({ round: 1, slot: 1, top: "s1", bottom: null });
  });

  test("standings use head to head between two tied teams", () => {
    const t = standings(["A", "B", "C"], [
      { home: "A", away: "B", games: [{ home: 11, away: 9 }] },
      { home: "B", away: "C", games: [{ home: 11, away: 0 }] },
      { home: "C", away: "A", games: [{ home: 11, away: 1 }] },
    ]);
    expect(t.map((x) => x.wins)).toEqual([1, 1, 1]);
    expect(t[0].entrant).toBe("B"); // three-way tie → point differential
  });
});

describe("adapters", () => {
  test("rating ranges from event names", () => {
    expect(ratingRangeFrom("Men's Doubles 3.5-4.0")).toEqual({ min: 3.5, max: 4.0 });
    expect(ratingRangeFrom("Mixed 4.0+")).toEqual({ min: 4.0, max: null });
    expect(ratingRangeFrom("Open")).toEqual({ min: null, max: null });
  });

  test("stripe form encoding", () => {
    expect(stripeForm({ a: 1, b: { c: "x y" }, d: [{ e: 2 }] })).toBe("a=1&b%5Bc%5D=x%20y&d%5B0%5D%5Be%5D=2");
  });
});
