import SwiftUI

struct HomeView: View {
    @EnvironmentObject var model: AppModel
    @State private var creating: EventKind?
    @State private var showNotifications = false

    private var me: Me? { model.me }

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                header
                ratingCard
                liveSection
                quickActions
                clubsSection
                eventsSection
                picksSection
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 24)
        }
        .screenBackground()
        .refreshable { await model.refreshAll() }
        .toolbar(.hidden, for: .navigationBar)
        .appDestinations()
        .onAppear { takePendingCreate() }
        .onChange(of: model.pendingCreate) { _, _ in takePendingCreate() }
        .sheet(item: $creating) { kind in
            NavigationStack { CreateEventView(kind: kind) }
        }
        .sheet(isPresented: $showNotifications) {
            NavigationStack { NotificationsView() }
        }
    }

    private func takePendingCreate() {
        guard let k = model.pendingCreate else { return }
        creating = k
        model.pendingCreate = nil
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(Date().formatted(.dateTime.weekday(.wide).month().day())).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.muted)
                Text("Hey, \(me?.user.name.split(separator: " ").first.map(String.init) ?? "there")").font(Theme.display(30))
            }
            Spacer()
            if model.isDemo { Pill(text: "Demo", fg: Theme.ink, bg: Theme.sky) }
            Button { showNotifications = true } label: {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: "bell.fill").font(.system(size: 18)).foregroundStyle(Theme.text)
                        .frame(width: 44, height: 44).background(Theme.surface, in: Circle())
                    Badge(count: me?.unread.notifications ?? 0).offset(x: 4, y: -2)
                }
            }
            .accessibilityLabel("Notifications, \(me?.unread.notifications ?? 0) unread")
        }
        .padding(.top, 12)
    }

    private var ratingCard: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 6) {
                Text("DUPR DOUBLES").font(.system(size: 11, weight: .heavy)).tracking(1.4)
                Text(ratingText(me?.dupr.doublesRating)).font(Theme.display(56)).monospacedDigit()
                if let rel = me?.dupr.doublesReliability { Pill(text: "Reliability \(Int(rel))%") }
                Text("Singles \(ratingText(me?.dupr.singlesRating)) · \(me?.dupr.duprId ?? "")").font(.system(size: 13, weight: .semibold))
            }
            Spacer()
            if let f = me?.form {
                Button { model.selectedTab = .insights } label: { FormRing(score: f.score, label: f.label.rawValue) }
                    .buttonStyle(.plain)
            } else {
                VStack {
                    Image(systemName: "hourglass").font(.system(size: 30, weight: .bold))
                    Text("Form after\n3 matches").font(.system(size: 12, weight: .bold)).multilineTextAlignment(.center)
                }
                .frame(width: 128)
            }
        }
        .foregroundStyle(Theme.ink)
        .padding(20)
        .background(Theme.lime, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
    }

    @ViewBuilder private var liveSection: some View {
        if let live = model.live, !live.items.isEmpty {
            VStack(spacing: 10) {
                SectionHeader(title: "Live matches")
                ForEach(live.items.prefix(4)) { item in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            NavigationLink(value: EventRoute(id: item.eventId)) {
                                Text(item.eventName + (item.roundNumber.map { " · Round \($0)" } ?? "") + (item.groupNumber.map { " · Heat \($0)" } ?? ""))
                                    .font(.system(size: 12, weight: .bold)).foregroundStyle(Theme.coral).lineLimit(1)
                            }
                            Spacer()
                            if let chat = item.chatId {
                                NavigationLink(value: ChatRoute(id: chat)) {
                                    Label("Chat", systemImage: "bubble.left.fill").font(.system(size: 12, weight: .semibold))
                                }
                            }
                        }
                        MatchCard(match: item.match, players: live.players) { await model.loadHome() }
                    }
                }
            }
        }
    }

    private var quickActions: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible())], spacing: 12) {
            action("person.3.fill", Theme.lime, "Create league") { creating = .league }
            action("trophy.fill", Theme.coral, "Create tournament") { creating = .tournament }
            action("magnifyingglass", Theme.sky, "Find events") { model.selectedTab = .events }
            action("chart.bar.fill", Theme.text, "My insights") { model.selectedTab = .insights }
        }
    }

    private func action(_ icon: String, _ color: Color, _ title: String, _ go: @escaping () -> Void) -> some View {
        Button(action: go) {
            VStack(alignment: .leading, spacing: 14) {
                IconTile(systemName: icon, color: color)
                Text(title).font(.system(size: 15, weight: .semibold))
            }
            .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
            .card()
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private var clubsSection: some View {
        let mine = (model.discover?.clubs ?? []).filter { $0.myRole != nil }
        VStack(spacing: 10) {
            SectionHeader(title: "My clubs", action: "All clubs") { model.selectedTab = .events }
            if mine.isEmpty {
                EmptyState(title: "No clubs yet", message: "Join a club to see its leagues and tournaments, and get member prices.")
            }
            ForEach(mine) { c in
                NavigationLink(value: ClubRoute(id: c.club.id)) { ClubRow(summary: c) }.buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder private var eventsSection: some View {
        let live = model.myEvents.filter { $0.event.status != .completed }
        VStack(spacing: 10) {
            SectionHeader(title: "My leagues & tournaments", action: "See all") { model.selectedTab = .events }
            if live.isEmpty {
                EmptyState(title: "Nothing yet", message: "Join a Heat Climb near you or create one for your group.")
            }
            ForEach(live.prefix(5)) { c in
                NavigationLink(value: EventRoute(id: c.event.id)) { EventCardRow(card: c, userID: model.userID) }.buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder private var picksSection: some View {
        let open = (model.discover?.events ?? []).filter { $0.myStatus == nil }.prefix(2)
        let recs = (model.recommendations?.recommendations ?? []).prefix(2)
        if !open.isEmpty || !recs.isEmpty {
            VStack(spacing: 10) {
                SectionHeader(title: "Picked for you", action: "More") { model.selectedTab = .events }
                ForEach(Array(open)) { c in
                    NavigationLink(value: EventRoute(id: c.event.id)) { EventCardRow(card: c, userID: model.userID) }.buttonStyle(.plain)
                }
                ForEach(Array(recs)) { RecommendationCard(rec: $0) }
            }
        }
    }
}

struct EventCardRow: View {
    let card: EventCard
    let userID: String

    var body: some View {
        let e = card.event
        HStack(spacing: 12) {
            IconTile(systemName: e.style.individual ? "person.3.fill" : e.kind == .league ? "person.2.fill" : "trophy.fill", color: e.kind == .league ? Theme.lime : Theme.coral)
            VStack(alignment: .leading, spacing: 3) {
                Text(e.name).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                Text([e.style.title, DateText.pretty(e.startDate), card.clubName].compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 13)).foregroundStyle(Theme.muted).lineLimit(1)
                HStack(spacing: 6) {
                    if let s = card.myStatus { Pill(text: s.title, fg: s == .confirmed ? Theme.lime : Theme.coral, bg: Theme.surface2) }
                    else if e.status == .open { Pill(text: card.myPriceCents > 0 ? money(card.myPriceCents) : "Free", fg: Theme.text, bg: Theme.surface2) }
                    Text("\(card.entryCount)/\(e.capacity)\(card.waitlistCount > 0 ? " · \(card.waitlistCount) waitlist" : "")").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    if e.organizerId == userID { Text("· Organizer").font(.system(size: 12)).foregroundStyle(Theme.muted) }
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").foregroundStyle(Theme.muted)
        }
        .card(padding: 14, radius: 18)
    }
}

struct ClubRow: View {
    let summary: ClubSummary

    var body: some View {
        HStack(spacing: 12) {
            Text(String(summary.club.name.prefix(1))).font(Theme.display(18)).foregroundStyle(Theme.ink)
                .frame(width: 40, height: 40).background(Theme.sky, in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(summary.club.name).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                    if let r = summary.myRole { Pill(text: r.title.uppercased(), fg: Theme.ink, bg: r == .member ? Theme.muted : Theme.lime) }
                }
                Text("\(summary.memberCount) members · \(summary.leagueCount) leagues · \(summary.tournamentCount) tournaments\(summary.distanceMiles.map { " · \(Int($0)) mi" } ?? "")")
                    .font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").foregroundStyle(Theme.muted)
        }
        .card(padding: 14, radius: 18)
    }
}

struct RecommendationCard: View {
    let rec: Recommendation

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(rec.tournament.source == "sample" ? "SAMPLE" : rec.tournament.source.uppercased())
                    .font(.system(size: 11, weight: .heavy)).tracking(1).foregroundStyle(Theme.coral)
                Spacer()
                Text(DateText.pretty(rec.tournament.startDate)).font(.system(size: 13)).foregroundStyle(Theme.muted)
            }
            Text(rec.tournament.name).font(Theme.display(19))
            Text("\(rec.event.name) · \(rec.tournament.city), \(rec.tournament.state)").font(.system(size: 14)).foregroundStyle(Theme.muted)
            VStack(alignment: .leading, spacing: 6) {
                ForEach(rec.reasons, id: \.self) { r in
                    Label(r, systemImage: r.contains("hot form") ? "flame.fill" : "checkmark.circle.fill")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(r.contains("hot form") ? Theme.coral : Theme.text)
                }
            }
            HStack {
                if let fee = rec.event.feeCents { Text(money(fee)).font(.system(size: 15, weight: .bold)) }
                Spacer()
                if let s = rec.tournament.url, let url = URL(string: s) {
                    Link("View", destination: url).font(.system(size: 14, weight: .bold)).foregroundStyle(Theme.lime)
                } else {
                    Text("\(Int((rec.score * 100).rounded()))% match").font(.system(size: 13, weight: .bold)).foregroundStyle(Theme.lime)
                }
            }
        }
        .card()
    }
}

struct NotificationsView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var items: [AppNotification] = []
    @State private var loaded = false

    var body: some View {
        List {
            if loaded && items.isEmpty {
                Text("You're all caught up.").foregroundStyle(Theme.muted).listRowBackground(Theme.surface)
            }
            ForEach(items) { n in
                Button {
                    if let link = n.link {
                        dismiss()
                        model.open(link: link)
                    }
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Circle().fill(n.read ? Color.clear : Theme.coral).frame(width: 8, height: 8).padding(.top, 6)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(n.title).font(.system(size: 15, weight: .semibold))
                            Text(n.body).font(.system(size: 14)).foregroundStyle(Theme.muted)
                            Text(relativeTime(n.createdAt)).font(.system(size: 12)).foregroundStyle(Theme.muted)
                        }
                    }
                }
                .buttonStyle(.plain)
                .listRowBackground(Theme.surface)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.ink.ignoresSafeArea())
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        .task {
            items = (try? await model.api.notifications()) ?? []
            loaded = true
            try? await model.api.markAllRead()
            await model.refreshMe()
        }
    }
}
