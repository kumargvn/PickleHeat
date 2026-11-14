// Identity adapters. Apple: verifies "Sign in with Apple" identity tokens (RS256, Apple's public keys).
// Google: verifies "Sign in with Google" ID tokens the same way (RS256, Google's public keys).
// Dev: accepts "dev:<name>" so the API can be exercised without Apple (only when ALLOW_DEV_AUTH=true).

import type { IdentityVerifier, VerifiedIdentity } from "../ports";
import { b64urlDecode, decodeJson } from "./crypto";

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg: string;
}

export class AppleIdentityVerifier implements IdentityVerifier {
  private keys: { at: number; keys: Jwk[] } | null = null;

  /** @param audiences bundle ID (iOS) and Services ID (web), e.g. ["com.gudivada.pickleheat", "com.gudivada.pickleheat.web"] */
  constructor(private audiences: string[], private fetchFn: typeof fetch = fetch) {}

  private async jwks(): Promise<Jwk[]> {
    if (this.keys && Date.now() - this.keys.at < 3_600_000) return this.keys.keys;
    const res = await this.fetchFn("https://appleid.apple.com/auth/keys");
    if (!res.ok) throw new Error(`Apple keys: HTTP ${res.status}`);
    const body = (await res.json()) as { keys: Jwk[] };
    this.keys = { at: Date.now(), keys: body.keys };
    return body.keys;
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) throw new Error("Malformed identity token");
    const header = decodeJson<{ kid: string; alg: string }>(h);
    if (header.alg !== "RS256") throw new Error("Unexpected algorithm");
    const jwk = (await this.jwks()).find((k) => k.kid === header.kid);
    if (!jwk) throw new Error("Unknown signing key");
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(s) as BufferSource, new TextEncoder().encode(`${h}.${p}`));
    if (!ok) throw new Error("Bad signature");
    const claims = decodeJson<{ iss: string; aud: string; exp: number; sub: string; email?: string }>(p);
    if (claims.iss !== "https://appleid.apple.com") throw new Error("Wrong issuer");
    if (!this.audiences.includes(claims.aud)) throw new Error("Wrong audience");
    if (claims.exp * 1000 < Date.now()) throw new Error("Expired");
    return { subject: claims.sub, email: claims.email ?? null };
  }
}

export class GoogleIdentityVerifier implements IdentityVerifier {
  private keys: { at: number; keys: Jwk[] } | null = null;

  /** @param clientIds OAuth client IDs from Google Cloud (web, and iOS if the app adds Google later). */
  constructor(private clientIds: string[], private fetchFn: typeof fetch = fetch, private now: () => number = Date.now) {}

  private async jwks(): Promise<Jwk[]> {
    if (this.keys && this.now() - this.keys.at < 3_600_000) return this.keys.keys;
    const res = await this.fetchFn("https://www.googleapis.com/oauth2/v3/certs");
    if (!res.ok) throw new Error(`Google keys: HTTP ${res.status}`);
    const body = (await res.json()) as { keys: Jwk[] };
    this.keys = { at: this.now(), keys: body.keys };
    return body.keys;
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) throw new Error("Malformed identity token");
    const header = decodeJson<{ kid: string; alg: string }>(h);
    if (header.alg !== "RS256") throw new Error("Unexpected algorithm");
    const jwk = (await this.jwks()).find((k) => k.kid === header.kid);
    if (!jwk) throw new Error("Unknown signing key");
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(s) as BufferSource, new TextEncoder().encode(`${h}.${p}`));
    if (!ok) throw new Error("Bad signature");
    const claims = decodeJson<{ iss: string; aud: string; exp: number; sub: string; email?: string; email_verified?: boolean | string; name?: string }>(p);
    if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new Error("Wrong issuer");
    if (!this.clientIds.includes(claims.aud)) throw new Error("Wrong audience");
    if (claims.exp * 1000 < this.now()) throw new Error("Expired");
    return { subject: claims.sub, email: claims.email ?? null, emailVerified: claims.email_verified === true || claims.email_verified === "true", name: claims.name ?? null };
  }
}

export class DevIdentityVerifier implements IdentityVerifier {
  async verify(token: string): Promise<VerifiedIdentity> {
    if (!token.startsWith("dev:") || token.length < 5) throw new Error("Dev tokens look like dev:<name>");
    const name = token.slice(4).trim().toLowerCase();
    return { subject: `dev-${name}`, email: `${name}@example.com`, emailVerified: true };
  }
}

/** Tries Apple first, then dev tokens. Used when ALLOW_DEV_AUTH=true. */
export class ChainedIdentityVerifier implements IdentityVerifier {
  constructor(private chain: IdentityVerifier[]) {}
  async verify(token: string): Promise<VerifiedIdentity> {
    let last: unknown = null;
    for (const v of this.chain) {
      try {
        return await v.verify(token);
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error("Sign-in failed");
  }
}
