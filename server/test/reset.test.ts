// Forgot password and email confirmation.
import { beforeAll, describe, expect, test } from "bun:test";
import { handle } from "../src/app";
import { buildDeps } from "../src/deps";
import { MemoryStore } from "../src/adapters/memoryStore";
import { LogEmailSender, ResendEmailSender } from "../src/adapters/email";
import type { Deps } from "../src/ports";

const BASE = "http://api.test";
let deps: Deps;
let mail: LogEmailSender;
let clock = Date.parse("2026-11-14T12:00:00Z");

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await handle(new Request(BASE + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), deps);
  return { status: res.status, body: JSON.parse(await res.text()) };
}
const linkToken = (text: string) => decodeURIComponent(text.match(/[?&]t=([^\s&]+)/)![1]);
const later = (seconds: number) => (clock += seconds * 1000);

beforeAll(() => {
  // Production-like: no dev shortcuts, so links travel only by email.
  deps = buildDeps({ PUBLIC_BASE_URL: BASE, WEB_APP_URL: "http://web.test/app/", JWT_SECRET: "x".repeat(40), ALLOW_DEV_AUTH: "false" }, new MemoryStore());
  deps.now = () => new Date(clock);
  mail = deps.email as LogEmailSender;
});

describe("email confirmation", () => {
  let token: string;

  test("signing up sends a confirmation link; opening it confirms the email", async () => {
    const s = await call("POST", "/v1/auth/signup", undefined, { email: "Pat@Example.com", password: "first-password", name: "Pat" });
    expect(s.status).toBe(201);
    token = s.body.token;
    expect(s.body.user.emailVerified).toBe(false);
    expect(s.body.user.hasPassword).toBe(true);
    expect(mail.sent.length).toBe(1);
    expect(mail.sent[0].to).toBe("pat@example.com");
    expect(mail.sent[0].text).toContain("http://web.test/app/#/verify?t=");
    expect((await call("POST", "/v1/auth/email/verify", undefined, { token: "junk" })).status).toBe(401);
    const v = await call("POST", "/v1/auth/email/verify", undefined, { token: linkToken(mail.sent[0].text) });
    expect(v.body).toEqual({ ok: true, email: "pat@example.com" });
    expect((await call("GET", "/v1/me", token)).body.user.emailVerified).toBe(true);
  });

  test("asking again is limited to once a minute, and not needed once confirmed", async () => {
    const s = await call("POST", "/v1/auth/signup", undefined, { email: "lee@example.com", password: "first-password", name: "Lee" });
    expect((await call("POST", "/v1/auth/email/verify/send", s.body.token)).status).toBe(429);
    later(61);
    const again = await call("POST", "/v1/auth/email/verify/send", s.body.token);
    expect(again.body.sent).toBe(true);
    expect(again.body.devLink).toBeUndefined(); // never handed back outside demo mode
    expect((await call("POST", "/v1/auth/email/verify/send", token)).body.sent).toBe(false); // Pat is already confirmed
  });
});

describe("forgot password", () => {
  test("the answer doesn't reveal whether an email has an account", async () => {
    const before = mail.sent.length;
    const unknown = await call("POST", "/v1/auth/password/forgot", undefined, { email: "nobody@example.com" });
    const known = await call("POST", "/v1/auth/password/forgot", undefined, { email: "PAT@example.com" });
    expect(unknown.body).toEqual({ ok: true });
    expect(known.body).toEqual({ ok: true });
    expect(mail.sent.length).toBe(before + 1);
    expect(mail.sent[mail.sent.length - 1].subject).toBe("Reset your PickleHeat password");
    // A second request right away sends nothing more.
    await call("POST", "/v1/auth/password/forgot", undefined, { email: "pat@example.com" });
    expect(mail.sent.length).toBe(before + 1);
  });

  test("the link sets a new password once, signs out old sessions, and then stops working", async () => {
    const old = (await call("POST", "/v1/auth/login", undefined, { email: "pat@example.com", password: "first-password" })).body.token;
    const t = linkToken(mail.sent[mail.sent.length - 1].text);
    expect((await call("POST", "/v1/auth/password/reset", undefined, { token: t, password: "short" })).status).toBe(422);
    later(5);
    const r = await call("POST", "/v1/auth/password/reset", undefined, { token: t, password: "second-password" });
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe("pat@example.com");
    expect((await call("GET", "/v1/me", r.body.token)).status).toBe(200);
    expect((await call("GET", "/v1/me", old)).status).toBe(401);
    expect((await call("POST", "/v1/auth/login", undefined, { email: "pat@example.com", password: "first-password" })).status).toBe(401);
    expect((await call("POST", "/v1/auth/login", undefined, { email: "pat@example.com", password: "second-password" })).status).toBe(200);
    expect((await call("POST", "/v1/auth/password/reset", undefined, { token: t, password: "third-password" })).status).toBe(401);
  });

  test("links expire after 30 minutes", async () => {
    later(120);
    await call("POST", "/v1/auth/password/forgot", undefined, { email: "pat@example.com" });
    const t = linkToken(mail.sent[mail.sent.length - 1].text);
    later(31 * 60);
    expect((await call("POST", "/v1/auth/password/reset", undefined, { token: t, password: "fourth-password" })).status).toBe(401);
  });

  test("a session token can't be used as a reset link", async () => {
    const session = (await call("POST", "/v1/auth/login", undefined, { email: "pat@example.com", password: "second-password" })).body.token;
    expect((await call("POST", "/v1/auth/password/reset", undefined, { token: session, password: "fifth-password" })).status).toBe(401);
  });
});

describe("Google and password accounts", () => {
  test("Google joins a password account only after its email is confirmed", async () => {
    const d = buildDeps({ PUBLIC_BASE_URL: BASE, JWT_SECRET: "x".repeat(40), ALLOW_DEV_AUTH: "true" }, new MemoryStore());
    const go = async (path: string, body: unknown) => {
      const res = await handle(new Request(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), d);
      return { status: res.status, body: JSON.parse(await res.text()) };
    };
    const s = await go("/v1/auth/signup", { email: "kim@example.com", password: "longenough1", name: "Kim" });
    expect((await go("/v1/auth/google", { credential: "dev:kim" })).status).toBe(409);
    const sent = (d.email as LogEmailSender).sent[0];
    await go("/v1/auth/email/verify", { token: linkToken(sent.text) });
    const g = await go("/v1/auth/google", { credential: "dev:kim" });
    expect(g.status).toBe(200);
    expect(g.body.user.id).toBe(s.body.user.id);
    // In demo mode there is no inbox, so the link comes back in the response instead.
    const f = await go("/v1/auth/password/forgot", { email: "kim@example.com" });
    expect(f.body.devLink).toContain("#/reset?t=");
  });
});

describe("Resend", () => {
  test("sends through the Resend API and reports failures", async () => {
    const calls: any[] = [];
    const ok = (async (url: string, init: any) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    await new ResendEmailSender("re_key", "PickleHeat <hi@example.com>", ok).send({ to: "a@b.co", subject: "S", text: "T", html: "<p>T</p>" });
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].init.headers.authorization).toBe("Bearer re_key");
    expect(JSON.parse(calls[0].init.body)).toEqual({ from: "PickleHeat <hi@example.com>", to: ["a@b.co"], subject: "S", text: "T", html: "<p>T</p>" });
    const bad = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    await expect(new ResendEmailSender("k", "f", bad).send({ to: "a@b.co", subject: "S", text: "T", html: "T" })).rejects.toThrow("Resend: HTTP 403");
  });
});
