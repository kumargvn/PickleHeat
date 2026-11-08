// DUPR adapters.
//
// DuprHttpProvider talks to the DUPR Partner API. The SSO page and hosts come from DUPR's
// partner docs (https://dupr.gitbook.io/dupr-raas). Exact endpoint paths and payload field
// names are set in DUPR_PATHS below and MUST be checked against DUPR's API explorer
// (api.uat.dupr.gg/api-explorer) once PickleHeat has partner keys. They are isolated here so
// nothing else changes when they do.
//
// MockDuprProvider behaves the same way with fake data. It is used until partner keys exist.

import type { PlayedMatch } from "../domain/types";
import type { DuprLink, DuprMatchUpload, DuprProfile, DuprTokens, RatingProvider, RatingUpdate } from "../ports";
import { sampleMatches, samplePlayer } from "./sample";

export type DuprEnv = "uat" | "production";

const HOSTS = {
  uat: { api: "https://api.uat.dupr.gg", sso: "https://uat.dupr.gg/login-external-app/" },
  production: { api: "https://api.dupr.gg", sso: "https://dashboard.dupr.com/login-external-app/" },
} as const;

/** Endpoint paths. Verify each against DUPR's API explorer during partner onboarding. */
export const DUPR_PATHS = {
  partnerToken: "/auth/v1.0/token",
  refreshUserToken: "/auth/v1.0/refresh",
  basicInfo: "/public/getBasicInfo",
  matchHistory: (duprUserId: string) => `/player/v1.0/${encodeURIComponent(duprUserId)}/history`,
  createMatch: "/match/v1.0/create",
  deleteMatch: "/match/v1.0/delete",
  subscribe: "/subscribe/v1.0/webhook",
};

export interface DuprConfig {
  env: DuprEnv;
  clientKey: string;
  clientSecret: string;
  /** Club ID when matches are submitted on behalf of a club (optional). */
  clubId?: string;
}

const num = (x: unknown): number | null => (typeof x === "number" && isFinite(x) ? x : typeof x === "string" && x.trim() !== "" && isFinite(Number(x)) ? Number(x) : null);

export class DuprHttpProvider implements RatingProvider {
  readonly name = "dupr";
  private partner: { token: string; until: number } | null = null;

  constructor(private cfg: DuprConfig, private fetchFn: typeof fetch = fetch) {}

  private get api() {
    return HOSTS[this.cfg.env].api;
  }

  ssoUrl(): string {
    return HOSTS[this.cfg.env].sso + btoa(this.cfg.clientKey);
  }

  private async partnerToken(): Promise<string> {
    if (this.partner && this.partner.until > Date.now() + 60_000) return this.partner.token;
    const res = await this.fetchFn(this.api + DUPR_PATHS.partnerToken, {
      method: "POST",
      headers: { "x-authorization": btoa(`${this.cfg.clientKey}:${this.cfg.clientSecret}`) },
    });
    if (!res.ok) throw new Error(`DUPR partner token: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: { token?: string; expiration?: number } };
    const token = body.result?.token;
    if (!token) throw new Error("DUPR partner token missing in response");
    this.partner = { token, until: body.result?.expiration ? body.result.expiration * 1000 : Date.now() + 50 * 60_000 };
    return token;
  }

  private async call(path: string, init: RequestInit & { userToken?: string } = {}): Promise<any> {
    const token = init.userToken ?? (await this.partnerToken());
    const res = await this.fetchFn(this.api + path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`DUPR ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  async verifyUser(accessToken: string): Promise<DuprProfile> {
    const body = await this.call(DUPR_PATHS.basicInfo, { method: "GET", userToken: accessToken });
    const r = body.result ?? body;
    const ratings = r.ratings ?? r.stats ?? {};
    return {
      duprId: String(r.duprId ?? r.dupr_id ?? ""),
      duprUserId: String(r.id ?? r.userId ?? ""),
      name: String(r.fullName ?? r.name ?? [r.firstName, r.lastName].filter(Boolean).join(" ") ?? ""),
      doublesRating: num(ratings.doubles ?? ratings.doublesRating),
      singlesRating: num(ratings.singles ?? ratings.singlesRating),
    };
  }

  async refresh(refreshToken: string): Promise<DuprTokens> {
    const body = await this.call(DUPR_PATHS.refreshUserToken, { method: "POST", body: JSON.stringify({ refreshToken }) });
    const r = body.result ?? body;
    return {
      accessToken: String(r.accessToken),
      refreshToken: String(r.refreshToken),
      accessExpiresAt: new Date(Date.now() + (this.cfg.env === "uat" ? 7 : 30) * 86_400_000).toISOString(),
    };
  }

  async matchHistory(link: DuprLink): Promise<PlayedMatch[]> {
    const body = await this.call(DUPR_PATHS.matchHistory(link.duprUserId), { method: "GET" });
    const hits: any[] = body.result?.hits ?? body.result ?? [];
    const out: PlayedMatch[] = [];
    for (const h of hits) {
      const teams: any[] = h.teams ?? [];
      const mineIdx = teams.findIndex((t) => [t.player1?.duprId, t.player2?.duprId].includes(link.duprId));
      if (mineIdx < 0 || teams.length !== 2) continue;
      const us = teams[mineIdx];
      const them = teams[1 - mineIdx];
      const rating = (t: any) => {
        const rs = [t.player1, t.player2].filter(Boolean).map((p: any) => num(p.ratings?.doubles ?? p.preRating ?? p.rating)).filter((x): x is number => x != null);
        return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
      };
      const ur = rating(us);
      const tr = rating(them);
      if (ur == null || tr == null) continue;
      const games: { us: number; them: number }[] = [];
      for (let g = 1; g <= 5; g++) {
        const a = num(us[`game${g}`]);
        const b = num(them[`game${g}`]);
        if (a != null && b != null && a + b > 0) games.push({ us: a, them: b });
      }
      if (!games.length) continue;
      out.push({
        id: String(h.matchId ?? h.id),
        playedAt: new Date(h.eventDate ?? h.matchDate ?? Date.now()).toISOString(),
        teamRating: ur,
        opponentRating: tr,
        games,
        partnerName: [us.player1, us.player2].find((p: any) => p && p.duprId !== link.duprId)?.fullName,
        opponentNames: [them.player1, them.player2].filter(Boolean).map((p: any) => String(p.fullName ?? "")),
        eventName: h.eventName ?? h.league ?? undefined,
      });
    }
    return out;
  }

  async uploadMatch(m: DuprMatchUpload): Promise<string> {
    const team = (t: DuprMatchUpload["teamA"]) => {
      const o: Record<string, unknown> = { player1: t.duprIds[0] };
      if (t.duprIds[1]) o.player2 = t.duprIds[1];
      t.games.forEach((g, i) => (o[`game${i + 1}`] = g));
      return o;
    };
    const body = await this.call(DUPR_PATHS.createMatch, {
      method: "POST",
      body: JSON.stringify({
        identifier: m.externalId,
        event: m.eventName,
        location: m.location,
        matchDate: m.playedAt.slice(0, 10),
        format: m.format === "singles" ? "SINGLES" : "DOUBLES",
        matchSource: "PARTNER",
        clubId: this.cfg.clubId,
        teamA: team(m.teamA),
        teamB: team(m.teamB),
      }),
    });
    const id = body.result?.matchId ?? body.result ?? body.matchId;
    if (id == null) throw new Error("DUPR did not return a match id");
    return String(id);
  }

  async deleteMatch(duprMatchId: string): Promise<void> {
    await this.call(DUPR_PATHS.deleteMatch, { method: "DELETE", body: JSON.stringify({ matchId: duprMatchId }) });
  }

  async subscribeRatings(webhookUrl: string): Promise<void> {
    await this.call(DUPR_PATHS.subscribe, { method: "POST", body: JSON.stringify({ webhookUrl, topics: ["RATING"] }) });
  }

  parseWebhook(body: unknown): RatingUpdate[] | null {
    const b = body as any;
    const topic = String(b?.topic ?? b?.event ?? "");
    if (!["RATING", "RATING_SEED"].includes(topic)) return null;
    const items: any[] = Array.isArray(b.message) ? b.message : Array.isArray(b.data) ? b.data : [b.message ?? b.data ?? b];
    return items
      .filter((x) => x && (x.duprId || x.dupr_id))
      .map((x) => ({
        duprId: String(x.duprId ?? x.dupr_id),
        doublesRating: num(x.rating?.doubles ?? x.doubles ?? x.doublesRating),
        singlesRating: num(x.rating?.singles ?? x.singles ?? x.singlesRating),
      }));
  }
}

/** Stand-in for DUPR until partner keys arrive. Every user who connects becomes a copy of the sample player. */
export class MockDuprProvider implements RatingProvider {
  readonly name = "dupr-mock";
  uploads: DuprMatchUpload[] = [];

  constructor(private publicBaseUrl: string) {}

  ssoUrl(): string {
    return `${this.publicBaseUrl}/v1/dupr/mock-login`;
  }

  async verifyUser(accessToken: string): Promise<DuprProfile> {
    if (!accessToken.startsWith("mock-")) throw new Error("Not a mock DUPR token");
    const who = accessToken.slice(5) || "player";
    return {
      duprId: `MOCK-${who.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "PLAYER"}`,
      duprUserId: `mock-${who}`,
      name: samplePlayer.name,
      doublesRating: samplePlayer.doublesRating,
      singlesRating: samplePlayer.singlesRating,
    };
  }

  async refresh(refreshToken: string): Promise<DuprTokens> {
    return { accessToken: refreshToken.replace("refresh-", "mock-"), refreshToken, accessExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() };
  }

  async matchHistory(): Promise<PlayedMatch[]> {
    return sampleMatches(new Date().toISOString().slice(0, 10));
  }

  async uploadMatch(m: DuprMatchUpload): Promise<string> {
    this.uploads.push(m);
    return `mock-match-${m.externalId}`;
  }

  async deleteMatch(): Promise<void> {}
  async subscribeRatings(): Promise<void> {}

  parseWebhook(body: unknown): RatingUpdate[] | null {
    const b = body as any;
    if (b?.topic !== "RATING") return null;
    return [{ duprId: String(b.duprId), doublesRating: num(b.doubles), singlesRating: num(b.singles) }];
  }
}
