// Builds Deps from environment variables. This is the one place that picks vendors.

import { ChainedIdentityVerifier, AppleIdentityVerifier, DevIdentityVerifier, GoogleIdentityVerifier } from "./adapters/identity";
import { DuprHttpProvider, MockDuprProvider } from "./adapters/dupr";
import { LogEmailSender, ResendEmailSender } from "./adapters/email";
import { ApnsPushSender, LogPushSender } from "./adapters/push";
import { MockPaymentProvider, StripeConnectProvider } from "./adapters/payments";
import { SampleTournamentSource } from "./adapters/sample";
import { FluidPbSource, PickleballComSource, PickleHeatEventsSource } from "./adapters/tournamentSources";
import type { Deps, PickleHeatEvent, Store, TournamentSource } from "./ports";

export interface Env {
  PUBLIC_BASE_URL: string;
  WEB_APP_URL?: string;
  JWT_SECRET: string;
  APPLE_AUDIENCES?: string; // comma separated: bundle id, web services id
  GOOGLE_CLIENT_IDS?: string; // comma separated OAuth client IDs; leave empty to turn Google sign-in off
  ALLOW_DEV_AUTH?: string;
  PLATFORM_FEE_BPS?: string;
  // Email (password reset, email confirmation): leave empty and no email is sent
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string; // "PickleHeat <hello@yourdomain.com>", a sender verified in Resend
  // iPhone push notifications: an APNs auth key (.p8) from Apple Developer → Keys. Leave empty and none are sent.
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_BUNDLE_ID?: string;
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

  const googleIds = (env.GOOGLE_CLIENT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const googleReal = googleIds.length ? new GoogleIdentityVerifier(googleIds) : null;
  const google = allowDevAuth ? new ChainedIdentityVerifier([...(googleReal ? [googleReal] : []), new DevIdentityVerifier()]) : googleReal;

  const dupr = env.DUPR_CLIENT_KEY && env.DUPR_CLIENT_SECRET
    ? new DuprHttpProvider({ env: env.DUPR_ENV === "production" ? "production" : "uat", clientKey: env.DUPR_CLIENT_KEY, clientSecret: env.DUPR_CLIENT_SECRET, clubId: env.DUPR_CLUB_ID })
    : new MockDuprProvider(base);

  const payments = env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET
    ? new StripeConnectProvider(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET)
    : new MockPaymentProvider(base);

  const webAppUrl = env.WEB_APP_URL ?? `${base}/`;
  const sources: TournamentSource[] = [
    new PickleHeatEventsSource(() => store.collection<PickleHeatEvent>("events").find({ status: "open" }), webAppUrl),
    new PickleballComSource(env.PICKLEBALL_COM_API_TOKEN),
    new FluidPbSource(env.FLUIDPB_API_TOKEN),
  ];
  if (env.SAMPLE_TOURNAMENTS !== "false") sources.push(new SampleTournamentSource());

  return {
    store,
    identity: allowDevAuth ? new ChainedIdentityVerifier([apple, new DevIdentityVerifier()]) : apple,
    google,
    email: env.RESEND_API_KEY && env.EMAIL_FROM ? new ResendEmailSender(env.RESEND_API_KEY, env.EMAIL_FROM) : new LogEmailSender(),
    push: env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY
      ? new ApnsPushSender({ keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, privateKey: env.APNS_PRIVATE_KEY, topic: env.APNS_BUNDLE_ID ?? "com.gudivada.pickleheat" })
      : new LogPushSender(),
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
    newId: () => (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`),
  };
}
