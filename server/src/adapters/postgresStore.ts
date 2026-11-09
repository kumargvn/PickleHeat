// Document store on plain PostgreSQL (Neon, Supabase, RDS, Cloud SQL, self-hosted).
// One table, `docs(kind, id, data jsonb)`, with a GIN index so `find` (jsonb @>) is fast.
// Schema: server/db/migrations/001_init.sql

import type { Collection, Doc, Store } from "../ports";

/** Anything that can run a parameterised query ($1, $2 …) and return rows. */
export interface SqlClient {
  query(text: string, params: unknown[]): Promise<Record<string, any>[]>;
}

export class PostgresStore implements Store {
  constructor(private db: SqlClient) {}

  collection<T extends Doc>(kind: string): Collection<T> {
    const db = this.db;
    return {
      async get(id) {
        const rows = await db.query("select data from docs where kind = $1 and id = $2", [kind, id]);
        return rows.length ? (rows[0].data as T) : null;
      },
      async put(doc) {
        await db.query(
          "insert into docs (kind, id, data, updated_at) values ($1, $2, $3::jsonb, now()) on conflict (kind, id) do update set data = excluded.data, updated_at = now()",
          [kind, doc.id, JSON.stringify(doc)],
        );
      },
      async delete(id) {
        await db.query("delete from docs where kind = $1 and id = $2", [kind, id]);
      },
      async find(match) {
        const rows = await db.query("select data from docs where kind = $1 and data @> $2::jsonb limit 5000", [kind, JSON.stringify(match)]);
        return rows.map((r) => r.data as T);
      },
    };
  }
}
