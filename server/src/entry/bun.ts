// Local / container entry (Bun). Uses the in-memory store with mock DUPR and payments by default,
// so the whole API runs with zero accounts:  bun run dev
import { handle } from "../app";
import { buildDeps } from "../deps";
import { MemoryStore } from "../adapters/memoryStore";

const port = Number(process.env.PORT ?? 8787);
const deps = buildDeps(
  {
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
    WEB_APP_URL: process.env.WEB_APP_URL ?? "http://localhost:5173",
    JWT_SECRET: process.env.JWT_SECRET ?? "local-dev-secret-change-me-0123456789abcdef",
    ALLOW_DEV_AUTH: process.env.ALLOW_DEV_AUTH ?? "true",
    PLATFORM_FEE_BPS: process.env.PLATFORM_FEE_BPS ?? "0",
    DUPR_ENV: process.env.DUPR_ENV,
    DUPR_CLIENT_KEY: process.env.DUPR_CLIENT_KEY,
    DUPR_CLIENT_SECRET: process.env.DUPR_CLIENT_SECRET,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    PICKLEBALL_COM_API_TOKEN: process.env.PICKLEBALL_COM_API_TOKEN,
  },
  new MemoryStore(),
);

Bun.serve({ port, fetch: (req) => handle(req, deps) });
console.log(`PickleHeat API on http://localhost:${port}  (DUPR: ${deps.dupr.name}, payments: ${deps.payments.name})`);
