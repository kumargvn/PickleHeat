<p align="center"><img src="design/logo.png" width="140" alt="PickleHeat logo"></p>

# PickleHeat

Pickleball leagues, tournaments and DUPR form, for iPhone and the web.

- **One-time DUPR connect**, then two-way sync: ratings and match history come in (webhooks + refresh), confirmed PickleHeat match scores go out to DUPR.
- **Form score (0–100)** from the last 8 DUPR matches: actual point share vs what the rating gap predicts, recency-weighted. Plus insights: record, point share, close games, results vs higher-rated teams, Player DNA and a tip.
- **Leagues and tournaments**: DUPR rating range, round robins, snake-seeded pools, standings, score report + confirm, playoff seeding.
- **Entry fees** through Stripe Connect, paid straight to the organizer's linked account (PickleHeat can keep a platform fee).
- **Tournament finder**: nearby events that fit your rating, with a "move up a bracket" nudge when you're hot. Feeds from PickleHeat, pickleball.com (PickleballTournaments) and FluidPB plug in as each grants API access.
- **Demo mode** everywhere: with no API configured, the iPhone app and the web app run on built-in sample data. TestFlight works on day one.

## Layout

```
ios/            SwiftUI app (XcodeGen project.yml), unit tests
  PickleHeat/Engine     Form, recommendations, schedules (pure Swift, mirrors server/src/domain)
  PickleHeat/Services   API client, demo backend, app state, Keychain, location, web sign-in sheets
  PickleHeat/Views      Screens
server/         API: TypeScript on standard Request/Response (no framework)
  src/domain         Form, recommendations, schedules
  src/ports.ts       Interfaces for every outside service
  src/adapters       Postgres + memory store, Apple sign-in, DUPR (real + stand-in), Stripe (real + mock), tournament feeds
  src/services       DUPR sync, events, payments
  src/entry          Cloudflare Workers entry, Bun/container entry
  db/migrations      Plain PostgreSQL schema
docs/           GitHub Pages: landing, privacy, support, and the web app (docs/app)
shared/         sample-data.json and test vectors both platforms must agree on
fastlane/       App Store text and review notes
```

## Swapping vendors (nothing is locked in)

The apps only talk to the PickleHeat API. Inside the API, each outside service is an interface in `server/src/ports.ts`, and `server/src/deps.ts` is the only file that picks the vendor.

| Need | Today | To switch |
| --- | --- | --- |
| Hosting | Cloudflare Workers (`src/entry/worker.ts`) | Any JS runtime: Bun, Node 20+, Deno, a container (`src/entry/bun.ts`) |
| Database | Neon Postgres | Any PostgreSQL. Write a new `Store` for a non-Postgres database |
| Sign-in | Sign in with Apple | Add an `IdentityVerifier` |
| Payments | Stripe Connect | Add a `PaymentProvider` |
| Ratings | DUPR Partner API | `RatingProvider` |
| Tournament feeds | pickleball.com, FluidPB, sample | Add a `TournamentSource` |

## Run locally

```
cd server && bun install && bun run dev      # API on :8787 with memory store, DUPR stand-in, mock payments
bun test                                       # API tests
npx http-server docs                           # web app at /app (demo mode)
```

## TestFlight (same setup as Sudoku Kids)

Uses your existing paid Apple Developer account and the same App Store Connect API key.

1. **Bundle ID**: Certificates, IDs & Profiles → Identifiers → + → App ID `com.gudivada.pickleheat`. Tick **Sign in with Apple**.
2. **App record**: App Store Connect → Apps → + New App, name **PickleHeat**, that bundle ID. This also reserves the name.
3. **Repository secrets** (Settings → Secrets and variables → Actions): `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY`, `APPLE_TEAM_ID`. The same values as the sudoku-kids repo.
4. **Repository variable**: `ENABLE_TESTFLIGHT` = `true`. Optional: `PICKLEHEAT_API_URL` = your deployed API (leave empty for a demo-mode build).
5. Push to `main` or run the **iOS** workflow. The build shows up in TestFlight after Apple processes it.

## Deploy the API (optional for TestFlight)

1. Create a free Neon project; copy its connection string.
2. Cloudflare: create an API token (Edit Workers), note the account ID.
3. Repository secrets: `DATABASE_URL`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Worker secrets: `npx wrangler secret put JWT_SECRET` (32+ random characters), and later `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `DUPR_CLIENT_KEY`, `DUPR_CLIENT_SECRET`, `PICKLEBALL_COM_API_TOKEN`.
4. Set `PUBLIC_BASE_URL` in `server/wrangler.toml`, then run the **API** workflow with "deploy" ticked.
5. Set the repo variable `PICKLEHEAT_API_URL` to the API URL, and `PICKLEHEAT_API_URL` in `docs/app/config.js`.

Without DUPR or Stripe keys the API uses the stand-in DUPR login and mock payments, so the whole flow can be tested end to end.

## Still to do with partners

- **DUPR partner application** (tech@mydupr.com). Their checklist: SSO login, ratings shown and kept current by webhooks, match create/update/delete, user gating. All are built. Once you have UAT keys, check the endpoint paths and field names in `DUPR_PATHS` (server/src/adapters/dupr.ts) against DUPR's API explorer, then subscribe the webhook `https://<api>/v1/webhooks/dupr`.
- **pickleball.com / PickleballTournaments**: ask for a PPA API token; set `PICKLEBALL_COM_API_TOKEN`. Field mapping is in `server/src/adapters/tournamentSources.ts`.
- **FluidPB**: no public API found. Ask them for one; the adapter is stubbed and off.
- **Stripe**: create a platform account, turn on Connect (Express), add the webhook `https://<api>/v1/webhooks/payments` for `checkout.session.*` and `account.updated`.
- **Sign in with Apple on the web**: create a Services ID (`com.gudivada.pickleheat.web`), add the web app's domain and return URL, and add it to `APPLE_AUDIENCES`.

## Keeping iOS and the API in agreement

The Form, recommendation and schedule math exists in TypeScript (API, web) and Swift (iOS demo + display). `server/scripts/make-vectors.ts` writes `shared/vectors/*.json` from the TypeScript code; the Swift tests replay them, and CI fails if they drift. After changing the math: `cd server && bun run vectors && bun run web/build.ts` from the repo root.
