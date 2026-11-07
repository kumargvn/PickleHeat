// Outside tournament feeds. Each is off until its partner grants API access:
//
// - pickleball.com (PickleballTournaments.com / PPA): documented API at apidoc.pickleball.com,
//   needs an API token. Field names below follow that page's sample responses and must be
//   checked once a token is issued. Location filtering is done here because the list endpoint
//   has no location parameter.
// - FluidPB: no public API found. The adapter is a placeholder that returns nothing until
//   FluidPB provides an API or feed.
//
// Scraping either website is deliberately NOT done: it can break their terms of use.

import { distanceMiles } from "../domain/recommend";
import type { EventFormat, TournamentEvent, TournamentListing } from "../domain/types";
import type { TournamentSearch, TournamentSource } from "../ports";

const num = (x: unknown): number | null => (x == null || x === "" || !isFinite(Number(x)) ? null : Number(x));

function formatFrom(text: string): EventFormat {
  const t = text.toLowerCase();
  if (t.includes("mixed")) return "mixed";
  if (t.includes("single")) return "singles";
  return "doubles";
}

/** Pulls "3.5", "4.0+", "3.5-4.0" style brackets out of an event name. */
export function ratingRangeFrom(text: string): { min: number | null; max: number | null } {
  const range = text.match(/(\d\.\d{1,2})\s*[-–to]+\s*(\d\.\d{1,2})/);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const plus = text.match(/(\d\.\d{1,2})\s*\+/);
  if (plus) return { min: Number(plus[1]), max: null };
  const single = text.match(/\b(\d\.\d{1,2})\b/);
  if (single) {
    const v = Number(single[1]);
    return { min: v - 0.25, max: v + 0.24 };
  }
  return { min: null, max: null };
}

export class PickleballComSource implements TournamentSource {
  readonly name = "pickleball.com";
  constructor(private apiToken: string | undefined, private baseUrl = "https://api.pickleball.com", private fetchFn: typeof fetch = fetch) {}

  get enabled(): boolean {
    return !!this.apiToken;
  }

  async search(q: TournamentSearch): Promise<TournamentListing[]> {
    if (!this.apiToken) return [];
    const res = await this.fetchFn(`${this.baseUrl}/v1/tournaments/current-and-future`, { headers: { "API-TOKEN": this.apiToken } });
    if (!res.ok) throw new Error(`pickleball.com: HTTP ${res.status}`);
    const body = (await res.json()) as any;
    const rows: any[] = body.data ?? body.result ?? body ?? [];
    const out: TournamentListing[] = [];
    for (const r of rows) {
      const lat = num(r.latitude ?? r.lat);
      const lng = num(r.longitude ?? r.lng);
      if (lat == null || lng == null) continue;
      if (distanceMiles(q.lat, q.lng, lat, lng) > q.radiusMiles) continue;
      const start = String(r.start_date ?? r.startDate ?? "").slice(0, 10);
      if (!start || start < q.today) continue;
      const events: TournamentEvent[] = (r.events ?? []).map((e: any, i: number) => {
        const name = String(e.title ?? e.name ?? `Event ${i + 1}`);
        const range = ratingRangeFrom(name);
        return { id: String(e.uuid ?? e.id ?? i), name, format: formatFrom(name), minRating: num(e.min_rating) ?? range.min, maxRating: num(e.max_rating) ?? range.max, feeCents: num(e.fee) != null ? Math.round(Number(e.fee) * 100) : null };
      });
      out.push({
        id: `pbcom-${r.uuid ?? r.id}`,
        source: this.name,
        name: String(r.title ?? r.name),
        url: r.url ?? (r.slug ? `https://pickleball.com/tournaments/${r.slug}` : null),
        startDate: start,
        endDate: String(r.end_date ?? r.endDate ?? start).slice(0, 10),
        venue: String(r.venue ?? r.location_name ?? ""),
        city: String(r.city ?? ""),
        state: String(r.state ?? ""),
        lat,
        lng,
        registrationOpen: r.registration_open ?? r.registrationOpen ?? true,
        events: events.length ? events : [{ id: "all", name: "All events", format: "doubles", minRating: null, maxRating: null, feeCents: null }],
      });
    }
    return out;
  }
}

export class FluidPbSource implements TournamentSource {
  readonly name = "fluidpb";
  constructor(private apiToken: string | undefined) {}
  get enabled(): boolean {
    return false; // Flip on once FluidPB provides an API; see README "Tournament feeds".
  }
  async search(_q: TournamentSearch): Promise<TournamentListing[]> {
    void this.apiToken;
    return [];
  }
}

/** Pickora's own open tournaments, so they show up alongside outside feeds. */
export class PickoraEventsSource implements TournamentSource {
  readonly name = "pickora";
  readonly enabled = true;
  constructor(private list: () => Promise<{ id: string; name: string; startDate: string; endDate: string | null; venue: string; city: string; state: string; lat: number | null; lng: number | null; format: EventFormat; minRating: number | null; maxRating: number | null; feeCents: number; kind: string; status: string }[]>, private webAppUrl: string) {}

  async search(q: TournamentSearch): Promise<TournamentListing[]> {
    const rows = await this.list();
    return rows
      .filter((e) => e.kind === "tournament" && e.status === "open" && e.lat != null && e.lng != null && e.startDate >= q.today)
      .filter((e) => distanceMiles(q.lat, q.lng, e.lat!, e.lng!) <= q.radiusMiles)
      .map((e) => ({
        id: `pickora-${e.id}`,
        source: this.name,
        name: e.name,
        url: `${this.webAppUrl}#/events/${e.id}`,
        startDate: e.startDate,
        endDate: e.endDate ?? e.startDate,
        venue: e.venue,
        city: e.city,
        state: e.state,
        lat: e.lat!,
        lng: e.lng!,
        registrationOpen: true,
        events: [{ id: e.id, name: e.name, format: e.format, minRating: e.minRating, maxRating: e.maxRating, feeCents: e.feeCents }],
      }));
  }
}
