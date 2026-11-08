import SwiftUI

/// Create a league or tournament. Saves as a draft, then (optionally) opens registration.
struct CreateEventView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var draft: EventDraft
    @State private var date = Date().addingTimeInterval(8 * 86_400)
    @State private var fee: Double
    @State private var minRating = 3.5
    @State private var maxRating = 4.25
    @State private var openNow = true

    init(kind: EventKind) {
        let d = EventDraft.sample(kind: kind)
        _draft = State(initialValue: EventDraft(kind: kind, name: "", format: .doubles, startDate: d.startDate, weeks: d.weeks, venue: "", city: "", state: "", lat: nil, lng: nil, minRating: 3.5, maxRating: 4.25, capacity: d.capacity, feeCents: d.feeCents, requireDuprVerified: true, submitToDupr: true))
        _fee = State(initialValue: Double(d.feeCents) / 100)
    }

    var body: some View {
        Form {
            Section {
                Picker("Type", selection: $draft.kind) {
                    ForEach(EventKind.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                TextField(draft.kind == .league ? "League name" : "Tournament name", text: $draft.name)
                Picker("Format", selection: $draft.format) {
                    ForEach(EventFormat.allCases) { Text($0.title).tag($0) }
                }
                DatePicker(draft.kind == .league ? "First week" : "Date", selection: $date, in: Date()..., displayedComponents: .date)
                if draft.kind == .league {
                    Stepper("Weeks: \(draft.weeks ?? 8)", value: Binding(get: { draft.weeks ?? 8 }, set: { draft.weeks = $0 }), in: 1...26)
                }
                Stepper("\(draft.format == .singles ? "Players" : "Teams"): \(draft.capacity)", value: $draft.capacity, in: 2...128)
            }

            Section("Where") {
                TextField("Venue", text: $draft.venue)
                TextField("City", text: $draft.city)
                TextField("State", text: $draft.state)
            }

            Section {
                HStack {
                    Text("DUPR range")
                    Spacer()
                    Text(String(format: "%.2f – %.2f", minRating, maxRating)).foregroundStyle(Theme.lime).monospacedDigit()
                }
                Slider(value: $minRating, in: 2...6, step: 0.25) { Text("Minimum") }
                    .onChange(of: minRating) { _, v in if v > maxRating { maxRating = v } }
                Slider(value: $maxRating, in: 2...6, step: 0.25) { Text("Maximum") }
                    .onChange(of: maxRating) { _, v in if v < minRating { minRating = v } }
                Toggle("Send results to DUPR", isOn: $draft.submitToDupr)
                Toggle("DUPR-connected players only", isOn: $draft.requireDuprVerified)
            } header: { Text("Rating") } footer: { Text("Results go to DUPR once both teams confirm the score. Every player needs a connected DUPR account for that.") }

            Section {
                HStack {
                    Text("Entry fee per player")
                    Spacer()
                    TextField("0", value: $fee, format: .currency(code: "USD")).keyboardType(.decimalPad).multilineTextAlignment(.trailing).frame(width: 110)
                }
                if fee > 0 {
                    HStack {
                        Image(systemName: model.me?.payouts.ready == true ? "checkmark.circle.fill" : "building.columns.fill")
                            .foregroundStyle(model.me?.payouts.ready == true ? Theme.lime : Theme.coral)
                        Text(model.me?.payouts.ready == true ? "Fees go to your linked account" : "Link the bank account that receives fees")
                        Spacer()
                        if model.me?.payouts.ready != true {
                            Button("Link") { Task { await model.linkPayouts() } }.bold()
                        }
                    }
                }
                Toggle("Open registration now", isOn: $openNow)
            } header: { Text("Payment") } footer: { Text("Players pay by card or Apple Pay through Stripe. Money goes straight to the organizer's linked account.") }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.ink.ignoresSafeArea())
        .navigationTitle(draft.kind == .league ? "New league" : "New tournament")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Create") { Task { await create() } }
                    .bold()
                    .disabled(draft.name.trimmingCharacters(in: .whitespaces).isEmpty || model.busy)
            }
        }
        .onChange(of: draft.kind) { _, k in
            draft.weeks = k == .league ? (draft.weeks ?? 8) : nil
        }
    }

    private func create() async {
        var d = draft
        d.name = d.name.trimmingCharacters(in: .whitespaces)
        d.startDate = DateText.string(date)
        d.feeCents = Int((fee * 100).rounded())
        d.minRating = minRating
        d.maxRating = maxRating
        let place = [d.venue, d.city, d.state].filter { !$0.isEmpty }.joined(separator: ", ")
        if let c = await LocationProvider.geocode(place) {
            d.lat = c.latitude
            d.lng = c.longitude
        }
        await model.run {
            let ev = try await model.service.createEvent(d)
            if openNow {
                if d.feeCents > 0 && model.me?.payouts.ready != true {
                    model.errorMessage = "Saved as a draft. Link your payout account, then open registration from the event page."
                } else {
                    _ = try await model.service.publish(eventID: ev.id)
                }
            }
            await model.loadEvents()
            model.selectedTab = .events
            dismiss()
        }
    }
}

/// Register for an event: pick a partner by DUPR ID, check eligibility, pay.
struct RegisterView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let event: PickleHeatEvent
    var onDone: () async -> Void
    @State private var partnerDupr = ""
    @State private var teamName = ""

    init(event: PickleHeatEvent, onDone: @escaping () async -> Void) {
        self.event = event
        self.onDone = onDone
    }

    private var myRating: Double? {
        event.format == .singles ? (model.me?.dupr.singlesRating ?? model.me?.dupr.doublesRating) : model.me?.dupr.doublesRating
    }

    private var fits: Bool {
        guard let r = myRating else { return false }
        return (event.minRating.map { r >= $0 } ?? true) && (event.maxRating.map { r <= $0 } ?? true)
    }

    private var total: Int { event.feeCents * (event.format == .singles ? 1 : 2) }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("\(event.kind.title.uppercased()) · \(event.format.title.uppercased())").font(.system(size: 11, weight: .heavy)).tracking(1.4)
                    Text(event.name).font(Theme.display(28))
                    HStack {
                        Pill(text: DateText.pretty(event.startDate), fg: Theme.text)
                        Pill(text: "DUPR \(event.ratingRangeText)", fg: Theme.text)
                    }
                }
                .foregroundStyle(Theme.ink)
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.coral, in: RoundedRectangle(cornerRadius: 24, style: .continuous))

                HStack(spacing: 12) {
                    Image(systemName: fits ? "checkmark.circle.fill" : "exclamationmark.triangle.fill").foregroundStyle(fits ? Theme.lime : Theme.coral)
                    Text(fits ? "Your DUPR \(ratingText(myRating)) fits the range" : "Your DUPR \(ratingText(myRating)) is outside this event's range")
                }
                .card(padding: 14, radius: 16)

                if event.format != .singles {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Partner's DUPR ID").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.muted)
                        TextField(model.isDemo ? "Try DEMO-PK01" : "e.g. ABC123", text: $partnerDupr)
                            .textInputAutocapitalization(.characters).autocorrectionDisabled()
                            .padding(14).background(Theme.surface2, in: RoundedRectangle(cornerRadius: 14))
                        Text("Your partner needs PickleHeat with DUPR connected.").font(.footnote).foregroundStyle(Theme.muted)
                        TextField("Team name (optional)", text: $teamName)
                            .padding(14).background(Theme.surface2, in: RoundedRectangle(cornerRadius: 14))
                    }
                    .card()
                }

                if event.feeCents > 0 {
                    VStack(spacing: 10) {
                        HStack { Text("Entry fee").foregroundStyle(Theme.muted); Spacer(); Text("\(money(event.feeCents)) × \(event.format == .singles ? 1 : 2)") }
                        Divider().overlay(Theme.line)
                        HStack { Text("Total").bold(); Spacer(); Text(money(total)).font(Theme.display(20)) }
                        Text("Paid securely through Stripe to the organizer's account. Refunds follow the organizer's policy.").font(.footnote).foregroundStyle(Theme.muted)
                    }
                    .card()
                }

                Button {
                    Task { await submit() }
                } label: {
                    if model.busy { ProgressView().tint(Theme.ink) } else { Text(event.feeCents > 0 ? "Continue to payment" : "Register") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(!fits || (event.format != .singles && partnerDupr.trimmingCharacters(in: .whitespaces).isEmpty))
            }
            .padding(20)
        }
        .screenBackground()
        .navigationTitle("Join event")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
    }

    private func submit() async {
        await model.run {
            let r = try await model.service.register(eventID: event.id, partnerDuprID: event.format == .singles ? nil : partnerDupr, teamName: teamName.isEmpty ? nil : teamName)
            if let s = r.checkoutUrl, let url = URL(string: s) {
                _ = try await model.web.open(url)
            }
            await onDone()
            await model.loadEvents()
            dismiss()
        }
    }
}

/// Enter or confirm a match score. Games are from the first-named team's side.
struct ScoreEntryView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let match: EventMatch
    let detail: EventDetail
    var onDone: () async -> Void
    @State private var games: [GameScore]

    init(match: EventMatch, detail: EventDetail, onDone: @escaping () async -> Void) {
        self.match = match
        self.detail = detail
        self.onDone = onDone
        _games = State(initialValue: match.games.isEmpty ? [GameScore(us: 11, them: 0)] : match.games)
    }

    private var home: String { detail.teamName(match.homeEntryId) }
    private var away: String { detail.teamName(match.awayEntryId) }
    private var amIn: Bool { [match.homeEntryId, match.awayEntryId].compactMap { detail.entry($0) }.contains { $0.playerIds.contains(model.userID) } }
    private var canConfirm: Bool {
        guard match.status == .reported, let reporter = match.reportedBy else { return false }
        if detail.isOrganizer { return true }
        let side: (String) -> String? = { uid in
            detail.entry(match.homeEntryId)?.playerIds.contains(uid) == true ? "home" : detail.entry(match.awayEntryId)?.playerIds.contains(uid) == true ? "away" : nil
        }
        return side(model.userID) != nil && side(model.userID) != side(reporter)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(games.indices, id: \.self) { i in
                        HStack {
                            Text("Game \(i + 1)").foregroundStyle(Theme.muted)
                            Spacer()
                            Stepper(value: $games[i].us, in: 0...30) { Text("\(games[i].us)").font(Theme.display(20)).monospacedDigit() }.labelsHidden()
                            Text("\(games[i].us)").font(Theme.display(20)).monospacedDigit().frame(width: 30)
                            Text("–")
                            Text("\(games[i].them)").font(Theme.display(20)).monospacedDigit().frame(width: 30)
                            Stepper(value: $games[i].them, in: 0...30) { Text("\(games[i].them)") }.labelsHidden()
                        }
                    }
                    if games.count < 3 { Button("Add game") { games.append(GameScore(us: 0, them: 11)) } }
                    if games.count > 1 { Button("Remove last game", role: .destructive) { games.removeLast() } }
                } header: {
                    Text("\(home)  vs  \(away)")
                } footer: {
                    Text("Left number = \(home). The other team confirms, then PickleHeat sends the result to DUPR.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.ink.ignoresSafeArea())
            .navigationTitle("Score")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if canConfirm {
                        Button("Confirm") { Task { await save(confirm: true) } }.bold()
                    } else if amIn || detail.isOrganizer {
                        Button("Submit") { Task { await save(confirm: false) } }.bold().disabled(games.contains { $0.us == $0.them })
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func save(confirm: Bool) async {
        await model.run {
            if confirm {
                _ = try await model.service.confirmScore(matchID: match.id)
            } else {
                _ = try await model.service.reportScore(matchID: match.id, games: games)
            }
            await onDone()
            dismiss()
        }
    }
}
