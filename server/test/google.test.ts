// Google ID token checks, against a key pair made for the test (no network).
import { beforeAll, describe, expect, test } from "bun:test";
import { GoogleIdentityVerifier } from "../src/adapters/identity";
import { buildDeps } from "../src/deps";
import { MemoryStore } from "../src/adapters/memoryStore";
import { signInWithGoogle } from "../src/services/auth";

const CLIENT = "123-abc.apps.googleusercontent.com";
const b64 = (b: ArrayBuffer | string) => Buffer.from(b as any).toString("base64url");
let pair: CryptoKeyPair;
let other: CryptoKeyPair;
let jwk: JsonWebKey;

async function token(claims: Record<string, unknown>, key = pair.privateKey, alg = "RS256") {
  const head = b64(JSON.stringify({ alg, kid: "k1", typ: "JWT" }));
  const body = b64(JSON.stringify({ iss: "https://accounts.google.com", aud: CLIENT, sub: "g-1", email: "Pat@Example.com", email_verified: true, name: "Pat Lob", exp: 2_000_000_000, ...claims }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(sig)}`;
}

const keysFetch = (async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k1", alg: "RS256" }] }))) as unknown as typeof fetch;
const verifier = () => new GoogleIdentityVerifier([CLIENT], keysFetch, () => 1_900_000_000_000);

beforeAll(async () => {
  const gen = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  pair = await gen();
  other = await gen();
  jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
});

describe("Google identity tokens", () => {
  test("accepts a token signed by Google for our client", async () => {
    expect(await verifier().verify(await token({}))).toEqual({ subject: "g-1", email: "Pat@Example.com", emailVerified: true, name: "Pat Lob" });
  });

  test("rejects another app's token, a wrong issuer, an expired token and a forged signature", async () => {
    await expect(verifier().verify(await token({ aud: "someone-else" }))).rejects.toThrow("Wrong audience");
    await expect(verifier().verify(await token({ iss: "https://evil.example" }))).rejects.toThrow("Wrong issuer");
    await expect(verifier().verify(await token({ exp: 1_800_000_000 }))).rejects.toThrow("Expired");
    await expect(verifier().verify(await token({}, other.privateKey))).rejects.toThrow("Bad signature");
    await expect(verifier().verify(await token({}, pair.privateKey, "none"))).rejects.toThrow("Unexpected algorithm");
  });

  test("an unconfirmed Google email is not stored or linked", async () => {
    const env = { PUBLIC_BASE_URL: "http://api.test", JWT_SECRET: "x".repeat(40), GOOGLE_CLIENT_IDS: CLIENT };
    const deps = { ...buildDeps(env, new MemoryStore()), google: verifier() };
    const user = await signInWithGoogle(deps, await token({ email_verified: false }));
    expect(user.email).toBeNull();
    expect(user.name).toBe("Pat Lob");
    expect((await signInWithGoogle(deps, await token({ email_verified: false }))).id).toBe(user.id);
  });

  test("Google sign-in is off until a client ID is configured", async () => {
    const deps = buildDeps({ PUBLIC_BASE_URL: "http://api.test", JWT_SECRET: "x".repeat(40) }, new MemoryStore());
    expect(deps.google).toBeNull();
    await expect(signInWithGoogle(deps, "x.y.z")).rejects.toThrow("isn't set up");
  });
});
