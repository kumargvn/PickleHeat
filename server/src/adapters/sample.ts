// Sample data from shared/sample-data.json, turned into domain objects with real dates.
// Backs demo mode and the "sample" tournament source until real feeds are switched on.

import data from "../../../shared/sample-data.json";
import type { EventFormat, PlayedMatch, TournamentListing } from "../domain/types";
import type { TournamentSearch, TournamentSource } from "../ports";
import { distanceMiles } from "../domain/recommend";

export function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate.slice(0, 10) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function sampleMatches(today: string): PlayedMatch[] {
  return data.matches.map((x) => ({
    id: x.id,
    playedAt: `${addDays(today, -x.daysAgo)}T18:00:00Z`,
    teamRating: x.teamRating,
    opponentRating: x.opponentRating,
    games: x.games.map(([us, them]) => ({ us, them })),
    partnerName: x.partnerName,
    opponentNames: x.opponentNames,
    eventName: x.eventName,
  }));
}

export function sampleTournaments(today: string): TournamentListing[] {
  return data.tournaments.map((t) => ({
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
    events: t.events.map((e) => ({ ...e, format: e.format as EventFormat })),
  }));
}

export const samplePlayer = data.player;
export const sampleLeagues = data.leagues;

export class SampleTournamentSource implements TournamentSource {
  readonly name = "sample";
  readonly enabled = true;
  async search(q: TournamentSearch): Promise<TournamentListing[]> {
    return sampleTournaments(q.today).filter((t) => distanceMiles(q.lat, q.lng, t.lat, t.lng) <= q.radiusMiles);
  }
}
