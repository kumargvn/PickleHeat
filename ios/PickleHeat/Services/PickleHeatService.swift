import Foundation

/// Everything the app needs from a backend. Two implementations:
/// LiveService (the PickleHeat API) and DemoService (on-device sample data, no account needed).
@MainActor
protocol PickleHeatService: AnyObject {
    var isDemo: Bool { get }

    func signIn(identityToken: String, name: String?) async throws -> Me
    func restore() async throws -> Me?
    func me() async throws -> Me
    func updateProfile(name: String?, lat: Double?, lng: Double?, maxDistanceMiles: Double?, formats: [EventFormat]?) async throws -> Me
    func deleteAccount() async throws
    func signOut()

    /// Live: a web page that hosts DUPR's login; returns to pickleheat://dupr. Demo: nil (connect in-app).
    func duprConnectURL() async throws -> URL?
    /// Called after the DUPR page returns (or right away in demo).
    func completeDuprConnect() async throws -> Me
    func syncDupr() async throws -> Me
    func disconnectDupr() async throws -> Me

    func form() async throws -> FormPayload
    func recommended(lat: Double?, lng: Double?, radius: Double?) async throws -> RecommendedPayload

    func events() async throws -> [PickleHeatEvent]
    func createEvent(_ draft: EventDraft) async throws -> PickleHeatEvent
    func publish(eventID: String) async throws -> PickleHeatEvent
    func generateSchedule(eventID: String) async throws -> [EventMatch]
    func event(id: String) async throws -> EventDetail
    func register(eventID: String, partnerDuprID: String?, teamName: String?) async throws -> RegisterResult
    func reportScore(matchID: String, games: [GameScore]) async throws -> EventMatch
    func confirmScore(matchID: String) async throws -> EventMatch

    /// Live: Stripe onboarding page; returns to pickleheat://payouts. Demo: nil (linked instantly).
    func onboardPayouts() async throws -> URL?
    func payoutStatus() async throws -> PayoutStatus
}

struct ServiceError: LocalizedError, Equatable {
    var message: String
    var code: String?
    var status: Int?
    var errorDescription: String? { message }

    static let notSignedIn = ServiceError(message: "Please sign in again.", code: "unauthorized", status: 401)
}

enum AppConfig {
    /// From the PICKLEHEAT_API_URL build setting. Empty = demo mode.
    static var apiBaseURL: URL? {
        guard let s = Bundle.main.object(forInfoDictionaryKey: "PickleHeatAPIURL") as? String,
              !s.trimmingCharacters(in: .whitespaces).isEmpty,
              let url = URL(string: s.trimmingCharacters(in: .whitespaces))
        else { return nil }
        return url
    }

    static let callbackScheme = "pickleheat"
    static let privacyURL = URL(string: "https://kumargvn.github.io/PickleHeat/privacy.html")!
    static let supportURL = URL(string: "https://kumargvn.github.io/PickleHeat/support.html")!

    @MainActor
    static func makeService() -> PickleHeatService {
        if let url = apiBaseURL { return LiveService(baseURL: url) }
        return DemoService()
    }
}
