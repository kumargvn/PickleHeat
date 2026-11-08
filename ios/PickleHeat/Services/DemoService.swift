import Foundation

/// On-device backend with sample data. Used when no API URL is configured (TestFlight preview,
/// App Review, screenshots). Same behaviour as the API, minus real DUPR and real money.
@MainActor
final class DemoService: PickleHeatService {
    let isDemo = true

    private let sample = SampleData.shared
    private var today: String { DateText.string(Date()) }
    private var signedIn = false
    private var user: User
    private var duprConnected = false
    private var payoutsLinked = false
    private var eventsByID: [String: PickleHeatEvent] = [:]
    private var entriesByEvent: [String: [Entry]] = [:]
    private var matchesByEvent: [String: [EventMatch]] = [:]
    private var names: [String: String] = [:]
    private var counter = 0

    private let meID = "demo-me"
    /// Other sample players, so leagues and tournaments look alive.
    private let others: [(id: String, name: String, dupr: String, rating: Double)] = [
        ("demo-pk", "Priya K.", "DEMO-PK01", 4.04), ("demo-md", "Marco D.", "DEMO-MD02", 3.95), ("demo-ls", "Lena S.", "DEMO-LS03", 3.99),
        ("demo-cw", "Chen W.", "DEMO-CW04", 4.18), ("demo-aa", "Ana A.", "DEMO-AA05", 4.12), ("demo-so", "Sam O.", "DEMO-SO06", 4.06),
        ("demo-dp", "Dev P.", "DEMO-DP07", 4.10), ("demo-bt", "Brooks T.", "DEMO-BT08", 4.21), ("demo-hr", "Hale R.", "DEMO-HR09", 4.19),
    ]

    init() {
        user = User(id: meID, email: nil, name: sample.player.name, lat: sample.player.lat, lng: sample.player.lng, maxDistanceMiles: 75, formats: [.doubles, .mixed])
        names[meID] = sample.player.name
        for o in others { names[o.id] = o.name }
        seedLeagues()
    }

    private func newID(_ prefix: String) -> String {
        counter += 1
        return "\(prefix)-\(counter)"
    }

    private func rating(_ id: String) -> Double {
        id == meID ? sample.player.doublesRating : (others.first { $0.id == id }?.rating ?? 4.0)
    }

    private var matches: [PlayedMatch] { duprConnected ? sample.matches(today: today) : [] }

    private func currentMe() -> Me {
        let form = FormEngine.score(matches)
        return Me(
            token: "demo",
            user: user,
            dupr: duprConnected
                ? DuprStatus(connected: true, duprId: sample.player.duprId, doublesRating: sample.player.doublesRating, singlesRating: sample.player.singlesRating, ratingUpdatedAt: ISO8601DateFormatter().string(from: Date()), matchesSyncedAt: ISO8601DateFormatter().string(from: Date()))
                : DuprStatus(connected: false),
            form: form.map { FormSummary(score: $0.score, label: $0.label, previousScore: $0.previousScore) },
            payouts: PayoutStatus(linked: payoutsLinked, chargesEnabled: payoutsLinked, payoutsEnabled: payoutsLinked)
        )
    }

    // MARK: account

    func signIn(identityToken: String, name: String?) async throws -> Me {
        signedIn = true
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty {
            user.name = name
            names[meID] = name
        }
        return currentMe()
    }

    func restore() async throws -> Me? { signedIn ? currentMe() : nil }
    func me() async throws -> Me { currentMe() }

    func updateProfile(name: String?, lat: Double?, lng: Double?, maxDistanceMiles: Double?, formats: [EventFormat]?) async throws -> Me {
        if let name { user.name = name; names[meID] = name }
        if let lat { user.lat = lat }
        if let lng { user.lng = lng }
        if let maxDistanceMiles { user.maxDistanceMiles = maxDistanceMiles }
        if let formats { user.formats = formats }
        return currentMe()
    }

    func deleteAccount() async throws { signOut() }

    func signOut() {
        signedIn = false
        duprConnected = false
        payoutsLinked = false
    }

    // MARK: DUPR

    func duprConnectURL() async throws -> URL? { nil }

    func completeDuprConnect() async throws -> Me {
        try await Task.sleep(nanoseconds: 600_000_000)
        duprConnected = true
        return currentMe()
    }

    func syncDupr() async throws -> Me {
        try await Task.sleep(nanoseconds: 400_000_000)
        return currentMe()
    }

    func disconnectDupr() async throws -> Me {
        duprConnected = false
        return currentMe()
    }

    // MARK: insights & discovery

    func form() async throws -> FormPayload {
        FormPayload(form: FormEngine.score(matches), insights: FormEngine.insights(matches), matches: FormEngine.newestFirst(matches))
    }

    func recommended(lat: Double?, lng: Double?, radius: Double?) async throws -> RecommendedPayload {
        let me = currentMe()
        let profile = PlayerProfileForRecs(
            doublesRating: me.dupr.doublesRating, singlesRating: me.dupr.singlesRating, form: me.form?.score,
            lat: lat ?? user.lat ?? sample.player.lat, lng: lng ?? user.lng ?? sample.player.lng,
            maxDistanceMiles: radius ?? user.maxDistanceMiles, formats: user.formats
        )
        let listings = sample.tournaments(today: today)
        let recs = Recommender.recommend(profile, listings, today: today, limit: 20)
        return RecommendedPayload(recommendations: recs, sources: [
            SourceStatus(name: "sample", ok: true, count: listings.count, error: nil),
            SourceStatus(name: "pickleball.com", ok: false, count: 0, error: "Waiting for API access"),
            SourceStatus(name: "fluidpb", ok: false, count: 0, error: "Waiting for API access"),
        ])
    }

    // MARK: events

    func events() async throws -> [PickleHeatEvent] {
        eventsByID.values.sorted { $0.startDate < $1.startDate }
    }

    func createEvent(_ d: EventDraft) async throws -> PickleHeatEvent {
        guard !d.name.trimmingCharacters(in: .whitespaces).isEmpty else { throw ServiceError(message: "Give your event a name.") }
        let ev = PickleHeatEvent(
            id: newID("ev"), organizerId: meID, kind: d.kind, name: d.name, format: d.format, startDate: d.startDate, endDate: nil,
            weeks: d.weeks, venue: d.venue, city: d.city, state: d.state, lat: d.lat, lng: d.lng, minRating: d.minRating, maxRating: d.maxRating,
            capacity: d.capacity, feeCents: d.feeCents, currency: "usd", requireDuprVerified: d.requireDuprVerified, submitToDupr: d.submitToDupr,
            status: .draft, createdAt: ISO8601DateFormatter().string(from: Date())
        )
        eventsByID[ev.id] = ev
        // Some sample teams have already signed up, so the organizer view has something to show.
        let pairs = [(others[1], others[2]), (others[3], others[4]), (others[7], others[8])]
        entriesByEvent[ev.id] = pairs.map { a, b in
            Entry(id: newID("en"), eventId: ev.id, playerIds: [a.id, b.id], teamName: "\(a.name.split(separator: " ")[0]) / \(b.name.split(separator: " ")[0])", teamRating: (a.rating + b.rating) / 2, status: .confirmed, createdAt: ev.createdAt)
        }
        return ev
    }

    func publish(eventID: String) async throws -> PickleHeatEvent {
        guard var ev = eventsByID[eventID] else { throw ServiceError(message: "Event not found") }
        if ev.feeCents > 0 && !payoutsLinked { throw ServiceError(message: "Link a payout account before opening a paid event", code: "payouts_required") }
        ev.status = .open
        eventsByID[eventID] = ev
        return ev
    }

    func generateSchedule(eventID: String) async throws -> [EventMatch] {
        guard var ev = eventsByID[eventID] else { throw ServiceError(message: "Event not found") }
        if let existing = matchesByEvent[eventID], !existing.isEmpty { return existing }
        let entries = (entriesByEvent[eventID] ?? []).filter { $0.status == .confirmed }.sorted { ($0.teamRating ?? 0) > ($1.teamRating ?? 0) }
        guard entries.count >= 2 else { throw ServiceError(message: "Need at least two confirmed entries") }
        let ids = entries.map(\.id)
        let groups = ev.kind == .league ? [ids] : Schedule.snakePools(ids, count: max(1, Int((Double(ids.count) / 4).rounded())))
        var out: [EventMatch] = []
        for (i, g) in groups.enumerated() {
            for p in Schedule.roundRobin(g) {
                out.append(EventMatch(id: newID("m"), eventId: eventID, round: p.round, pool: ev.kind == .league ? nil : i + 1, homeEntryId: p.home, awayEntryId: p.away, scheduledAt: nil, court: "Ct \(out.count % 6 + 1)", games: [], status: .scheduled, reportedBy: nil, confirmedBy: nil, duprMatchId: nil, duprSyncedAt: nil, duprError: nil))
            }
        }
        matchesByEvent[eventID] = out
        ev.status = .inProgress
        eventsByID[eventID] = ev
        return out
    }

    func event(id: String) async throws -> EventDetail {
        guard let ev = eventsByID[id] else { throw ServiceError(message: "Event not found") }
        let entries = entriesByEvent[id] ?? []
        let ms = matchesByEvent[id] ?? []
        let pools = Array(Set(ms.map(\.pool))).sorted { ($0 ?? 0) < ($1 ?? 0) }
        let live = entries.filter { $0.status == .confirmed }
        let tables: [PoolStandings] = (pools.isEmpty ? [nil] : pools).map { pool in
            let inPool = ms.filter { $0.pool == pool }
            let ids = pools.isEmpty ? live.map(\.id) : Array(Set(inPool.flatMap { [$0.homeEntryId, $0.awayEntryId] })).sorted()
            let results = inPool.filter { $0.status == .confirmed }.map { m in
                Schedule.Result(home: m.homeEntryId, away: m.awayEntryId, games: m.games.map { .init(home: $0.us, away: $0.them) })
            }
            return PoolStandings(pool: pool, table: Schedule.standings(ids, results))
        }
        let paid = live.filter { $0.playerIds.contains(meID) == false }.count
        return EventDetail(
            event: ev, entries: entries, matches: ms, standings: tables, playoffs: [],
            isOrganizer: ev.organizerId == meID, names: names,
            money: ev.organizerId == meID ? Money(collectedCents: paid * ev.feeCents * (ev.format == .singles ? 1 : 2), paidEntries: paid) : nil
        )
    }

    func register(eventID: String, partnerDuprID: String?, teamName: String?) async throws -> RegisterResult {
        guard let ev = eventsByID[eventID] else { throw ServiceError(message: "Event not found") }
        guard ev.status == .open else { throw ServiceError(message: "Registration is not open") }
        guard duprConnected else { throw ServiceError(message: "Connect your DUPR account first", code: "dupr_required") }
        var players = [meID]
        if ev.format != .singles {
            let code = (partnerDuprID ?? "").trimmingCharacters(in: .whitespaces).uppercased()
            guard let partner = others.first(where: { $0.dupr == code }) else {
                throw ServiceError(message: "No PickleHeat player has connected that DUPR ID yet. In the demo, try DEMO-PK01.", code: "partner_not_found")
            }
            players.append(partner.id)
        }
        if (entriesByEvent[eventID] ?? []).contains(where: { $0.playerIds.contains(meID) }) { throw ServiceError(message: "Already registered") }
        let avg = players.map(rating).reduce(0, +) / Double(players.count)
        let entry = Entry(id: newID("en"), eventId: eventID, playerIds: players, teamName: teamName ?? players.map { (names[$0] ?? "Player").split(separator: " ").first.map(String.init) ?? "" }.joined(separator: " / "), teamRating: avg, status: .confirmed, createdAt: ISO8601DateFormatter().string(from: Date()))
        entriesByEvent[eventID, default: []].append(entry)
        return RegisterResult(entry: entry, checkoutUrl: nil)
    }

    func reportScore(matchID: String, games: [GameScore]) async throws -> EventMatch {
        for (eid, list) in matchesByEvent {
            if let i = list.firstIndex(where: { $0.id == matchID }) {
                guard games.allSatisfy({ $0.us != $0.them && $0.us >= 0 && $0.them >= 0 }), !games.isEmpty else { throw ServiceError(message: "Each game needs two different scores") }
                var m = list[i]
                let organizer = eventsByID[eid]?.organizerId == meID
                m.games = games
                m.status = organizer ? .confirmed : .reported
                m.reportedBy = meID
                if m.status == .confirmed { m.duprMatchId = "demo-dupr-\(m.id)"; m.duprSyncedAt = ISO8601DateFormatter().string(from: Date()) }
                matchesByEvent[eid]?[i] = m
                return m
            }
        }
        throw ServiceError(message: "Match not found")
    }

    func confirmScore(matchID: String) async throws -> EventMatch {
        for (eid, list) in matchesByEvent {
            if let i = list.firstIndex(where: { $0.id == matchID }) {
                var m = list[i]
                m.status = .confirmed
                m.confirmedBy = meID
                m.duprMatchId = "demo-dupr-\(m.id)"
                matchesByEvent[eid]?[i] = m
                return m
            }
        }
        throw ServiceError(message: "Match not found")
    }

    // MARK: payouts

    func onboardPayouts() async throws -> URL? {
        try await Task.sleep(nanoseconds: 400_000_000)
        payoutsLinked = true
        return nil
    }

    func payoutStatus() async throws -> PayoutStatus { PayoutStatus(linked: payoutsLinked, chargesEnabled: payoutsLinked, payoutsEnabled: payoutsLinked) }

    // MARK: seed

    private func seedLeagues() {
        let created = ISO8601DateFormatter().string(from: Date())
        for lg in sample.leagues {
            let ev = PickleHeatEvent(
                id: lg.id, organizerId: "demo-cw", kind: .league, name: lg.name, format: lg.format,
                startDate: DateText.adding(-7 * (lg.currentWeek - 1), to: today), endDate: nil, weeks: lg.weeks,
                venue: "Sample Community Courts", city: "Round Rock", state: "TX", lat: 30.51, lng: -97.67,
                minRating: 3.75, maxRating: 4.49, capacity: lg.players / 2, feeCents: lg.feeCents, currency: "usd",
                requireDuprVerified: true, submitToDupr: true, status: .inProgress, createdAt: created
            )
            eventsByID[ev.id] = ev
            let teams: [[String]] = [[meID, "demo-pk"], ["demo-md", "demo-ls"], ["demo-cw", "demo-aa"], ["demo-so", "demo-dp"]]
            let entries = teams.map { ps in
                Entry(id: "\(lg.id)-\(ps[0])", eventId: ev.id, playerIds: ps, teamName: ps.map { (names[$0] ?? "").split(separator: " ").first.map(String.init) ?? "" }.joined(separator: " / "), teamRating: ps.map(rating).reduce(0, +) / Double(ps.count), status: .confirmed, createdAt: created)
            }
            entriesByEvent[ev.id] = entries
            let scores: [[GameScore]] = [[.init(us: 11, them: 7)], [.init(us: 9, them: 11)], [.init(us: 11, them: 8)], [.init(us: 11, them: 5)]]
            var ms: [EventMatch] = []
            for (k, p) in Schedule.roundRobin(entries.map(\.id)).enumerated() {
                let done = p.round <= 2
                ms.append(EventMatch(id: "\(lg.id)-m\(k)", eventId: ev.id, round: p.round, pool: nil, homeEntryId: p.home, awayEntryId: p.away, scheduledAt: nil, court: "Ct \(k % 4 + 1)", games: done ? scores[k % scores.count] : [], status: done ? .confirmed : .scheduled, reportedBy: nil, confirmedBy: nil, duprMatchId: done ? "demo" : nil, duprSyncedAt: nil, duprError: nil))
            }
            matchesByEvent[ev.id] = ms
        }
    }
}
