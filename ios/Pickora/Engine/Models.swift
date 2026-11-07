import Foundation

// Core domain types. Mirrors server/src/domain/types.ts — keep the two in sync.

struct GameScore: Codable, Hashable {
    var us: Int
    var them: Int
}

/// One completed match from one player's side.
struct PlayedMatch: Codable, Hashable, Identifiable {
    var id: String
    var playedAt: Date
    /// Average DUPR rating of the player's team (singles: the player's rating).
    var teamRating: Double
    var opponentRating: Double
    var games: [GameScore]
    var partnerName: String?
    var opponentNames: [String]?
    var eventName: String?
}

enum FormLabel: String, Codable {
    case hot = "Hot", rising = "Rising", steady = "Steady", cooling = "Cooling", cold = "Cold"
}

struct FormResult: Codable, Hashable {
    var score: Int
    var label: FormLabel
    var matchesUsed: Int
    /// Actual point share minus expected, newest first.
    var residuals: [Double]
    var weightedResidual: Double
    var previousScore: Int?
}

enum EventFormat: String, Codable, CaseIterable, Identifiable {
    case doubles, mixed, singles
    var id: String { rawValue }
    var title: String {
        switch self {
        case .doubles: return "Doubles"
        case .mixed: return "Mixed"
        case .singles: return "Singles"
        }
    }
}

struct TournamentEvent: Codable, Hashable, Identifiable {
    var id: String
    var name: String
    var format: EventFormat
    var minRating: Double?
    var maxRating: Double?
    var feeCents: Int?
}

struct TournamentListing: Codable, Hashable, Identifiable {
    var id: String
    var source: String
    var name: String
    var url: String?
    var startDate: String // YYYY-MM-DD
    var endDate: String
    var venue: String
    var city: String
    var state: String
    var lat: Double
    var lng: Double
    var registrationOpen: Bool
    var events: [TournamentEvent]
}

struct PlayerProfileForRecs: Hashable {
    var doublesRating: Double?
    var singlesRating: Double?
    var form: Int?
    var lat: Double
    var lng: Double
    var maxDistanceMiles: Double
    var formats: [EventFormat]
}

struct Recommendation: Codable, Hashable, Identifiable {
    var tournament: TournamentListing
    var event: TournamentEvent
    var score: Double
    var distanceMiles: Double
    var reasons: [String]
    var id: String { tournament.id + "/" + event.id }
}

struct WinLoss: Codable, Hashable {
    var wins: Int
    var losses: Int
    var text: String { "\(wins)–\(losses)" }
}

struct Traits: Codable, Hashable {
    var clutch: Int
    var consistency: Int
    var giantKiller: Int
    var momentum: Int
}

struct Insights: Codable, Hashable {
    var record: WinLoss
    var pointShare: Double
    var closeGames: WinLoss
    var vsHigherRated: WinLoss
    var traits: Traits
    var tip: String
}

extension PlayedMatch {
    var points: (us: Int, them: Int) {
        games.reduce((0, 0)) { ($0.0 + $1.us, $0.1 + $1.them) }
    }

    var won: Bool {
        var gw = 0, gl = 0
        for g in games {
            if g.us > g.them { gw += 1 } else if g.them > g.us { gl += 1 }
        }
        if gw != gl { return gw > gl }
        return points.us > points.them
    }

    var scoreText: String { games.map { "\($0.us)–\($0.them)" }.joined(separator: ", ") }
}
