import Foundation

/// Sample players, matches, tournaments and leagues from shared/sample-data.json (bundled).
/// Powers demo mode. Dates in the file are relative to "today".
struct SampleData {
    struct Player: Decodable {
        var id: String
        var name: String
        var duprId: String
        var doublesRating: Double
        var singlesRating: Double
        var lat: Double
        var lng: Double
        var homeArea: String
    }

    struct Match: Decodable {
        var id: String
        var daysAgo: Int
        var teamRating: Double
        var opponentRating: Double
        var games: [[Int]]
        var partnerName: String?
        var opponentNames: [String]?
        var eventName: String?
    }

    struct Tournament: Decodable {
        var id: String
        var name: String
        var startInDays: Int
        var lengthDays: Int
        var venue: String
        var city: String
        var state: String
        var lat: Double
        var lng: Double
        var registrationOpen: Bool
        var events: [TournamentEvent]
    }

    struct League: Decodable, Identifiable {
        var id: String
        var name: String
        var kind: String
        var format: EventFormat
        var weeks: Int
        var currentWeek: Int
        var players: Int
        var rank: Int
        var wins: Int
        var losses: Int
        var feeCents: Int
    }

    private struct File: Decodable {
        var player: Player
        var matches: [Match]
        var tournaments: [Tournament]
        var leagues: [League]
    }

    let player: Player
    private let rawMatches: [Match]
    private let rawTournaments: [Tournament]
    let leagues: [League]

    static let shared: SampleData = {
        guard let url = Bundle.main.url(forResource: "sample-data", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let file = try? JSONDecoder().decode(File.self, from: data)
        else {
            return SampleData(player: Player(id: "demo", name: "Demo Player", duprId: "DEMO", doublesRating: 3.5, singlesRating: 3.5, lat: 30.27, lng: -97.74, homeArea: ""), rawMatches: [], rawTournaments: [], leagues: [])
        }
        return SampleData(player: file.player, rawMatches: file.matches, rawTournaments: file.tournaments, leagues: file.leagues)
    }()

    static func load(from data: Data) throws -> SampleData {
        let file = try JSONDecoder().decode(File.self, from: data)
        return SampleData(player: file.player, rawMatches: file.matches, rawTournaments: file.tournaments, leagues: file.leagues)
    }

    func matches(today: String) -> [PlayedMatch] {
        rawMatches.map { m in
            let day = DateText.adding(-m.daysAgo, to: today)
            let date = ISO8601DateFormatter().date(from: "\(day)T18:00:00Z") ?? Date()
            return PlayedMatch(
                id: m.id,
                playedAt: date,
                teamRating: m.teamRating,
                opponentRating: m.opponentRating,
                games: m.games.map { GameScore(us: $0[0], them: $0[1]) },
                partnerName: m.partnerName,
                opponentNames: m.opponentNames,
                eventName: m.eventName
            )
        }
    }

    func tournaments(today: String) -> [TournamentListing] {
        rawTournaments.map { t in
            TournamentListing(
                id: t.id, source: "sample", name: t.name, url: nil,
                startDate: DateText.adding(t.startInDays, to: today),
                endDate: DateText.adding(t.startInDays + t.lengthDays - 1, to: today),
                venue: t.venue, city: t.city, state: t.state, lat: t.lat, lng: t.lng,
                registrationOpen: t.registrationOpen, events: t.events
            )
        }
    }
}
