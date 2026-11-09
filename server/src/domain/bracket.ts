// Single- and double-elimination brackets with byes and automatic advancement.
//
// A bracket is a list of nodes. Each slot (home/away) is either filled with an entry id,
// waiting for an earlier match, or "dead" (a bye that will never be filled). A match with one
// dead slot is a walkover; a match with two dead slots disappears. resolve() propagates these.

export type Side = "home" | "away";
export interface SlotRef {
  key: string;
  side: Side;
}

export interface BNode {
  key: string;
  side: "W" | "L" | "GF";
  round: number;
  slot: number;
  home: string | null;
  away: string | null;
  homeDead: boolean;
  awayDead: boolean;
  winnerTo: SlotRef | null;
  loserTo: SlotRef | null;
  decided: boolean;
  /** null + decided = nobody advanced (both slots dead). */
  winner: string | null;
}

export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const m = order.length * 2 + 1;
    order = order.flatMap((s) => [s, m - s]);
  }
  return order;
}

const key = (side: "W" | "L" | "GF", round: number, slot: number) => `${side}${round}-${slot}`;

function node(side: "W" | "L" | "GF", round: number, slot: number): BNode {
  return { key: key(side, round, slot), side, round, slot, home: null, away: null, homeDead: false, awayDead: false, winnerTo: null, loserTo: null, decided: false, winner: null };
}

/** Builds the bracket for teams in seed order (best first). Double elimination needs 3+ teams. */
export function buildBracket(seeded: string[], double: boolean): BNode[] {
  if (seeded.length < 2) return [];
  if (double && seeded.length < 3) double = false;
  let size = 2;
  while (size < seeded.length) size *= 2;
  const k = Math.log2(size);
  const nodes = new Map<string, BNode>();
  const add = (n: BNode) => nodes.set(n.key, n);

  // Winners bracket
  for (let r = 1; r <= k; r++) {
    const count = size / 2 ** r;
    for (let s = 1; s <= count; s++) {
      const n = node("W", r, s);
      if (r < k) n.winnerTo = { key: key("W", r + 1, Math.ceil(s / 2)), side: s % 2 ? "home" : "away" };
      add(n);
    }
  }
  const order = seedOrder(size);
  for (let i = 0; i < order.length; i += 2) {
    const n = nodes.get(key("W", 1, i / 2 + 1))!;
    const a = order[i], b = order[i + 1];
    if (a <= seeded.length) n.home = seeded[a - 1];
    else n.homeDead = true;
    if (b <= seeded.length) n.away = seeded[b - 1];
    else n.awayDead = true;
  }

  if (double) {
    // Losers bracket: odd rounds pair losers-bracket winners, even rounds bring in winners-bracket losers.
    const lbRounds = 2 * (k - 1);
    for (let j = 1; j <= lbRounds; j++) {
      const m = Math.ceil(j / 2);
      const count = size / 2 ** (m + 1);
      for (let s = 1; s <= count; s++) add(node("L", j, s));
    }
    for (let j = 1; j <= lbRounds; j++) {
      const m = Math.ceil(j / 2);
      const count = size / 2 ** (m + 1);
      for (let s = 1; s <= count; s++) {
        const n = nodes.get(key("L", j, s))!;
        if (j === lbRounds) n.winnerTo = { key: key("GF", 1, 1), side: "away" };
        else if (j % 2 === 1) n.winnerTo = { key: key("L", j + 1, s), side: "home" };
        else n.winnerTo = { key: key("L", j + 1, Math.ceil(s / 2)), side: s % 2 ? "home" : "away" };
      }
    }
    // Winners-bracket losers drop down.
    for (let s = 1; s <= size / 2; s++) nodes.get(key("W", 1, s))!.loserTo = { key: key("L", 1, Math.ceil(s / 2)), side: s % 2 ? "home" : "away" };
    for (let r = 2; r <= k; r++) {
      const count = size / 2 ** r;
      const lbRound = 2 * (r - 1);
      for (let s = 1; s <= count; s++) nodes.get(key("W", r, s))!.loserTo = { key: key("L", lbRound, count - s + 1), side: "away" };
    }
    nodes.get(key("W", k, 1))!.winnerTo = { key: key("GF", 1, 1), side: "home" };
    add(node("GF", 1, 1));
    add(node("GF", 2, 1)); // reset match, only played if the losers-bracket champion wins GF1
  }

  const list = [...nodes.values()];
  resolve(list);
  return list;
}

function setSlot(nodes: Map<string, BNode>, ref: SlotRef | null, value: string | null) {
  if (!ref) return;
  const n = nodes.get(ref.key);
  if (!n) return;
  if (ref.side === "home") {
    n.home = value;
    n.homeDead = value === null;
  } else {
    n.away = value;
    n.awayDead = value === null;
  }
}

const filled = (n: BNode, side: Side) => (side === "home" ? n.home !== null : n.away !== null);
const dead = (n: BNode, side: Side) => (side === "home" ? n.homeDead : n.awayDead);

/** Walkovers and empty matches advance on their own. Call after any change. */
export function resolve(list: BNode[]): void {
  const nodes = new Map(list.map((n) => [n.key, n]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of list) {
      if (n.decided || n.key === "GF2-1") continue;
      const hd = dead(n, "home"), ad = dead(n, "away");
      const hf = filled(n, "home"), af = filled(n, "away");
      if ((hd && (af || ad)) || (ad && hf)) {
        n.decided = true;
        n.winner = hd && ad ? null : hd ? n.away : n.home;
        setSlot(nodes, n.winnerTo, n.winner);
        setSlot(nodes, n.loserTo, null);
        changed = true;
      }
    }
  }
}

/** Records a played result and moves both teams on. */
export function advance(list: BNode[], k: string, winner: string): void {
  const nodes = new Map(list.map((n) => [n.key, n]));
  const n = nodes.get(k);
  if (!n || n.decided) throw new Error("That match is already decided");
  if (winner !== n.home && winner !== n.away) throw new Error("Winner must be one of the two teams");
  const loser = winner === n.home ? n.away : n.home;
  n.decided = true;
  n.winner = winner;
  if (n.key === "GF1-1") {
    const reset = nodes.get("GF2-1")!;
    if (winner === n.home) {
      // Winners-bracket champion wins: no reset match.
      reset.homeDead = reset.awayDead = true;
      reset.decided = true;
      reset.winner = null;
    } else {
      reset.home = n.home;
      reset.away = n.away;
    }
  } else {
    setSlot(nodes, n.winnerTo, winner);
    setSlot(nodes, n.loserTo, loser);
  }
  resolve(list);
}

/** True when both teams are known and the match hasn't been played. */
export function playable(n: BNode): boolean {
  return !n.decided && n.home !== null && n.away !== null;
}

/** Champion once the bracket is finished, else null. */
export function champion(list: BNode[]): string | null {
  const gf2 = list.find((n) => n.key === "GF2-1");
  if (gf2) {
    if (gf2.decided && gf2.winner) return gf2.winner;
    const gf1 = list.find((n) => n.key === "GF1-1")!;
    return gf2.decided && gf1.decided ? gf1.winner : null;
  }
  const finals = list.filter((n) => n.side === "W");
  const top = finals.reduce((a, b) => (b.round > a.round ? b : a), finals[0]);
  return top?.decided ? top.winner : null;
}
