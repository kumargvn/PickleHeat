import Foundation

// Shapes of the Pickora API's JSON. See server/src/app.ts.

struct User: Codable, Hashable {
    var id: String
    var email: String?
    var name: String
    var lat: Double?
    var lng: Double?
    var maxDistanceMiles: Double
    var formats: [EventFormat]
}

struct DuprStatus: Codable, Hashable {
    var connected: Bool
    var duprId: String?
    var doublesRating: Double?
    var singlesRating: Double?
    var ratingUpdatedAt: String?
    var matchesSyncedAt: String?
}

struct FormSummary: Codable, Hashable {
    var score: Int
    var label: FormLabel
    var previousScore: Int?
}

struct PayoutStatus: Codable, Hashable {
    var linked: Bool
    var chargesEnabled: Bool?
    var payoutsEnabled: Bool?
    var ready: Bool { linked && (chargesEnabled ?? false) }
}

struct Me: Codable, Hashable {
    var token: String?
    var user: User
    var dupr: DuprStatus
    var form: FormSummary?
    var payouts: PayoutStatus
}

struct FormPayload: Codable, Hashable {
    var form: FormResult?
    var insights: Insights
    var matches: [PlayedMatch]
}

struct SourceStatus: Codable, Hashable {
    var name: String
    var ok: Bool
    var count: Int
    var error: String?
}

struct RecommendedPayload: Codable, Hashable {
    var recommendations: [Recommendation]
    var sources: [SourceStatus]
}

enum EventKind: String, Codable, CaseIterable, Identifiable {
    case league, tournament
    var id: String { rawValue }
    var title: String { self == .league ? "League" : "Tournament" }
}

enum EventStatus: String, Codable {
    case draft, open, closed
    case inProgress = "in_progress"
    case completed

    var title: String {
        switch self {
        case .draft: return "Draft"
        case .open: return "Registration open"
        case .closed: return "Registration closed"
        case .inProgress: return "In progress"
        case .completed: return "Completed"
        }
    }
}

struct PickoraEvent: Codable, Hashable, Identifiable {
    var id: String
    var organizerId: String
    var kind: EventKind
    var name: String
    var format: EventFormat
    var startDate: String
    var endDate: String?
    var weeks: Int?
    var venue: String
    var city: String
    var state: String
    var lat: Double?
    var lng: Double?
    var minRating: Double?
    var maxRating: Double?
    var capacity: Int
    var feeCents: Int
    var currency: String
    var requireDuprVerified: Bool
    var submitToDupr: Bool
    var status: EventStatus
    var createdAt: String

    var ratingRangeText: String {
        switch (minRating, maxRating) {
        case let (lo?, hi?): return String(format: "%.2f–%.2f", lo, hi)
        case let (lo?, nil): return String(format: "%.2f+", lo)
        case let (nil, hi?): return String(format: "up to %.2f", hi)
        default: return "Open"
        }
    }

    var place: String { [venue, city].filter { !$0.isEmpty }.joined(separator: " · ") }
}

/// What the Create screen sends.
struct EventDraft: Codable, Hashable {
    var kind: EventKind
    var name: String
    var format: EventFormat
    var startDate: String
    var weeks: Int?
    var venue: String
    var city: String
    var state: String
    var lat: Double?
    var lng: Double?
    var minRating: Double?
    var maxRating: Double?
    var capacity: Int
    var feeCents: Int
    var requireDuprVerified: Bool
    var submitToDupr: Bool

    static func sample(kind: EventKind) -> EventDraft {
        EventDraft(
            kind: kind,
            name: kind == .tournament ? "Fall Slam Doubles" : "Tuesday Night Ladder",
            format: .doubles,
            startDate: DateText.adding(8, to: DateText.string(Date())),
            weeks: kind == .league ? 8 : nil,
            venue: "", city: "", state: "", lat: nil, lng: nil,
            minRating: 3.5, maxRating: 4.25,
            capacity: kind == .tournament ? 16 : 12,
            feeCents: kind == .tournament ? 3500 : 6000,
            requireDuprVerified: true, submitToDupr: true
        )
    }
}

enum EntryStatus: String, Codable {
    case pendingPayment = "pending_payment"
    case confirmed, withdrawn, refunded
}

struct Entry: Codable, Hashable, Identifiable {
    var id: String
    var eventId: String
    var playerIds: [String]
    var teamName: String
    var teamRating: Double?
    var status: EntryStatus
    var createdAt: String
}

enum MatchStatus: String, Codable {
    case scheduled, reported, confirmed
}

struct EventMatch: Codable, Hashable, Identifiable {
    var id: String
    var eventId: String
    var round: Int
    var pool: Int?
    var homeEntryId: String
    var awayEntryId: String
    var scheduledAt: String?
    var court: String?
    var games: [GameScore]
    var status: MatchStatus
    var reportedBy: String?
    var confirmedBy: String?
    var duprMatchId: String?
    var duprSyncedAt: String?
    var duprError: String?
}

struct PoolStandings: Codable, Hashable {
    var pool: Int?
    var table: [Schedule.Standing]
}

struct Money: Codable, Hashable {
    var collectedCents: Int
    var paidEntries: Int
}

struct EventDetail: Codable, Hashable {
    var event: PickoraEvent
    var entries: [Entry]
    var matches: [EventMatch]
    var standings: [PoolStandings]
    var playoffs: [Schedule.BracketSlot]
    var isOrganizer: Bool
    var names: [String: String]
    var money: Money?

    func entry(_ id: String) -> Entry? { entries.first { $0.id == id } }
    func teamName(_ entryID: String) -> String { entry(entryID)?.teamName ?? "TBD" }
    func myEntry(userID: String) -> Entry? {
        entries.first { $0.playerIds.contains(userID) && $0.status != .withdrawn && $0.status != .refunded }
    }
}

struct RegisterResult: Codable, Hashable {
    var entry: Entry
    var checkoutUrl: String?
}

struct LinkResponse: Codable, Hashable {
    var url: String
    var callbackScheme: String?
}

struct APIErrorBody: Codable {
    var error: String
    var code: String?
}
