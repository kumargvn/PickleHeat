import SwiftUI

/// One league or tournament. Adapts to the style: Heat Climb / Wildfire Mixer show rounds, heats and
/// rankings; team events show matches, standings and the bracket.
struct EventDetailView: View {
    @EnvironmentObject var model: AppModel
    let eventID: String

    enum Pane: Hashable { case overview, round, ranks, stats, matches, standings, bracket, players }

    @State private var detail: EventDetail?
    @State private var pane: Pane = .overview
    @State private var roundID: String?
    @State private var roundView: RoundView?
    @State private var rankings: RankingsPayload?
    @State private var stats: StatsPayload?
    @State private var registering = false
    @State private var inviting = false
    @State private var confirmWithdraw = false
    @State private var loadError: String?

    init(eventID: String) { self.eventID = eventID }

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                if let d = detail {
                    header(d)
                    ChipTabs(items: panes(d), selection: $pane)
                    switch pane {
                    case .overview: overview(d)
                    case .round: roundPane(d)
                    case .ranks: ranksPane(d)
                    case .stats: statsPane(d)
                    case .matches: matchesPane(d)
                    case .standings: standingsPane(d)
                    case .bracket: bracketPane(d)
                    case .players: playersPane(d)
                    }
                } else if let loadError {
                    EmptyState(title: "Couldn't open this event", message: loadError)
                } else {
                    ProgressView().padding(.top, 80)
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 28)
        }
        .screenBackground()
        .navigationTitle(detail?.event.name ?? "Event")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let chat = detail?.chatId {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink(value: ChatRoute(id: chat)) { Image(systemName: "bubble.left.and.bubble.right.fill") }
                        .accessibilityLabel("Event chat")
                }
            }
            if let d = detail {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: URL(string: "\(AppConfig.site.absoluteString)app/#/events/\(d.event.id)") ?? AppConfig.site, subject: Text(d.event.name), message: Text("Join \(d.event.name) on PickleHeat")) {
                        Image(systemName: "square.and.arrow.up")
                    }
                }
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .onChange(of: pane) { _, p in Task { await loadPane(p) } }
        .onChange(of: roundID) { _, _ in Task { await loadRound() } }
        .sheet(isPresented: $registering) {
            if let d = detail { NavigationStack { RegisterView(detail: d) { await load() } } }
        }
        .sheet(isPresented: $inviting) {
            if let d = detail { NavigationStack { InviteView(eventID: d.event.id, invites: d.invites) { await load() } } }
        }
        .confirmationDialog("Withdraw from \(detail?.event.name ?? "this event")?", isPresented: $confirmWithdraw, titleVisibility: .visible) {
            Button("Withdraw", role: .destructive) { Task { await model.run { try await model.api.withdraw(eventID); await load(); await model.loadHome() } } }
        } message: {
            Text("Refunds are up to the organizer.")
        }
    }

    // MARK: loading

    private func load() async {
        do {
            let d = try await model.api.event(eventID)
            detail = d
            loadError = nil
            if roundID == nil { roundID = d.currentRoundId ?? d.rounds.last(where: { $0.status != .upcoming })?.id ?? d.rounds.first?.id }
            await loadPane(pane)
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func loadPane(_ p: Pane) async {
        switch p {
        case .round: await loadRound()
        case .ranks: rankings = try? await model.api.rankings(eventID)
        case .stats: stats = try? await model.api.stats(eventID)
        default: break
        }
    }

    private func loadRound() async {
        guard let roundID else { roundView = nil; return }
        roundView = try? await model.api.round(roundID)
    }

    private func refreshEverything() async {
        await load()
        await loadRound()
        await model.loadHome()
    }

    private func panes(_ d: EventDetail) -> [(Pane, String)] {
        let s = d.event.style
        if s.individual {
            return [(.overview, "Overview"), (.round, "Heats"), (.ranks, s == .flexLadder ? "Ladder" : "Standings"), (.stats, "Stats"), (.players, "Players")]
        }
        var out: [(Pane, String)] = [(.overview, "Overview"), (.matches, "Matches")]
        if s.bracket { out.append((.bracket, "Bracket")) } else { out.append((.standings, "Standings")) }
        if s == .poolsPlayoffs { out.append((.bracket, "Playoffs")) }
        out.append((.players, "Teams"))
        return out
    }

    // MARK: header

    private func header(_ d: EventDetail) -> some View {
        let e = d.event
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Pill(text: e.style.title.uppercased(), fg: Theme.ink, bg: e.kind == .league ? Theme.lime : Theme.coral)
                Pill(text: e.status.title, fg: Theme.text, bg: Theme.surface2)
                Spacer()
            }
            Text(e.name).font(Theme.display(26))
            if let club = d.club {
                NavigationLink(value: ClubRoute(id: club.id)) {
                    Label(club.name, systemImage: "house.fill").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.sky)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                info("calendar", dateLine(e))
                if !e.place.isEmpty { info("mappin.and.ellipse", e.place + (e.city.isEmpty ? "" : ", \(e.state)")) }
                info("chart.line.uptrend.xyaxis", "DUPR \(e.ratingRangeText) · \(e.format.title)")
                info("person.2.fill", "\(d.entries.count)/\(e.capacity) \(e.teamSize == 1 ? "players" : "teams")\(d.waitlist.isEmpty ? "" : " · \(d.waitlist.count) waitlist")")
                info("creditcard.fill", priceLine(d))
            }
        }
        .card()
    }

    private func info(_ icon: String, _ text: String) -> some View {
        Label { Text(text).font(.system(size: 14)) } icon: { Image(systemName: icon).foregroundStyle(Theme.muted) }
    }

    private func dateLine(_ e: PickleHeatEvent) -> String {
        var s = DateText.pretty(e.startDate)
        if let w = e.weeks, e.kind == .league { s += " · \(w) rounds, every \(e.roundDays) days" }
        else if let end = e.endDate, end != e.startDate { s += " – \(DateText.pretty(end))" }
        return s
    }

    private func priceLine(_ d: EventDetail) -> String {
        let e = d.event
        guard e.isPaid else { return "Free" }
        var s = money(e.feeCents) + " per player"
        if let m = e.memberFeeCents, m != e.feeCents { s += " · members \(money(m))" }
        return s
    }

    // MARK: overview

    @ViewBuilder private func overview(_ d: EventDetail) -> some View {
        myEntryCard(d)
        if !d.event.description.isEmpty {
            Text(d.event.description).font(.system(size: 15)).frame(maxWidth: .infinity, alignment: .leading).card()
        }
        VStack(alignment: .leading, spacing: 6) {
            Text("How it works").font(Theme.display(17))
            Text(d.event.style.blurb).font(.system(size: 14)).foregroundStyle(Theme.muted)
            if d.event.submitToDupr {
                Label("Confirmed scores are sent to DUPR", systemImage: "checkmark.seal.fill").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.lime)
            }
        }
        .card()
        if d.isManager { organizerCard(d) }
    }

    @ViewBuilder private func myEntryCard(_ d: EventDetail) -> some View {
        let e = d.event
        if let entry = d.myEntry, entry.status != .withdrawn {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(entry.status == .waitlisted ? "You're on the waitlist" : entry.status == .pendingPayment ? "Finish your registration" : "You're in")
                        .font(Theme.display(19))
                    Spacer()
                    Pill(text: entry.status.title, fg: entry.status == .confirmed ? Theme.lime : Theme.coral, bg: Theme.surface2)
                }
                if e.teamSize > 1 { Text(entry.teamName).font(.system(size: 14)).foregroundStyle(Theme.muted) }
                if entry.status == .pendingPayment {
                    Text("Entry fee \(money(d.myPriceCents)). Payment is handled on the PickleHeat website and goes to the organizer.")
                        .font(.system(size: 14)).foregroundStyle(Theme.muted)
                    Button("Pay on pickleheat.app") {
                        Task { if model.isDemo { await model.demoPay(entryID: entry.id); await load() } else { await model.openOnWeb("entries/\(entry.id)/pay") } }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                }
                if [.confirmed, .waitlisted, .pendingPayment].contains(entry.status) && e.status != .completed {
                    Button("Withdraw") { confirmWithdraw = true }.buttonStyle(SecondaryButtonStyle())
                }
            }
            .card()
        } else if e.status == .open {
            VStack(alignment: .leading, spacing: 12) {
                Text(d.entries.count >= e.capacity ? "Full: join the waitlist" : "Registration is open").font(Theme.display(19))
                Text(d.myPriceCents > 0 ? "Your price: \(money(d.myPriceCents))" : "Free to join").font(.system(size: 14)).foregroundStyle(Theme.muted)
                Button(d.entries.count >= e.capacity ? "Join waitlist" : "Register") { registering = true }.buttonStyle(PrimaryButtonStyle())
            }
            .card()
        }
    }

    @ViewBuilder private func organizerCard(_ d: EventDetail) -> some View {
        let e = d.event
        VStack(alignment: .leading, spacing: 12) {
            Text("Organizer tools").font(Theme.display(17))
            if let m = d.money, e.isPaid {
                HStack {
                    stat(money(m.collectedCents), "collected")
                    stat("\(m.paidEntries)", "paid")
                    stat("\(m.pendingEntries)", "pending")
                }
            }
            if e.status == .draft {
                if e.isPaid && model.me?.payouts.ready != true {
                    Text("Paid events need a payout account so entry fees reach you. Set it up on the PickleHeat website.").font(.system(size: 13)).foregroundStyle(Theme.muted)
                    Button("Set up payouts") { Task { await model.setUpPayouts() } }.buttonStyle(SecondaryButtonStyle())
                }
                Button("Open registration") { act { try await model.api.publish(e.id) } }.buttonStyle(PrimaryButtonStyle())
            }
            if e.style.individual {
                if e.status != .draft && e.status != .completed {
                    let running = d.rounds.first { $0.status == .inProgress }
                    let next = d.rounds.first { $0.status == .upcoming }
                    if let next {
                        Button(running == nil ? "Start round \(next.number)" : "Close round \(running!.number) & start \(next.number)") {
                            act { _ = try await model.api.startRound(e.id); pane = .round; roundID = nil }
                        }
                        .buttonStyle(PrimaryButtonStyle())
                    }
                    if let running, next == nil {
                        Button("Close final round") { act { _ = try await model.api.closeRound(running.id) } }.buttonStyle(PrimaryButtonStyle())
                    }
                }
            } else if e.status == .open || e.status == .closed {
                Button(d.matches.isEmpty ? "Build schedule" : "Rebuild schedule") { act { try await model.api.buildSchedule(e.id); pane = .matches } }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(d.entries.count < 2)
            }
            if e.status == .open {
                Button("Close registration") { act { try await model.api.closeRegistration(e.id) } }.buttonStyle(SecondaryButtonStyle())
            }
            Button("Invite players (\(d.invites.count))") { inviting = true }.buttonStyle(SecondaryButtonStyle())
        }
        .card()
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(Theme.display(20)).monospacedDigit()
            Text(label).font(.system(size: 12)).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func act(_ work: @escaping () async throws -> Void) {
        Task {
            await model.run {
                try await work()
                await refreshEverything()
            }
        }
    }

    // MARK: Heat Climb / Wildfire Mixer rounds

    @ViewBuilder private func roundPane(_ d: EventDetail) -> some View {
        if d.rounds.isEmpty {
            EmptyState(title: "No rounds yet", message: "Rounds appear once registration opens.")
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(d.rounds) { r in
                        Button { roundID = r.id } label: {
                            VStack(spacing: 2) {
                                Text("R\(r.number)").font(.system(size: 15, weight: .bold))
                                Text(r.status == .inProgress ? "LIVE" : r.status == .completed ? "DONE" : DateText.pretty(r.startDate))
                                    .font(.system(size: 9, weight: .heavy)).lineLimit(1)
                            }
                            .frame(width: 64, height: 48)
                            .foregroundStyle(roundID == r.id ? Theme.ink : Theme.text)
                            .background(roundID == r.id ? Theme.lime : Theme.surface, in: RoundedRectangle(cornerRadius: 14))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            if let rv = roundView, rv.round.id == roundID {
                roundBody(d, rv)
            } else {
                ProgressView().padding(.top, 30)
            }
        }
    }

    @ViewBuilder private func roundBody(_ d: EventDetail, _ rv: RoundView) -> some View {
        let me = model.userID
        let isPlayer = d.event.ladder.contains(me) || d.myEntry?.status == .confirmed
        HStack {
            Text("Round \(rv.round.number)").font(Theme.display(20))
            Spacer()
            Text("\(DateText.pretty(rv.round.startDate)) – \(DateText.pretty(rv.round.endDate))").font(.system(size: 13)).foregroundStyle(Theme.muted)
        }
        if rv.round.status == .upcoming && isPlayer {
            VStack(alignment: .leading, spacing: 10) {
                Text(rv.myAttendance == "declined" ? "You're sitting this one out" : "Are you playing this round?").font(Theme.display(17))
                Text(d.event.style == .flexLadder ? "If you skip, you keep your ladder spot." : "Skipping is fine; you just won't score this round.")
                    .font(.system(size: 13)).foregroundStyle(Theme.muted)
                HStack {
                    Button("I'm in") { act { _ = try await model.api.attendance(rv.round.id, going: true) } }
                        .buttonStyle(PrimaryButtonStyle(color: rv.myAttendance == "declined" ? Theme.surface2 : Theme.lime))
                    Button("Can't make it") { act { _ = try await model.api.attendance(rv.round.id, going: false) } }
                        .buttonStyle(SecondaryButtonStyle())
                }
            }
            .card()
        }
        if rv.round.byes.contains(me) {
            EmptyState(title: "You have a bye", message: "Odd numbers this round. You keep your spot.")
        }
        if let g = rv.myGroup { heatCard(d, rv, g, mine: true) }
        let openSubs = rv.subs.filter { $0.status == "open" }
        if !openSubs.isEmpty {
            SectionHeader(title: "Subs needed")
            ForEach(openSubs) { s in
                HStack {
                    Avatar(player: rv.players[s.userId])
                    VStack(alignment: .leading) {
                        Text("\(rv.players.name(s.userId)) needs a sub").font(.system(size: 15, weight: .semibold))
                        Text("Heat \(rv.groups.first(where: { $0.group.id == s.groupId })?.group.number ?? 0)").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    }
                    Spacer()
                    if s.userId == me {
                        Button("Cancel") { act { _ = try await model.api.cancelSub(s.id) } }.font(.system(size: 14, weight: .bold)).foregroundStyle(Theme.coral)
                    } else if rv.myGroupId != s.groupId {
                        Button("I'll sub") { act { _ = try await model.api.acceptSub(s.id) } }.font(.system(size: 14, weight: .bold)).foregroundStyle(Theme.lime)
                    }
                }
                .card(padding: 12, radius: 16)
            }
        }
        let others = rv.groups.filter { $0.group.id != rv.myGroupId }
        if !others.isEmpty {
            SectionHeader(title: rv.myGroup == nil ? "Heats" : "Other heats")
            ForEach(others) { g in heatCard(d, rv, g, mine: false) }
        }
        if rv.groups.isEmpty && rv.round.status == .upcoming {
            EmptyState(title: "Heats aren't set yet", message: "The organizer starts the round, then everyone gets their heat and a heat chat.")
        }
        if d.isManager && rv.round.status == .inProgress {
            Button("Close round \(rv.round.number)") { act { _ = try await model.api.closeRound(rv.round.id) } }.buttonStyle(SecondaryButtonStyle())
        }
    }

    @ViewBuilder private func heatCard(_ d: EventDetail, _ rv: RoundView, _ g: GroupView, mine: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    if mine { Text("YOUR HEAT").font(.system(size: 11, weight: .heavy)).tracking(1.2).foregroundStyle(Theme.coral) }
                    Text(mine ? "You're in Heat \(g.group.number)" : "Heat \(g.group.number)").font(Theme.display(20))
                }
                Spacer()
                if mine || d.isManager {
                    NavigationLink(value: ChatRoute(id: g.group.chatId)) {
                        Label("Heat chat", systemImage: "bubble.left.fill").font(.system(size: 13, weight: .semibold))
                    }
                }
            }
            HStack(spacing: -6) {
                ForEach(g.group.playerIds, id: \.self) { Avatar(player: rv.players[$0], size: 34, color: mine ? Theme.surface2 : Theme.line) }
                Spacer(minLength: 12)
                Text(g.group.playerIds.map { rv.players.first($0) }.joined(separator: ", ")).font(.system(size: 13)).foregroundStyle(Theme.muted).lineLimit(2)
            }
            if mine || d.isManager {
                ForEach(g.matches) { m in
                    MatchCard(match: m, players: rv.players, tags: rv.tags[m.id] ?? [], canManage: d.isManager) { await loadRound(); await model.loadHome() }
                }
            }
            if !g.standings.isEmpty {
                VStack(spacing: 6) {
                    ForEach(Array(g.standings.enumerated()), id: \.element.id) { i, s in
                        HStack {
                            Text("\(i + 1)").font(.system(size: 13, weight: .bold)).frame(width: 18).foregroundStyle(i == 0 ? Theme.lime : Theme.muted)
                            Text(rv.players.name(s.userId)).font(.system(size: 14, weight: s.userId == model.userID ? .bold : .regular))
                            Spacer()
                            Text("\(s.wins)–\(s.losses)").font(.system(size: 13, weight: .semibold)).monospacedDigit()
                            Text(s.pd >= 0 ? "+\(s.pd)" : "\(s.pd)").font(.system(size: 13)).foregroundStyle(Theme.muted).monospacedDigit().frame(width: 36, alignment: .trailing)
                        }
                    }
                }
            }
            if mine && rv.round.status != .completed && !rv.subs.contains(where: { $0.userId == model.userID && $0.status == "open" }) {
                Button("I can't play: find a sub") { act { _ = try await model.api.requestSub(rv.round.id) } }
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.coral)
            }
        }
        .card()
    }

    // MARK: ranks & stats

    @ViewBuilder private func ranksPane(_ d: EventDetail) -> some View {
        if let r = rankings {
            if r.rows.isEmpty {
                EmptyState(title: "No rankings yet", message: "Rankings appear after the first round closes.")
            } else {
                Text(r.round.map { "After round \($0)" } ?? "Starting order").font(.system(size: 13)).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, alignment: .leading)
                VStack(spacing: 0) {
                    ForEach(r.rows) { row in
                        HStack(spacing: 10) {
                            Text("\(row.rank)").font(Theme.display(17)).monospacedDigit().frame(width: 28)
                            movement(row.movement)
                            Avatar(player: r.players[row.userId], size: 32)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(r.players.name(row.userId)).font(.system(size: 15, weight: row.userId == model.userID ? .bold : .regular)).lineLimit(1)
                                Text(r.players[row.userId]?.ratingLine ?? "").font(.system(size: 11)).foregroundStyle(Theme.muted)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 1) {
                                Text(row.played ? "\(row.wins)–\(row.losses)" : "Sat out").font(.system(size: 13, weight: .semibold)).monospacedDigit()
                                if let h = row.nextGroup, d.event.style == .flexLadder { Text("→ Heat \(h)").font(.system(size: 11)).foregroundStyle(Theme.sky) }
                            }
                        }
                        .padding(.vertical, 9)
                        .padding(.horizontal, 12)
                        .background(row.userId == model.userID ? Theme.surface2 : Color.clear)
                        Divider().overlay(Theme.line)
                    }
                }
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18))
                .clipShape(RoundedRectangle(cornerRadius: 18))
            }
        } else {
            ProgressView().padding(.top, 30)
        }
    }

    @ViewBuilder private func movement(_ m: Int) -> some View {
        if m > 0 { Label("\(m)", systemImage: "arrow.up").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.lime).frame(width: 34) }
        else if m < 0 { Label("\(-m)", systemImage: "arrow.down").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.coral).frame(width: 34) }
        else { Text("–").font(.system(size: 11)).foregroundStyle(Theme.muted).frame(width: 34) }
    }

    @ViewBuilder private func statsPane(_ d: EventDetail) -> some View {
        if let s = stats {
            if s.rows.isEmpty {
                EmptyState(title: "No stats yet", message: "Stats build up as scores are confirmed.")
            } else {
                HStack {
                    Text("Player").frame(maxWidth: .infinity, alignment: .leading)
                    Text("W–L").frame(width: 50)
                    Text("PD").frame(width: 40)
                    Text("DUPR±").frame(width: 50)
                }
                .font(.system(size: 11, weight: .heavy)).foregroundStyle(Theme.muted)
                ForEach(s.rows) { row in
                    HStack {
                        Text(s.players.name(row.userId)).font(.system(size: 14, weight: row.userId == model.userID ? .bold : .regular)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                        Text("\(row.wins)–\(row.losses)").frame(width: 50)
                        Text(row.pd >= 0 ? "+\(row.pd)" : "\(row.pd)").frame(width: 40)
                        Text(row.ratingChange.map { String(format: "%+.2f", $0) } ?? "—").frame(width: 50)
                            .foregroundStyle((row.ratingChange ?? 0) > 0 ? Theme.lime : (row.ratingChange ?? 0) < 0 ? Theme.coral : Theme.muted)
                    }
                    .font(.system(size: 13)).monospacedDigit()
                    .padding(.vertical, 6)
                }
                .padding(.horizontal, 4)
            }
        } else {
            ProgressView().padding(.top, 30)
        }
    }

    // MARK: team events

    @ViewBuilder private func matchesPane(_ d: EventDetail) -> some View {
        if d.matches.isEmpty {
            EmptyState(title: "No matches yet", message: d.isManager ? "Build the schedule from Overview once teams are in." : "The organizer posts the schedule once registration closes.")
        } else {
            let mine = d.matches.filter { $0.includes(model.userID) && $0.status != .confirmed && $0.ready }
            if !mine.isEmpty {
                SectionHeader(title: "Your next matches")
                ForEach(mine) { teamMatch(d, $0) }
            }
            let rounds = Array(Set(d.matches.filter { $0.bracket == nil }.map(\.round))).sorted()
            ForEach(rounds, id: \.self) { r in
                SectionHeader(title: d.event.kind == .league ? "Week \(r)" : "Round \(r)")
                ForEach(d.matches.filter { $0.bracket == nil && $0.round == r }) { teamMatch(d, $0) }
            }
            let bracket = d.matches.filter { $0.bracket != nil && !($0.homeDead && $0.awayDead) }
            if !bracket.isEmpty && rounds.isEmpty {
                ForEach(bracket.sorted { ($0.bracket!.side, $0.bracket!.round, $0.bracket!.slot) < ($1.bracket!.side, $1.bracket!.round, $1.bracket!.slot) }) { teamMatch(d, $0) }
            }
        }
    }

    private func teamMatch(_ d: EventDetail, _ m: EventMatch) -> some View {
        MatchCard(match: m, players: d.players, homeName: m.homeEntryId.map { d.teamName($0) }, awayName: m.awayEntryId.map { d.teamName($0) }, canManage: d.isManager) {
            await load()
            await model.loadHome()
        }
    }

    @ViewBuilder private func standingsPane(_ d: EventDetail) -> some View {
        if d.standings.isEmpty || d.standings.allSatisfy({ $0.table.isEmpty }) {
            EmptyState(title: "No standings yet", message: "Standings fill in as scores are confirmed.")
        }
        ForEach(Array(d.standings.enumerated()), id: \.offset) { _, pool in
            VStack(alignment: .leading, spacing: 8) {
                if let p = pool.pool { Text("Pool \(p)").font(Theme.display(17)) }
                HStack {
                    Text("Team").frame(maxWidth: .infinity, alignment: .leading)
                    Text("W–L").frame(width: 50)
                    Text("PD").frame(width: 44)
                }
                .font(.system(size: 11, weight: .heavy)).foregroundStyle(Theme.muted)
                ForEach(Array(pool.table.enumerated()), id: \.element.id) { i, s in
                    HStack {
                        Text("\(i + 1). \(d.teamName(s.entrant))").font(.system(size: 14, weight: d.myEntry?.id == s.entrant ? .bold : .regular)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                        Text("\(s.wins)–\(s.losses)").frame(width: 50)
                        Text(s.diff >= 0 ? "+\(s.diff)" : "\(s.diff)").frame(width: 44)
                    }
                    .font(.system(size: 14)).monospacedDigit()
                }
            }
            .card()
        }
    }

    @ViewBuilder private func bracketPane(_ d: EventDetail) -> some View {
        let bracket = d.matches.filter { $0.bracket != nil }
        if bracket.isEmpty {
            EmptyState(title: "No bracket yet", message: d.event.style == .poolsPlayoffs ? "Playoffs are drawn when pool play finishes." : "The bracket is drawn when the organizer builds the schedule.")
        } else {
            ForEach(["W", "L", "GF"], id: \.self) { side in
                let ms = bracket.filter { $0.bracket?.side == side && !($0.homeDead && $0.awayDead) }
                if !ms.isEmpty {
                    Text(side == "W" ? (d.event.style == .doubleElim ? "Winners bracket" : "Bracket") : side == "L" ? "Losers bracket" : "Grand final")
                        .font(Theme.display(18)).frame(maxWidth: .infinity, alignment: .leading)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(alignment: .top, spacing: 12) {
                            ForEach(Array(Set(ms.compactMap { $0.bracket?.round })).sorted(), id: \.self) { r in
                                VStack(spacing: 10) {
                                    ForEach(ms.filter { $0.bracket?.round == r }.sorted { ($0.bracket?.slot ?? 0) < ($1.bracket?.slot ?? 0) }) { m in
                                        teamMatch(d, m).frame(width: 260)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: players / teams

    @ViewBuilder private func playersPane(_ d: EventDetail) -> some View {
        let e = d.event
        SectionHeader(title: e.teamSize == 1 ? "\(d.entries.count) players" : "\(d.entries.count) teams")
        ForEach(d.entries) { entry in entryRow(d, entry) }
        if !d.waitlist.isEmpty {
            SectionHeader(title: "Waitlist")
            ForEach(d.waitlist) { entry in entryRow(d, entry) }
        }
    }

    private func entryRow(_ d: EventDetail, _ entry: Entry) -> some View {
        HStack(spacing: 10) {
            HStack(spacing: -8) { ForEach(entry.playerIds, id: \.self) { Avatar(player: d.players[$0], size: 34) } }
            VStack(alignment: .leading, spacing: 2) {
                Text(d.event.teamSize == 1 ? d.players.name(entry.playerIds.first ?? "") : entry.teamName).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                Text(entry.playerIds.map { d.players[$0]?.ratingLine ?? "" }.joined(separator: " · ")).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer()
            if d.isManager {
                Menu {
                    Text(entry.status.title + (entry.comped ? " · comped" : ""))
                    if entry.status == .confirmed && d.event.isPaid && !entry.comped {
                        Button("Refund & remove", role: .destructive) { act { try await model.api.refund(d.event.id, entryID: entry.id) } }
                    }
                } label: { Image(systemName: "ellipsis.circle").foregroundStyle(Theme.muted) }
            } else if entry.status != .confirmed {
                Text(entry.status.title).font(.system(size: 12)).foregroundStyle(Theme.coral)
            }
        }
        .card(padding: 12, radius: 16)
    }
}
