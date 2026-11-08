// Store on plain PostgreSQL (Neon, Supabase, RDS, Cloud SQL, self-hosted: anything that speaks Postgres).
// Each table keeps lookup columns plus a JSONB "data" column with the full record, so adding a
// field needs no migration. Schema: server/db/migrations.

import type { PlayedMatch } from "../domain/types";
import type { DuprLink, Entry, Match, Payment, PayoutAccount, PickleHeatEvent, Store, User } from "../ports";

/** Anything that can run a parameterised query ($1, $2 …) and return rows. */
export interface SqlClient {
  query(text: string, params: unknown[]): Promise<Record<string, any>[]>;
}

const one = <T>(rows: Record<string, any>[]): T | null => (rows.length ? (rows[0].data as T) : null);
const many = <T>(rows: Record<string, any>[]): T[] => rows.map((r) => r.data as T);
const j = (x: unknown) => JSON.stringify(x);

export class PostgresStore implements Store {
  constructor(private db: SqlClient) {}

  private q(text: string, params: unknown[] = []) {
    return this.db.query(text, params);
  }

  async getUser(id: string) { return one<User>(await this.q("select data from users where id = $1", [id])); }
  async getUserByAppleSub(sub: string) { return one<User>(await this.q("select data from users where apple_sub = $1", [sub])); }
  async saveUser(u: User) {
    await this.q("insert into users (id, apple_sub, data) values ($1, $2, $3::jsonb) on conflict (id) do update set apple_sub = excluded.apple_sub, data = excluded.data", [u.id, u.appleSub, j(u)]);
  }
  async deleteUser(id: string) {
    await this.q("delete from dupr_matches where user_id = $1", [id]);
    await this.q("delete from dupr_links where user_id = $1", [id]);
    await this.q("delete from payout_accounts where user_id = $1", [id]);
    await this.q("delete from users where id = $1", [id]);
  }

  async getDuprLink(userId: string) { return one<DuprLink>(await this.q("select data from dupr_links where user_id = $1", [userId])); }
  async getDuprLinkByDuprId(duprId: string) { return one<DuprLink>(await this.q("select data from dupr_links where dupr_id = $1", [duprId])); }
  async saveDuprLink(l: DuprLink) {
    await this.q(
      "insert into dupr_links (user_id, dupr_id, access_expires_at, data) values ($1, $2, $3, $4::jsonb) on conflict (user_id) do update set dupr_id = excluded.dupr_id, access_expires_at = excluded.access_expires_at, data = excluded.data",
      [l.userId, l.duprId, l.accessExpiresAt, j(l)],
    );
  }
  async deleteDuprLink(userId: string) {
    await this.q("delete from dupr_matches where user_id = $1", [userId]);
    await this.q("delete from dupr_links where user_id = $1", [userId]);
  }
  async listDuprLinksExpiringBefore(iso: string) { return many<DuprLink>(await this.q("select data from dupr_links where access_expires_at < $1", [iso])); }

  async saveDuprMatches(userId: string, m: PlayedMatch[]) {
    await this.q("insert into dupr_matches (user_id, data) values ($1, $2::jsonb) on conflict (user_id) do update set data = excluded.data", [userId, j(m)]);
  }
  async getDuprMatches(userId: string) { return one<PlayedMatch[]>(await this.q("select data from dupr_matches where user_id = $1", [userId])) ?? []; }

  async getEvent(id: string) { return one<PickleHeatEvent>(await this.q("select data from events where id = $1", [id])); }
  async saveEvent(e: PickleHeatEvent) {
    await this.q(
      "insert into events (id, organizer_id, status, start_date, data) values ($1, $2, $3, $4, $5::jsonb) on conflict (id) do update set status = excluded.status, start_date = excluded.start_date, data = excluded.data",
      [e.id, e.organizerId, e.status, e.startDate, j(e)],
    );
  }
  async listEventsByOrganizer(userId: string) { return many<PickleHeatEvent>(await this.q("select data from events where organizer_id = $1 order by start_date", [userId])); }
  async listOpenEvents() { return many<PickleHeatEvent>(await this.q("select data from events where status = 'open' order by start_date limit 500")); }
  async listEventsForPlayer(userId: string) {
    return many<PickleHeatEvent>(
      await this.q(
        "select distinct on (e.id) e.data from events e join entries x on x.event_id = e.id where jsonb_exists(x.data->'playerIds', $1) and x.data->>'status' <> 'withdrawn'",
        [userId],
      ),
    );
  }

  async getEntry(id: string) { return one<Entry>(await this.q("select data from entries where id = $1", [id])); }
  async saveEntry(e: Entry) {
    await this.q("insert into entries (id, event_id, data) values ($1, $2, $3::jsonb) on conflict (id) do update set data = excluded.data", [e.id, e.eventId, j(e)]);
  }
  async listEntries(eventId: string) { return many<Entry>(await this.q("select data from entries where event_id = $1 order by data->>'createdAt'", [eventId])); }

  async getMatch(id: string) { return one<Match>(await this.q("select data from matches where id = $1", [id])); }
  async saveMatch(m: Match) {
    await this.q(
      "insert into matches (id, event_id, round, needs_dupr, data) values ($1, $2, $3, $4, $5::jsonb) on conflict (id) do update set needs_dupr = excluded.needs_dupr, data = excluded.data",
      [m.id, m.eventId, m.round, m.status === "confirmed" && m.duprMatchId == null, j(m)],
    );
  }
  async listMatches(eventId: string) { return many<Match>(await this.q("select data from matches where event_id = $1 order by round, id", [eventId])); }
  async listMatchesNeedingDuprSync() { return many<Match>(await this.q("select data from matches where needs_dupr limit 200")); }

  async getPayment(id: string) { return one<Payment>(await this.q("select data from payments where id = $1", [id])); }
  async getPaymentByProviderRef(ref: string) { return one<Payment>(await this.q("select data from payments where provider_ref = $1", [ref])); }
  async savePayment(p: Payment) {
    await this.q(
      "insert into payments (id, event_id, provider_ref, data) values ($1, $2, $3, $4::jsonb) on conflict (id) do update set provider_ref = excluded.provider_ref, data = excluded.data",
      [p.id, p.eventId, p.providerRef, j(p)],
    );
  }
  async listPaymentsForEvent(eventId: string) { return many<Payment>(await this.q("select data from payments where event_id = $1", [eventId])); }

  async getPayoutAccount(userId: string) { return one<PayoutAccount>(await this.q("select data from payout_accounts where user_id = $1", [userId])); }
  async getPayoutAccountByProviderId(id: string) { return one<PayoutAccount>(await this.q("select data from payout_accounts where provider_account_id = $1", [id])); }
  async savePayoutAccount(a: PayoutAccount) {
    await this.q(
      "insert into payout_accounts (user_id, provider_account_id, data) values ($1, $2, $3::jsonb) on conflict (user_id) do update set provider_account_id = excluded.provider_account_id, data = excluded.data",
      [a.userId, a.providerAccountId, j(a)],
    );
  }
}
