import SwiftUI

// MARK: navigation routes (shared by every tab's NavigationStack)

struct EventRoute: Hashable { let id: String }
struct ClubRoute: Hashable { let id: String }
struct ChatRoute: Hashable { let id: String }

extension View {
    func appDestinations() -> some View {
        navigationDestination(for: EventRoute.self) { EventDetailView(eventID: $0.id) }
            .navigationDestination(for: ClubRoute.self) { ClubDetailView(clubID: $0.id) }
            .navigationDestination(for: ChatRoute.self) { ChatView(chatID: $0.id) }
    }
}

// MARK: match card

/// One match: teams, score, status, and the action that's due (enter, confirm).
struct MatchCard: View {
    @EnvironmentObject var model: AppModel
    let match: EventMatch
    let players: Players
    var homeName: String? = nil
    var awayName: String? = nil
    var tags: [String] = []
    var canManage: Bool = false
    var onChange: () async -> Void

    @State private var scoring = false

    init(match: EventMatch, players: Players, homeName: String? = nil, awayName: String? = nil, tags: [String] = [], canManage: Bool = false, onChange: @escaping () async -> Void) {
        self.match = match
        self.players = players
        self.homeName = homeName
        self.awayName = awayName
        self.tags = tags
        self.canManage = canManage
        self.onChange = onChange
    }

    private var me: String { model.userID }
    private var mySide: String? { match.side(of: me) }
    private var reporterSide: String? { match.reportedBy.flatMap { match.side(of: $0) } }
    private var canEnter: Bool { match.ready && (mySide != nil || canManage) && (match.status != .confirmed || (canManage && match.bracket == nil)) }
    private var canConfirm: Bool { match.status == .reported && ((mySide != nil && mySide != reporterSide) || canManage) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(match.label ?? "Match").font(.system(size: 11, weight: .heavy)).tracking(0.8).foregroundStyle(Theme.muted)
                ForEach(tags, id: \.self) { tag in
                    Text(tagTitle(tag)).font(.system(size: 10, weight: .bold)).padding(.horizontal, 6).padding(.vertical, 2)
                        .foregroundStyle(Theme.ink).background(tagColor(tag), in: Capsule())
                }
                Spacer()
                Text(statusText).font(.system(size: 11, weight: .semibold)).foregroundStyle(canManage && match.duprStatus == "failed" ? Theme.coral : Theme.muted)
            }
            teamRow(name: homeName ?? names(match.homePlayers), side: "home")
            teamRow(name: awayName ?? names(match.awayPlayers), side: "away")
            if let lines = match.lines, !lines.isEmpty, lines.contains(where: { !$0.games.isEmpty }) {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                        HStack {
                            Text(l.label).font(.system(size: 12)).foregroundStyle(Theme.muted)
                            Spacer()
                            Text(l.games.map { "\($0.us)–\($0.them)" }.joined(separator: " ")).font(.system(size: 12, weight: .semibold)).monospacedDigit()
                        }
                    }
                }
            }
            if canConfirm || canEnter {
                HStack(spacing: 10) {
                    if canConfirm {
                        Button("Confirm \(match.scoreText)") { Task { await model.run { _ = try await model.api.confirmScore(match.id); await onChange() } } }
                            .buttonStyle(PrimaryButtonStyle())
                    }
                    if canEnter {
                        Button(match.games.isEmpty && (match.lines?.allSatisfy { $0.games.isEmpty } ?? true) ? "Enter score" : "Edit score") { scoring = true }
                            .buttonStyle(SecondaryButtonStyle())
                    }
                }
            }
        }
        .card(padding: 14, radius: 18)
        .sheet(isPresented: $scoring) {
            ScoreSheet(match: match, players: players, homeName: homeName ?? names(match.homePlayers), awayName: awayName ?? names(match.awayPlayers)) { await onChange() }
        }
    }

    private func names(_ ids: [String]) -> String {
        ids.isEmpty ? (match.homeDead || match.awayDead ? "Bye" : "TBD") : ids.map { players.first($0) }.joined(separator: " & ")
    }

    private func teamRow(name: String, side: String) -> some View {
        let won = winner == side
        let games = match.lines?.isEmpty == false ? [] : match.games
        return HStack {
            Text(name).font(.system(size: 15, weight: won || mySide == side ? .bold : .regular)).lineLimit(1)
            if won { Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.lime).font(.system(size: 13)) }
            Spacer()
            ForEach(Array(games.enumerated()), id: \.offset) { _, g in
                Text("\(side == "home" ? g.us : g.them)").font(Theme.display(17)).monospacedDigit().frame(minWidth: 24)
                    .foregroundStyle((side == "home" ? g.us > g.them : g.them > g.us) ? Theme.text : Theme.muted)
            }
        }
    }

    private var winner: String? {
        guard match.status == .confirmed else { return nil }
        if let lines = match.lines, !lines.isEmpty {
            var h = 0, a = 0
            for l in lines {
                let hw = l.games.filter { $0.us > $0.them }.count, aw = l.games.filter { $0.them > $0.us }.count
                if hw > aw { h += 1 } else if aw > hw { a += 1 }
            }
            return h == a ? nil : (h > a ? "home" : "away")
        }
        let h = match.games.filter { $0.us > $0.them }.count, a = match.games.filter { $0.them > $0.us }.count
        if h != a { return h > a ? "home" : "away" }
        let ph = match.games.reduce(0) { $0 + $1.us }, pa = match.games.reduce(0) { $0 + $1.them }
        return ph == pa ? nil : (ph > pa ? "home" : "away")
    }

    private var statusText: String {
        switch match.status {
        case .scheduled: return match.ready ? "Not played" : "Waiting"
        case .reported: return canConfirm && mySide != nil ? "Confirm this score" : "Awaiting confirmation"
        case .confirmed:
            switch match.duprStatus {
            case "submitted": return "Sent to DUPR ✓"
            case "ready": return canManage ? "Ready for DUPR" : "Final · organizer reviews before DUPR"
            case "failed": return canManage ? "DUPR didn't accept it yet" : "Final · organizer reviews before DUPR"
            case "skipped": return "Final · not sent to DUPR"
            default: return "Final"
            }
        }
    }

    private func tagTitle(_ t: String) -> String { t == "upset" ? "UPSET" : t == "nailbiter" ? "NAILBITER" : "SMACKDOWN" }
    private func tagColor(_ t: String) -> Color { t == "upset" ? Theme.coral : t == "nailbiter" ? Theme.sky : Theme.lime }
}

// MARK: DUPR review (organizers)

/// Confirmed results wait here. Nothing goes to DUPR until the organizer sends it.
struct DuprReviewView: View {
    @EnvironmentObject var model: AppModel
    let detail: EventDetail
    var onChange: () async -> Void

    @State private var queue: ReviewQueue?
    @State private var loadError: String?
    @State private var confirmSendAll = false
    @State private var deleting: ReviewQueue.Item?
    @State private var takingBack: ReviewQueue.Item?

    private struct Group: Identifiable {
        let id: String
        let title: String
        let hint: String?
    }

    private static let sections: [Group] = [
        Group(id: "failed", title: "Needs attention", hint: "You sent these, but DUPR hasn't accepted them. PickleHeat retries every hour."),
        Group(id: "ready", title: "Ready to send", hint: nil),
        Group(id: "skipped", title: "Not sent", hint: "These count in PickleHeat but stay off DUPR."),
        Group(id: "submitted", title: "On DUPR", hint: nil),
        Group(id: "not_rated", title: "Not rated by DUPR", hint: nil),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let q = queue {
                    summary(q)
                    ForEach(Self.sections) { group in
                        section(group, q)
                    }
                } else if let loadError {
                    EmptyState(title: "Couldn't load the review queue", message: loadError)
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 80)
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 28)
        }
        .screenBackground()
        .navigationTitle("DUPR review")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .confirmationDialog("Send \(waiting) reviewed result\(waiting == 1 ? "" : "s") to DUPR?", isPresented: $confirmSendAll, titleVisibility: .visible) {
            Button("Send to DUPR") { act { queue = try await model.api.submitAllToDupr(detail.event.id) } }
        }
        .confirmationDialog("Delete this result?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete result", role: .destructive) {
                if let id = deleting?.match.id { act { _ = try await model.api.deleteResult(id) } }
            }
        } message: {
            Text("The match goes back to not played, and anything sent to DUPR is taken back.")
        }
        .confirmationDialog("Take this result back from DUPR?", isPresented: Binding(get: { takingBack != nil }, set: { if !$0 { takingBack = nil } }), titleVisibility: .visible) {
            Button("Take back from DUPR", role: .destructive) {
                if let id = takingBack?.match.id { act { _ = try await model.api.withdrawFromDupr(id) } }
            }
        } message: {
            Text("The score still counts in PickleHeat.")
        }
    }

    private var waiting: Int { (queue?.counts.ready ?? 0) + (queue?.counts.failed ?? 0) }

    private func load() async {
        do {
            queue = try await model.api.reviewQueue(detail.event.id)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func act(_ work: @escaping () async throws -> Void) {
        Task {
            await model.run {
                try await work()
                await load()
                await onChange()
            }
        }
    }

    private func summary(_ q: ReviewQueue) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Players enter and confirm scores. Nothing is sent to DUPR until you send it here. Check each result, fix or delete anything that's wrong, then send.")
                .font(.system(size: 14)).foregroundStyle(Theme.muted)
            HStack {
                count(q.counts.ready, "ready")
                count(q.counts.failed, "need attention")
                count(q.counts.submitted, "on DUPR")
            }
            if waiting > 0 {
                Button("Send all \(waiting) to DUPR") { confirmSendAll = true }
                    .buttonStyle(PrimaryButtonStyle())
                    .accessibilityIdentifier("duprSendAll")
            } else {
                Text("Nothing is waiting right now.").font(.system(size: 14)).foregroundStyle(Theme.muted)
            }
        }
        .card()
    }

    private func count(_ value: Int, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(value)").font(Theme.display(20)).monospacedDigit()
            Text(label).font(.system(size: 12)).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func label(_ item: ReviewQueue.Item) -> String {
        if detail.event.style.individual {
            let round = "Round \(item.roundNumber ?? item.match.round)"
            if let g = item.groupNumber { return "\(round) · Heat \(g)" }
            return round
        }
        return item.match.label ?? "Round \(item.roundNumber ?? item.match.round)"
    }

    @ViewBuilder private func section(_ group: Group, _ q: ReviewQueue) -> some View {
        let items = q.items.filter { $0.status == group.id }
        if !items.isEmpty {
            Text("\(group.title) (\(items.count))").font(Theme.display(17)).padding(.top, 4)
            if let hint = group.hint { Text(hint).font(.system(size: 13)).foregroundStyle(Theme.muted) }
            ForEach(items) { item in row(item, q) }
        }
    }

    private func labeled(_ item: ReviewQueue.Item) -> EventMatch {
        var m = item.match
        m.label = label(item)
        return m
    }

    private func row(_ item: ReviewQueue.Item, _ q: ReviewQueue) -> some View {
        let m = labeled(item)
        return VStack(alignment: .leading, spacing: 8) {
            MatchCard(match: m, players: q.players,
                      homeName: m.homeEntryId.map { detail.teamName($0) }, awayName: m.awayEntryId.map { detail.teamName($0) },
                      canManage: true) { await load(); await onChange() }
            if item.status == "failed", let err = item.match.duprError {
                Text(err).font(.system(size: 13)).foregroundStyle(Theme.coral)
            }
            if !item.missingDupr.isEmpty && item.status != "submitted" {
                Text("Not connected to DUPR yet: \(item.missingDupr.map { q.players.name($0) }.joined(separator: ", "))")
                    .font(.system(size: 13)).foregroundStyle(Theme.coral)
            }
            HStack(spacing: 10) {
                if item.status == "ready" || item.status == "failed" {
                    Button(item.status == "failed" ? "Try again" : "Send to DUPR") { act { _ = try await model.api.submitToDupr(item.match.id) } }
                        .buttonStyle(PrimaryButtonStyle())
                    Button("Don't send") { act { _ = try await model.api.withdrawFromDupr(item.match.id) } }
                        .buttonStyle(SecondaryButtonStyle())
                } else if item.status == "skipped" {
                    Button("Send to DUPR") { act { _ = try await model.api.submitToDupr(item.match.id) } }
                        .buttonStyle(SecondaryButtonStyle())
                } else if item.status == "submitted" {
                    Button("Take back from DUPR") { takingBack = item }
                        .buttonStyle(SecondaryButtonStyle())
                }
            }
            Button("Delete result", role: .destructive) { deleting = item }
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.coral)
        }
    }
}

// MARK: score entry

/// Enter games (or MLP/trips lines). Left number = first-named team.
struct ScoreSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let match: EventMatch
    let players: Players
    let homeName: String
    let awayName: String
    var onDone: () async -> Void

    @State private var games: [GameScore]
    @State private var lines: [[GameScore]]

    init(match: EventMatch, players: Players, homeName: String, awayName: String, onDone: @escaping () async -> Void) {
        self.match = match
        self.players = players
        self.homeName = homeName
        self.awayName = awayName
        self.onDone = onDone
        let defaultGames = match.roundId != nil ? 2 : 1
        _games = State(initialValue: match.games.isEmpty ? Array(repeating: GameScore(us: 11, them: 0), count: defaultGames) : match.games)
        _lines = State(initialValue: (match.lines ?? []).map { $0.games.isEmpty ? [GameScore(us: 21, them: 0)] : $0.games })
    }

    private var usesLines: Bool { !(match.lines ?? []).isEmpty }
    private var valid: Bool {
        usesLines ? lines.allSatisfy { $0.allSatisfy { $0.us != $0.them } } : !games.isEmpty && games.allSatisfy { $0.us != $0.them }
    }

    var body: some View {
        NavigationStack {
            Form {
                if usesLines {
                    ForEach(Array((match.lines ?? []).enumerated()), id: \.offset) { i, line in
                        Section(line.label) {
                            Text("\(line.homePlayers.map { players.first($0) }.joined(separator: " & ")) vs \(line.awayPlayers.map { players.first($0) }.joined(separator: " & "))")
                                .font(.footnote).foregroundStyle(Theme.muted)
                            ForEach(lines[i].indices, id: \.self) { g in
                                ScoreRow(label: lines[i].count > 1 ? "Game \(g + 1)" : "Score", score: $lines[i][g], max: 30)
                            }
                        }
                    }
                } else {
                    Section {
                        ForEach(games.indices, id: \.self) { i in
                            ScoreRow(label: "Game \(i + 1)", score: $games[i], max: 30)
                        }
                        if games.count < 5 { Button("Add game") { games.append(GameScore(us: 0, them: 11)) } }
                        if games.count > 1 { Button("Remove last game", role: .destructive) { games.removeLast() } }
                    } header: {
                        Text("\(homeName)  vs  \(awayName)")
                    } footer: {
                        Text("Left number = \(homeName). The other team confirms it. The organizer reviews results before they go to DUPR.")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.ink.ignoresSafeArea())
            .navigationTitle("Score")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Submit") { Task { await save() } }.bold().disabled(!valid || model.busy)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func save() async {
        await model.run {
            let saved: EventMatch
            if usesLines {
                saved = try await model.api.reportLines(match.id, lines: lines)
            } else {
                saved = try await model.api.reportScore(match.id, games: games)
            }
            if let l = saved.lines, l.count > (match.lines?.count ?? 0), saved.status == .scheduled {
                model.notice = "It's 2–2. Play the DreamBreaker, then enter its score."
            }
            await onDone()
            dismiss()
        }
    }
}

struct ScoreRow: View {
    let label: String
    @Binding var score: GameScore
    var max: Int

    var body: some View {
        HStack {
            Text(label).foregroundStyle(Theme.muted)
            Spacer()
            Stepper("", value: $score.us, in: 0...max).labelsHidden()
            Text("\(score.us)").font(Theme.display(20)).monospacedDigit().frame(width: 32)
            Text("–")
            Text("\(score.them)").font(Theme.display(20)).monospacedDigit().frame(width: 32)
            Stepper("", value: $score.them, in: 0...max).labelsHidden()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(score.us) to \(score.them)")
    }
}
