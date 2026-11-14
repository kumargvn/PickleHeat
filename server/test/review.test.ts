// DUPR review queue: confirmed scores wait for the organizer. Nothing is sent until they submit.
import { beforeAll, describe, expect, test } from "bun:test";
import { handle } from "../src/app";
import { buildDeps } from "../src/deps";
import { MemoryStore } from "../src/adapters/memoryStore";
import { MockDuprProvider } from "../src/adapters/dupr";
import { runSyncJob } from "../src/services/duprSync";
import { seedDemo, DEMO_USER_ID } from "../src/demo/seed";
import type { Deps } from "../src/ports";

const BASE = "http://api.test";
let deps: Deps;
let mock: MockDuprProvider;
const deleted: string[] = [];

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await handle(new Request(BASE + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), deps);
  return { status: res.status, body: JSON.parse(await res.text()) };
}
const as = async (slug: string) => (await call("POST", "/v1/auth/apple", undefined, { identityToken: `dev:${slug}`, name: slug })).body.token as string;

let demo: string, chen: string, ladderId: string, matchId: string;

beforeAll(async () => {
  deps = buildDeps({ PUBLIC_BASE_URL: BASE, WEB_APP_URL: "http://web.test/app/", JWT_SECRET: "x".repeat(40), ALLOW_DEV_AUTH: "true" }, new MemoryStore());
  await seedDemo(deps);
  mock = deps.dupr as MockDuprProvider;
  mock.deleteMatch = async (id?: string) => void deleted.push(String(id));
  demo = await as("demo");
  chen = await as("chen");
  ladderId = (await call("GET", "/v1/events", demo)).body.events.find((c: any) => c.event.name === "Sunrise Heat Climb").event.id;
});

describe("DUPR review queue", () => {
  test("two teams confirming a score never sends it to DUPR", async () => {
    const before = mock.uploads.length;
    const live = (await call("GET", "/v1/me/live", demo)).body;
    matchId = live.items.find((i: any) => i.needsMyConfirmation).match.id;
    const c = await call("POST", `/v1/matches/${matchId}/confirm`, demo);
    expect(c.body.match.status).toBe("confirmed");
    expect(c.body.match.duprStatus).toBe("ready");
    expect(c.body.match.duprMatchId).toBeNull();
    // Not now, and not from the hourly job either.
    await runSyncJob(deps);
    expect(mock.uploads.length).toBe(before);
    // The organizer is told results are waiting.
    const notes = (await call("GET", "/v1/notifications", chen)).body.notifications;
    expect(notes.filter((n: any) => n.kind === "dupr_review").length).toBe(1);
  });

  test("only the organizer sees the queue", async () => {
    expect((await call("GET", `/v1/events/${ladderId}/dupr`, demo)).status).toBe(403);
    expect((await call("POST", `/v1/events/${ladderId}/dupr/submit`, demo, {})).status).toBe(403);
    expect((await call("POST", `/v1/matches/${matchId}/dupr/submit`, demo)).status).toBe(403);
    expect((await call("DELETE", `/v1/matches/${matchId}/score`, demo)).status).toBe(403);
    const q = (await call("GET", `/v1/events/${ladderId}/dupr`, chen)).body;
    expect(q.counts.ready).toBeGreaterThan(1);
    expect(q.counts.submitted).toBeGreaterThan(10); // earlier weeks, already sent
    const mine = q.items.find((i: any) => i.match.id === matchId);
    expect(mine.status).toBe("ready");
    expect(mine.missingDupr).toEqual([DEMO_USER_ID]); // the demo player hasn't connected DUPR yet
    expect((await call("GET", `/v1/events/${ladderId}`, chen)).body.duprReview.ready).toBe(q.counts.ready);
    expect((await call("GET", `/v1/events/${ladderId}`, demo)).body.duprReview).toBeNull();
  });

  test("a result DUPR can't take is kept and retried after the organizer submitted it", async () => {
    const before = mock.uploads.length;
    const r = await call("POST", `/v1/matches/${matchId}/dupr/submit`, chen);
    expect(r.body.match.duprStatus).toBe("failed");
    expect(r.body.match.duprError).toContain("connected DUPR account");
    expect(mock.uploads.length).toBe(before);
    // The player connects DUPR. What the organizer already approved goes right away, with no wait for the hourly job.
    const s = await call("POST", "/v1/dupr/connect-session", demo, { client: "app" });
    await call("POST", "/v1/dupr/link", new URL(s.body.url).searchParams.get("t")!, { userToken: "mock-demo", refreshToken: "refresh-demo" });
    // (Their earlier weeks' results were approved too, so those go with it.)
    expect(mock.uploads.length).toBeGreaterThan(before);
    expect(mock.uploads.some((u) => u.externalId === matchId)).toBe(true);
    const job = await runSyncJob(deps);
    expect(job).toMatchObject({ uploaded: 0, failed: 0 });
    const q = (await call("GET", `/v1/events/${ladderId}/dupr`, chen)).body;
    const mine = q.items.find((i: any) => i.match.id === matchId);
    expect(mine.status).toBe("submitted");
    expect(mine.match.duprMatchId).toBe(`mock-match-${matchId}`);
    expect(mine.match.duprSubmittedBy).toBe("u-chen");
    expect((await call("POST", `/v1/matches/${matchId}/dupr/submit`, chen)).status).toBe(409); // already there
  });

  test("editing a submitted result takes it back from DUPR and returns it to the queue", async () => {
    const before = mock.uploads.length;
    const e = await call("POST", `/v1/matches/${matchId}/score`, chen, { games: [{ us: 11, them: 3 }, { us: 11, them: 4 }] });
    expect(e.body.match.duprStatus).toBe("ready");
    expect(e.body.match.duprMatchId).toBeNull();
    expect(deleted).toContain(`mock-match-${matchId}`);
    expect(mock.uploads.length).toBe(before); // the correction waits for review too
  });

  test("the organizer can keep a result out of DUPR, and change their mind", async () => {
    const before = mock.uploads.length;
    const w = await call("DELETE", `/v1/matches/${matchId}/dupr`, chen);
    expect(w.body.match.duprStatus).toBe("skipped");
    expect(w.body.match.status).toBe("confirmed"); // the score still counts in the league
    // "Submit all" leaves skipped results alone.
    const all = await call("POST", `/v1/events/${ladderId}/dupr/submit`, chen, {});
    expect(all.body.failed).toBe(0);
    expect(all.body.counts.ready).toBe(0);
    expect(all.body.counts.skipped).toBe(1);
    expect(all.body.submitted).toBe(mock.uploads.length - before);
    expect(mock.uploads.some((u) => u.externalId === matchId && u.teamA.games[0] === 11 && u.teamA.games[1] === 11)).toBe(false);
    // Naming it sends it, with the corrected score.
    const s = await call("POST", `/v1/events/${ladderId}/dupr/submit`, chen, { matchIds: [matchId] });
    expect(s.body.submitted).toBe(1);
    const up = mock.uploads[mock.uploads.length - 1];
    expect(up.externalId).toBe(matchId);
    expect([up.teamA.games, up.teamB.games]).toEqual([[11, 11], [3, 4]]);
  });

  test("taking back a submitted result deletes it at DUPR", async () => {
    deleted.length = 0;
    const w = await call("DELETE", `/v1/matches/${matchId}/dupr`, chen);
    expect(w.body.match.duprStatus).toBe("skipped");
    expect(w.body.match.duprMatchId).toBeNull();
    expect(deleted).toEqual([`mock-match-${matchId}`]);
  });

  test("if DUPR refuses the removal, we don't pretend it happened", async () => {
    await call("POST", `/v1/matches/${matchId}/dupr/submit`, chen);
    const real = mock.deleteMatch;
    mock.deleteMatch = async () => { throw new Error("DUPR is down"); };
    const w = await call("DELETE", `/v1/matches/${matchId}/dupr`, chen);
    expect(w.status).toBe(502);
    const still = (await call("GET", `/v1/events/${ladderId}/dupr`, chen)).body.items.find((i: any) => i.match.id === matchId);
    expect(still.status).toBe("submitted");
    mock.deleteMatch = real;
  });

  test("deleting a result puts the match back to not played and takes it off DUPR", async () => {
    deleted.length = 0;
    const d = await call("DELETE", `/v1/matches/${matchId}/score`, chen);
    expect(d.status).toBe(200);
    expect(d.body.match.status).toBe("scheduled");
    expect(d.body.match.games).toEqual([]);
    expect(d.body.match.duprStatus).toBeNull();
    expect(deleted).toEqual([`mock-match-${matchId}`]);
    expect((await call("DELETE", `/v1/matches/${matchId}/score`, chen)).status).toBe(409);
    expect((await call("GET", `/v1/events/${ladderId}/dupr`, chen)).body.items.some((i: any) => i.match.id === matchId)).toBe(false);
    // A closed round's results can't be deleted (standings are final), only kept out of DUPR.
    const old = (await call("GET", `/v1/events/${ladderId}/dupr`, chen)).body.items.find((i: any) => i.roundNumber === 1);
    expect((await call("DELETE", `/v1/matches/${old.match.id}/score`, chen)).status).toBe(409);
    expect((await call("DELETE", `/v1/matches/${old.match.id}/dupr`, chen)).body.match.duprStatus).toBe("skipped");
  });

  test("events that don't send to DUPR have no queue entries", async () => {
    const ev = await call("POST", "/v1/events", chen, { kind: "tournament", style: "round_robin", format: "doubles", name: "Just For Fun", startDate: "2027-01-10", venue: "Park", city: "Austin", state: "TX", capacity: 4, feeCents: 0, submitToDupr: false, requireDuprVerified: false });
    expect(ev.status).toBe(201);
    expect((await call("POST", `/v1/events/${ev.body.event.id}/dupr/submit`, chen, {})).status).toBe(409);
    expect((await call("GET", `/v1/events/${ev.body.event.id}/dupr`, chen)).body.enabled).toBe(false);
  });
});
