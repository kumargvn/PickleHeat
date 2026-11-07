// Small WebCrypto helpers (no dependencies): base64url, HMAC, our session JWTs.
// Runs unchanged on Cloudflare Workers, Bun, Deno and Node 20+.

const enc = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const b64urlJson = (x: unknown) => b64url(enc.encode(JSON.stringify(x)));
export const decodeJson = <T>(s: string): T => JSON.parse(new TextDecoder().decode(b64urlDecode(s))) as T;

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface SessionClaims {
  sub: string; // user id
  purpose: "session" | "dupr_connect";
  iat: number;
  exp: number;
}

export async function signJwt(claims: Omit<SessionClaims, "iat" | "exp">, secret: string, ttlSeconds: number, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  const body = `${b64urlJson({ alg: "HS256", typ: "JWT" })}.${b64urlJson({ ...claims, iat, exp: iat + ttlSeconds })}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function verifyJwt(token: string, secret: string, purpose: SessionClaims["purpose"], now = Date.now()): Promise<SessionClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = decodeJson<{ alg: string }>(parts[0]);
    if (header.alg !== "HS256") return null;
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64urlDecode(parts[2]) as BufferSource, enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const claims = decodeJson<SessionClaims>(parts[1]);
    if (claims.purpose !== purpose || claims.exp * 1000 < now) return null;
    return claims;
  } catch {
    return null;
  }
}
