// End-to-end API flows on the seeded demo world (memory store, mock DUPR, mock payments).
import { beforeAll, describe, expect, test } from "bun:test";
import { handle } from "../src/app";
import { buildDeps } from "../src/deps";
import { MemoryStore } from "../src/adapters/memoryStore";
import { MockDuprProvider } from "../src/adapters/dupr";
import { StripeConnectProvider } from "../src/adapters/payments";
import { hmacHex } from "../src/adapters/crypto";
import { seedDemo, DEMO_USER_ID } from "../src/demo/seed";
import type { Deps } from "../src/ports";

const BASE = "http://api.test";
let deps: Deps;

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await handle(new Request(BASE + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), deps);
  const text = await res.text();
  return { status: res.status, body: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text, headers: res.headers };
}

const tokens: Record<string, string> = {};
async function as(slug: string) {
  if (!tokens[slug]) {
    const r = await call("POST", "/v1/auth/apple", undefined, { identityToken: `dev:${slug}`, name: slug });
    expect(r.status).toBe(200);
    tokens[slug] = r.body.token;
  }
  return tokens[slug];
}

async function connect(token: string, who: string) {
  const s = await call("POST", "/v1/dupr/connect-session", token, { client: "app" });
  const t = new URL(s.body.url).searchParams.get("t")!;
  return call("POST", "/v1/dupr/link", t, { userToken: `mock-${who}`, refreshToken: `refresh-${who}` });
}

const eventByName = async (token: string, name: string) => (await call("GET", "/v1/discover", token)).body.events.find((c: any) => c.event.name === name)?.event ?? (await call("GET", "/v1/events", token)).body.events.find((c: any) => c.event.name === name)?.event;

beforeAll(async () => {
  deps = buildDeps({ PUBLIC_BASE_URL: BASE, WEB_APP_URL: "http://web.test/app/", JWT_SECRET: "x".repeat(40), ALLOW_DEV_AUTH: "true", PLATFORM_FEE_BPS: "300" }, new MemoryStore());
  await seedDemo(deps);
});

describe("accounts", () => {
  test("auth required; demo user signs in to the seeded account", async () => {
    expect((await call("GET", "/v1/me")).status).toBe(401);
    const me = await call("GET", "/v1/me", await as("demo"));
    expect(me.body.user.id).toBe(DEMO_USER_ID);
    expect(me.body.unread.notifications).toBeGreaterThan(0);
  });

  test("email sign-up and login (web)", async () => {
    const s = await call("POST", "/v1/auth/signup", undefined, { email: "New@Example.com", password: "longenough1", name: "New Player" });
    expect(s.status).toBe(201);
    expect((await call("POST", "/v1/auth/login", undefined, { email: "new@example.com", password: "wrong-pass" })).status).toBe(401);
    expect((await call("POST", "/v1/auth/login", undefined, { email: "new@example.com", password: "longenough1" })).body.user.name).toBe("New Player");
    expect((await call("POST", "/v1/auth/signup", undefined, { email: "new@example.com", password: "longenough1", name: "x" })).status).toBe(409);
  });

  test("handoff link opens the web signed in, once", async () => {
    const t = await as("demo");
    const { url } = (await call("POST", "/v1/auth/handoff", t, { to: "payouts" })).body;
    expect(url).toStartWith("http://web.test/app/#/handoff?t=");
    const token = decodeURIComponent(url.split("t=")[1]);
    const r = await call("POST", "/v1/auth/handoff/redeem", undefined, { token });
    expect(r.body.to).toBe("payouts");
    expect(r.body.user.id).toBe(DEMO_USER_ID);
    expect((await call("POST", "/v1/auth/handoff/redeem", undefined, { token })).status).toBe(401);
    expect((await call("POST", "/v1/auth/handoff", t, { to: "https://evil.example" })).status).toBe(422);
  });

  test("DUPR connect once; reliability shows up", async () => {
    const t = await as("demo");
    const r = await connect(t, "demo");
    expect(r.status).toBe(200);
    const me = (await call("GET", "/v1/me", t)).body;
    expect(me.dupr.connected).toBe(true);
    expect(me.dupr.doublesReliability).toBe(100);
    expect(me.form.score).toBeGreaterThan(0);
  });
});

describe("flex ladder", () => {
  test("round 4: my group, my matches, a score to confirm, group chat", async () => {
    const t = await as("demo");
    const ladder = await eventByName(t, "Sunrise Heat Climb");
    const detail = (await call("GET", `/v1/events/${ladder.id}`, t)).body;
    expect(detail.rounds.length).toBe(8);
    const current = detail.rounds.find((r: any) => r.id === detail.currentRoundId);
    expect(current.number).toBe(4);
    expect(current.status).toBe("in_progress");
    const rv = (await call("GET", `/v1/rounds/${current.id}`, t)).body;
    const myGroup = rv.groups.find((g: any) => g.group.id === rv.myGroupId);
    expect(myGroup.group.playerIds).toContain(DEMO_USER_ID);
    expect(myGroup.matches.length).toBeGreaterThanOrEqual(3);
    expect(rv.subs.some((s: any) => s.status === "open")).toBe(true);

    const live = (await call("GET", "/v1/me/live", t)).body;
    const toConfirm = live.items.find((i: any) => i.needsMyConfirmation);
    expect(toConfirm).toBeTruthy();
    const c = await call("POST", `/v1/matches/${toConfirm.match.id}/confirm`, t);
    expect(c.body.match.status).toBe("confirmed");
    expect(c.body.match.duprMatchId).toBeTruthy();

    const chat = (await call("GET", `/v1/chats/${myGroup.group.chatId}/messages`, t)).body;
    expect(chat.messages[0].userId).toBeNull(); // bot
    expect(chat.messages.length).toBeGreaterThanOrEqual(3);
    const post = await call("POST", `/v1/chats/${myGroup.group.chatId}/messages`, t, { text: "See you Thursday!" });
    expect(post.status).toBe(201);
    const reacted = await call("POST", `/v1/chats/${myGroup.group.chatId}/messages/${post.body.message.id}/react`, t, { emoji: "👍" });
    expect(reacted.body.message.reactions["👍"]).toEqual([DEMO_USER_ID]);
  });

  test("rankings move players between groups; stats and tags", async () => {
    const t = await as("demo");
    const ladder = await eventByName(t, "Sunrise Heat Climb");
    const rk = (await call("GET", `/v1/events/${ladder.id}/rankings`, t)).body;
    expect(rk.round).toBe(3);
    expect(rk.rows.length).toBe(24);
    expect(rk.rows.some((r: any) => r.prevRank !== null && r.prevRank !== r.rank)).toBe(true);
    const st = (await call("GET", `/v1/events/${ladder.id}/stats`, t)).body;
    expect(st.rows.length).toBeGreaterThan(10);
    expect(Object.values(st.tags).flat().length).toBeGreaterThan(0);
  });

  test("sub in, organizer closes the round and starts the next", async () => {
    const t = await as("demo");
    const ladder = await eventByName(t, "Sunrise Heat Climb");
    const detail = (await call("GET", `/v1/events/${ladder.id}`, t)).body;
    const rv = (await call("GET", `/v1/rounds/${detail.currentRoundId}`, t)).body;
    const open = rv.subs.find((s: any) => s.status === "open");
    // Demo player is already playing this round: can't sub.
    expect((await call("POST", `/v1/subs/${open.id}/accept`, t)).status).toBe(409);
    // A club member who isn't in the ladder can sub.
    const fresh = await call("POST", "/v1/auth/signup", undefined, { email: "sub@example.com", password: "longenough1", name: "Sub Player" });
    const clubId = detail.club.id;
    await call("POST", `/v1/clubs/${clubId}/join`, fresh.body.token);
    const acc = await call("POST", `/v1/subs/${open.id}/accept`, fresh.body.token);
    expect(acc.status).toBe(200);
    expect(acc.body.subs.find((s: any) => s.id === open.id).status).toBe("filled");

    expect((await call("POST", `/v1/events/${ladder.id}/rounds/start`, t)).status).toBe(403);
    const chen = await as("chen");
    const next = await call("POST", `/v1/events/${ladder.id}/rounds/start`, chen);
    expect(next.status).toBe(200);
    expect(next.body.round.number).toBe(5);
    const rk = (await call("GET", `/v1/events/${ladder.id}/rankings`, t)).body;
    expect(rk.round).toBe(4);
    const covered = rk.rows.find((r: any) => r.userId === open.userId);
    expect(covered.played).toBe(false);
  });

  test("attendance: decline an upcoming round", async () => {
    const t = await as("demo");
    const ladder = await eventByName(t, "Sunrise Heat Climb");
    const detail = (await call("GET", `/v1/events/${ladder.id}`, t)).body;
    const upcoming = detail.rounds.find((r: any) => r.status === "upcoming");
    const r = await call("POST", `/v1/rounds/${upcoming.id}/attendance`, t, { status: "declined" });
    expect(r.body.myAttendance).toBe("declined");
    const inProgress = detail.rounds.find((r: any) => r.status === "in_progress");
    expect((await call("POST", `/v1/rounds/${inProgress.id}/attendance`, t, { status: "declined" })).status).toBe(409);
  });
});

describe("registration and payments (web only)", () => {
  test("app registration never takes payment; the web does", async () => {
    const t = await as("demo");
    const scramble = await eventByName(t, "Friday Wildfire Mixer");
    const card = (await call("GET", "/v1/discover", t)).body.events.find((c: any) => c.event.id === scramble.id);
    expect(card.myPriceCents).toBe(3000); // club member price
    const reg = await call("POST", `/v1/events/${scramble.id}/register?client=app`, t, {});
    expect(reg.status).toBe(201);
    expect(reg.body.payOnWeb).toBe(true);
    expect(reg.body.checkoutUrl).toBeNull();
    expect(reg.body.entry.status).toBe("pending_payment");
    // On the web, after the handoff:
    const co = await call("POST", `/v1/entries/${reg.body.entry.id}/checkout`, t);
    expect(co.body.url).toContain("/v1/payments/mock-pay");
    const pay = await call("GET", new URL(co.body.url).pathname + new URL(co.body.url).search);
    expect(pay.status).toBe(302);
    const detail = (await call("GET", `/v1/events/${scramble.id}`, t)).body;
    expect(detail.myEntry.status).toBe("confirmed");
  });

  test("teams: partner by DUPR ID, rating range, waitlist and promotion", async () => {
    const t = await as("demo");
    const slam = await eventByName(t, "Fall Slam Doubles");
    expect((await call("POST", `/v1/events/${slam.id}/register?client=web`, t, {})).status).toBe(422); // needs a partner
    const priya = (await call("GET", "/v1/me", await as("priya"))).body.dupr.duprId;
    const reg = await call("POST", `/v1/events/${slam.id}/register?client=web`, t, { partnerDuprIds: [priya] });
    expect(reg.status).toBe(201);
    expect(reg.body.checkoutUrl).toContain("mock-pay"); // web registration goes straight to checkout
    // Out of range, then fill the last spot, then a ninth team waits.
    const chen = await as("chen");
    const ana = (await call("GET", "/v1/me", await as("ana"))).body.dupr.duprId;
    expect((await call("POST", `/v1/events/${slam.id}/register?client=web`, chen, { partnerDuprIds: [ana] })).status).toBe(409); // 4.38 is above 4.35
    const sofia = await as("sofia");
    const haleId = (await call("GET", "/v1/me", await as("hale"))).body.dupr.duprId;
    const r8 = await call("POST", `/v1/events/${slam.id}/register?client=web`, sofia, { partnerDuprIds: [haleId] });
    expect(r8.body.entry.status).toBe("pending_payment");
    const brooks = await as("brooks");
    const r9 = await call("POST", `/v1/events/${slam.id}/register?client=web`, brooks, { partnerDuprIds: [ana] });
    expect(r9.body.entry.status).toBe("waitlisted");
    await call("POST", `/v1/events/${slam.id}/withdraw`, sofia);
    const detail = (await call("GET", `/v1/events/${slam.id}`, brooks)).body;
    expect(detail.myEntry.status).toBe("pending_payment");
    const notes = (await call("GET", "/v1/notifications", brooks)).body.notifications;
    expect(notes[0].kind).toBe("waitlist");
    expect(notes[0].link).toBe(`entries/${detail.myEntry.id}/pay`);
  });

  test("organizer refunds a paid entry", async () => {
    const hale = await as("hale");
    const slam = await eventByName(hale, "Fall Slam Doubles");
    const detail = (await call("GET", `/v1/events/${slam.id}`, await as("demo"))).body;
    const t = await as("demo");
    const pay = await call("POST", `/v1/demo/pay/${detail.myEntry.id}`, t);
    expect(pay.body.entry.status).toBe("confirmed");
    const ref = await call("POST", `/v1/events/${slam.id}/entries/${detail.myEntry.id}/refund`, hale);
    expect(ref.body.entry.status).toBe("refunded");
  });
});

describe("tournaments", () => {
  test("double elimination plays out through the API", async () => {
    const hale = await as("hale");
    const slam = await eventByName(hale, "Fall Slam Doubles");
    // Pay pending teams so everyone is confirmed, then build the bracket.
    const detail = (await call("GET", `/v1/events/${slam.id}`, hale)).body;
    for (const e of detail.entries.filter((x: any) => x.status === "pending_payment")) {
      const slug = Object.keys(tokens).find((s) => detail.players[e.playerIds[0]]?.name.toLowerCase().startsWith(s)) ?? "brooks";
      await call("POST", `/v1/demo/pay/${e.id}`, await as(slug));
    }
    const sched = await call("POST", `/v1/events/${slam.id}/schedule`, hale);
    expect(sched.status).toBe(200);
    let guard = 0;
    for (;;) {
      const d = (await call("GET", `/v1/events/${slam.id}`, hale)).body;
      const next = d.matches.find((m: any) => m.status === "scheduled" && m.homePlayers.length && m.awayPlayers.length);
      if (!next || guard++ > 40) break;
      const r = await call("POST", `/v1/matches/${next.id}/score`, hale, { games: [{ us: 11, them: 6 }] });
      expect(r.status).toBe(200);
    }
    const done = (await call("GET", `/v1/events/${slam.id}`, hale)).body;
    expect(done.event.status).toBe("completed");
    expect(done.matches.some((m: any) => m.bracket?.side === "L")).toBe(true);
    expect((await call("POST", `/v1/matches/${done.matches[0].id}/score`, hale, { games: [{ us: 1, them: 11 }] })).status).toBe(409);
  });

  test("MLP: lines, DreamBreaker at 2–2", async () => {
    const ana = await as("ana");
    const mlp = await eventByName(ana, "Club MLP Showdown");
    await call("POST", `/v1/events/${mlp.id}/schedule`, ana);
    const d = (await call("GET", `/v1/events/${mlp.id}`, ana)).body;
    const m = d.matches[0];
    expect(m.lines.map((l: any) => l.label)).toEqual(["Women's doubles", "Men's doubles", "Mixed 1", "Mixed 2"]);
    const tied = await call("POST", `/v1/matches/${m.id}/score`, ana, { lines: [0, 1, 2, 3].map((i) => ({ games: [i < 2 ? { us: 21, them: 15 } : { us: 15, them: 21 }] })) });
    expect(tied.body.match.lines.length).toBe(5);
    expect(tied.body.match.status).toBe("scheduled");
    const done = await call("POST", `/v1/matches/${m.id}/score`, ana, { lines: [0, 1, 2, 3, 4].map((i) => ({ games: [i === 4 ? { us: 21, them: 18 } : i < 2 ? { us: 21, them: 15 } : { us: 15, them: 21 }] })) });
    expect(done.body.match.status).toBe("confirmed");
    const after = (await call("GET", `/v1/events/${mlp.id}`, ana)).body;
    expect(after.standings[0].table[0].wins).toBe(1);
  });
});

describe("clubs, invites, chats, notifications", () => {
  test("clubs: mine and nearby, join, roles", async () => {
    const t = await as("demo");
    const list = (await call("GET", "/v1/clubs", t)).body;
    expect(list.mine.length).toBe(1);
    const river = list.nearby.find((c: any) => c.club.name === "Riverside Paddle Club");
    const joined = (await call("POST", `/v1/clubs/${river.club.id}/join`, t)).body;
    expect(joined.summary.myRole).toBe("member");
    expect((await call("PATCH", `/v1/clubs/${river.club.id}/members/u-grace`, t, { role: "admin" })).status).toBe(403);
    const omar = await as("omar");
    expect((await call("PATCH", `/v1/clubs/${river.club.id}/members/${DEMO_USER_ID}`, omar, { role: "admin" })).body.members.find((m: any) => m.userId === DEMO_USER_ID).role).toBe("admin");
  });

  test("invites: imported players join when they sign up", async () => {
    const chen = await as("chen");
    const ladder = await eventByName(chen, "Sunrise Heat Climb");
    const r = await call("POST", `/v1/events/${ladder.id}/invites`, chen, { csv: "name,email\nZoe Fox, zoe@example.com" });
    expect(r.body.added).toBe(1);
    const zoe = await call("POST", "/v1/auth/signup", undefined, { email: "zoe@example.com", password: "longenough1", name: "Zoe Fox" });
    const d = (await call("GET", `/v1/events/${ladder.id}`, zoe.body.token)).body;
    expect(d.myEntry.status).toBe("confirmed");
    expect(d.myEntry.comped).toBe(true);
  });

  test("chat list with unread counts; direct chat; notifications read", async () => {
    const t = await as("demo");
    const chats = (await call("GET", "/v1/chats", t)).body;
    expect(chats.chats.length).toBeGreaterThan(2);
    const dm = await call("POST", "/v1/chats", t, { userIds: ["u-priya"] });
    expect(dm.status).toBe(201);
    await call("POST", `/v1/chats/${dm.body.chat.id}/messages`, await as("priya"), { text: "Practice Sunday?" });
    const list = (await call("GET", "/v1/chats", t)).body.chats;
    expect(list[0].chat.id).toBe(dm.body.chat.id);
    expect(list[0].unread).toBe(1);
    expect((await call("POST", "/v1/notifications/read", t, {})).body.updated).toBeGreaterThan(0);
    expect((await call("GET", "/v1/me", t)).body.unread.notifications).toBe(0);
  });

  test("account deletion", async () => {
    const x = await call("POST", "/v1/auth/signup", undefined, { email: "bye@example.com", password: "longenough1", name: "Bye" });
    expect((await call("DELETE", "/v1/me", x.body.token)).body.deleted).toBe(true);
    expect((await call("GET", "/v1/me", x.body.token)).status).toBe(401);
  });
});

describe("misc", () => {
  test("DUPR stand-in login is frameable only by us", async () => {
    expect((await call("GET", "/v1/dupr/mock-login")).headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
  });

  test("mock DUPR received uploads", () => {
    expect((deps.dupr as MockDuprProvider).uploads.length).toBeGreaterThan(10);
  });

  test("stripe webhook signatures", async () => {
    const p = new StripeConnectProvider("sk_test_x", "whsec_test");
    const body = JSON.stringify({ type: "checkout.session.completed", data: { object: { id: "cs_1", payment_status: "paid" } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = await hmacHex("whsec_test", `${t}.${body}`);
    expect(await p.parseWebhook(body, `t=${t},v1=${sig}`)).toEqual({ type: "checkout_paid", providerRef: "cs_1" });
    await expect(p.parseWebhook(body, `t=${t},v1=${"0".repeat(64)}`)).rejects.toThrow("Bad Stripe signature");
  });
});
