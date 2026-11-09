import SwiftUI

struct EventsView: View {
    @EnvironmentObject var model: AppModel
    enum Pane: Hashable { case discover, mine, clubs }
    @State private var section: Pane = .discover
    @State private var creating: EventKind?
    @State private var creatingClub = false

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                ChipTabs(items: [(Pane.discover, "Discover"), (Pane.mine, "My events"), (Pane.clubs, "Clubs")], selection: $section)
                switch section {
                case .discover: discover
                case .mine: mine
                case .clubs: clubs
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 24)
        }
        .screenBackground()
        .navigationTitle("Events")
        .appDestinations()
        .navigationDestination(item: $model.openEventID) { id in EventDetailView(eventID: id) }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("New league", systemImage: "person.3.fill") { creating = .league }
                    Button("New tournament", systemImage: "trophy.fill") { creating = .tournament }
                    Button("New club", systemImage: "house.fill") { creatingClub = true }
                } label: { Image(systemName: "plus.circle.fill").font(.system(size: 22)) }
                .accessibilityLabel("Create")
            }
        }
        .sheet(item: $creating) { kind in NavigationStack { CreateEventView(kind: kind) } }
        .sheet(isPresented: $creatingClub) { NavigationStack { CreateClubView() } }
        .refreshable { await model.refreshAll() }
    }

    @ViewBuilder private var discover: some View {
        let open = (model.discover?.events ?? []).filter { $0.myStatus == nil }
        if !open.isEmpty {
            SectionHeader(title: "Open on PickleHeat")
            ForEach(open) { c in
                NavigationLink(value: EventRoute(id: c.event.id)) { EventCardRow(card: c, userID: model.userID) }.buttonStyle(.plain)
            }
        }
        if let recs = model.recommendations, !recs.recommendations.isEmpty {
            SectionHeader(title: "Tournaments that fit your rating")
            ForEach(recs.recommendations) { RecommendationCard(rec: $0) }
            Text("Searched: \(recs.sources.filter { $0.ok }.map(\.name).joined(separator: ", ")).")
                .font(.footnote).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, alignment: .leading)
        } else if model.me?.user.lat == nil {
            VStack(alignment: .leading, spacing: 12) {
                Text("Where do you play?").font(Theme.display(20))
                Text("PickleHeat finds tournaments near you that fit your DUPR rating.").foregroundStyle(Theme.muted)
                Button("Use my location") { Task { await model.useCurrentLocation() } }.buttonStyle(PrimaryButtonStyle())
            }
            .card()
        } else if open.isEmpty {
            EmptyState(title: "Nothing open nearby", message: "Try a bigger search distance in Profile, or start a Heat Climb for your group.")
        }
    }

    @ViewBuilder private var mine: some View {
        if model.myEvents.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("No events yet").font(Theme.display(20))
                Text("Start a Heat Climb with your regular group, or run a tournament.").foregroundStyle(Theme.muted)
                HStack {
                    Button("New league") { creating = .league }.buttonStyle(SecondaryButtonStyle())
                    Button("New tournament") { creating = .tournament }.buttonStyle(PrimaryButtonStyle())
                }
            }
            .card()
        }
        ForEach(model.myEvents) { c in
            NavigationLink(value: EventRoute(id: c.event.id)) { EventCardRow(card: c, userID: model.userID) }.buttonStyle(.plain)
        }
    }

    @ViewBuilder private var clubs: some View {
        let all = model.discover?.clubs ?? []
        let mine = all.filter { $0.myRole != nil }
        let nearby = all.filter { $0.myRole == nil }
        Button("Create a club") { creatingClub = true }.buttonStyle(SecondaryButtonStyle())
        if !mine.isEmpty { SectionHeader(title: "My clubs") }
        ForEach(mine) { c in NavigationLink(value: ClubRoute(id: c.club.id)) { ClubRow(summary: c) }.buttonStyle(.plain) }
        if !nearby.isEmpty { SectionHeader(title: "Clubs near you") }
        ForEach(nearby) { c in NavigationLink(value: ClubRoute(id: c.club.id)) { ClubRow(summary: c) }.buttonStyle(.plain) }
    }
}
