-- PickleHeat schema. Plain PostgreSQL 14+; no extensions or vendor features.
-- Every entity is a JSON document in one table (see src/adapters/postgresStore.ts).

create table if not exists docs (
  kind       text not null,
  id         text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (kind, id)
);

-- Makes `data @> '{"eventId": "..."}'` lookups fast for every collection.
create index if not exists docs_data on docs using gin (data jsonb_path_ops);
create index if not exists docs_kind on docs (kind);
