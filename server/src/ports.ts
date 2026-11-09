// Ports: the only things the API knows about the outside world.
// Each one has adapters in src/adapters. Swapping a vendor (database, payments,
// identity, DUPR, tournament feeds) means writing a new adapter, not touching routes.

import type { EventFormat, GameScore, PlayedMatch, TournamentListing } from "./domain/types";

// ---------- Storage: a small document store ----------
//
// Every entity is a JSON document with an `id`, kept in a named collection.
// `find` matches by JSON containment: {eventId: "e1"} or {playerIds: ["u1"]}.
// Postgres implements this with jsonb @>, the memory store in plain JS, so any
// database that can do the same can host PickleHeat.

export interface Doc {
  id: string;
}

export interface Collection<T extends Doc> {
  get(id: string): Promise<T | null>;
  put(doc: T): Promise<void>;
  delete(id: string): Promise<void>;
  find(match: Record<string, unknown>): Promise<T[]>;
}

export interface Store {
  collection<T extends Doc>(name: string): Collection<T>;
}

// ---------- Entities ----------

export type Gender = "m" | "f";

export interface User extends Doc {
  appleSub: string | null;
  email: string | null;
  name: string;
  gender: Gender | null;
  lat: number | null;
  lng: number | null;
  maxDistanceMiles: number;
  formats: EventFormat[];
  createdAt: string;
}

/** Email + password sign-in (web). id = lower-cased email. */
export interface Credential extends Doc {
  userId: string;
  salt: string;
  hash: string;
  createdAt: string;
}

/** id = userId */
export interface DuprLink extends Doc {
  userId: string;
  duprId: string;
  duprUserId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  doublesRating: number | null;
  singlesRating: number | null;
  /** DUPR's reliability score, 0–100. */
  doublesReliability: number | null;
  singlesReliability: number | null;
  ratingUpdatedAt: string | null;
  matchesSyncedAt: string | null;
  linkedAt: string;
}

/** id = userId */
export interface DuprHistory extends Doc {
  matches: PlayedMatch[];
}

export type ClubRole = "owner" | "admin" | "member";

export interface Club extends Doc {
  name: string;
  description: string;
  city: string;
  state: string;
  lat: number | null;
  lng: number | null;
  createdBy: string;
  createdAt: string;
}

/** id = `${clubId}:${userId}` */
export interface ClubMember extends Doc {
  clubId: string;
  userId: string;
  role: ClubRole;
  joinedAt: string;
}

export type EventKind = "league" | "tournament";
export type EventStatus = "draft" | "open" | "closed" | "in_progress" | "completed";
/**
 * How play is organised.
 * - flex_ladder ("Heat Climb"): players sign up alone; each round they're placed in heats of 4 by rank,
 *   play rotating partners, and move up or down a heat based on results.
 * - scramble ("Wildfire Mixer"): like Heat Climb, but heats are reshuffled every round with no promotion.
 * - round_robin: fixed teams, everyone plays everyone (leagues: one round per week).
 * - pools_playoffs: fixed teams, snake-seeded pools, then single-elimination playoffs.
 * - single_elim / double_elim: fixed teams, bracket only.
 */
export type EventStyle = "flex_ladder" | "scramble" | "round_robin" | "pools_playoffs" | "single_elim" | "double_elim";

export const INDIVIDUAL_STYLES: EventStyle[] = ["flex_ladder", "scramble"];

export interface PickleHeatEvent extends Doc {
  organizerId: string;
  clubId: string | null;
  kind: EventKind;
  style: EventStyle;
  name: string;
  description: string;
  format: EventFormat;
  startDate: string;
  endDate: string | null;
  /** Leagues: number of rounds (weeks). */
  weeks: number | null;
  /** Flex/scramble: days per round. */
  roundDays: number;
  /** Games in each match (flex leagues usually play 2). */
  gamesPerMatch: number;
  venue: string;
  city: string;
  state: string;
  lat: number | null;
  lng: number | null;
  minRating: number | null;
  maxRating: number | null;
  /** Teams (or players, for individual styles and singles). */
  capacity: number;
  /** Per player. Non-members when the event belongs to a club. */
  feeCents: number;
  /** Per player for club members; null = same as feeCents. */
  memberFeeCents: number | null;
  currency: string;
  requireDuprVerified: boolean;
  submitToDupr: boolean;
  status: EventStatus;
  /** Flex ladder: current order of players, best first. */
  ladder: string[];
  createdAt: string;
}

export type EntryStatus = "pending_payment" | "confirmed" | "waitlisted" | "withdrawn" | "refunded";

export interface Entry extends Doc {
  eventId: string;
  playerIds: string[];
  teamName: string;
  teamRating: number | null;
  status: EntryStatus;
  /** True when the organizer added the entry (invite/import): no payment due. */
  comped: boolean;
  createdAt: string;
}

export type RoundStatus = "upcoming" | "in_progress" | "completed";

export interface RankRow {
  userId: string;
  rank: number;
  prevRank: number | null;
  fromGroup: number | null;
  nextGroup: number | null;
  wins: number;
  losses: number;
  pd: number;
  played: boolean;
}

export interface Round extends Doc {
  eventId: string;
  number: number;
  startDate: string;
  endDate: string;
  status: RoundStatus;
  /** Players who sat out because the count didn't split into groups of 4–5. */
  byes: string[];
  /** Filled when the round closes. */
  ranking: RankRow[] | null;
}

/** id = `${roundId}:${userId}` */
export interface Attendance extends Doc {
  roundId: string;
  eventId: string;
  userId: string;
  status: "confirmed" | "declined";
}

export interface PlayGroup extends Doc {
  eventId: string;
  roundId: string;
  number: number;
  playerIds: string[];
  chatId: string;
}

export interface SubRequest extends Doc {
  eventId: string;
  roundId: string;
  groupId: string;
  userId: string;
  status: "open" | "filled" | "cancelled";
  subUserId: string | null;
  createdAt: string;
}

export type MatchStatus = "scheduled" | "reported" | "confirmed";

export interface Line {
  label: string;
  homePlayers: string[];
  awayPlayers: string[];
  games: GameScore[];
}

export interface Slot {
  matchId: string;
  side: "home" | "away";
}

export interface Match extends Doc {
  eventId: string;
  roundId: string | null;
  groupId: string | null;
  /** Round number (league week, pool round, or bracket round). */
  round: number;
  pool: number | null;
  /** Bracket position for elimination play: W = winners, L = losers, GF = grand final. */
  bracket: { side: "W" | "L" | "GF"; round: number; slot: number } | null;
  label: string | null;
  homeEntryId: string | null;
  awayEntryId: string | null;
  homePlayers: string[];
  awayPlayers: string[];
  /** Bracket slots that will never be filled (byes). */
  homeDead: boolean;
  awayDead: boolean;
  winnerTo: Slot | null;
  loserTo: Slot | null;
  scheduledAt: string | null;
  court: string | null;
  /** Games from the home side's point of view. */
  games: GameScore[];
  /** Team formats (MLP, trips): one entry per line; the team that wins more lines wins. */
  lines: Line[] | null;
  status: MatchStatus;
  reportedBy: string | null;
  confirmedBy: string | null;
  duprMatchId: string | null;
  duprSyncedAt: string | null;
  duprError: string | null;
}

export type PaymentStatus = "pending" | "paid" | "refunded" | "failed";

export interface Payment extends Doc {
  entryId: string;
  eventId: string;
  userId: string;
  amountCents: number;
  applicationFeeCents: number;
  currency: string;
  provider: string;
  providerRef: string;
  status: PaymentStatus;
  createdAt: string;
}

/** id = userId */
export interface PayoutAccount extends Doc {
  userId: string;
  provider: string;
  providerAccountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

export type ChatKind = "event" | "group" | "club" | "direct";

export interface Chat extends Doc {
  kind: ChatKind;
  title: string;
  eventId: string | null;
  groupId: string | null;
  clubId: string | null;
  memberIds: string[];
  lastMessageAt: string | null;
  createdAt: string;
}

export interface Message extends Doc {
  chatId: string;
  /** null = PickleHeat bot. */
  userId: string | null;
  text: string;
  createdAt: string;
  reactions: Record<string, string[]>;
}

/** id = `${chatId}:${userId}` */
export interface ChatRead extends Doc {
  chatId: string;
  userId: string;
  at: string;
}

export interface Notification extends Doc {
  userId: string;
  kind: string;
  title: string;
  body: string;
  /** In-app path, e.g. "events/<id>" or "chats/<id>". */
  link: string | null;
  read: boolean;
  createdAt: string;
}

export interface Invite extends Doc {
  eventId: string;
  name: string;
  email: string | null;
  duprId: string | null;
  status: "pending" | "joined";
  createdAt: string;
}

/** One-time tokens already redeemed (handoff links). id = token id. */
export interface UsedToken extends Doc {
  usedAt: string;
}

// ---------- Identity (who is signing in) ----------

export interface VerifiedIdentity {
  subject: string;
  email: string | null;
}

export interface IdentityVerifier {
  verify(identityToken: string): Promise<VerifiedIdentity>;
}

// ---------- DUPR (ratings in, matches out) ----------

export interface DuprProfile {
  duprId: string;
  duprUserId: string;
  name: string;
  doublesRating: number | null;
  singlesRating: number | null;
  doublesReliability: number | null;
  singlesReliability: number | null;
}

export interface DuprTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
}

export interface DuprMatchUpload {
  /** Our id; DUPR echoes it back so retries are safe. */
  externalId: string;
  eventName: string;
  playedAt: string;
  location: string;
  format: "singles" | "doubles";
  teamA: { duprIds: string[]; games: number[] };
  teamB: { duprIds: string[]; games: number[] };
}

export interface RatingUpdate {
  duprId: string;
  doublesRating: number | null;
  singlesRating: number | null;
  doublesReliability?: number | null;
  singlesReliability?: number | null;
}

export interface RatingProvider {
  readonly name: string;
  ssoUrl(): string;
  verifyUser(accessToken: string): Promise<DuprProfile>;
  refresh(refreshToken: string): Promise<DuprTokens>;
  matchHistory(link: DuprLink): Promise<PlayedMatch[]>;
  uploadMatch(m: DuprMatchUpload): Promise<string>;
  deleteMatch(duprMatchId: string): Promise<void>;
  subscribeRatings(webhookUrl: string): Promise<void>;
  parseWebhook(body: unknown): RatingUpdate[] | null;
}

// ---------- Payments (web only; money goes to the organizer's linked account) ----------

export interface CheckoutRequest {
  amountCents: number;
  applicationFeeCents: number;
  currency: string;
  destinationAccountId: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  customerEmail: string | null;
}

export type PaymentEvent =
  | { type: "checkout_paid"; providerRef: string }
  | { type: "checkout_failed"; providerRef: string }
  | { type: "refunded"; providerRef: string }
  | { type: "account_updated"; providerAccountId: string; chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean };

export interface PaymentProvider {
  readonly name: string;
  createAccount(user: User): Promise<string>;
  onboardingLink(accountId: string, returnUrl: string, refreshUrl: string): Promise<string>;
  accountStatus(accountId: string): Promise<Pick<PayoutAccount, "chargesEnabled" | "payoutsEnabled" | "detailsSubmitted">>;
  dashboardLink(accountId: string): Promise<string>;
  createCheckout(req: CheckoutRequest): Promise<{ id: string; url: string }>;
  refund(providerRef: string): Promise<void>;
  parseWebhook(rawBody: string, signatureHeader: string | null): Promise<PaymentEvent | null>;
}

// ---------- Tournament feeds ----------

export interface TournamentSearch {
  lat: number;
  lng: number;
  radiusMiles: number;
  today: string;
}

export interface TournamentSource {
  readonly name: string;
  readonly enabled: boolean;
  search(q: TournamentSearch): Promise<TournamentListing[]>;
}

// ---------- Everything a request handler can reach ----------

export interface Deps {
  store: Store;
  identity: IdentityVerifier;
  dupr: RatingProvider;
  payments: PaymentProvider;
  tournamentSources: TournamentSource[];
  config: AppConfig;
  now: () => Date;
  newId: () => string;
}

export interface AppConfig {
  publicBaseUrl: string;
  jwtSecret: string;
  appScheme: string;
  webAppUrl: string;
  platformFeeBps: number;
  allowDevAuth: boolean;
}
