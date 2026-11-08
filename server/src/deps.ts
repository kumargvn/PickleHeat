// Builds Deps from environment variables. This is the one place that picks vendors.

import { ChainedIdentityVerifier, AppleIdentityVerifier, DevIdentityVerifier } from "./adapters/identity";
import { DuprHttpProvider, MockDuprProvider } from "./adapters/dupr";
import { MockPaymentProvider, StripeConnectProvider } from "./adapters/payments";
import { SampleTournamentSource } from "./adapters/sample";
import { FluidPbSource, PickleballComSource, PickleHeatEventsSource } from "./adapters/tournamentSources";
import type { Deps, Store, TournamentSource } from "./ports";

export interface Env {
  PUBLIC_BASE_URL: string;
  WEB_APP_URL?: string;
  JWT_SECRET: string;
  APPLE_AUDIENCES?: string; // comma separated: bundle id, web services id
  ALLOW_DEV_AUTH?: string;
  PLATFORM_FEE_BPS?: string;
  // DUPR: leave empty to use the stand-in until partner keys arrive
  DUPR_ENV?: string; // "uat" | "production"
  DUPR_CLIENT_KEY?: string;
  DUPR_CLIENT_SECRET?: string;
  DUPR_CLUB_ID?: string;
  // Stripe: leave empty to use mock payments
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  // Tournament feeds
  PICKLEBALL_COM_API_TOKEN?: string;
  FLUIDPB_API_TOKEN?: string;
  SAMPLE_TOURNAMENTS?: string; // "true" to include the sample feed
}

export function buildDeps(env: Env, store: Store): Deps {
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) throw new Error("JWT_SECRET must be set (32+ characters)");
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const allowDevAuth = env.ALLOW_DEV_AUTH === "true";
  const apple = new AppleIdentityVerifier((env.APPLE_AUDIENCES ?? "com.gudivada.pickleheat").split(",").map((s) => s.trim()).filter(Boolean));

  const dupr = env.DUPR_CLIENT_KEY && env.DUPR_CLIENT_SECRET
    ? new DuprHttpProvider({ env: env.DUPR_ENV === "production" ? "production" : "uat", clientKey: env.DUPR_CLIENT_KEY, clientSecret: env.DUPR_CLIENT_SECRET, clubId: env.DUPR_CLUB_ID })
    : new MockDuprProvider(base);

  const payments = env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET
    ? new StripeConnectProvider(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET)
    : new MockPaymentProvider(base);

  const webAppUrl = (env.WEB_APP_URL ?? base).replace(/\/$/, "");
  const sources: TournamentSource[] = [
    new PickleHeatEventsSource(() => store.listOpenEvents(), webAppUrl),
    new PickleballComSource(env.PICKLEBALL_COM_API_TOKEN),
    new FluidPbSource(env.FLUIDPB_API_TOKEN),
  ];
  if (env.SAMPLE_TOURNAMENTS !== "false") sources.push(new SampleTournamentSource());

  return {
    store,
    identity: allowDevAuth ? new ChainedIdentityVerifier([apple, new DevIdentityVerifier()]) : apple,
    dupr,
    payments,
    tournamentSources: sources,
    config: {
      publicBaseUrl: base,
      jwtSecret: env.JWT_SECRET,
      appScheme: "pickleheat",
      webAppUrl,
      platformFeeBps: Number(env.PLATFORM_FEE_BPS ?? 0),
      allowDevAuth,
    },
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
  };
}
