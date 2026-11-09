// Accounts: Sign in with Apple, email + password (web), sessions, and app → web handoff links.

import { checkPassword, hashPassword, signJwt, verifyJwt } from "../adapters/crypto";
import { db } from "../db";
import { HttpError } from "../http";
import type { Deps, User } from "../ports";
import { applyInvitesForUser } from "./invites";

export const SESSION_TTL = 60 * 60 * 24 * 60; // 60 days

export async function session(deps: Deps, userId: string): Promise<string> {
  return signJwt({ sub: userId, purpose: "session" }, deps.config.jwtSecret, SESSION_TTL, deps.now().getTime());
}

export async function userFromRequest(deps: Deps, req: Request): Promise<User> {
  const h = req.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const claims = token ? await verifyJwt(token, deps.config.jwtSecret, "session", deps.now().getTime()) : null;
  if (!claims) throw new HttpError(401, "Sign in again", "unauthorized");
  const user = await db(deps).users.get(claims.sub);
  if (!user) throw new HttpError(401, "Account not found", "unauthorized");
  return user;
}

function newUser(deps: Deps, fields: Partial<User>): User {
  return {
    id: deps.newId(),
    appleSub: null,
    email: null,
    name: "Player",
    gender: null,
    lat: null,
    lng: null,
    maxDistanceMiles: 75,
    formats: ["doubles", "mixed"],
    createdAt: deps.now().toISOString(),
    ...fields,
  };
}

export async function signInWithApple(deps: Deps, identityToken: string, name: string | null): Promise<User> {
  const id = await deps.identity.verify(identityToken).catch((e) => {
    throw new HttpError(401, `Sign in failed: ${(e as Error).message}`, "unauthorized");
  });
  const existing = (await db(deps).users.find({ appleSub: id.subject }))[0];
  if (existing) return existing;
  // Same email already signed up with a password? Link the Apple ID to that account.
  if (id.email) {
    const cred = await db(deps).credentials.get(id.email.toLowerCase());
    const byEmail = cred ? await db(deps).users.get(cred.userId) : null;
    if (byEmail) {
      const linked = { ...byEmail, appleSub: id.subject };
      await db(deps).users.put(linked);
      return linked;
    }
  }
  const user = newUser(deps, { appleSub: id.subject, email: id.email, name: name?.trim().slice(0, 80) || "Player" });
  await db(deps).users.put(user);
  await applyInvitesForUser(deps, user.id);
  return user;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function signUpWithPassword(deps: Deps, email: string, password: string, name: string): Promise<User> {
  const e = email.trim().toLowerCase();
  if (!EMAIL.test(e)) throw new HttpError(422, "Enter a valid email", "invalid");
  if (password.length < 8) throw new HttpError(422, "Use at least 8 characters for your password", "invalid");
  if (await db(deps).credentials.get(e)) throw new HttpError(409, "That email already has an account. Sign in instead.", "exists");
  const user = newUser(deps, { email: e, name: name.trim().slice(0, 80) || "Player" });
  await db(deps).users.put(user);
  const h = await hashPassword(password);
  await db(deps).credentials.put({ id: e, userId: user.id, salt: h.salt, hash: h.hash, createdAt: user.createdAt });
  await applyInvitesForUser(deps, user.id);
  return user;
}

export async function signInWithPassword(deps: Deps, email: string, password: string): Promise<User> {
  const cred = await db(deps).credentials.get(email.trim().toLowerCase());
  if (!cred || !(await checkPassword(password, cred.salt, cred.hash))) throw new HttpError(401, "Wrong email or password", "unauthorized");
  const user = await db(deps).users.get(cred.userId);
  if (!user) throw new HttpError(401, "Account not found", "unauthorized");
  return user;
}

const HANDOFF_TARGET = /^(events\/[A-Za-z0-9_-]{1,64}(\/register)?|payouts|entries\/[A-Za-z0-9_-]{1,64}\/pay)$/;

/** A 5-minute, single-use link that opens the web app already signed in (used for payments). */
export async function handoffLink(deps: Deps, userId: string, to: string): Promise<string> {
  if (!HANDOFF_TARGET.test(to)) throw new HttpError(422, "Unknown destination", "invalid");
  const t = await signJwt({ sub: userId, purpose: "handoff", jti: deps.newId(), to }, deps.config.jwtSecret, 300, deps.now().getTime());
  return `${deps.config.webAppUrl}#/handoff?t=${encodeURIComponent(t)}`;
}

export async function redeemHandoff(deps: Deps, token: string): Promise<{ user: User; to: string }> {
  const claims = await verifyJwt(token, deps.config.jwtSecret, "handoff", deps.now().getTime());
  if (!claims?.jti || !claims.to) throw new HttpError(401, "This link has expired. Open it again from the app.", "expired");
  if (await db(deps).usedTokens.get(claims.jti)) throw new HttpError(401, "This link was already used. Open it again from the app.", "expired");
  await db(deps).usedTokens.put({ id: claims.jti, usedAt: deps.now().toISOString() });
  const user = await db(deps).users.get(claims.sub);
  if (!user) throw new HttpError(401, "Account not found", "unauthorized");
  return { user, to: claims.to };
}

export async function deleteAccount(deps: Deps, userId: string): Promise<void> {
  const d = db(deps);
  const u = await d.users.get(userId);
  if (u?.email) await d.credentials.delete(u.email.toLowerCase());
  await d.dupr.delete(userId);
  await d.history.delete(userId);
  await d.payouts.delete(userId);
  for (const m of await d.members.find({ userId })) await d.members.delete(m.id);
  for (const n of await d.notifications.find({ userId })) await d.notifications.delete(n.id);
  // Results and entries stay (other players' standings depend on them); the name is gone.
  await d.users.delete(userId);
}
