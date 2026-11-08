import SwiftUI

struct EventsView: View {
    @EnvironmentObject var model: AppModel
    @State private var tab = 0
    @State private var creating: EventKind?

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                Picker("Show", selection: $tab) {
                    Text("For you").tag(0)
                    Text("My events").tag(1)
                }
                .pickerStyle(.segmented)

                if tab == 0 { recommended } else { mine }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 24)
        }
        .screenBackground()
        .navigationTitle("Events")
        .navigationDestination(for: String.self) { EventDetailView(eventID: $0) }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("New league", systemImage: "person.2.fill") { creating = .league }
                    Button("New tournament", systemImage: "trophy.fill") { creating = .tournament }
                } label: { Image(systemName: "plus.circle.fill").font(.system(size: 22)) }
                .accessibilityLabel("Create event")
            }
        }
        .sheet(item: $creating) { kind in
            NavigationStack { CreateEventView(kind: kind) }
        }
        .refreshable {
            await model.loadRecommendations()
            await model.loadEvents()
        }
        .onChange(of: model.eventToOpen) { _, id in
            if id != nil {
                tab = 1
                Task { await model.loadEvents() }
                model.eventToOpen = nil
            }
        }
    }

    @ViewBuilder private var recommended: some View {
        if let payload = model.recommendations {
            if payload.recommendations.isEmpty {
                Text("No open tournaments within \(Int(model.me?.user.maxDistanceMiles ?? 75)) miles fit your rating right now. Try a bigger search distance in Profile.")
                    .font(.system(size: 15)).foregroundStyle(Theme.muted).card()
            } else {
                ForEach(payload.recommendations) { RecommendationCard(rec: $0) }
            }
            sourcesNote(payload.sources)
        } else if model.me?.user.lat == nil {
            VStack(alignment: .leading, spacing: 12) {
                Text("Where do you play?").font(Theme.display(20))
                Text("PickleHeat finds tournaments near you that fit your DUPR rating.").foregroundStyle(Theme.muted)
                Button("Use my location") { Task { await model.useCurrentLocation() } }.buttonStyle(PrimaryButtonStyle())
            }
            .card()
        } else {
            ProgressView().padding(.top, 40).task { await model.loadRecommendations() }
        }
    }

    private func sourcesNote(_ sources: [SourceStatus]) -> some View {
        let live = sources.filter { $0.ok }.map(\.name)
        return Text("Searched: \(live.joined(separator: ", ")). PickleballTournaments and FluidPB appear here once their data access is switched on.")
            .font(.footnote).foregroundStyle(Theme.muted)
    }

    @ViewBuilder private var mine: some View {
        if model.myEvents.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("No events yet").font(Theme.display(20))
                Text("Start a league with your regular group, or run a tournament and collect entry fees.").foregroundStyle(Theme.muted)
                HStack {
                    Button("New league") { creating = .league }.buttonStyle(SecondaryButtonStyle())
                    Button("New tournament") { creating = .tournament }.buttonStyle(PrimaryButtonStyle())
                }
            }
            .card()
        } else {
            ForEach(model.myEvents) { ev in
                NavigationLink(value: ev.id) { EventRow(event: ev, userID: model.userID) }.buttonStyle(.plain)
            }
        }
    }
}

struct EventDetailView: View {
    @EnvironmentObject var model: AppModel
    let eventID: String
    @State private var detail: EventDetail?
    @State private var scoring: EventMatch?
    @State private var registering = false

    init(eventID: String) {
        self.eventID = eventID
    }

    var body: some View {
        ScrollView {
            if let d = detail {
                VStack(spacing: 16) {
                    hero(d.event)
                    actions(d)
                    if let money = d.money { organizerMoney(money, d) }
                    if !d.matches.isEmpty { standings(d) }
                    if !d.matches.isEmpty { schedule(d) }
                    teams(d)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            } else {
                ProgressView().padding(.top, 80)
            }
        }
        .screenBackground()
        .navigationTitle(detail?.event.name ?? "Event")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $scoring) { m in
            if let d = detail { ScoreEntryView(match: m, detail: d) { await load() } }
        }
        .sheet(isPresented: $registering) {
            if let d = detail { NavigationStack { RegisterView(event: d.event) { await load() } } }
        }
    }

    private func load() async {
        do { detail = try await model.service.event(id: eventID) } catch { model.errorMessage = error.localizedDescription }
    }

    private func hero(_ e: PickleHeatEvent) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("\(e.kind.title.uppercased()) · \(e.format.title.uppercased())").font(.system(size: 11, weight: .heavy)).tracking(1.4)
            Text(e.name).font(Theme.display(30)).tracking(-0.5)
            HStack(spacing: 8) {
                Pill(text: DateText.pretty(e.startDate), fg: Theme.text)
                Pill(text: "DUPR \(e.ratingRangeText)", fg: Theme.text)
                if e.feeCents > 0 { Pill(text: "\(money(e.feeCents))/player", fg: Theme.text) }
            }
            if !e.place.isEmpty { Text(e.place).font(.system(size: 14, weight: .semibold)) }
            Text(e.status.title).font(.system(size: 13, weight: .bold))
        }
        .foregroundStyle(Theme.ink)
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(e.kind == .league ? Theme.lime : Theme.coral, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
    }

    @ViewBuilder private func actions(_ d: EventDetail) -> some View {
        let e = d.event
        let mine = d.myEntry(userID: model.userID)
        if d.isOrganizer {
            if e.status == .draft {
                if e.feeCents > 0 && !(model.me?.payouts.ready ?? false) {
                    Button("Link payout account") { Task { await model.linkPayouts() } }.buttonStyle(SecondaryButtonStyle())
                }
                Button("Open registration") {
                    Task { await model.run { _ = try await model.service.publish(eventID: e.id); await load(); await model.loadEvents() } }
                }
                .buttonStyle(PrimaryButtonStyle())
            } else if d.matches.isEmpty && (e.status == .open || e.status == .closed) {
                Button(e.kind == .league ? "Build season schedule" : "Build pools & schedule") {
                    Task { await model.run { _ = try await model.service.generateSchedule(eventID: e.id); await load() } }
                }
                .buttonStyle(PrimaryButtonStyle())
            }
        }
        if mine == nil && e.status == .open && !d.isOrganizer {
            Button(e.feeCents > 0 ? "Register · \(money(e.feeCents * (e.format == .singles ? 1 : 2)))" : "Register") { registering = true }
                .buttonStyle(PrimaryButtonStyle())
        } else if let mine {
            Label(mine.status == .pendingPayment ? "Payment pending: \(mine.teamName)" : "You're in: \(mine.teamName)", systemImage: mine.status == .pendingPayment ? "clock.fill" : "checkmark.seal.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(mine.status == .pendingPayment ? Theme.coral : Theme.lime)
                .card(padding: 14, radius: 16)
        }
    }

    private func organizerMoney(_ m: Money, _ d: EventDetail) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("Collected").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted)
                Text(money(m.collectedCents)).font(Theme.display(26))
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text("Teams").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted)
                Text("\(d.entries.filter { $0.status == .confirmed }.count) / \(d.event.capacity)").font(Theme.display(26))
            }
        }
        .card()
    }

    private func standings(_ d: EventDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Standings")
            ForEach(Array(d.standings.enumerated()), id: \.offset) { _, pool in
                VStack(alignment: .leading, spacing: 8) {
                    if let p = pool.pool { Text("Pool \(p)").font(.system(size: 12, weight: .heavy)).foregroundStyle(Theme.muted) }
                    ForEach(Array(pool.table.enumerated()), id: \.element.id) { i, row in
                        HStack {
                            Text("\(i + 1)").font(Theme.display(15)).foregroundStyle(Theme.muted).frame(width: 22, alignment: .leading)
                            Text(d.teamName(row.entrant)).font(.system(size: 15, weight: d.entry(row.entrant)?.playerIds.contains(model.userID) == true ? .bold : .regular))
                            Spacer()
                            Text("\(row.wins)–\(row.losses)").font(.system(size: 15, weight: .semibold)).monospacedDigit()
                            Text(row.diff >= 0 ? "+\(row.diff)" : "\(row.diff)").font(.system(size: 13)).foregroundStyle(Theme.muted).frame(width: 40, alignment: .trailing).monospacedDigit()
                        }
                    }
                }
                .card()
            }
        }
    }

    private func schedule(_ d: EventDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: d.event.kind == .league ? "Season" : "Matches")
            ForEach(d.matches) { m in
                Button { scoring = m } label: {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(d.event.kind == .league ? "Week" : "Round") \(m.round)\(m.pool.map { " · Pool \($0)" } ?? "")\(m.court.map { " · \($0)" } ?? "")")
                                .font(.system(size: 11, weight: .heavy)).foregroundStyle(Theme.muted)
                            Text("\(d.teamName(m.homeEntryId))  vs  \(d.teamName(m.awayEntryId))").font(.system(size: 14, weight: .semibold)).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        VStack(alignment: .trailing, spacing: 3) {
                            Text(m.games.isEmpty ? "Enter score" : m.games.map { "\($0.us)–\($0.them)" }.joined(separator: ", "))
                                .font(.system(size: 13, weight: .bold)).monospacedDigit()
                                .foregroundStyle(m.games.isEmpty ? Theme.lime : Theme.text)
                            Text(statusText(m)).font(.system(size: 11)).foregroundStyle(m.duprError != nil ? Theme.coral : Theme.muted)
                        }
                    }
                    .card(padding: 12, radius: 16)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func statusText(_ m: EventMatch) -> String {
        if m.duprError != nil { return "DUPR: waiting on player links" }
        switch m.status {
        case .scheduled: return "Not played"
        case .reported: return "Awaiting confirmation"
        case .confirmed: return m.duprMatchId != nil ? "Sent to DUPR ✓" : "Confirmed"
        }
    }

    private func teams(_ d: EventDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Teams (\(d.entries.filter { $0.status == .confirmed }.count))")
            ForEach(d.entries.filter { $0.status != .withdrawn }) { e in
                HStack {
                    Text(e.teamName).font(.system(size: 15))
                    Spacer()
                    Text(ratingText(e.teamRating)).font(.system(size: 14, weight: .semibold)).monospacedDigit().foregroundStyle(Theme.muted)
                    if e.status == .pendingPayment { Image(systemName: "clock").foregroundStyle(Theme.coral) }
                }
            }
        }
        .card()
    }
}
