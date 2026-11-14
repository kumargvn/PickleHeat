// Push notifications: device sign-up, what gets pushed, and the APNs request itself.
import { beforeAll, describe, expect, test } from "bun:test";
import { handle } from "../src/app";
import { buildDeps } from "../src/deps";
import { MemoryStore } from "../src/adapters/memoryStore";
import { ApnsPushSender, LogPushSender } from "../src/adapters/push";
import { seedDemo, DEMO_USER_ID } from "../src/demo/seed";
import type { Deps, Device } from "../src/ports";

const BASE = "http://api.test";
let deps: Deps;
let log: LogPushSender;
const A = "a".repeat(64), B = "b".repeat(64);

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await handle(new Request(BASE + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), deps);
  return { status: res.status, body: JSON.parse(await res.text()) };
}
const as = async (slug: string) => (await call("POST", "/v1/auth/apple", undefined, { identityToken: `dev:${slug}`, name: slug })).body.token as string;

beforeAll(async () => {
  deps = buildDeps({ PUBLIC_BASE_URL: BASE, JWT_SECRET: "x".repeat(40), ALLOW_DEV_AUTH: "true" }, new MemoryStore());
  await seedDemo(deps);
  log = deps.push as LogPushSender;
});

describe("push notifications", () => {
  test("a phone signs up; bad tokens are refused", async () => {
    const demo = await as("demo");
    expect((await call("POST", "/v1/me/devices", demo, { token: "not a token" })).status).toBe(422);
    expect((await call("POST", "/v1/me/devices", undefined, { token: A })).status).toBe(401);
    const r = await call("POST", "/v1/me/devices", demo, { token: A.toUpperCase() });
    expect(r.status).toBe(201);
    expect(r.body.environment).toBe("production");
  });

  test("a score to confirm reaches the opponent's lock screen with a link and badge", async () => {
    const demo = await as("demo");
    log.sent.length = 0;
    const live = (await call("GET", "/v1/me/live", demo)).body;
    const item = live.items.find((i: any) => i.match.status === "scheduled" && i.match.homePlayers.length);
    const opponent = [...item.match.homePlayers, ...item.match.awayPlayers].find((p: string) => {
      const mine = item.match.homePlayers.includes(DEMO_USER_ID) ? item.match.homePlayers : item.match.awayPlayers;
      return !mine.includes(p);
    });
    const opp = await as(opponent.replace("u-", ""));
    await call("POST", `/v1/matches/${item.match.id}/score`, opp, { games: [{ us: 11, them: 7 }, { us: 11, them: 9 }] });
    const mine = log.sent.find((s) => s.tokens.includes(A));
    expect(mine?.message.title).toBe("Confirm a score");
    expect(mine?.message.link).toBe(`events/${item.eventId}`);
    expect(mine?.message.badge).toBeGreaterThan(0);
  });

  test("chat messages are pushed to the others in the chat, not the sender", async () => {
    const demo = await as("demo");
    const chat = (await call("GET", "/v1/chats", demo)).body.chats[0].chat;
    const other = chat.memberIds.find((id: string) => id !== DEMO_USER_ID);
    const otherToken = await as(other.replace("u-", ""));
    await call("POST", "/v1/me/devices", otherToken, { token: B, environment: "sandbox" });
    log.sent.length = 0;
    await call("POST", `/v1/chats/${chat.id}/messages`, demo, { text: "Court 3 at 6?" });
    expect(log.sent.some((s) => s.tokens.includes(A))).toBe(false);
    const got = log.sent.find((s) => s.tokens.includes(B));
    expect(got?.message.body).toContain("Court 3 at 6?");
    expect(got?.message.link).toBe(`chats/${chat.id}`);
  });

  test("signing out on a phone stops its pushes; a phone follows whoever signed in last", async () => {
    const demo = await as("demo");
    const chen = await as("chen");
    await call("POST", "/v1/me/devices", chen, { token: A }); // same phone, new account
    expect((await call("DELETE", `/v1/me/devices/${A}`, demo)).status).toBe(200); // not demo's any more: no effect
    expect((await deps.store.collection<Device>("devices").get(A))?.userId).toBe("u-chen");
    await call("DELETE", `/v1/me/devices/${A}`, chen);
    expect(await deps.store.collection<Device>("devices").get(A)).toBeNull();
  });
});

describe("APNs", () => {
  test("signs with the .p8 key and forgets tokens Apple rejects", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
    const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
    const calls: { url: string; init: any }[] = [];
    const fetchFn = (async (url: string, init: any) => {
      calls.push({ url, init });
      if (url.endsWith(B)) return new Response(JSON.stringify({ reason: "Unregistered" }), { status: 410 });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const apns = new ApnsPushSender({ keyId: "KEY123", teamId: "TEAM456", privateKey: pem, topic: "com.gudivada.pickleheat" }, fetchFn, () => 1_800_000_000_000);
    const dev = (id: string, environment: "production" | "sandbox"): Device => ({ id, userId: "u", platform: "ios", environment, createdAt: "" });
    const gone = await apns.send([dev(A, "production"), dev(B, "sandbox")], { title: "Your heat is posted", body: "Round 5 · Heat 2", link: "events/e1", badge: 3 });
    expect(gone).toEqual([B]);
    expect(calls.map((c) => c.url).sort()).toEqual([`https://api.push.apple.com/3/device/${A}`, `https://api.sandbox.push.apple.com/3/device/${B}`]);
    const h = calls[0].init.headers;
    expect(h["apns-topic"]).toBe("com.gudivada.pickleheat");
    expect(h["apns-push-type"]).toBe("alert");
    expect(JSON.parse(calls[0].init.body)).toEqual({ aps: { alert: { title: "Your heat is posted", body: "Round 5 · Heat 2" }, sound: "default", badge: 3 }, link: "events/e1" });
    // The bearer token is an ES256 JWT that Apple can check with the public key.
    const [head, claims, sig] = h.authorization.replace("bearer ", "").split(".");
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY123" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({ iss: "TEAM456", iat: 1_800_000_000 });
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, Buffer.from(sig, "base64url"), new TextEncoder().encode(`${head}.${claims}`))).toBe(true);
  });
});
