import { describe, expect, test } from "bun:test";
import { advance, buildBracket, champion, playable } from "../src/domain/bracket";
import { formGroups, groupSizes, nextLadder, rotation, seededShuffle, tally } from "../src/domain/ladder";
import { lineTemplate, linesOutcome } from "../src/domain/lines";
import { matchTags, playerStats } from "../src/domain/stats";
import { contains } from "../src/adapters/memoryStore";
import { parseInviteCsv } from "../src/services/invites";

describe("ladder groups", () => {
  test("splits into 4s and 5s, byes only when it can't", () => {
    expect(groupSizes(8)).toEqual({ sizes: [4, 4], byes: 0 });
    expect(groupSizes(9)).toEqual({ sizes: [4, 5], byes: 0 });
    expect(groupSizes(13)).toEqual({ sizes: [4, 4, 5], byes: 0 });
    expect(groupSizes(55).sizes.reduce((a, b) => a + b, 0) + groupSizes(55).byes).toBe(55);
    expect(groupSizes(55).byes).toBe(0);
    expect(groupSizes(6)).toEqual({ sizes: [5], byes: 1 });
    expect(groupSizes(7)).toEqual({ sizes: [5], byes: 2 });
    expect(groupSizes(3)).toEqual({ sizes: [], byes: 3 });
  });

  test("bottom players take byes; 5-groups sit at the bottom", () => {
    const ids = "abcdefghijk".split(""); // 11 players: 10 = 5 + 5, one bye
    const { groups, byes } = formGroups(ids);
    expect(groups.map((g) => g.length)).toEqual([5, 5]);
    expect(byes).toEqual(["k"]);
  });

  test("rotation: everyone partners everyone once", () => {
    for (const n of [4, 5]) {
      const g = "abcde".slice(0, n).split("");
      const pairs = rotation(g).flatMap((p) => [p.home.slice().sort().join(""), p.away.slice().sort().join("")]);
      const want = new Set<string>();
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) want.add(g[i] + g[j]);
      expect(new Set(pairs)).toEqual(want);
    }
  });

  test("seeded shuffle is reproducible", () => {
    expect(seededShuffle([1, 2, 3, 4, 5, 6], 42)).toEqual(seededShuffle([1, 2, 3, 4, 5, 6], 42));
    expect(seededShuffle([1, 2, 3, 4, 5, 6], 42)).not.toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("promotion and relegation: one up, one down", () => {
    const prev = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const groups = [["a", "b", "c", "d"], ["e", "f", "g", "h"]];
    // Group 1: d is bottom. Group 2: h wins everything.
    const results = [
      { home: ["a", "b"], away: ["c", "d"], games: [{ us: 11, them: 5 }] },
      { home: ["a", "c"], away: ["b", "d"], games: [{ us: 11, them: 7 }] },
      { home: ["a", "d"], away: ["b", "c"], games: [{ us: 4, them: 11 }] },
      { home: ["e", "h"], away: ["f", "g"], games: [{ us: 11, them: 3 }] },
      { home: ["f", "h"], away: ["e", "g"], games: [{ us: 11, them: 6 }] },
      { home: ["g", "h"], away: ["e", "f"], games: [{ us: 11, them: 9 }] },
    ];
    const { order, rows } = nextLadder(prev, groups, [], results);
    expect(order.slice(0, 4)).toContain("h");
    expect(order.slice(4)).toContain("d");
    const h = rows.find((r) => r.userId === "h")!;
    expect(h.prevRank).toBe(8);
    expect(h.nextGroup).toBe(1);
    expect(h.wins).toBe(3);
  });

  test("players who declined keep their spot", () => {
    const prev = ["a", "b", "c", "d", "x", "e", "f", "g", "h"];
    const groups = [["a", "b", "c", "d"], ["e", "f", "g", "h"]];
    const { order } = nextLadder(prev, groups, [], []);
    expect(order.indexOf("x")).toBe(4);
  });

  test("tally counts games", () => {
    const t = tally([{ home: ["a", "b"], away: ["c", "d"], games: [{ us: 11, them: 5 }, { us: 9, them: 11 }] }]);
    expect(t.get("a")).toEqual({ wins: 1, losses: 1, pf: 20, pa: 16 });
  });
});

describe("brackets", () => {
  test("single elimination with byes", () => {
    const b = buildBracket(["s1", "s2", "s3", "s4", "s5", "s6"], false);
    const r1 = b.filter((n) => n.side === "W" && n.round === 1);
    expect(r1.filter((n) => n.decided).length).toBe(2); // top two seeds get byes
    const semis = b.filter((n) => n.side === "W" && n.round === 2);
    expect(semis.some((n) => n.home === "s1")).toBe(true);
    for (const n of r1.filter(playable)) advance(b, n.key, n.home!);
    for (const n of b.filter((x) => x.side === "W" && x.round === 2).filter(playable)) advance(b, n.key, n.home!);
    const final = b.find((n) => n.side === "W" && n.round === 3)!;
    expect(playable(final)).toBe(true);
    advance(b, final.key, final.home!);
    expect(champion(b)).toBe("s1");
  });

  test("double elimination: every team must lose twice; reset match when the losers-bracket champ wins", () => {
    const teams = ["t1", "t2", "t3", "t4", "t5"];
    const b = buildBracket(teams, true);
    const losses = new Map(teams.map((t) => [t, 0]));
    let guard = 0;
    // Higher seed (lower number) always wins, except the grand final which the losers-bracket champ wins.
    while (!champion(b) && guard++ < 50) {
      const n = b.find(playable);
      if (!n) break;
      const better = (x: string, y: string) => (Number(x.slice(1)) < Number(y.slice(1)) ? x : y);
      let w = better(n.home!, n.away!);
      if (n.key === "GF1-1") w = n.away!;
      const l = w === n.home ? n.away! : n.home!;
      losses.set(l, losses.get(l)! + 1);
      advance(b, n.key, w);
    }
    const champ = champion(b);
    expect(champ).not.toBeNull();
    expect(b.find((n) => n.key === "GF2-1")!.decided).toBe(true);
    for (const t of teams) if (t !== champ) expect(losses.get(t)).toBe(2);
    expect(losses.get(champ!)).toBe(1);
  });

  test("double elimination with a clean winners-bracket champion skips the reset", () => {
    const b = buildBracket(["a1", "a2", "a3", "a4"], true);
    let guard = 0;
    while (!champion(b) && guard++ < 50) {
      const n = b.find(playable)!;
      advance(b, n.key, Number(n.home!.slice(1)) < Number(n.away!.slice(1)) ? n.home! : n.away!);
    }
    expect(champion(b)).toBe("a1");
    const reset = b.find((n) => n.key === "GF2-1")!;
    expect(reset.homeDead && reset.awayDead).toBe(true);
  });
});

describe("lines (MLP, trips)", () => {
  const g = (id: string) => (id.startsWith("m") ? "m" : "f") as "m" | "f";
  test("MLP template: WD, MD, two mixed", () => {
    const lines = lineTemplate("mlp", ["m1", "m2", "f1", "f2"], ["m3", "m4", "f3", "f4"], g);
    expect(lines.map((l) => l.label)).toEqual(["Women's doubles", "Men's doubles", "Mixed 1", "Mixed 2"]);
    expect(lines[0].homePlayers).toEqual(["f1", "f2"]);
  });
  test("2–2 needs a DreamBreaker", () => {
    const lines = lineTemplate("mlp", ["m1", "m2", "f1", "f2"], ["m3", "m4", "f3", "f4"], g).map((l, i) => ({ ...l, games: [i < 2 ? { us: 21, them: 15 } : { us: 15, them: 21 }] }));
    expect(linesOutcome("mlp", lines).needsDreamBreaker).toBe(true);
    const withDb = [...lines, { label: "DreamBreaker", homePlayers: [], awayPlayers: [], games: [{ us: 21, them: 19 }] }];
    expect(linesOutcome("mlp", withDb)).toMatchObject({ winner: "home", needsDreamBreaker: false });
  });
  test("trips: 3 lines, best of 3", () => {
    const lines = lineTemplate("trips", ["a", "b", "c"], ["x", "y", "z"], () => null).map((l, i) => ({ ...l, games: [{ us: i === 0 ? 5 : 11, them: i === 0 ? 11 : 7 }] }));
    expect(lines.length).toBe(3);
    expect(linesOutcome("trips", lines).winner).toBe("home");
  });
});

describe("stats and tags", () => {
  test("player stats and percentages", () => {
    const s = playerStats([{ home: ["a", "b"], away: ["c", "d"], games: [{ us: 11, them: 4 }] }]);
    expect(s[0]).toMatchObject({ wins: 1, losses: 0, winPct: 100, pd: 7 });
  });
  test("upset, nailbiter, smackdown", () => {
    const rating = (id: string) => ({ a: 3.0, b: 3.0, c: 3.6, d: 3.6 })[id] ?? null;
    expect(matchTags({ home: ["a", "b"], away: ["c", "d"], games: [{ us: 11, them: 9 }, { us: 12, them: 10 }] }, rating)).toEqual(["upset", "nailbiter"]);
    expect(matchTags({ home: ["c", "d"], away: ["a", "b"], games: [{ us: 11, them: 2 }, { us: 11, them: 5 }] }, rating)).toEqual(["smackdown"]);
  });
});

describe("store and imports", () => {
  test("JSON containment matches Postgres @>", () => {
    expect(contains({ a: 1, ids: ["x", "y"] }, { ids: ["y"] })).toBe(true);
    expect(contains({ a: 1, ids: ["x"] }, { ids: ["y"] })).toBe(false);
    expect(contains({ a: null }, { a: null })).toBe(true);
    expect(contains({ a: { b: 2, c: 3 } }, { a: { b: 2 } })).toBe(true);
  });
  test("CSV invites", () => {
    expect(parseInviteCsv("name,email,dupr\nAna Diaz, ana@example.com, AB12CD\nBo Li\tBO34XY")).toEqual([
      { name: "Ana Diaz", email: "ana@example.com", duprId: "AB12CD" },
      { name: "Bo Li", email: null, duprId: "BO34XY" },
    ]);
  });
});
