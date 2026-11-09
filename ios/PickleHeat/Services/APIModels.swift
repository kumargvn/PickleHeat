import Foundation

// Shapes of the PickleHeat API's JSON (server/src/services/views.ts and friends).
// The unit tests decode recorded responses (shared/vectors/api) into these types.

// MARK: people

struct UserProfile: Codable, Hashable {
    var id: String
    var email: String?
    var name: String
    var gender: String?
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
    var doublesReliability: Double?
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
    var ready: Bool
}

struct UnreadCounts: Codable, Hashable {
    var notifications: Int
    var chats: Int
}

struct Me: Codable, Hashable {
    var token: String?
    var user: UserProfile
    var dupr: DuprStatus
    var form: FormSummary?
    var payouts: PayoutStatus
    var unread: UnreadCounts
}

struct PlayerInfo: Codable, Hashable, Identifiable {
    var id: String
    var name: String
    var gender: String?
    var duprId: String?
    var rating: Double?
    var singlesRating: Double?
    var reliability: Double?

    var firstName: String { String(name.split(separator: " ").first ?? Substring(name)) }
    var initials: String { name.split(separator: " ").prefix(2).compactMap { $0.first.map(String.init) }.joined() }
    /// "3.34 · 70%" like DUPR shows it.
    var ratingLine: String {
        guard let rating else { return "No DUPR" }
        if let reliability { return String(format: "%.2f · %d%%", rating, Int(reliability)) }
        return String(format: "%.2f", rating)
    }
}

typealias Players = [String: PlayerInfo]

extension Dictionary where Key == String, Value == PlayerInfo {
    func name(_ id: String) -> String { self[id]?.name ?? "Player" }
    func first(_ id: String) -> String { self[id]?.firstName ?? "Player" }
}

// MARK: form & recommendations

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

// MARK: events

enum EventKind: String, Codable, CaseIterable, Identifiable {
    case league, tournament
    var id: String { rawValue }
    var title: String { self == .league ? "League" : "Tournament" }
}

enum EventStyle: String, Codable, CaseIterable, Identifiable {
    case flexLadder = "flex_ladder"
    case scramble
    case roundRobin = "round_robin"
    case poolsPlayoffs = "pools_playoffs"
    case singleElim = "single_elim"
    case doubleElim = "double_elim"

    var id: String { rawValue }
    var title: String {
        switch self {
        case .flexLadder: return "Heat Climb"
        case .scramble: return "Wildfire Mixer"
        case .roundRobin: return "Round robin"
        case .poolsPlayoffs: return "Pools + playoffs"
        case .singleElim: return "Single elimination"
        case .doubleElim: return "Double elimination"
        }
    }
    var blurb: String {
        switch self {
        case .flexLadder: return "Sign up solo. Each round you're placed in a heat of 4 near your level and play rotating partners. Win your heat to climb; last place drops a heat."
        case .scramble: return "Sign up solo. A new heat and new partners every round. Standings by total games won."
        case .roundRobin: return "Fixed teams. Everyone plays everyone."
        case .poolsPlayoffs: return "Fixed teams. Pools first, then a playoff bracket."
        case .singleElim: return "Fixed teams. Lose once and you're out."
        case .doubleElim: return "Fixed teams. Lose twice and you're out, with a grand final."
        }
    }
    var individual: Bool { self == .flexLadder || self == .scramble }
    var bracket: Bool { self == .singleElim || self == .doubleElim }
    static func options(for kind: EventKind) -> [EventStyle] {
        kind == .league ? [.flexLadder, .scramble, .roundRobin] : [.doubleElim, .singleElim, .poolsPlayoffs, .roundRobin, .scramble]
    }
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

struct PickleHeatEvent: Codable, Hashable, Identifiable {
    var id: String
    var organizerId: String
    var clubId: String?
    var kind: EventKind
    var style: EventStyle
    var name: String
    var description: String
    var format: EventFormat
    var startDate: String
    var endDate: String?
    var weeks: Int?
    var roundDays: Int
    var gamesPerMatch: Int
    var venue: String
    var city: String
    var state: String
    var lat: Double?
    var lng: Double?
    var minRating: Double?
    var maxRating: Double?
    var capacity: Int
    var feeCents: Int
    var memberFeeCents: Int?
    var currency: String
    var requireDuprVerified: Bool
    var submitToDupr: Bool
    var status: EventStatus
    var ladder: [String]
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
    var teamSize: Int { style.individual ? 1 : format.teamSize }
    var isPaid: Bool { feeCents > 0 || (memberFeeCents ?? 0) > 0 }
    var subtitle: String { "\(style.title) · \(format.title)" }
}

enum EntryStatus: String, Codable {
    case pendingPayment = "pending_payment"
    case confirmed, waitlisted, withdrawn, refunded

    var title: String {
        switch self {
        case .pendingPayment: return "Payment due"
        case .confirmed: return "Registered"
        case .waitlisted: return "Waitlist"
        case .withdrawn: return "Withdrawn"
        case .refunded: return "Refunded"
        }
    }
}

struct EventCard: Codable, Hashable, Identifiable {
    var event: PickleHeatEvent
    var clubName: String?
    var entryCount: Int
    var waitlistCount: Int
    var myStatus: EntryStatus?
    var myPriceCents: Int
    var distanceMiles: Double?
    var id: String { event.id }
}

struct Entry: Codable, Hashable, Identifiable {
    var id: String
    var eventId: String
    var playerIds: [String]
    var teamName: String
    var teamRating: Double?
    var status: EntryStatus
    var comped: Bool
    var createdAt: String
}

enum MatchStatus: String, Codable {
    case scheduled, reported, confirmed
}

struct BracketPos: Codable, Hashable {
    var side: String // W, L, GF
    var round: Int
    var slot: Int
}

struct SlotRef: Codable, Hashable {
    var matchId: String
    var side: String
}

struct Line: Codable, Hashable {
    var label: String
    var homePlayers: [String]
    var awayPlayers: [String]
    var games: [GameScore]
}

struct EventMatch: Codable, Hashable, Identifiable {
    var id: String
    var eventId: String
    var roundId: String?
    var groupId: String?
    var round: Int
    var pool: Int?
    var bracket: BracketPos?
    var label: String?
    var homeEntryId: String?
    var awayEntryId: String?
    var homePlayers: [String]
    var awayPlayers: [String]
    var homeDead: Bool
    var awayDead: Bool
    var winnerTo: SlotRef?
    var loserTo: SlotRef?
    var scheduledAt: String?
    var court: String?
    var games: [GameScore]
    var lines: [Line]?
    var status: MatchStatus
    var reportedBy: String?
    var confirmedBy: String?
    var duprMatchId: String?
    var duprSyncedAt: String?
    var duprError: String?

    var ready: Bool { !homePlayers.isEmpty && !awayPlayers.isEmpty }
    func includes(_ userID: String) -> Bool { homePlayers.contains(userID) || awayPlayers.contains(userID) }
    func side(of userID: String) -> String? { homePlayers.contains(userID) ? "home" : awayPlayers.contains(userID) ? "away" : nil }
    var scoreText: String {
        if let lines, !lines.isEmpty {
            return lines.filter { !$0.games.isEmpty }.map { l in l.games.map { "\($0.us)–\($0.them)" }.joined(separator: " ") }.joined(separator: " · ")
        }
        return games.map { "\($0.us)–\($0.them)" }.joined(separator: ", ")
    }
}

struct PoolStandings: Codable, Hashable {
    var pool: Int?
    var table: [Schedule.Standing]
}

struct RankRow: Codable, Hashable, Identifiable {
    var userId: String
    var rank: Int
    var prevRank: Int?
    var fromGroup: Int?
    var nextGroup: Int?
    var wins: Int
    var losses: Int
    var pd: Int
    var played: Bool
    var id: String { userId }
    var movement: Int { prevRank.map { $0 - rank } ?? 0 }
}

enum RoundStatus: String, Codable {
    case upcoming
    case inProgress = "in_progress"
    case completed

    var title: String {
        switch self {
        case .upcoming: return "Not started"
        case .inProgress: return "In progress"
        case .completed: return "Completed"
        }
    }
}

struct Round: Codable, Hashable, Identifiable {
    var id: String
    var eventId: String
    var number: Int
    var startDate: String
    var endDate: String
    var status: RoundStatus
    var byes: [String]
    var ranking: [RankRow]?
}

struct Money: Codable, Hashable {
    var collectedCents: Int
    var paidEntries: Int
    var pendingEntries: Int
}

struct Invite: Codable, Hashable, Identifiable {
    var id: String
    var eventId: String
    var name: String
    var email: String?
    var duprId: String?
    var status: String
    var createdAt: String
}

struct ClubRef: Codable, Hashable {
    var id: String
    var name: String
}

struct EventDetail: Codable, Hashable {
    var event: PickleHeatEvent
    var club: ClubRef?
    var isManager: Bool
    var myEntry: Entry?
    var myPriceCents: Int
    var entries: [Entry]
    var waitlist: [Entry]
    var players: Players
    var matches: [EventMatch]
    var standings: [PoolStandings]
    var rounds: [Round]
    var currentRoundId: String?
    var chatId: String?
    var money: Money?
    var invites: [Invite]

    func entry(_ id: String?) -> Entry? { entries.first { $0.id == id } ?? waitlist.first { $0.id == id } }
    func teamName(_ id: String?) -> String { entry(id)?.teamName ?? "TBD" }
    func names(_ ids: [String]) -> String { ids.map { players.first($0) }.joined(separator: " & ") }
}

struct StatRow: Codable, Hashable, Identifiable {
    var userId: String
    var wins: Int
    var losses: Int
    var winPct: Double
    var pf: Int
    var pa: Int
    var pd: Int
    var pdPct: Double
    var ratingChange: Double?
    var id: String { userId }
}

struct PlayGroup: Codable, Hashable, Identifiable {
    var id: String
    var eventId: String
    var roundId: String
    var number: Int
    var playerIds: [String]
    var chatId: String
}

struct GroupView: Codable, Hashable, Identifiable {
    var group: PlayGroup
    var matches: [EventMatch]
    var standings: [StatRow]
    var id: String { group.id }
}

struct SubRequest: Codable, Hashable, Identifiable {
    var id: String
    var eventId: String
    var roundId: String
    var groupId: String
    var userId: String
    var status: String // open, filled, cancelled
    var subUserId: String?
    var createdAt: String
}

struct RoundView: Codable, Hashable {
    var round: Round
    var groups: [GroupView]
    var myGroupId: String?
    var myAttendance: String?
    var subs: [SubRequest]
    var tags: [String: [String]]
    var players: Players

    var myGroup: GroupView? { groups.first { $0.group.id == myGroupId } }
}

struct RankingsPayload: Codable, Hashable {
    var round: Int?
    var rows: [RankRow]
    var players: Players
}

struct StatsPayload: Codable, Hashable {
    var rows: [StatRow]
    var tags: [String: [String]]
    var players: Players
}

struct RegisterResult: Codable, Hashable {
    var entry: Entry
    var amountCents: Int
    var payOnWeb: Bool
    var checkoutUrl: String?
}

struct LiveItem: Codable, Hashable, Identifiable {
    var eventId: String
    var eventName: String
    var roundNumber: Int?
    var groupNumber: Int?
    var chatId: String?
    var match: EventMatch
    var needsMyConfirmation: Bool
    var id: String { match.id }
}

struct LivePayload: Codable, Hashable {
    var items: [LiveItem]
    var players: Players
}

// MARK: clubs

enum ClubRole: String, Codable, CaseIterable {
    case owner, admin, member
    var title: String { rawValue.capitalized }
}

struct Club: Codable, Hashable, Identifiable {
    var id: String
    var name: String
    var description: String
    var city: String
    var state: String
    var lat: Double?
    var lng: Double?
    var createdBy: String
    var createdAt: String
}

struct ClubSummary: Codable, Hashable, Identifiable {
    var club: Club
    var memberCount: Int
    var leagueCount: Int
    var tournamentCount: Int
    var myRole: ClubRole?
    var distanceMiles: Double?
    var id: String { club.id }
}

struct ClubsPayload: Codable, Hashable {
    var mine: [ClubSummary]
    var nearby: [ClubSummary]
}

struct ClubMemberRow: Codable, Hashable, Identifiable {
    var userId: String
    var role: ClubRole
    var joinedAt: String
    var id: String { userId }
}

struct ClubDetail: Codable, Hashable {
    var summary: ClubSummary
    var members: [ClubMemberRow]
    var players: Players
    var events: [EventCard]
    var chatId: String?
}

struct DiscoverPayload: Codable, Hashable {
    var events: [EventCard]
    var clubs: [ClubSummary]
}

// MARK: chat & notifications

struct Chat: Codable, Hashable, Identifiable {
    var id: String
    var kind: String // event, group, club, direct
    var title: String
    var eventId: String?
    var groupId: String?
    var clubId: String?
    var memberIds: [String]
    var lastMessageAt: String?
    var createdAt: String
}

struct ChatMessage: Codable, Hashable, Identifiable {
    var id: String
    var chatId: String
    var userId: String?
    var text: String
    var createdAt: String
    var reactions: [String: [String]]
}

struct ChatSummary: Codable, Hashable, Identifiable {
    var chat: Chat
    var lastMessage: ChatMessage?
    var unread: Int
    var id: String { chat.id }
}

struct ChatsPayload: Codable, Hashable {
    var chats: [ChatSummary]
    var players: Players
}

struct MessagesPayload: Codable, Hashable {
    var chat: Chat
    var messages: [ChatMessage]
    var players: Players
}

struct AppNotification: Codable, Hashable, Identifiable {
    var id: String
    var userId: String
    var kind: String
    var title: String
    var body: String
    var link: String?
    var read: Bool
    var createdAt: String
}

struct NotificationsPayload: Codable, Hashable {
    var notifications: [AppNotification]
}

struct URLPayload: Codable, Hashable {
    var url: String
}

struct APIErrorBody: Codable {
    var error: String
    var code: String?
}

// MARK: create forms

struct EventDraft: Encodable {
    var kind: EventKind
    var style: EventStyle
    var name: String
    var description: String
    var format: EventFormat
    var clubId: String?
    var startDate: String
    var weeks: Int?
    var roundDays: Int
    var gamesPerMatch: Int
    var venue: String
    var city: String
    var state: String
    var lat: Double?
    var lng: Double?
    var minRating: Double?
    var maxRating: Double?
    var capacity: Int
    var feeCents: Int
    var memberFeeCents: Int?
    var requireDuprVerified: Bool
    var submitToDupr: Bool
}

enum ISO {
    static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let plain = ISO8601DateFormatter()
    static func date(_ s: String?) -> Date? {
        guard let s else { return nil }
        return fractional.date(from: s) ?? plain.date(from: s)
    }
}
