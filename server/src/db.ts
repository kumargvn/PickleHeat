// Typed access to every collection.
import type {
  Attendance, Chat, ChatRead, Club, ClubMember, Credential, Deps, DuprHistory, DuprLink, Entry, Invite, Match,
  Message, Notification, Payment, PayoutAccount, PickleHeatEvent, PlayGroup, Round, Store, SubRequest, UsedToken, User,
} from "./ports";

export function collections(store: Store) {
  return {
    users: store.collection<User>("users"),
    credentials: store.collection<Credential>("credentials"),
    dupr: store.collection<DuprLink>("dupr_links"),
    history: store.collection<DuprHistory>("dupr_history"),
    clubs: store.collection<Club>("clubs"),
    members: store.collection<ClubMember>("club_members"),
    events: store.collection<PickleHeatEvent>("events"),
    entries: store.collection<Entry>("entries"),
    rounds: store.collection<Round>("rounds"),
    attendance: store.collection<Attendance>("attendance"),
    groups: store.collection<PlayGroup>("groups"),
    subs: store.collection<SubRequest>("sub_requests"),
    matches: store.collection<Match>("matches"),
    payments: store.collection<Payment>("payments"),
    payouts: store.collection<PayoutAccount>("payout_accounts"),
    chats: store.collection<Chat>("chats"),
    messages: store.collection<Message>("messages"),
    reads: store.collection<ChatRead>("chat_reads"),
    notifications: store.collection<Notification>("notifications"),
    invites: store.collection<Invite>("invites"),
    usedTokens: store.collection<UsedToken>("used_tokens"),
  };
}

export type DB = ReturnType<typeof collections>;

const cache = new WeakMap<Store, DB>();
export function db(deps: Deps): DB {
  let d = cache.get(deps.store);
  if (!d) cache.set(deps.store, (d = collections(deps.store)));
  return d;
}
