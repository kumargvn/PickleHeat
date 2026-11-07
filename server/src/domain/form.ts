// Form score, win probability and score-based insights.
// The same math lives in ios/Rally/Engine/Form.swift; shared/vectors/form.json keeps them in sync.

import type { FormLabel, FormResult, PlayedMatch } from "./types";

/** How many recent DUPR matches feed the Form score. */
export const FORM_WINDOW = 8;
/** Weight multiplier per step back in time (newest = 1). */
export const FORM_DECAY = 0.8;
/** Score points per unit of weighted residual (0.07 → +28). */
export const FORM_GAIN = 400;
/** Fewer matches than this and there is no score. */
export const FORM_MIN_MATCHES = 3;
/** Rating gap that moves the expected point share by one "decade" of odds. */
const POINT_SCALE = 4;
/** Rating gap that moves the match win probability by one "decade" of odds. */
const MATCH_SCALE = 1;

export function expectedPointShare(teamRating: number, opponentRating: number): number {
  return 1 / (1 + Math.pow(10, -(teamRating - opponentRating) / POINT_SCALE));
}

export function pointsFor(m: PlayedMatch): { us: number; them: number } {
  let us = 0;
  let them = 0;
  for (const g of m.games) {
    us += g.us;
    them += g.them;
  }
  return { us, them };
}

export function actualPointShare(m: PlayedMatch): number {
  const { us, them } = pointsFor(m);
  return us + them === 0 ? 0.5 : us / (us + them);
}

/** True when the player's team won the match (more games; ties broken on points). */
export function won(m: PlayedMatch): boolean {
  let gw = 0;
  let gl = 0;
  for (const g of m.games) {
    if (g.us > g.them) gw++;
    else if (g.them > g.us) gl++;
  }
  if (gw !== gl) return gw > gl;
  const { us, them } = pointsFor(m);
  return us > them;
}

export function formLabel(score: number): FormLabel {
  if (score >= 75) return "Hot";
  if (score >= 60) return "Rising";
  if (score >= 40) return "Steady";
  if (score >= 25) return "Cooling";
  return "Cold";
}

function newestFirst(matches: PlayedMatch[]): PlayedMatch[] {
  return [...matches].sort((a, b) => (a.playedAt < b.playedAt ? 1 : a.playedAt > b.playedAt ? -1 : 0));
}

function scoreOf(window: PlayedMatch[]): { score: number; residuals: number[]; weighted: number } {
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

export function formScore(matches: PlayedMatch[]): FormResult | null {
  const sorted = newestFirst(matches);
  const window = sorted.slice(0, FORM_WINDOW);
  if (window.length < FORM_MIN_MATCHES) return null;
  const now = scoreOf(window);
  const older = sorted.slice(2, 2 + FORM_WINDOW);
  const previousScore = older.length >= FORM_MIN_MATCHES ? scoreOf(older).score : null;
  return {
    score: now.score,
    label: formLabel(now.score),
    matchesUsed: window.length,
    residuals: now.residuals,
    weightedResidual: now.weighted,
    previousScore,
  };
}

/** Rating bump implied by a form score, damped by half. Form 50 → 0. */
export function formRatingBoost(form: number | null | undefined): number {
  if (form == null) return 0;
  const r = Math.min(0.45, Math.max(-0.45, (form - 50) / FORM_GAIN));
  return 0.5 * POINT_SCALE * Math.log10((0.5 + r) / (0.5 - r));
}

/** Chance that team A beats team B, from ratings and (optionally) current form. */
export function winProbability(ratingA: number, ratingB: number, formA?: number | null, formB?: number | null): number {
  const a = ratingA + formRatingBoost(formA);
  const b = ratingB + formRatingBoost(formB);
  return 1 / (1 + Math.pow(10, -(a - b) / MATCH_SCALE));
}

export interface Record {
  wins: number;
  losses: number;
}

export interface Insights {
  record: Record;
  pointShare: number;
  closeGames: Record; // games decided by 2 points or fewer
  vsHigherRated: Record; // opponents rated 0.05+ above the player's team
  traits: { clutch: number; consistency: number; giantKiller: number; momentum: number };
  tip: string;
}

const pct = (r: Record) => (r.wins + r.losses === 0 ? 50 : Math.round((100 * r.wins) / (r.wins + r.losses)));
const clamp = (x: number) => Math.round(Math.min(100, Math.max(0, x)));

export function insights(matches: PlayedMatch[]): Insights {
  const window = newestFirst(matches).slice(0, FORM_WINDOW);
  const record = { wins: 0, losses: 0 };
  const closeGames = { wins: 0, losses: 0 };
  const vsHigherRated = { wins: 0, losses: 0 };
  let us = 0;
  let total = 0;
  for (const m of window) {
    const w = won(m);
    if (w) record.wins++;
    else record.losses++;
    if (m.opponentRating >= m.teamRating + 0.05) {
      if (w) vsHigherRated.wins++;
      else vsHigherRated.losses++;
    }
    for (const g of m.games) {
      us += g.us;
      total += g.us + g.them;
      if (Math.abs(g.us - g.them) <= 2 && g.us !== g.them) {
        if (g.us > g.them) closeGames.wins++;
        else closeGames.losses++;
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
    momentum,
  };
  return { record, pointShare: total === 0 ? 0.5 : us / total, closeGames, vsHigherRated, traits, tip: tipFor(traits, window.length) };
}

export function tipFor(t: Insights["traits"], matchCount: number): string {
  if (matchCount < FORM_MIN_MATCHES) return "Play a few more DUPR matches to unlock your insights.";
  const entries: [keyof Insights["traits"], number][] = [
    ["clutch", t.clutch],
    ["consistency", t.consistency],
    ["giantKiller", t.giantKiller],
    ["momentum", t.momentum],
  ];
  entries.sort((a, b) => a[1] - b[1]);
  const [weakest, value] = entries[0];
  if (value >= 60) return "Every part of your game is trending well. Time to try a higher bracket.";
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
