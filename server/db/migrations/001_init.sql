-- Pickora schema. Plain PostgreSQL 14+; no extensions or vendor features.
-- Each table: lookup columns + the full record in "data" (see src/adapters/postgresStore.ts).

create table if not exists users (
  id         text primary key,
  apple_sub  text unique,
  data       jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists dupr_links (
  user_id           text primary key references users(id) on delete cascade,
  dupr_id           text not null unique,
  access_expires_at timestamptz not null,
  data              jsonb not null
);
create index if not exists dupr_links_expiry on dupr_links (access_expires_at);

create table if not exists dupr_matches (
  user_id text primary key references users(id) on delete cascade,
  data    jsonb not null
);

create table if not exists events (
  id           text primary key,
  organizer_id text not null,
  status       text not null,
  start_date   date not null,
  data         jsonb not null
);
create index if not exists events_organizer on events (organizer_id);
create index if not exists events_open on events (status, start_date);

create table if not exists entries (
  id       text primary key,
  event_id text not null references events(id) on delete cascade,
  data     jsonb not null
);
create index if not exists entries_event on entries (event_id);
create index if not exists entries_players on entries using gin ((data->'playerIds'));

create table if not exists matches (
  id         text primary key,
  event_id   text not null references events(id) on delete cascade,
  round      int not null,
  needs_dupr boolean not null default false,
  data       jsonb not null
);
create index if not exists matches_event on matches (event_id, round);
create index if not exists matches_needs_dupr on matches (needs_dupr) where needs_dupr;

create table if not exists payments (
  id           text primary key,
  event_id     text not null references events(id) on delete cascade,
  provider_ref text not null unique,
  data         jsonb not null
);
create index if not exists payments_event on payments (event_id);

create table if not exists payout_accounts (
  user_id             text primary key references users(id) on delete cascade,
  provider_account_id text not null unique,
  data                jsonb not null
);
