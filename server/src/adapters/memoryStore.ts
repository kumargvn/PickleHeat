// In-memory Store for tests, local development and the demo API.
import type { PlayedMatch } from "../domain/types";
import type { DuprLink, Entry, Match, Payment, PayoutAccount, PickoraEvent, Store, User } from "../ports";

const clone = <T>(x: T): T => structuredClone(x);

export class MemoryStore implements Store {
  users = new Map<string, User>();
  dupr = new Map<string, DuprLink>();
  duprMatches = new Map<string, PlayedMatch[]>();
  events = new Map<string, PickoraEvent>();
  entries = new Map<string, Entry>();
  matches = new Map<string, Match>();
  payments = new Map<string, Payment>();
  payouts = new Map<string, PayoutAccount>();

  async getUser(id: string) { const u = this.users.get(id); return u ? clone(u) : null; }
  async getUserByAppleSub(sub: string) { for (const u of this.users.values()) if (u.appleSub === sub) return clone(u); return null; }
  async saveUser(u: User) { this.users.set(u.id, clone(u)); }
  async deleteUser(id: string) {
    this.users.delete(id);
    this.dupr.delete(id);
    this.duprMatches.delete(id);
    this.payouts.delete(id);
  }

  async getDuprLink(userId: string) { const l = this.dupr.get(userId); return l ? clone(l) : null; }
  async getDuprLinkByDuprId(duprId: string) { for (const l of this.dupr.values()) if (l.duprId === duprId) return clone(l); return null; }
  async saveDuprLink(l: DuprLink) { this.dupr.set(l.userId, clone(l)); }
  async deleteDuprLink(userId: string) { this.dupr.delete(userId); this.duprMatches.delete(userId); }
  async listDuprLinksExpiringBefore(iso: string) { return [...this.dupr.values()].filter((l) => l.accessExpiresAt < iso).map(clone); }

  async saveDuprMatches(userId: string, m: PlayedMatch[]) { this.duprMatches.set(userId, clone(m)); }
  async getDuprMatches(userId: string) { return clone(this.duprMatches.get(userId) ?? []); }

  async getEvent(id: string) { const e = this.events.get(id); return e ? clone(e) : null; }
  async saveEvent(e: PickoraEvent) { this.events.set(e.id, clone(e)); }
  async listEventsByOrganizer(userId: string) { return [...this.events.values()].filter((e) => e.organizerId === userId).map(clone); }
  async listOpenEvents() { return [...this.events.values()].filter((e) => e.status === "open").map(clone); }
  async listEventsForPlayer(userId: string) {
    const ids = new Set([...this.entries.values()].filter((x) => x.playerIds.includes(userId) && x.status !== "withdrawn").map((x) => x.eventId));
    return [...this.events.values()].filter((e) => ids.has(e.id)).map(clone);
  }

  async getEntry(id: string) { const e = this.entries.get(id); return e ? clone(e) : null; }
  async saveEntry(e: Entry) { this.entries.set(e.id, clone(e)); }
  async listEntries(eventId: string) { return [...this.entries.values()].filter((e) => e.eventId === eventId).map(clone); }

  async getMatch(id: string) { const m = this.matches.get(id); return m ? clone(m) : null; }
  async saveMatch(m: Match) { this.matches.set(m.id, clone(m)); }
  async listMatches(eventId: string) {
    return [...this.matches.values()].filter((m) => m.eventId === eventId).sort((a, b) => a.round - b.round || a.id.localeCompare(b.id)).map(clone);
  }
  async listMatchesNeedingDuprSync() {
    return [...this.matches.values()].filter((m) => m.status === "confirmed" && m.duprMatchId == null).map(clone);
  }

  async getPayment(id: string) { const p = this.payments.get(id); return p ? clone(p) : null; }
  async getPaymentByProviderRef(ref: string) { for (const p of this.payments.values()) if (p.providerRef === ref) return clone(p); return null; }
  async savePayment(p: Payment) { this.payments.set(p.id, clone(p)); }
  async listPaymentsForEvent(eventId: string) { return [...this.payments.values()].filter((p) => p.eventId === eventId).map(clone); }

  async getPayoutAccount(userId: string) { const a = this.payouts.get(userId); return a ? clone(a) : null; }
  async getPayoutAccountByProviderId(id: string) { for (const a of this.payouts.values()) if (a.providerAccountId === id) return clone(a); return null; }
  async savePayoutAccount(a: PayoutAccount) { this.payouts.set(a.userId, clone(a)); }
}
