import Foundation
import Security

/// Talks to the PickleHeat API over HTTPS. The session token lives in the Keychain.
@MainActor
final class LiveService: PickleHeatService {
    let baseURL: URL
    let isDemo = false
    private var token: String? {
        didSet { Keychain.set(token, for: "session") }
    }

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { dec in
            let s = try dec.singleValueContainer().decode(String.self)
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = f.date(from: s) { return date }
            f.formatOptions = [.withInternetDateTime]
            if let date = f.date(from: s) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: dec.codingPath, debugDescription: "Bad date \(s)"))
        }
        return d
    }()

    init(baseURL: URL) {
        self.baseURL = baseURL
        self.token = Keychain.get("session")
    }

    private func request<T: Decodable>(_ method: String, _ path: String, body: Encodable? = nil, query: [URLQueryItem] = [], auth: Bool = true) async throws -> T {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        req.timeoutInterval = 30
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }
        if auth {
            guard let token else { throw ServiceError.notSignedIn }
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let body = try? JSONDecoder().decode(APIErrorBody.self, from: data)
            if status == 401 { token = nil }
            throw ServiceError(message: body?.error ?? "Something went wrong (\(status)).", code: body?.code, status: status)
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw ServiceError(message: "Unexpected response from PickleHeat. Please update the app.", code: "decode", status: status)
        }
    }

    // MARK: account

    func signIn(identityToken: String, name: String?) async throws -> Me {
        struct Body: Encodable { var identityToken: String; var name: String? }
        let me: Me = try await request("POST", "v1/auth/apple", body: Body(identityToken: identityToken, name: name), auth: false)
        token = me.token
        return me
    }

    func restore() async throws -> Me? {
        guard token != nil else { return nil }
        do { return try await me() } catch let e as ServiceError where e.status == 401 { return nil }
    }

    func me() async throws -> Me { try await request("GET", "v1/me") }

    func updateProfile(name: String?, lat: Double?, lng: Double?, maxDistanceMiles: Double?, formats: [EventFormat]?) async throws -> Me {
        struct Body: Encodable { var name: String?; var lat: Double?; var lng: Double?; var maxDistanceMiles: Double?; var formats: [EventFormat]? }
        return try await request("PATCH", "v1/me", body: Body(name: name, lat: lat, lng: lng, maxDistanceMiles: maxDistanceMiles, formats: formats))
    }

    func deleteAccount() async throws {
        struct Done: Decodable { var deleted: Bool }
        let _: Done = try await request("DELETE", "v1/me")
        token = nil
    }

    func signOut() { token = nil }

    // MARK: DUPR

    func duprConnectURL() async throws -> URL? {
        struct Body: Encodable { var client = "app" }
        let r: LinkResponse = try await request("POST", "v1/dupr/connect-session", body: Body())
        return URL(string: r.url)
    }

    func completeDuprConnect() async throws -> Me { try await me() }
    func syncDupr() async throws -> Me { try await request("POST", "v1/dupr/sync") }

    func disconnectDupr() async throws -> Me {
        struct R: Decodable { var connected: Bool }
        let _: R = try await request("DELETE", "v1/dupr/link")
        return try await me()
    }

    // MARK: insights & discovery

    func form() async throws -> FormPayload { try await request("GET", "v1/me/form") }

    func recommended(lat: Double?, lng: Double?, radius: Double?) async throws -> RecommendedPayload {
        var q: [URLQueryItem] = []
        if let lat, let lng {
            q.append(URLQueryItem(name: "lat", value: String(lat)))
            q.append(URLQueryItem(name: "lng", value: String(lng)))
        }
        if let radius { q.append(URLQueryItem(name: "radius", value: String(Int(radius)))) }
        return try await request("GET", "v1/tournaments/recommended", query: q)
    }

    // MARK: events

    func events() async throws -> [PickleHeatEvent] {
        struct R: Decodable { var events: [PickleHeatEvent] }
        let r: R = try await request("GET", "v1/events", query: [URLQueryItem(name: "scope", value: "mine")])
        return r.events
    }

    func createEvent(_ draft: EventDraft) async throws -> PickleHeatEvent {
        struct R: Decodable { var event: PickleHeatEvent }
        let r: R = try await request("POST", "v1/events", body: draft)
        return r.event
    }

    func publish(eventID: String) async throws -> PickleHeatEvent {
        struct R: Decodable { var event: PickleHeatEvent }
        let r: R = try await request("POST", "v1/events/\(eventID)/publish")
        return r.event
    }

    func generateSchedule(eventID: String) async throws -> [EventMatch] {
        struct R: Decodable { var matches: [EventMatch] }
        let r: R = try await request("POST", "v1/events/\(eventID)/schedule")
        return r.matches
    }

    func event(id: String) async throws -> EventDetail { try await request("GET", "v1/events/\(id)") }

    func register(eventID: String, partnerDuprID: String?, teamName: String?) async throws -> RegisterResult {
        struct Body: Encodable { var partnerDuprId: String?; var teamName: String? }
        return try await request("POST", "v1/events/\(eventID)/register", body: Body(partnerDuprId: partnerDuprID, teamName: teamName), query: [URLQueryItem(name: "client", value: "app")])
    }

    func reportScore(matchID: String, games: [GameScore]) async throws -> EventMatch {
        struct Body: Encodable { var games: [GameScore] }
        struct R: Decodable { var match: EventMatch }
        let r: R = try await request("POST", "v1/matches/\(matchID)/score", body: Body(games: games))
        return r.match
    }

    func confirmScore(matchID: String) async throws -> EventMatch {
        struct R: Decodable { var match: EventMatch }
        let r: R = try await request("POST", "v1/matches/\(matchID)/confirm")
        return r.match
    }

    // MARK: payouts

    func onboardPayouts() async throws -> URL? {
        let r: LinkResponse = try await request("POST", "v1/payouts/onboard", query: [URLQueryItem(name: "client", value: "app")])
        return URL(string: r.url)
    }

    func payoutStatus() async throws -> PayoutStatus { try await request("GET", "v1/payouts/status") }
}

/// Lets `request` take any Encodable body.
private struct AnyEncodable: Encodable {
    let value: Encodable
    init(_ value: Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}

/// Minimal Keychain wrapper for the session token.
enum Keychain {
    private static let service = "com.gudivada.pickleheat"

    static func get(_ key: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func set(_ value: String?, for key: String) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
        SecItemDelete(base as CFDictionary)
        guard let value, let data = value.data(using: .utf8) else { return }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}
