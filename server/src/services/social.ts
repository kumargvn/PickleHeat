// Notifications and chat.

import { db } from "../db";
import { HttpError } from "../http";
import type { Chat, ChatKind, Deps, Message, Notification } from "../ports";

// ---------- notifications ----------

export async function notify(deps: Deps, userIds: string[], n: { kind: string; title: string; body: string; link: string | null }): Promise<void> {
  const now = deps.now().toISOString();
  for (const userId of new Set(userIds)) {
    const doc: Notification = { id: deps.newId(), userId, read: false, createdAt: now, ...n };
    await db(deps).notifications.put(doc);
  }
}

export async function listNotifications(deps: Deps, userId: string): Promise<Notification[]> {
  const all = await db(deps).notifications.find({ userId });
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
}

export async function markRead(deps: Deps, userId: string, ids: string[] | null): Promise<number> {
  let n = 0;
  for (const x of await db(deps).notifications.find({ userId, read: false })) {
    if (ids && !ids.includes(x.id)) continue;
    await db(deps).notifications.put({ ...x, read: true });
    n++;
  }
  return n;
}

// ---------- chat ----------

export async function createChat(deps: Deps, c: { kind: ChatKind; title: string; memberIds: string[]; eventId?: string | null; groupId?: string | null; clubId?: string | null }): Promise<Chat> {
  const chat: Chat = {
    id: deps.newId(),
    kind: c.kind,
    title: c.title,
    eventId: c.eventId ?? null,
    groupId: c.groupId ?? null,
    clubId: c.clubId ?? null,
    memberIds: [...new Set(c.memberIds)],
    lastMessageAt: null,
    createdAt: deps.now().toISOString(),
  };
  await db(deps).chats.put(chat);
  return chat;
}

export async function addChatMembers(deps: Deps, chatId: string, userIds: string[]): Promise<void> {
  const chat = await db(deps).chats.get(chatId);
  if (!chat) return;
  const next = [...new Set([...chat.memberIds, ...userIds])];
  if (next.length !== chat.memberIds.length) await db(deps).chats.put({ ...chat, memberIds: next });
}

export async function removeChatMember(deps: Deps, chatId: string, userId: string): Promise<void> {
  const chat = await db(deps).chats.get(chatId);
  if (!chat) return;
  await db(deps).chats.put({ ...chat, memberIds: chat.memberIds.filter((m) => m !== userId) });
}

export async function postMessage(deps: Deps, chatId: string, userId: string | null, text: string): Promise<Message> {
  const chat = await db(deps).chats.get(chatId);
  if (!chat) throw new HttpError(404, "Chat not found", "not_found");
  if (userId && !chat.memberIds.includes(userId)) throw new HttpError(403, "You're not in this chat", "forbidden");
  const clean = text.trim().slice(0, 2000);
  if (!clean) throw new HttpError(422, "Message is empty", "invalid");
  // Keep ids sortable by time so "after" queries and ordering are simple.
  const now = deps.now();
  const m: Message = { id: `${now.getTime().toString(36).padStart(10, "0")}-${deps.newId().slice(0, 8)}`, chatId, userId, text: clean, createdAt: now.toISOString(), reactions: {} };
  await db(deps).messages.put(m);
  await db(deps).chats.put({ ...chat, lastMessageAt: m.createdAt });
  if (userId) await markChatRead(deps, chatId, userId, m.createdAt);
  return m;
}

export async function react(deps: Deps, chatId: string, messageId: string, userId: string, emoji: string): Promise<Message> {
  const chat = await db(deps).chats.get(chatId);
  if (!chat || !chat.memberIds.includes(userId)) throw new HttpError(403, "You're not in this chat", "forbidden");
  const m = await db(deps).messages.get(messageId);
  if (!m || m.chatId !== chatId) throw new HttpError(404, "Message not found", "not_found");
  const e = emoji.trim().slice(0, 8);
  if (!e) throw new HttpError(422, "Pick an emoji", "invalid");
  const who = new Set(m.reactions[e] ?? []);
  if (who.has(userId)) who.delete(userId);
  else who.add(userId);
  const reactions = { ...m.reactions, [e]: [...who] };
  if (!who.size) delete reactions[e];
  const updated = { ...m, reactions };
  await db(deps).messages.put(updated);
  return updated;
}

export async function markChatRead(deps: Deps, chatId: string, userId: string, at: string): Promise<void> {
  await db(deps).reads.put({ id: `${chatId}:${userId}`, chatId, userId, at });
}

export async function messages(deps: Deps, chatId: string, userId: string, after: string | null): Promise<Message[]> {
  const chat = await db(deps).chats.get(chatId);
  if (!chat) throw new HttpError(404, "Chat not found", "not_found");
  if (!chat.memberIds.includes(userId)) throw new HttpError(403, "You're not in this chat", "forbidden");
  const all = (await db(deps).messages.find({ chatId })).sort((a, b) => a.id.localeCompare(b.id));
  const list = after ? all.filter((m) => m.createdAt > after) : all.slice(-200);
  if (all.length) await markChatRead(deps, chatId, userId, all[all.length - 1].createdAt);
  return list;
}

export interface ChatSummary {
  chat: Chat;
  lastMessage: Message | null;
  unread: number;
}

export async function myChats(deps: Deps, userId: string): Promise<ChatSummary[]> {
  const chats = await db(deps).chats.find({ memberIds: [userId] });
  const out: ChatSummary[] = [];
  for (const chat of chats) {
    const msgs = (await db(deps).messages.find({ chatId: chat.id })).sort((a, b) => a.id.localeCompare(b.id));
    const read = await db(deps).reads.get(`${chat.id}:${userId}`);
    const unread = msgs.filter((m) => m.userId !== userId && (!read || m.createdAt > read.at)).length;
    out.push({ chat, lastMessage: msgs[msgs.length - 1] ?? null, unread });
  }
  return out.sort((a, b) => (b.chat.lastMessageAt ?? b.chat.createdAt).localeCompare(a.chat.lastMessageAt ?? a.chat.createdAt));
}

export async function unreadCounts(deps: Deps, userId: string): Promise<{ notifications: number; chats: number }> {
  const notifications = (await db(deps).notifications.find({ userId, read: false })).length;
  const chats = (await myChats(deps, userId)).reduce((s, c) => s + (c.unread > 0 ? 1 : 0), 0);
  return { notifications, chats };
}
