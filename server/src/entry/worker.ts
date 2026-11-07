// Cloudflare Workers entry. Swap this file (not the app) to host elsewhere; see entry/bun.ts.
import { neon } from "@neondatabase/serverless";
import { handle } from "../app";
import { buildDeps, type Env } from "../deps";
import { PostgresStore } from "../adapters/postgresStore";
import { runSyncJob } from "../services/duprSync";

interface WorkerEnv extends Env {
  DATABASE_URL: string;
}

function depsFor(env: WorkerEnv) {
  const sql = neon(env.DATABASE_URL);
  const store = new PostgresStore({ query: (text, params) => sql.query(text, params) as Promise<Record<string, any>[]> });
  return buildDeps(env, store);
}

export default {
  async fetch(req: Request, env: WorkerEnv): Promise<Response> {
    return handle(req, depsFor(env));
  },
  // Cron trigger (wrangler.toml): refresh DUPR tokens and retry match uploads.
  async scheduled(_event: unknown, env: WorkerEnv): Promise<void> {
    const result = await runSyncJob(depsFor(env));
    console.log("dupr sync", JSON.stringify(result));
  },
};
