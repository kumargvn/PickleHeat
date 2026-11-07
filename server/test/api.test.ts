// End-to-end API flow on the in-memory store with mock DUPR and mock payments.
import { beforeEach, describe, expect, test } from "bun:test";
import { handle } from "../src/app";
import { buildDeps } from "../src/deps";
import { MemoryStore } from "../src/adapters/memoryStore";
import { MockDuprProvider } from "../src/adapters/dupr";
import { MockPaymentProvider, StripeConnectProvider } from "../src/adapters/payments";
import { hmacHex } from "../src/adapters/crypto";
import type { Deps } from "../src/ports";

const BASE = "http://api.test";
let deps: Deps;

beforeEach(() => {
  deps = buildDeps({ PUBLIC_BASE_URL: BASE, WEB_APP_URL: "http://web.test", JWT_SECRET: "x".repeat(40), ALLOW_DEV_AUTH: "true", PLATFORM_FEE_BPS: "300" }, new MemoryStore());
});

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await handle(
    new Request(BASE + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }),
    deps,
  );
  const text = await res.text();
  return { status: res.status, body: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text, headers: res.headers };
}

async function signIn(name: string) {
  const r = await call("POST", "/v1/auth/apple", undefined, { identityToken: `dev:${name}`, name });
  expect(r.status).toBe(200);
  return r.body.token as string;
}

async function connectDupr(token: string, who: string) {
  const s = await call("POST", "/v1/dupr/connect-session", token, { client: "app" });
  const connectToken = new URL(s.body.url).searchParams.get("t")!;
  const r = await call("POST", "/v1/dupr/link", connectToken, { userToken: `mock-${who}`, refreshToken: `refresh-${who}` });
  expect(r.status).toBe(200);
  return r.body.duprId as string;
}

describe("api", () => {
  test("stand-in DUPR login can be framed by our page; other pages can't", async () => {
    const mock = await call("GET", "/v1/dupr/mock-login");
    expect(mock.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(mock.headers.get("x-frame-options")).toBeNull();
    const expired = await call("GET", "/v1/dupr/connect?t=x");
    expect(expired.headers.get("x-frame-options")).toBe("DENY");
  });

  test("health lists adapters", async () => {
    const r = await call("GET", "/v1/health");
    expect(r.body.dupr).toBe("dupr-mock");
    expect(r.body.payments).toBe("mock");
  });

  test("auth is required", async () => {
    expect((await call("GET", "/v1/me")).status).toBe(401);
    expect((await call("GET", "/v1/me", "garbage")).status).toBe(401);
  });

  test("one-time DUPR connect, then ratings, form and insights", async () => {
    const t = await signIn("jordan");
    const page = await call("GET", "/v1/dupr/connect?t=bad");
    expect(page.status).toBe(401);
    const duprId = await connectDupr(t, "jordan");
    expect(duprId).toStartWith("MOCK-");
    const me = await call("GET", "/v1/me", t);
    expect(me.body.dupr.connected).toBe(true);
    expect(me.body.dupr.doublesRating).toBe(4.12);
    expect(me.body.form.score).toBeGreaterThan(50);
    const form = await call("GET", "/v1/me/form", t);
    expect(form.body.matches.length).toBe(10);
    expect(form.body.insights.record.wins).toBeGreaterThan(0);
  });

  test("a DUPR account can only belong to one Pickora account", async () => {
    const a = await signIn("a");
    const b = await signIn("b");
    await connectDupr(a, "same");
    const s = await call("POST", "/v1/dupr/connect-session", b, {});
    const r = await call("POST", "/v1/dupr/link", new URL(s.body.url).searchParams.get("t")!, { userToken: "mock-same", refreshToken: "refresh-same" });
    expect(r.status).toBe(409);
  });

  test("rating webhook updates the stored rating", async () => {
    const t = await signIn("jordan");
    const duprId = await connectDupr(t, "jordan");
    await call("POST", "/v1/webhooks/dupr", undefined, { topic: "RATING", duprId, doubles: 4.2, singles: 3.9 });
    expect((await call("GET", "/v1/me", t)).body.dupr.doublesRating).toBe(4.2);
  });

  test("recommended tournaments near the player", async () => {
    const t = await signIn("jordan");
    await connectDupr(t, "jordan");
    expect((await call("GET", "/v1/tournaments/recommended", t)).status).toBe(422); // no location yet
    await call("PATCH", "/v1/me", t, { lat: 30.5083, lng: -97.6789, maxDistanceMiles: 75 });
    const r = await call("GET", "/v1/tournaments/recommended", t);
    expect(r.status).toBe(200);
    expect(r.body.recommendations.length).toBeGreaterThan(0);
    expect(r.body.sources.find((s: any) => s.name === "sample").ok).toBe(true);
  });

  test("full tournament: payouts, registration with payment, schedule, scores, DUPR upload, refund", async () => {
    const org = await signIn("organizer");
    const players = await Promise.all(["p1", "p2", "p3", "p4"].map(signIn));
    for (const [i, p] of players.entries()) await connectDupr(p, `p${i + 1}`);

    const created = await call("POST", "/v1/events", org, {
      kind: "tournament",
      name: "Fall Slam Doubles",
      format: "doubles",
      startDate: "2026-11-15",
      city: "Round Rock",
      state: "TX",
      lat: 30.516,
      lng: -97.665,
      minRating: 3.5,
      maxRating: 4.25,
      capacity: 8,
      feeCents: 3500,
    });
    expect(created.status).toBe(201);
    const id = created.body.event.id;

    expect((await call("POST", `/v1/events/${id}/publish`, org)).status).toBe(409); // no payout account yet
    const onboard = await call("POST", "/v1/payouts/onboard", org);
    expect(onboard.body.url).toContain("/v1/bounce?client=app&to=payouts");
    expect((await call("POST", `/v1/events/${id}/publish`, org)).body.event.status).toBe("open");

    // Team 1: p1 + p2. Partner is found by DUPR ID.
    const p2Dupr = (await call("GET", "/v1/me", players[1])).body.dupr.duprId;
    const reg1 = await call("POST", `/v1/events/${id}/register`, players[0], { partnerDuprId: p2Dupr });
    expect(reg1.status).toBe(201);
    expect(reg1.body.entry.status).toBe("pending_payment");
    expect(reg1.body.checkoutUrl).toContain("/v1/payments/mock-pay");
    const paid = await call("GET", new URL(reg1.body.checkoutUrl).pathname + new URL(reg1.body.checkoutUrl).search);
    expect(paid.status).toBe(302);
    const back = new URL(paid.headers.get("location")!);
    expect(back.pathname).toBe("/v1/bounce");
    const bounced = await call("GET", back.pathname + back.search);
    expect(bounced.headers.get("location")).toBe(`pickora://events/${id}?paid=1`);
    expect((await call("GET", "/v1/bounce?to=https://evil.example")).status).toBe(400);

    const p4 = (await call("GET", "/v1/me", players[3])).body.user.id;
    const reg2 = await call("POST", `/v1/events/${id}/register`, players[2], { partnerUserId: p4 });
    expect((await call("POST", `/v1/events/${id}/register`, players[3], { partnerUserId: (await call("GET", "/v1/me", players[0])).body.user.id })).status).toBe(409); // already in
    await call("GET", new URL(reg2.body.checkoutUrl).pathname + new URL(reg2.body.checkoutUrl).search);

    // Organizer sees money minus the 3% platform fee: 2 teams × 2 players × $35 = $140, fee $4.20.
    let detail = await call("GET", `/v1/events/${id}`, org);
    expect(detail.body.entries.every((e: any) => e.status === "confirmed")).toBe(true);
    expect(detail.body.money.collectedCents).toBe(14000 - 420);

    const sched = await call("POST", `/v1/events/${id}/schedule`, org);
    expect(sched.body.matches.length).toBe(1);
    const matchId = sched.body.matches[0].id;
    const homeIsTeam1 = sched.body.matches[0].homeEntryId === reg1.body.entry.id;

    // A player on one team reports; a player on the same team can't confirm; the other team confirms.
    const reporter = homeIsTeam1 ? players[0] : players[2];
    const sameTeam = homeIsTeam1 ? players[1] : players[3];
    const other = homeIsTeam1 ? players[2] : players[0];
    expect((await call("POST", `/v1/matches/${matchId}/score`, reporter, { games: [{ us: 11, them: 7 }, { us: 11, them: 9 }] })).body.match.status).toBe("reported");
    expect((await call("POST", `/v1/matches/${matchId}/confirm`, sameTeam)).status).toBe(403);
    const confirmed = await call("POST", `/v1/matches/${matchId}/confirm`, other);
    expect(confirmed.body.match.status).toBe("confirmed");
    expect(confirmed.body.match.duprMatchId).toBe(`mock-match-${matchId}`);
    expect((deps.dupr as MockDuprProvider).uploads[0].teamA.games).toEqual([11, 11]);

    detail = await call("GET", `/v1/events/${id}`, org);
    expect(detail.body.standings[0].table[0].wins).toBe(1);

    const refunded = await call("POST", `/v1/events/${id}/entries/${reg2.body.entry.id}/refund`, org);
    expect(refunded.body.entry.status).toBe("refunded");
    expect((deps.payments as MockPaymentProvider).refunded.length).toBe(1);
  });

  test("rating range is enforced at registration", async () => {
    const org = await signIn("org");
    await call("POST", "/v1/payouts/onboard", org);
    const ev = (await call("POST", "/v1/events", org, { kind: "tournament", name: "3.0 only", format: "doubles", startDate: "2026-12-01", maxRating: 3.49, feeCents: 0 })).body.event;
    await call("POST", `/v1/events/${ev.id}/publish`, org);
    const a = await signIn("a1");
    const b = await signIn("b1");
    await connectDupr(a, "a1");
    await connectDupr(b, "b1");
    const bId = (await call("GET", "/v1/me", b)).body.user.id;
    const r = await call("POST", `/v1/events/${ev.id}/register`, a, { partnerUserId: bId });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("rating_out_of_range");
  });

  test("account deletion removes the user", async () => {
    const t = await signIn("leaver");
    await connectDupr(t, "leaver");
    expect((await call("DELETE", "/v1/me", t)).body.deleted).toBe(true);
    expect((await call("GET", "/v1/me", t)).status).toBe(401);
  });
});

describe("stripe webhook signatures", () => {
  test("accepts a correct signature and rejects a wrong one", async () => {
    const p = new StripeConnectProvider("sk_test_x", "whsec_test");
    const body = JSON.stringify({ type: "checkout.session.completed", data: { object: { id: "cs_1", payment_status: "paid" } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = await hmacHex("whsec_test", `${t}.${body}`);
    expect(await p.parseWebhook(body, `t=${t},v1=${sig}`)).toEqual({ type: "checkout_paid", providerRef: "cs_1" });
    await expect(p.parseWebhook(body, `t=${t},v1=${"0".repeat(64)}`)).rejects.toThrow("Bad Stripe signature");
  });
});
