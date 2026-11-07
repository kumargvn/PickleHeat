// Ports: the only things the API knows about the outside world.
// Each one has adapters in src/adapters. Swapping a vendor (database, payments,
// identity, DUPR, tournament feeds) means writing a new adapter, not touching routes.

import type { EventFormat, GameScore, PlayedMatch, TournamentListing } from "./domain/types";

// ---------- Stored entities ----------

export interface User {
  id: string;
  appleSub: string | null;
  email: string | null;
  name: string;
  lat: number | null;
  lng: number | null;
  maxDistanceMiles: number;
  formats: EventFormat[];
  createdAt: string;
}

export interface DuprLink {
  userId: string;
  duprId: string; // public DUPR ID, e.g. "ABC123"
  duprUserId: string; // DUPR's internal user id
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  doublesRating: number | null;
  singlesRating: number | null;
  ratingUpdatedAt: string | null;
  matchesSyncedAt: string | null;
  linkedAt: string;
}

export type EventKind = "league" | "tournament";
export type EventStatus = "draft" | "open" | "closed" | "in_progress" | "completed";

export interface PickoraEvent {
  id: string;
  organizerId: string;
  kind: EventKind;
  name: string;
  format: EventFormat;
  startDate: string;
  endDate: string | null;
  weeks: number | null;
  venue: string;
  city: string;
  state: string;
  lat: number | null;
  lng: number | null;
  minRating: number | null;
  maxRating: number | null;
  capacity: number; // teams (doubles) or players (singles)
  feeCents: number; // per player
  currency: string;
  requireDuprVerified: boolean;
  submitToDupr: boolean;
  status: EventStatus;
  createdAt: string;
}

export type EntryStatus = "pending_payment" | "confirmed" | "withdrawn" | "refunded";

export interface Entry {
  id: string;
  eventId: string;
  playerIds: string[];
  teamName: string;
  teamRating: number | null;
  status: EntryStatus;
  createdAt: string;
}

export type MatchStatus = "scheduled" | "reported" | "confirmed";

export interface Match {
  id: string;
  eventId: string;
  round: number;
  pool: number | null;
  homeEntryId: string;
  awayEntryId: string;
  scheduledAt: string | null;
  court: string | null;
  games: GameScore[]; // home = "us"
  status: MatchStatus;
  reportedBy: string | null;
  confirmedBy: string | null;
  duprMatchId: string | null;
  duprSyncedAt: string | null;
  duprError: string | null;
}

export type PaymentStatus = "pending" | "paid" | "refunded" | "failed";

export interface Payment {
  id: string;
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

export interface PayoutAccount {
  userId: string;
  provider: string;
  providerAccountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

// ---------- Storage ----------

export interface Store {
  getUser(id: string): Promise<User | null>;
  getUserByAppleSub(sub: string): Promise<User | null>;
  saveUser(u: User): Promise<void>;
  deleteUser(id: string): Promise<void>;

  getDuprLink(userId: string): Promise<DuprLink | null>;
  getDuprLinkByDuprId(duprId: string): Promise<DuprLink | null>;
  saveDuprLink(l: DuprLink): Promise<void>;
  deleteDuprLink(userId: string): Promise<void>;
  listDuprLinksExpiringBefore(iso: string): Promise<DuprLink[]>;

  saveDuprMatches(userId: string, matches: PlayedMatch[]): Promise<void>;
  getDuprMatches(userId: string): Promise<PlayedMatch[]>;

  getEvent(id: string): Promise<PickoraEvent | null>;
  saveEvent(e: PickoraEvent): Promise<void>;
  listEventsByOrganizer(userId: string): Promise<PickoraEvent[]>;
  listOpenEvents(): Promise<PickoraEvent[]>;
  listEventsForPlayer(userId: string): Promise<PickoraEvent[]>;

  getEntry(id: string): Promise<Entry | null>;
  saveEntry(e: Entry): Promise<void>;
  listEntries(eventId: string): Promise<Entry[]>;

  getMatch(id: string): Promise<Match | null>;
  saveMatch(m: Match): Promise<void>;
  listMatches(eventId: string): Promise<Match[]>;
  listMatchesNeedingDuprSync(): Promise<Match[]>;

  getPayment(id: string): Promise<Payment | null>;
  getPaymentByProviderRef(ref: string): Promise<Payment | null>;
  savePayment(p: Payment): Promise<void>;
  listPaymentsForEvent(eventId: string): Promise<Payment[]>;

  getPayoutAccount(userId: string): Promise<PayoutAccount | null>;
  getPayoutAccountByProviderId(id: string): Promise<PayoutAccount | null>;
  savePayoutAccount(a: PayoutAccount): Promise<void>;
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
}

export interface DuprTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
}

export interface DuprMatchUpload {
  /** Our match id; DUPR echoes it back so retries are safe. */
  externalId: string;
  eventName: string;
  playedAt: string;
  location: string;
  format: EventFormat;
  teamA: { duprIds: string[]; games: number[] };
  teamB: { duprIds: string[]; games: number[] };
}

export interface RatingUpdate {
  duprId: string;
  doublesRating: number | null;
  singlesRating: number | null;
}

export interface RatingProvider {
  readonly name: string;
  /** URL of DUPR's login page to embed (SSO). */
  ssoUrl(): string;
  /** Checks a user token from SSO and returns who it belongs to. */
  verifyUser(accessToken: string): Promise<DuprProfile>;
  refresh(refreshToken: string): Promise<DuprTokens>;
  matchHistory(link: DuprLink): Promise<PlayedMatch[]>;
  uploadMatch(m: DuprMatchUpload): Promise<string>;
  deleteMatch(duprMatchId: string): Promise<void>;
  subscribeRatings(webhookUrl: string): Promise<void>;
  /** Parses a DUPR webhook body. Returns null for topics we ignore. */
  parseWebhook(body: unknown): RatingUpdate[] | null;
}

// ---------- Payments (money goes to the organizer's linked account) ----------

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
  /** Verifies the signature and parses the event. Throws on a bad signature. */
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
  publicBaseUrl: string; // where this API is reachable, for webhooks and DUPR connect page
  jwtSecret: string;
  appScheme: string; // "pickora" → pickora://...
  webAppUrl: string;
  platformFeeBps: number; // e.g. 300 = 3% kept by Pickora on each entry fee
  allowDevAuth: boolean;
}
