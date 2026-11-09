// Organizer imports: paste a list of players (name, email, DUPR ID). When a listed player signs
// up or connects DUPR, they're added to the event automatically (no payment: the organizer comped them).

import { db } from "../db";
import { HttpError } from "../http";
import { INDIVIDUAL_STYLES, type Deps, type Entry, type Invite } from "../ports";
import { notify } from "./social";

export interface InviteRow {
  name: string;
  email: string | null;
  duprId: string | null;
}

/** Accepts "name, email, DUPR ID" lines (any order of email / DUPR ID; header row optional). */
export function parseInviteCsv(text: string): InviteRow[] {
  const rows: InviteRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const cells = raw.split(/[,\t;]/).map((c) => c.trim().replace(/^"|"$/g, "")).filter(Boolean);
    if (!cells.length) continue;
    if (/^name$/i.test(cells[0])) continue;
    const email = cells.find((c) => /@/.test(c)) ?? null;
    const dupr = cells.find((c) => c !== email && /^[A-Z0-9]{5,8}$/i.test(c) && /\d/.test(c)) ?? null;
    const name = cells.find((c) => c !== email && c !== dupr) ?? email ?? dupr ?? "";
    if (!name) continue;
    rows.push({ name: name.slice(0, 80), email: email?.toLowerCase() ?? null, duprId: dupr?.toUpperCase() ?? null });
  }
  return rows.slice(0, 500);
}

export async function addInvites(deps: Deps, eventId: string, rows: InviteRow[]): Promise<{ added: number; joinedNow: number }> {
  if (!rows.length) throw new HttpError(422, "No players found. Use one line per player: name, email, DUPR ID", "invalid");
  const existing = await db(deps).invites.find({ eventId });
  let added = 0;
  for (const r of rows) {
    if (existing.some((x) => (r.email && x.email === r.email) || (r.duprId && x.duprId === r.duprId))) continue;
    const inv: Invite = { id: deps.newId(), eventId, name: r.name, email: r.email, duprId: r.duprId, status: "pending", createdAt: deps.now().toISOString() };
    await db(deps).invites.put(inv);
    added++;
  }
  // Players who already have accounts join right away.
  let joinedNow = 0;
  for (const inv of await db(deps).invites.find({ eventId, status: "pending" })) {
    const userId = await findUserFor(deps, inv);
    if (userId && (await joinFromInvite(deps, inv, userId))) joinedNow++;
  }
  return { added, joinedNow };
}

async function findUserFor(deps: Deps, inv: Invite): Promise<string | null> {
  if (inv.email) {
    const cred = await db(deps).credentials.get(inv.email);
    if (cred) return cred.userId;
    const u = (await db(deps).users.find({ email: inv.email }))[0];
    if (u) return u.id;
  }
  if (inv.duprId) {
    const l = (await db(deps).dupr.find({ duprId: inv.duprId }))[0];
    if (l) return l.userId;
  }
  return null;
}

async function joinFromInvite(deps: Deps, inv: Invite, userId: string): Promise<boolean> {
  const ev = await db(deps).events.get(inv.eventId);
  if (!ev) return false;
  await db(deps).invites.put({ ...inv, status: "joined" });
  const entries = await db(deps).entries.find({ eventId: ev.id });
  if (entries.some((e) => e.playerIds.includes(userId) && e.status !== "withdrawn" && e.status !== "refunded")) return false;
  if (INDIVIDUAL_STYLES.includes(ev.style)) {
    const entry: Entry = { id: deps.newId(), eventId: ev.id, playerIds: [userId], teamName: (await db(deps).users.get(userId))?.name ?? inv.name, teamRating: (await db(deps).dupr.get(userId))?.doublesRating ?? null, status: "confirmed", comped: true, createdAt: deps.now().toISOString() };
    await db(deps).entries.put(entry);
    if (!ev.ladder.includes(userId)) await db(deps).events.put({ ...ev, ladder: [...ev.ladder, userId] });
    const chat = (await db(deps).chats.find({ eventId: ev.id, kind: "event" }))[0];
    if (chat && !chat.memberIds.includes(userId)) await db(deps).chats.put({ ...chat, memberIds: [...chat.memberIds, userId] });
    await notify(deps, [userId], { kind: "invite_joined", title: `You're in ${ev.name}`, body: "The organizer added you. See your schedule in the app.", link: `events/${ev.id}` });
  } else {
    await notify(deps, [userId], { kind: "invite", title: `You're invited to ${ev.name}`, body: "Register your team from the event page.", link: `events/${ev.id}` });
  }
  return true;
}

/** Called when someone signs up or connects DUPR. */
export async function applyInvitesForUser(deps: Deps, userId: string): Promise<void> {
  const user = await db(deps).users.get(userId);
  const link = await db(deps).dupr.get(userId);
  const matches: Invite[] = [];
  if (user?.email) matches.push(...(await db(deps).invites.find({ email: user.email.toLowerCase(), status: "pending" })));
  if (link?.duprId) matches.push(...(await db(deps).invites.find({ duprId: link.duprId, status: "pending" })));
  const seen = new Set<string>();
  for (const inv of matches) {
    if (seen.has(inv.id)) continue;
    seen.add(inv.id);
    await joinFromInvite(deps, inv, userId);
  }
}
