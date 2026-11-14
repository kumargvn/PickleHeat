// Accounts: Sign in with Apple, Sign in with Google, email + password, sessions, and app → web handoff links.

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
  if (user.sessionsValidFrom && claims.iat < user.sessionsValidFrom) throw new HttpError(401, "Sign in again", "unauthorized");
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
  const user = newUser(deps, { appleSub: id.subject, email: id.email, emailVerified: !!id.email, name: name?.trim().slice(0, 80) || "Player" });
  await db(deps).users.put(user);
  await applyInvitesForUser(deps, user.id);
  return user;
}

export async function signInWithGoogle(deps: Deps, credential: string): Promise<User> {
  if (!deps.google) throw new HttpError(501, "Google sign-in isn't set up yet", "unavailable");
  const id = await deps.google.verify(credential).catch((e) => {
    throw new HttpError(401, `Sign in failed: ${(e as Error).message}`, "unauthorized");
  });
  const existing = (await db(deps).users.find({ googleSub: id.subject }))[0];
  if (existing) return existing;
  const email = id.email?.toLowerCase() ?? null;
  if (email && id.emailVerified) {
    // A password account is linked only once its email has been confirmed. Otherwise someone could
    // sign up with another person's email and wait for them to arrive via Google.
    const cred = await db(deps).credentials.get(email);
    if (cred) {
      const owner = await db(deps).users.get(cred.userId);
      if (!owner?.emailVerified) throw new HttpError(409, "That email already has a password. Sign in with your email and password, then confirm your email to use Google too.", "exists");
      const linked = { ...owner, googleSub: id.subject };
      await db(deps).users.put(linked);
      return linked;
    }
    // Same email from Sign in with Apple (confirmed by Apple)? Link Google to that account.
    const byEmail = (await db(deps).users.find({ email }))[0] ?? null;
    if (byEmail) {
      const linked = { ...byEmail, googleSub: id.subject };
      await db(deps).users.put(linked);
      return linked;
    }
  }
  const user = newUser(deps, { googleSub: id.subject, email: id.emailVerified ? email : null, emailVerified: !!(email && id.emailVerified), name: id.name?.trim().slice(0, 80) || "Player" });
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
  // A failed email must not block sign-up: the player can ask for the link again from Profile.
  await sendVerification(deps, user).catch(() => undefined);
  return user;
}

// ---------- password reset and email confirmation ----------

const RESET_TTL = 30 * 60;
const VERIFY_TTL = 7 * 24 * 60 * 60;
const RESEND_AFTER_MS = 60_000;

/** True if this kind of email may go to this address now (at most one a minute). */
async function mayEmail(deps: Deps, kind: string, email: string): Promise<boolean> {
  const id = `${kind}:${email}`;
  const last = await db(deps).emailThrottle.get(id);
  const now = deps.now();
  if (last && now.getTime() - Date.parse(last.at) < RESEND_AFTER_MS) return false;
  await db(deps).emailThrottle.put({ id, at: now.toISOString() });
  return true;
}

function emailBody(title: string, line: string, button: string, url: string, footer: string) {
  const text = `${title}\n\n${line}\n\n${url}\n\n${footer}`;
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0A0F24"><h2 style="margin:0 0 12px">${title}</h2><p style="font-size:16px;line-height:1.5">${line}</p><p><a href="${url}" style="display:inline-block;background:#0A0F24;color:#D4FF3A;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:700">${button}</a></p><p style="font-size:13px;color:#555">${footer}</p></div>`;
  return { text, html };
}

/** Links are only handed back in the response where no real email goes out (local development and demo mode). */
const devLink = (deps: Deps, url: string) => (deps.config.allowDevAuth && !deps.email.live ? url : undefined);

/**
 * Starts a password reset. Always answers the same way, whether or not the email has an account,
 * so this can't be used to find out who has signed up.
 */
export async function forgotPassword(deps: Deps, email: string): Promise<{ ok: true; devLink?: string }> {
  const e = email.trim().toLowerCase();
  const cred = EMAIL.test(e) ? await db(deps).credentials.get(e) : null;
  if (!cred || !(await mayEmail(deps, "reset", e))) return { ok: true };
  const t = await signJwt({ sub: cred.userId, purpose: "pw_reset", v: cred.hash.slice(0, 12) }, deps.config.jwtSecret, RESET_TTL, deps.now().getTime());
  const url = `${deps.config.webAppUrl}#/reset?t=${encodeURIComponent(t)}`;
  const body = emailBody("Reset your PickleHeat password", "Someone asked to reset the password for this email. If it was you, choose a new password with the button below. The link works once and expires in 30 minutes.", "Choose a new password", url, "If you didn't ask for this, you can ignore this email. Your password stays the same.");
  await deps.email.send({ to: e, subject: "Reset your PickleHeat password", ...body }).catch(() => undefined);
  return { ok: true, devLink: devLink(deps, url) };
}

export async function resetPassword(deps: Deps, token: string, password: string): Promise<User> {
  const expired = () => new HttpError(401, "This reset link has expired or was already used. Ask for a new one.", "expired");
  const claims = await verifyJwt(token, deps.config.jwtSecret, "pw_reset", deps.now().getTime());
  if (!claims?.v) throw expired();
  const user = await db(deps).users.get(claims.sub);
  const cred = user?.email ? await db(deps).credentials.get(user.email.toLowerCase()) : null;
  // The link carries a fingerprint of the old password, so it stops working the moment the password changes.
  if (!user || !cred || cred.userId !== user.id || cred.hash.slice(0, 12) !== claims.v) throw expired();
  if (password.length < 8) throw new HttpError(422, "Use at least 8 characters for your password", "invalid");
  const h = await hashPassword(password);
  await db(deps).credentials.put({ ...cred, salt: h.salt, hash: h.hash });
  // Opening the link proves they own the email. Everyone signed in with the old password is signed out.
  const updated: User = { ...user, emailVerified: true, sessionsValidFrom: Math.floor(deps.now().getTime() / 1000) };
  await db(deps).users.put(updated);
  return updated;
}

/** Sends (or re-sends) the "confirm your email" link to a password account. */
export async function sendVerification(deps: Deps, user: User): Promise<{ ok: true; sent: boolean; devLink?: string }> {
  if (!user.email || user.emailVerified) return { ok: true, sent: false };
  const e = user.email.toLowerCase();
  if (!(await mayEmail(deps, "verify", e))) return { ok: true, sent: false };
  const t = await signJwt({ sub: user.id, purpose: "email_verify", v: e }, deps.config.jwtSecret, VERIFY_TTL, deps.now().getTime());
  const url = `${deps.config.webAppUrl}#/verify?t=${encodeURIComponent(t)}`;
  const body = emailBody("Confirm your email", "Welcome to PickleHeat. Confirm this is your email so you can reset your password if you ever forget it.", "Confirm my email", url, "If you didn't create a PickleHeat account, you can ignore this email.");
  await deps.email.send({ to: e, subject: "Confirm your email for PickleHeat", ...body });
  return { ok: true, sent: true, devLink: devLink(deps, url) };
}

export async function verifyEmail(deps: Deps, token: string): Promise<User> {
  const claims = await verifyJwt(token, deps.config.jwtSecret, "email_verify", deps.now().getTime());
  const user = claims ? await db(deps).users.get(claims.sub) : null;
  if (!claims || !user || user.email?.toLowerCase() !== claims.v) throw new HttpError(401, "This confirmation link has expired. Ask for a new one from your profile.", "expired");
  if (user.emailVerified) return user;
  const updated: User = { ...user, emailVerified: true };
  await db(deps).users.put(updated);
  return updated;
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
