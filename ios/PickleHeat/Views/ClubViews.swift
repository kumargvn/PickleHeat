import SwiftUI

struct ClubDetailView: View {
    @EnvironmentObject var model: AppModel
    let clubID: String
    @State private var detail: ClubDetail?
    @State private var creating: EventKind?
    @State private var confirmLeave = false

    init(clubID: String) { self.clubID = clubID }

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                if let d = detail { content(d) } else { ProgressView().padding(.top, 80) }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 24)
        }
        .screenBackground()
        .navigationTitle(detail?.summary.club.name ?? "Club")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let chat = detail?.chatId, detail?.summary.myRole != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink(value: ChatRoute(id: chat)) { Image(systemName: "bubble.left.and.bubble.right.fill") }.accessibilityLabel("Club chat")
                }
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $creating, onDismiss: { Task { await load() } }) { kind in
            NavigationStack { CreateEventView(kind: kind, clubID: clubID) }
        }
        .confirmationDialog("Leave this club?", isPresented: $confirmLeave, titleVisibility: .visible) {
            Button("Leave club", role: .destructive) { change { try await model.api.leaveClub(clubID) } }
        }
    }

    private func load() async {
        do { detail = try await model.api.club(clubID) } catch { model.errorMessage = error.localizedDescription }
    }

    private func change(_ work: @escaping () async throws -> ClubDetail) {
        Task {
            await model.run {
                detail = try await work()
                await model.loadHome()
            }
        }
    }

    @ViewBuilder private func content(_ d: ClubDetail) -> some View {
        let s = d.summary
        let manager = s.myRole == .owner || s.myRole == .admin
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 14) {
                Text(String(s.club.name.prefix(1))).font(Theme.display(26)).foregroundStyle(Theme.ink)
                    .frame(width: 60, height: 60).background(Theme.sky, in: RoundedRectangle(cornerRadius: 18))
                VStack(alignment: .leading, spacing: 3) {
                    Text(s.club.name).font(Theme.display(22))
                    Text([s.club.city, s.club.state].filter { !$0.isEmpty }.joined(separator: ", ")).font(.system(size: 14)).foregroundStyle(Theme.muted)
                }
            }
            if !s.club.description.isEmpty { Text(s.club.description).font(.system(size: 15)) }
            HStack {
                Pill(text: "\(s.memberCount) members", fg: Theme.text, bg: Theme.surface2)
                Pill(text: "\(s.leagueCount) leagues", fg: Theme.text, bg: Theme.surface2)
                Pill(text: "\(s.tournamentCount) tournaments", fg: Theme.text, bg: Theme.surface2)
            }
            if let role = s.myRole {
                HStack {
                    Label("You're a\(role == .admin || role == .owner ? "n" : "") \(role.title.lowercased())", systemImage: "checkmark.seal.fill")
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.lime)
                    Spacer()
                    if role != .owner { Button("Leave") { confirmLeave = true }.font(.system(size: 14)).foregroundStyle(Theme.coral) }
                }
            } else {
                Button("Join club") { change { try await model.api.joinClub(clubID) } }.buttonStyle(PrimaryButtonStyle())
                Text("Members see club events first and get member prices.").font(.system(size: 13)).foregroundStyle(Theme.muted)
            }
        }
        .card()

        if manager {
            HStack(spacing: 10) {
                Button("New league") { creating = .league }.buttonStyle(SecondaryButtonStyle())
                Button("New tournament") { creating = .tournament }.buttonStyle(PrimaryButtonStyle())
            }
        }

        SectionHeader(title: "Events")
        if d.events.isEmpty { EmptyState(title: "No events yet", message: manager ? "Create the club's first league or tournament." : "Check back soon.") }
        ForEach(d.events) { c in
            NavigationLink(value: EventRoute(id: c.event.id)) { EventCardRow(card: c, userID: model.userID) }.buttonStyle(.plain)
        }

        SectionHeader(title: "Members")
        VStack(spacing: 0) {
            ForEach(d.members) { m in
                HStack(spacing: 10) {
                    Avatar(player: d.players[m.userId], size: 32)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(d.players.name(m.userId)).font(.system(size: 15))
                        Text(d.players[m.userId]?.ratingLine ?? "").font(.system(size: 11)).foregroundStyle(Theme.muted)
                    }
                    Spacer()
                    if m.role != .member { Pill(text: m.role.title.uppercased(), fg: Theme.ink, bg: Theme.lime) }
                    if s.myRole == .owner && m.role != .owner {
                        Menu {
                            Button(m.role == .admin ? "Make member" : "Make admin") {
                                change { try await model.api.setRole(clubID, userID: m.userId, role: m.role == .admin ? .member : .admin) }
                            }
                        } label: { Image(systemName: "ellipsis.circle").foregroundStyle(Theme.muted) }
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 9)
                Divider().overlay(Theme.line)
            }
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18))
    }
}

struct CreateClubView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var city = ""
    @State private var state = ""

    var body: some View {
        Form {
            Section {
                TextField("Club name", text: $name)
                TextField("What's your club about?", text: $description, axis: .vertical).lineLimit(2...5)
            }
            Section("Where") {
                TextField("City", text: $city)
                TextField("State", text: $state)
            }
            Section {
                Text("You'll be the owner. Make others admins so they can run events too. Everyone who joins gets the club chat and member prices.")
                    .font(.footnote).foregroundStyle(Theme.muted)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.ink.ignoresSafeArea())
        .navigationTitle("New club")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Create") { Task { await create() } }.bold().disabled(name.trimmingCharacters(in: .whitespaces).count < 2 || model.busy)
            }
        }
    }

    private func create() async {
        await model.run {
            let c = await LocationProvider.geocode([city, state].filter { !$0.isEmpty }.joined(separator: ", "))
            _ = try await model.api.createClub(name: name, description: description, city: city, state: state, lat: c?.latitude, lng: c?.longitude)
            await model.loadHome()
            dismiss()
        }
    }
}
