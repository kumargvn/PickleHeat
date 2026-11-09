// Core domain types shared by the API, the adapters and the tests.
// Mirrors ios/Rally/Engine/Models.swift. Keep the two in sync.

export type ID = string;

export interface GameScore {
  /** Points won by the player's team. */
  us: number;
  /** Points won by the opponents. */
  them: number;
}

/** One completed match as seen from one player's side. */
export interface PlayedMatch {
  id: ID;
  playedAt: string; // ISO 8601
  /** Average DUPR rating of the player's team (singles: the player's rating). */
  teamRating: number;
  /** Average DUPR rating of the opposing team. */
  opponentRating: number;
  games: GameScore[];
  partnerName?: string;
  opponentNames?: string[];
  eventName?: string;
}

export type FormLabel = "Hot" | "Rising" | "Steady" | "Cooling" | "Cold";

export interface FormResult {
  score: number; // 0..100, 50 = playing exactly at rating
  label: FormLabel;
  matchesUsed: number;
  /** Per match: actual point share minus expected, newest first. */
  residuals: number[];
  /** Weighted average residual (e.g. 0.07 = winning 7% more points than expected). */
  weightedResidual: number;
  /** Score two matches ago, for a trend arrow. null when there is not enough history. */
  previousScore: number | null;
}

export type EventFormat = "doubles" | "mixed" | "singles" | "mlp" | "trips";

export interface TournamentEvent {
  id: ID;
  name: string;
  format: EventFormat;
  minRating: number | null;
  maxRating: number | null;
  feeCents: number | null;
}

export interface TournamentListing {
  id: ID;
  source: string; // "rally" | "pickleball.com" | "fluidpb" | "sample"
  name: string;
  url: string | null;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  venue: string;
  city: string;
  state: string;
  lat: number;
  lng: number;
  registrationOpen: boolean;
  events: TournamentEvent[];
}

export interface PlayerProfileForRecs {
  doublesRating: number | null;
  singlesRating: number | null;
  form: number | null;
  lat: number;
  lng: number;
  maxDistanceMiles: number;
  formats: EventFormat[];
}

export interface Recommendation {
  tournament: TournamentListing;
  event: TournamentEvent;
  score: number; // 0..1
  distanceMiles: number;
  reasons: string[];
}
