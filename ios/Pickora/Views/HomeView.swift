import SwiftUI

struct HomeView: View {
    @EnvironmentObject var model: AppModel
    @State private var creating: EventKind?

    private var me: Me? { model.me }

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                header
                ratingCard
                if let form = model.formPayload?.form, let i = model.formPayload?.insights {
                    Button { model.selectedTab = .insights } label: {
                        HStack(spacing: 12) {
                            IconTile(systemName: "chart.line.uptrend.xyaxis", color: Theme.coral)
                            (Text("\(i.record.wins) wins in your last \(i.record.wins + i.record.losses). ").bold()
                                + Text(form.weightedResidual >= 0 ? "You're playing above your rating. See why" : "You're a bit below your rating. See why").foregroundColor(Theme.muted))
                                .font(.system(size: 14))
                                .multilineTextAlignment(.leading)
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right").foregroundStyle(Theme.muted)
                        }
                        .card(padding: 14, radius: 18)
                    }
                    .buttonStyle(.plain)
                }
                quickActions
                upNext
                recommendedPreview
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 24)
        }
        .screenBackground()
        .refreshable { await model.syncDupr() }
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: String.self) { EventDetailView(eventID: $0) }
        .sheet(item: $creating) { kind in
            NavigationStack { CreateEventView(kind: kind) }
        }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(Date().formatted(.dateTime.weekday(.wide).month().day())).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.muted)
                Text("Hey, \(me?.user.name.split(separator: " ").first.map(String.init) ?? "there")").font(Theme.display(30))
            }
            Spacer()
            if model.isDemo { Pill(text: "Demo", fg: Theme.ink, bg: Theme.sky) }
        }
        .padding(.top, 12)
    }

    private var ratingCard: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 6) {
                Text("DUPR DOUBLES").font(.system(size: 11, weight: .heavy)).tracking(1.4)
                Text(ratingText(me?.dupr.doublesRating)).font(Theme.display(56)).monospacedDigit()
                if let f = me?.form, let p = f.previousScore {
                    Pill(text: f.score >= p ? "▲ form up \(f.score - p)" : "▼ form down \(p - f.score)")
                }
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

    private var quickActions: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible())], spacing: 12) {
            action("person.2.fill", Theme.lime, "Create league") { creating = .league }
            action("trophy.fill", Theme.coral, "Create tournament") { creating = .tournament }
            action("chart.bar.fill", Theme.sky, "My insights") { model.selectedTab = .insights }
            action("magnifyingglass", Theme.text, "Find events") { model.selectedTab = .events }
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

    @ViewBuilder private var upNext: some View {
        let live = model.myEvents.filter { $0.status != .completed && $0.status != .draft }
        if !live.isEmpty {
            VStack(spacing: 10) {
                SectionHeader(title: "My events", action: "See all") { model.selectedTab = .events }
                ForEach(live.prefix(3)) { ev in
                    NavigationLink(value: ev.id) { EventRow(event: ev, userID: model.userID) }.buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder private var recommendedPreview: some View {
        if let recs = model.recommendations?.recommendations, !recs.isEmpty {
            VStack(spacing: 10) {
                SectionHeader(title: "Picked for you", action: "More") { model.selectedTab = .events }
                ForEach(recs.prefix(2)) { RecommendationCard(rec: $0) }
            }
        }
    }
}

struct EventRow: View {
    var event: PickoraEvent
    var userID: String

    var body: some View {
        HStack(spacing: 12) {
            IconTile(systemName: event.kind == .league ? "person.2.fill" : "trophy.fill", color: event.kind == .league ? Theme.lime : Theme.coral)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.name).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                Text("\(DateText.pretty(event.startDate)) · \(event.status.title)\(event.organizerId == userID ? " · Organizer" : "")")
                    .font(.system(size: 13)).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").foregroundStyle(Theme.muted)
        }
        .card(padding: 14, radius: 18)
    }
}

struct RecommendationCard: View {
    var rec: Recommendation

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
                    Link("Register", destination: url).font(.system(size: 14, weight: .bold)).foregroundStyle(Theme.lime)
                } else {
                    Text("\(Int((rec.score * 100).rounded()))% match").font(.system(size: 13, weight: .bold)).foregroundStyle(Theme.lime)
                }
            }
        }
        .card()
    }
}
