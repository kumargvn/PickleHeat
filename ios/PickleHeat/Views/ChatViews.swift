import SwiftUI

/// Every chat you're in: event chats, your heat chats, club chats and direct messages.
struct ChatsView: View {
    @EnvironmentObject var model: AppModel
    @State private var payload: ChatsPayload?

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if let p = payload {
                    if p.chats.isEmpty {
                        EmptyState(title: "No chats yet", message: "Join a league or tournament and its chat shows up here. Each Heat Climb round also gets a heat chat for setting a time and court.")
                    }
                    ForEach(p.chats) { c in
                        NavigationLink(value: ChatRoute(id: c.chat.id)) { row(c, p.players) }.buttonStyle(.plain)
                    }
                } else {
                    ProgressView().padding(.top, 60)
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 24)
        }
        .screenBackground()
        .navigationTitle("Chats")
        .appDestinations()
        .navigationDestination(item: $model.openChatID) { id in ChatView(chatID: id) }
        .task { await load() }
        .refreshable { await load() }
        .onAppear { Task { await load() } }
    }

    private func load() async {
        payload = try? await model.api.chats()
        await model.refreshMe()
    }

    private func row(_ c: ChatSummary, _ players: Players) -> some View {
        HStack(spacing: 12) {
            IconTile(systemName: icon(c.chat.kind), color: color(c.chat.kind))
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(c.chat.title).font(.system(size: 15, weight: c.unread > 0 ? .bold : .semibold)).lineLimit(1)
                    Spacer()
                    Text(relativeTime(c.lastMessage?.createdAt ?? c.chat.lastMessageAt)).font(.system(size: 11)).foregroundStyle(Theme.muted)
                }
                HStack {
                    Text(preview(c, players)).font(.system(size: 13)).foregroundStyle(Theme.muted).lineLimit(1)
                    Spacer()
                    Badge(count: c.unread)
                }
            }
        }
        .card(padding: 12, radius: 18)
    }

    private func preview(_ c: ChatSummary, _ players: Players) -> String {
        guard let m = c.lastMessage else { return "No messages yet" }
        let who = m.userId.map { $0 == model.userID ? "You" : players.first($0) } ?? "PickleHeat"
        return "\(who): \(m.text)"
    }

    private func icon(_ kind: String) -> String {
        switch kind {
        case "group": return "flame.fill"
        case "club": return "house.fill"
        case "direct": return "person.fill"
        default: return "trophy.fill"
        }
    }

    private func color(_ kind: String) -> Color {
        switch kind {
        case "group": return Theme.coral
        case "club": return Theme.sky
        case "direct": return Theme.text
        default: return Theme.lime
        }
    }
}

/// One conversation. Polls every few seconds while open.
struct ChatView: View {
    @EnvironmentObject var model: AppModel
    let chatID: String
    @State private var payload: MessagesPayload?
    @State private var draft = ""
    @State private var reacting: ChatMessage?
    private let emojis = ["👍", "🔥", "😂", "🏓", "❤️", "👏"]

    init(chatID: String) { self.chatID = chatID }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(payload?.messages ?? []) { m in bubble(m).id(m.id) }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .onChange(of: payload?.messages.last?.id) { _, id in
                    if let id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
                }
            }
            composer
        }
        .screenBackground()
        .navigationTitle(payload?.chat.title ?? "Chat")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let ev = payload?.chat.eventId {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink(value: EventRoute(id: ev)) { Image(systemName: "info.circle") }.accessibilityLabel("Open event")
                }
            }
        }
        .task {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(5))
            }
        }
        .onDisappear { Task { await model.refreshMe() } }
        .confirmationDialog("React", isPresented: Binding(get: { reacting != nil }, set: { if !$0 { reacting = nil } })) {
            ForEach(emojis, id: \.self) { e in
                Button(e) { if let m = reacting { Task { await react(m, e) } } }
            }
        }
    }

    private func load() async {
        if let p = try? await model.api.messages(chatID) { payload = p }
    }

    private var composer: some View {
        HStack(spacing: 10) {
            TextField("Message", text: $draft, axis: .vertical)
                .lineLimit(1...4)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 20))
            Button {
                Task { await send() }
            } label: {
                Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold)).foregroundStyle(Theme.ink)
                    .frame(width: 40, height: 40).background(Theme.lime, in: Circle())
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.ink)
    }

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        await model.run {
            _ = try await model.api.send(chatID, text: text)
            await load()
        }
    }

    private func react(_ m: ChatMessage, _ emoji: String) async {
        await model.run {
            _ = try await model.api.react(chatID, messageID: m.id, emoji: emoji)
            await load()
        }
    }

    @ViewBuilder private func bubble(_ m: ChatMessage) -> some View {
        let mine = m.userId == model.userID
        let bot = m.userId == nil
        if bot {
            Text(m.text).font(.system(size: 13)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                .padding(10).frame(maxWidth: .infinity).background(Theme.surface.opacity(0.6), in: RoundedRectangle(cornerRadius: 14))
        } else {
            HStack(alignment: .bottom, spacing: 8) {
                if mine { Spacer(minLength: 50) } else { Avatar(player: payload?.players[m.userId ?? ""], size: 28) }
                VStack(alignment: mine ? .trailing : .leading, spacing: 3) {
                    if !mine { Text(payload?.players.first(m.userId ?? "") ?? "").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted) }
                    Text(m.text)
                        .font(.system(size: 15))
                        .foregroundStyle(mine ? Theme.ink : Theme.text)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(mine ? Theme.lime : Theme.surface2, in: RoundedRectangle(cornerRadius: 16))
                        .onLongPressGesture { reacting = m }
                    let reactions = m.reactions.filter { !$0.value.isEmpty }.sorted { $0.key < $1.key }
                    if !reactions.isEmpty {
                        HStack(spacing: 4) {
                            ForEach(reactions, id: \.key) { r in
                                Button { Task { await react(m, r.key) } } label: {
                                    Text("\(r.key) \(r.value.count)").font(.system(size: 12))
                                        .padding(.horizontal, 6).padding(.vertical, 2)
                                        .background(r.value.contains(model.userID) ? Theme.line : Theme.surface, in: Capsule())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    Text(ISO.date(m.createdAt)?.formatted(date: .omitted, time: .shortened) ?? "").font(.system(size: 10)).foregroundStyle(Theme.muted)
                }
                if !mine { Spacer(minLength: 50) }
            }
        }
    }
}
