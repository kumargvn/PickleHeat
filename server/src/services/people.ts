// Players, clubs and who may manage what.

import { distanceMiles } from "../domain/recommend";
import { db } from "../db";
import { HttpError } from "../http";
import type { Club, ClubMember, ClubRole, Deps, PickleHeatEvent } from "../ports";
import { addChatMembers, createChat, removeChatMember } from "./social";

export interface PlayerInfo {
  id: string;
  name: string;
  gender: "m" | "f" | null;
  duprId: string | null;
  rating: number | null; // doubles
  singlesRating: number | null;
  reliability: number | null; // doubles reliability, 0..100
}

export async function playerInfo(deps: Deps, ids: Iterable<string>): Promise<Record<string, PlayerInfo>> {
  const out: Record<string, PlayerInfo> = {};
  for (const id of new Set(ids)) {
    const u = await db(deps).users.get(id);
    const l = await db(deps).dupr.get(id);
    out[id] = {
      id,
      name: u?.name ?? "Player",
      gender: u?.gender ?? null,
      duprId: l?.duprId ?? null,
      rating: l?.doublesRating ?? null,
      singlesRating: l?.singlesRating ?? null,
      reliability: l?.doublesReliability ?? null,
    };
  }
  return out;
}

export async function ratingOf(deps: Deps, userId: string, singles = false): Promise<number | null> {
  const l = await db(deps).dupr.get(userId);
  if (!l) return null;
  return singles ? l.singlesRating ?? l.doublesRating : l.doublesRating ?? l.singlesRating;
}

// ---------- clubs ----------

export async function clubRole(deps: Deps, clubId: string | null, userId: string): Promise<ClubRole | null> {
  if (!clubId) return null;
  return (await db(deps).members.get(`${clubId}:${userId}`))?.role ?? null;
}

export async function canManage(deps: Deps, ev: PickleHeatEvent, userId: string): Promise<boolean> {
  if (ev.organizerId === userId) return true;
  const role = await clubRole(deps, ev.clubId, userId);
  return role === "owner" || role === "admin";
}

export async function requireManager(deps: Deps, ev: PickleHeatEvent, userId: string): Promise<void> {
  if (!(await canManage(deps, ev, userId))) throw new HttpError(403, "Only the organizer or a club admin can do that", "forbidden");
}

export async function clubChat(deps: Deps, clubId: string) {
  return (await db(deps).chats.find({ clubId, kind: "club" }))[0] ?? null;
}

export async function createClub(deps: Deps, userId: string, c: Pick<Club, "name" | "description" | "city" | "state" | "lat" | "lng">): Promise<Club> {
  const now = deps.now().toISOString();
  const club: Club = { id: deps.newId(), ...c, createdBy: userId, createdAt: now };
  await db(deps).clubs.put(club);
  await db(deps).members.put({ id: `${club.id}:${userId}`, clubId: club.id, userId, role: "owner", joinedAt: now });
  await createChat(deps, { kind: "club", title: club.name, memberIds: [userId], clubId: club.id });
  return club;
}

export async function joinClub(deps: Deps, clubId: string, userId: string): Promise<ClubMember> {
  const club = await db(deps).clubs.get(clubId);
  if (!club) throw new HttpError(404, "Club not found", "not_found");
  const existing = await db(deps).members.get(`${clubId}:${userId}`);
  if (existing) return existing;
  const m: ClubMember = { id: `${clubId}:${userId}`, clubId, userId, role: "member", joinedAt: deps.now().toISOString() };
  await db(deps).members.put(m);
  const chat = await clubChat(deps, clubId);
  if (chat) await addChatMembers(deps, chat.id, [userId]);
  return m;
}

export async function leaveClub(deps: Deps, clubId: string, userId: string): Promise<void> {
  const m = await db(deps).members.get(`${clubId}:${userId}`);
  if (!m) return;
  if (m.role === "owner") {
    const owners = (await db(deps).members.find({ clubId, role: "owner" })).length;
    if (owners <= 1) throw new HttpError(409, "Make someone else an owner before you leave", "last_owner");
  }
  await db(deps).members.delete(m.id);
  const chat = await clubChat(deps, clubId);
  if (chat) await removeChatMember(deps, chat.id, userId);
}

export async function setRole(deps: Deps, clubId: string, actorId: string, userId: string, role: ClubRole): Promise<ClubMember> {
  const actor = await clubRole(deps, clubId, actorId);
  if (actor !== "owner" && actor !== "admin") throw new HttpError(403, "Only club owners and admins can change roles", "forbidden");
  if (role === "owner" && actor !== "owner") throw new HttpError(403, "Only an owner can add owners", "forbidden");
  const m = await db(deps).members.get(`${clubId}:${userId}`);
  if (!m) throw new HttpError(404, "Not a member", "not_found");
  if (m.role === "owner" && role !== "owner" && (await db(deps).members.find({ clubId, role: "owner" })).length <= 1) {
    throw new HttpError(409, "A club needs at least one owner", "last_owner");
  }
  const updated = { ...m, role };
  await db(deps).members.put(updated);
  return updated;
}

export interface ClubSummary {
  club: Club;
  memberCount: number;
  leagueCount: number;
  tournamentCount: number;
  myRole: ClubRole | null;
  distanceMiles: number | null;
}

export async function clubSummary(deps: Deps, club: Club, userId: string, from?: { lat: number | null; lng: number | null }): Promise<ClubSummary> {
  const members = await db(deps).members.find({ clubId: club.id });
  const events = (await db(deps).events.find({ clubId: club.id })).filter((e) => e.status !== "draft");
  const dist = from?.lat != null && from?.lng != null && club.lat != null && club.lng != null ? Math.round(distanceMiles(from.lat, from.lng, club.lat, club.lng)) : null;
  return {
    club,
    memberCount: members.length,
    leagueCount: events.filter((e) => e.kind === "league").length,
    tournamentCount: events.filter((e) => e.kind === "tournament").length,
    myRole: members.find((m) => m.userId === userId)?.role ?? null,
    distanceMiles: dist,
  };
}
