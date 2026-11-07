// Tournament recommendations: picks the best event at each nearby tournament
// for a player and ranks them. Mirrored in ios/Pickora/Engine/Recommender.swift.

import { formRatingBoost } from "./form";
import type { EventFormat, PlayerProfileForRecs, Recommendation, TournamentEvent, TournamentListing } from "./types";

const EARTH_RADIUS_MILES = 3958.8;

export function distanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

function daysBetween(fromISODate: string, toISODate: string): number {
  const a = Date.parse(fromISODate.slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(toISODate.slice(0, 10) + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

const ratingText = (r: number) => r.toFixed(2);

function ratingFor(p: PlayerProfileForRecs, format: EventFormat): number | null {
  return format === "singles" ? p.singlesRating ?? p.doublesRating : p.doublesRating ?? p.singlesRating;
}

/** 0..1: how well a rating sits inside an event's bracket. 1 = upper-middle, the most competitive spot. */
export function bracketFit(rating: number, ev: TournamentEvent): number {
  const lo = ev.minRating ?? 0;
  const hi = ev.maxRating ?? 8;
  if (rating < lo - 0.05 || rating > hi + 0.0001) return 0;
  if (ev.minRating == null && ev.maxRating == null) return 0.5; // open event: allowed, not targeted
  const span = Math.max(0.25, hi - lo);
  const pos = (rating - lo) / span;
  return Math.max(0.2, 1 - Math.abs(pos - 0.6) * 1.2);
}

export function recommend(player: PlayerProfileForRecs, listings: TournamentListing[], today: string, limit = 10): Recommendation[] {
  const out: Recommendation[] = [];
  const hot = (player.form ?? 50) >= 75;
  for (const t of listings) {
    const days = daysBetween(today, t.startDate);
    if (days < 0 || !t.registrationOpen) continue;
    const dist = distanceMiles(player.lat, player.lng, t.lat, t.lng);
    if (dist > player.maxDistanceMiles) continue;

    // Eligibility uses the real DUPR rating; form only adds a "move up" nudge.
    let best: { ev: TournamentEvent; fit: number; rating: number } | null = null;
    for (const ev of t.events) {
      const rating = ratingFor(player, ev.format);
      if (rating == null) continue;
      const fit = bracketFit(rating, ev) * (player.formats.includes(ev.format) ? 1 : 0.6);
      if (fit > 0 && (best == null || fit > best.fit)) best = { ev, fit, rating };
    }
    if (best == null) continue;

    const distanceScore = 1 - dist / Math.max(1, player.maxDistanceMiles);
    const dateScore = days < 3 ? 0.3 : days <= 45 ? 1 : Math.max(0.2, 1 - (days - 45) / 120);
    const formatScore = player.formats.includes(best.ev.format) ? 1 : 0;
    const score = 0.45 * best.fit + 0.3 * distanceScore + 0.15 * dateScore + 0.1 * formatScore;

    const reasons: string[] = [];
    const base = ratingFor(player, best.ev.format)!;
    if (best.ev.minRating != null || best.ev.maxRating != null) {
      const lo = best.ev.minRating != null ? ratingText(best.ev.minRating) : "open";
      const hi = best.ev.maxRating != null ? ratingText(best.ev.maxRating) : "up";
      reasons.push(`Your ${ratingText(base)} fits the ${lo}–${hi} bracket`);
    } else {
      reasons.push("Open bracket, no rating cap");
    }
    reasons.push(`${Math.round(dist)} mi away`);
    if (days <= 14) reasons.push(days === 0 ? "Starts today" : `Starts in ${days} day${days === 1 ? "" : "s"}`);
    if (hot && best.ev.maxRating != null && best.rating + formRatingBoost(player.form) > best.ev.maxRating) {
      reasons.push("You're in hot form. Consider the next bracket up");
    }
    out.push({ tournament: t, event: best.ev, score: Math.round(score * 1000) / 1000, distanceMiles: Math.round(dist * 10) / 10, reasons });
  }
  out.sort((a, b) => b.score - a.score || a.distanceMiles - b.distanceMiles);
  return out.slice(0, limit);
}
