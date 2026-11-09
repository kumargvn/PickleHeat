import SwiftUI

/// Create a league or tournament: style, format, club, schedule, rating range, fees.
/// Saves a draft, then opens registration if asked. Fees are collected on the PickleHeat website.
struct CreateEventView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var kind: EventKind
    @State private var style: EventStyle
    @State private var format: EventFormat = .doubles
    @State private var name = ""
    @State private var description = ""
    @State private var clubID: String?
    @State private var date = Date().addingTimeInterval(7 * 86_400)
    @State private var weeks = 8
    @State private var roundDays = 7
    @State private var gamesPerMatch = 2
    @State private var capacity = 16
    @State private var venue = ""
    @State private var city = ""
    @State private var state = ""
    @State private var useRange = true
    @State private var minRating = 3.0
    @State private var maxRating = 4.0
    @State private var fee: Double = 0
    @State private var memberFee: Double = 0
    @State private var hasMemberPrice = false
    @State private var submitToDupr = true
    @State private var requireDupr = true
    @State private var openNow = true

    init(kind: EventKind, clubID: String? = nil) {
        _kind = State(initialValue: kind)
        _style = State(initialValue: kind == .league ? .flexLadder : .doubleElim)
        _clubID = State(initialValue: clubID)
        _gamesPerMatch = State(initialValue: kind == .league ? 2 : 1)
    }

    private var managedClubs: [ClubSummary] {
        (model.discover?.clubs ?? []).filter { $0.myRole == .owner || $0.myRole == .admin }
    }

    private var formats: [EventFormat] { style.individual ? [.doubles, .mixed] : EventFormat.allCases }

    var body: some View {
        Form {
            Section {
                Picker("Type", selection: $kind) {
                    ForEach(EventKind.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                TextField(kind == .league ? "League name" : "Tournament name", text: $name)
                TextField("Description (optional)", text: $description, axis: .vertical).lineLimit(1...4)
                if !managedClubs.isEmpty || clubID != nil {
                    Picker("Club", selection: $clubID) {
                        Text("No club").tag(String?.none)
                        ForEach(managedClubs) { Text($0.club.name).tag(Optional($0.club.id)) }
                    }
                }
            }

            Section {
                Picker("Style", selection: $style) {
                    ForEach(EventStyle.options(for: kind)) { Text($0.title).tag($0) }
                }
                Text(style.blurb).font(.footnote).foregroundStyle(Theme.muted)
                Picker("Format", selection: $format) {
                    ForEach(formats) { Text($0.title).tag($0) }
                }
                if !style.individual && (format == .mlp || format == .trips) {
                    Text(format == .mlp ? "Teams of 4 play women's, men's and two mixed doubles lines. A DreamBreaker settles a 2–2 tie." : "Teams of 3 play three doubles lines; the team winning more lines takes the match.")
                        .font(.footnote).foregroundStyle(Theme.muted)
                }
            } header: { Text("Format") }

            Section("When") {
                DatePicker(kind == .league ? "First round" : "Date", selection: $date, in: Date()..., displayedComponents: .date)
                if kind == .league {
                    Stepper("\(style.individual ? "Rounds" : "Weeks"): \(weeks)", value: $weeks, in: 1...26)
                    Stepper("Every \(roundDays) days", value: $roundDays, in: 1...31)
                }
                Stepper("Games per match: \(gamesPerMatch)", value: $gamesPerMatch, in: 1...5)
                Stepper("\(style.individual || format == .singles ? "Players" : "Teams"): \(capacity)", value: $capacity, in: 4...256, step: style.individual ? 4 : 1)
            }

            Section("Where") {
                TextField("Venue", text: $venue)
                TextField("City", text: $city)
                TextField("State", text: $state)
            }

            Section {
                Toggle("Limit by DUPR rating", isOn: $useRange)
                if useRange {
                    HStack {
                        Text("Range")
                        Spacer()
                        Text(String(format: "%.2f – %.2f", minRating, maxRating)).foregroundStyle(Theme.lime).monospacedDigit()
                    }
                    Slider(value: $minRating, in: 2...6, step: 0.25) { Text("Minimum") }
                        .onChange(of: minRating) { _, v in if v > maxRating { maxRating = v } }
                    Slider(value: $maxRating, in: 2...6, step: 0.25) { Text("Maximum") }
                        .onChange(of: maxRating) { _, v in if v < minRating { minRating = v } }
                }
                Toggle("Send results to DUPR", isOn: $submitToDupr)
                Toggle("DUPR-connected players only", isOn: $requireDupr)
            } header: { Text("DUPR") } footer: {
                Text("Scores go to DUPR once both sides confirm.")
            }

            Section {
                HStack {
                    Text("Entry fee per player")
                    Spacer()
                    TextField("Free", value: $fee, format: .currency(code: "USD")).keyboardType(.decimalPad).multilineTextAlignment(.trailing).frame(width: 110)
                }
                if clubID != nil {
                    Toggle("Member price", isOn: $hasMemberPrice)
                    if hasMemberPrice {
                        HStack {
                            Text("Club members pay")
                            Spacer()
                            TextField("Free", value: $memberFee, format: .currency(code: "USD")).keyboardType(.decimalPad).multilineTextAlignment(.trailing).frame(width: 110)
                        }
                    }
                }
                if fee > 0 || (hasMemberPrice && memberFee > 0) {
                    HStack {
                        Image(systemName: model.me?.payouts.ready == true ? "checkmark.circle.fill" : "building.columns.fill")
                            .foregroundStyle(model.me?.payouts.ready == true ? Theme.lime : Theme.coral)
                        Text(model.me?.payouts.ready == true ? "Fees go to your payout account" : "Set up payouts on the website first")
                        Spacer()
                        if model.me?.payouts.ready != true {
                            Button("Set up") { Task { await model.setUpPayouts() } }.bold()
                        }
                    }
                }
                Toggle("Open registration now", isOn: $openNow)
            } header: { Text("Entry") } footer: {
                Text("Players pay entry fees on the PickleHeat website, straight to your payout account.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.ink.ignoresSafeArea())
        .navigationTitle(kind == .league ? "New league" : "New tournament")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Create") { Task { await create() } }
                    .bold()
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || model.busy)
            }
        }
        .onChange(of: kind) { _, k in
            if !EventStyle.options(for: k).contains(style) { style = EventStyle.options(for: k)[0] }
        }
        .onChange(of: style) { _, s in
            if !formats.contains(format) { format = .doubles }
            gamesPerMatch = s.individual ? 2 : 1
            if s.individual { capacity = max(8, (capacity / 4) * 4) }
        }
    }

    private func create() async {
        let place = [venue, city, state].filter { !$0.isEmpty }.joined(separator: ", ")
        let coords = place.isEmpty ? nil : await LocationProvider.geocode(place)
        let draft = EventDraft(
            kind: kind, style: style, name: name.trimmingCharacters(in: .whitespaces), description: description, format: format,
            clubId: clubID, startDate: DateText.string(date), weeks: kind == .league ? weeks : nil, roundDays: roundDays,
            gamesPerMatch: gamesPerMatch, venue: venue, city: city, state: state, lat: coords?.latitude, lng: coords?.longitude,
            minRating: useRange ? minRating : nil, maxRating: useRange ? maxRating : nil, capacity: capacity,
            feeCents: Int((fee * 100).rounded()), memberFeeCents: clubID != nil && hasMemberPrice ? Int((memberFee * 100).rounded()) : nil,
            requireDuprVerified: requireDupr, submitToDupr: submitToDupr
        )
        await model.run {
            let ev = try await model.api.createEvent(draft)
            if openNow {
                if ev.isPaid && model.me?.payouts.ready != true {
                    model.notice = "Saved as a draft. Set up payouts, then open registration from the event page."
                } else {
                    try await model.api.publish(ev.id)
                }
            }
            await model.loadHome()
            dismiss()
            model.selectedTab = .events
            model.openEventID = ev.id
        }
    }
}

/// Join an event. Solo for Heat Climb / Wildfire Mixer; partners by DUPR ID for team events.
/// Entry fees are paid on the PickleHeat website, never in the app.
struct RegisterView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let detail: EventDetail
    var onDone: () async -> Void
    @State private var partners: [String]
    @State private var teamName = ""
    @State private var result: RegisterResult?

    init(detail: EventDetail, onDone: @escaping () async -> Void) {
        self.detail = detail
        self.onDone = onDone
        _partners = State(initialValue: Array(repeating: "", count: max(0, detail.event.teamSize - 1)))
    }

    private var event: PickleHeatEvent { detail.event }

    private var myRating: Double? {
        event.format == .singles ? (model.me?.dupr.singlesRating ?? model.me?.dupr.doublesRating) : model.me?.dupr.doublesRating
    }

    private var fits: Bool {
        guard event.minRating != nil || event.maxRating != nil else { return true }
        guard let r = myRating else { return false }
        return (event.minRating.map { r >= $0 } ?? true) && (event.maxRating.map { r <= $0 } ?? true)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if let result { done(result) } else { form }
            }
            .padding(20)
        }
        .screenBackground()
        .navigationTitle(result == nil ? "Join event" : "Registered")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
    }

    @ViewBuilder private var form: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(event.style.title.uppercased()) · \(event.format.title.uppercased())").font(.system(size: 11, weight: .heavy)).tracking(1.4)
            Text(event.name).font(Theme.display(28))
            HStack {
                Pill(text: DateText.pretty(event.startDate), fg: Theme.text)
                Pill(text: "DUPR \(event.ratingRangeText)", fg: Theme.text)
            }
        }
        .foregroundStyle(Theme.ink)
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(event.kind == .league ? Theme.lime : Theme.coral, in: RoundedRectangle(cornerRadius: 24, style: .continuous))

        HStack(spacing: 12) {
            Image(systemName: fits ? "checkmark.circle.fill" : "exclamationmark.triangle.fill").foregroundStyle(fits ? Theme.lime : Theme.coral)
            Text(fits ? "Your DUPR \(ratingText(myRating)) fits" : "Your DUPR \(ratingText(myRating)) is outside this event's range")
        }
        .card(padding: 14, radius: 16)

        if event.style.individual {
            Text("Sign up on your own. PickleHeat puts you in a heat each round and rotates your partners.")
                .font(.system(size: 14)).foregroundStyle(Theme.muted).card()
        } else if !partners.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(partners.count == 1 ? "Partner's DUPR ID" : "Teammates' DUPR IDs").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.muted)
                ForEach(partners.indices, id: \.self) { i in
                    TextField(model.isDemo ? "Try \(["DEMO-PR04", "DEMO-BR03", "DEMO-CH01"][min(i, 2)])" : "DUPR ID", text: $partners[i])
                        .textInputAutocapitalization(.characters).autocorrectionDisabled()
                        .padding(14).background(Theme.surface2, in: RoundedRectangle(cornerRadius: 14))
                }
                Text("Partners need PickleHeat with DUPR connected.").font(.footnote).foregroundStyle(Theme.muted)
                TextField("Team name (optional)", text: $teamName)
                    .padding(14).background(Theme.surface2, in: RoundedRectangle(cornerRadius: 14))
            }
            .card()
        }

        if detail.myPriceCents > 0 {
            VStack(alignment: .leading, spacing: 8) {
                HStack { Text("Entry fee").foregroundStyle(Theme.muted); Spacer(); Text(money(detail.myPriceCents)).font(Theme.display(20)) }
                Text("You'll finish payment on the PickleHeat website. The fee goes to the organizer.").font(.footnote).foregroundStyle(Theme.muted)
            }
            .card()
        }

        Button {
            Task { await submit() }
        } label: {
            if model.busy { ProgressView().tint(Theme.ink) } else { Text(detail.entries.count >= event.capacity ? "Join waitlist" : "Register") }
        }
        .buttonStyle(PrimaryButtonStyle())
        .disabled(!fits || partners.contains { $0.trimmingCharacters(in: .whitespaces).isEmpty } || model.busy)
    }

    @ViewBuilder private func done(_ r: RegisterResult) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: r.entry.status == .waitlisted ? "clock.fill" : "checkmark.seal.fill").font(.system(size: 40)).foregroundStyle(Theme.lime)
            Text(r.entry.status == .waitlisted ? "You're on the waitlist" : r.payOnWeb ? "Spot held: payment due" : "You're in!").font(Theme.display(24))
            Text(r.entry.status == .waitlisted ? "We'll notify you if a spot opens." : r.payOnWeb ? "Pay \(money(r.amountCents)) on the PickleHeat website to confirm your spot." : "See you on the court. Check the event chat for details.")
                .foregroundStyle(Theme.muted)
            if r.payOnWeb {
                Button("Pay on pickleheat.app") {
                    Task {
                        if model.isDemo { await model.demoPay(entryID: r.entry.id) } else { await model.openOnWeb("entries/\(r.entry.id)/pay") }
                        await onDone()
                        dismiss()
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                Button("Later") { dismiss() }.buttonStyle(SecondaryButtonStyle())
            } else {
                Button("Done") { dismiss() }.buttonStyle(PrimaryButtonStyle())
            }
        }
        .card()
    }

    private func submit() async {
        await model.run {
            let ids = partners.map { $0.trimmingCharacters(in: .whitespaces).uppercased() }
            result = try await model.api.register(event.id, partnerDuprIDs: ids, teamName: teamName.isEmpty ? nil : teamName)
            await onDone()
            await model.loadHome()
        }
    }
}

/// Organizer: invite players by pasting a list. Anyone not yet on PickleHeat joins automatically on sign-up.
struct InviteView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let eventID: String
    let invites: [Invite]
    var onDone: () async -> Void
    @State private var csv = ""

    init(eventID: String, invites: [Invite], onDone: @escaping () async -> Void) {
        self.eventID = eventID
        self.invites = invites
        self.onDone = onDone
    }

    var body: some View {
        Form {
            Section {
                TextEditor(text: $csv).frame(minHeight: 140).font(.system(size: 14, design: .monospaced))
            } header: { Text("One player per line") } footer: {
                Text("name, email, DUPR ID. Email or DUPR ID is enough to match. Players already on PickleHeat join right away; others join when they sign up or connect DUPR.")
            }
            if !invites.isEmpty {
                Section("Invited (\(invites.count))") {
                    ForEach(invites) { i in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(i.name)
                                Text([i.email, i.duprId].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(Theme.muted)
                            }
                            Spacer()
                            Text(i.status.capitalized).font(.caption).foregroundStyle(i.status == "joined" ? Theme.lime : Theme.muted)
                        }
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.ink.ignoresSafeArea())
        .navigationTitle("Invite players")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Invite") {
                    Task {
                        await model.run {
                            let r = try await model.api.invite(eventID, csv: csv)
                            model.notice = "Invited \(r.added). \(r.joined) joined right away."
                            await onDone()
                            dismiss()
                        }
                    }
                }
                .bold().disabled(csv.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }
}
