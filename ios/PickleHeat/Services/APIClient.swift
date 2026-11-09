import Foundation
import Security
import WebKit

/// Sends one API request and returns (status, body).
@MainActor
protocol Transport: AnyObject {
    func send(method: String, path: String, body: Data?, token: String?) async throws -> (Int, Data)
}

/// The live PickleHeat API over HTTPS.
@MainActor
final class HTTPTransport: Transport {
    let baseURL: URL
    init(baseURL: URL) { self.baseURL = baseURL }

    func send(method: String, path: String, body: Data?, token: String?) async throws -> (Int, Data) {
        guard let url = URL(string: baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path) else {
            throw ServiceError(message: "Bad address")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 30
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, resp) = try await URLSession.shared.data(for: req)
        return ((resp as? HTTPURLResponse)?.statusCode ?? 0, data)
    }
}

/// Demo mode: the real PickleHeat API (bundled as demo-api.js) running in a hidden web view,
/// with a seeded demo world. Nothing leaves the phone; state persists between launches.
@MainActor
final class LocalTransport: NSObject, Transport, WKNavigationDelegate {
    private let web: WKWebView
    private var loaded = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        web = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: config)
        super.init()
        web.navigationDelegate = self
        // "</script" inside the bundle (the DUPR connect page template) would end the inline tag early.
        let js = (Bundle.main.url(forResource: "demo-api", withExtension: "js").flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? "")
            .replacingOccurrences(of: "</script", with: "<\\/script")
        // An https base URL makes this a secure context (WebCrypto) with its own persistent storage.
        web.loadHTMLString("<!doctype html><html><head><meta charset=\"utf-8\"><script>\(js)</script></head><body></body></html>", baseURL: URL(string: "https://demo.pickleheat.app/"))
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in
            self.loaded = true
            self.waiters.forEach { $0.resume() }
            self.waiters = []
        }
    }

    private func ready() async {
        if loaded { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func send(method: String, path: String, body: Data?, token: String?) async throws -> (Int, Data) {
        await ready()
        let result = try await web.callAsyncJavaScript(
            "const r = await PickleHeatDemo.call(method, path, body, token); return [r.status, r.body];",
            arguments: ["method": method, "path": path, "body": body.flatMap { String(data: $0, encoding: .utf8) } ?? NSNull(), "token": token ?? NSNull()],
            in: nil,
            contentWorld: .page
        )
        guard let pair = result as? [Any], pair.count == 2, let text = pair[1] as? String else {
            throw ServiceError(message: "The demo couldn't answer. Restart the app.")
        }
        let status = (pair[0] as? NSNumber)?.intValue ?? 500
        return (status, Data(text.utf8))
    }

    func reset() async {
        await ready()
        _ = try? await web.callAsyncJavaScript("await PickleHeatDemo.reset(); return true;", arguments: [:], in: nil, contentWorld: .page)
    }
}

struct ServiceError: LocalizedError, Equatable {
    var message: String
    var code: String?
    var status: Int?
    var errorDescription: String? { message }
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
    static let site = URL(string: "https://kumargvn.github.io/PickleHeat/")!
    static let privacyURL = URL(string: "https://kumargvn.github.io/PickleHeat/privacy.html")!
    static let supportURL = URL(string: "https://kumargvn.github.io/PickleHeat/support.html")!
}

/// Typed access to every endpoint the app uses.
@MainActor
final class APIClient {
    let transport: Transport
    let isDemo: Bool
    private(set) var token: String? {
        didSet { Keychain.set(token, for: isDemo ? "demo-session" : "session") }
    }

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { dec in
            let s = try dec.singleValueContainer().decode(String.self)
            if let date = ISO.date(s) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: dec.codingPath, debugDescription: "Bad date \(s)"))
        }
        return d
    }()

    init(transport: Transport, isDemo: Bool) {
        self.transport = transport
        self.isDemo = isDemo
        self.token = Keychain.get(isDemo ? "demo-session" : "session")
    }

    static func make() -> APIClient {
        if let url = AppConfig.apiBaseURL { return APIClient(transport: HTTPTransport(baseURL: url), isDemo: false) }
        return APIClient(transport: LocalTransport(), isDemo: true)
    }

    var signedIn: Bool { token != nil }
    func signOut() { token = nil }

    func request<T: Decodable>(_ method: String, _ path: String, _ body: [String: Any]? = nil, query: [String: String] = [:]) async throws -> T {
        var p = path
        if !query.isEmpty {
            var comps = URLComponents()
            comps.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
            p += "?" + (comps.percentEncodedQuery ?? "")
        }
        let data = try body.map { try JSONSerialization.data(withJSONObject: $0) }
        let (status, out) = try await transport.send(method: method, path: p, body: data, token: token)
        guard (200..<300).contains(status) else {
            let err = try? JSONDecoder().decode(APIErrorBody.self, from: out)
            if status == 401 { token = nil }
            throw ServiceError(message: err?.error ?? "Something went wrong (\(status)).", code: err?.code, status: status)
        }
        do {
            return try Self.decoder.decode(T.self, from: out)
        } catch {
            throw ServiceError(message: "Unexpected response from PickleHeat. Please update the app.", code: "decode", status: status)
        }
    }

    private struct Done: Decodable {}

    // MARK: account

    func signInWithApple(identityToken: String, name: String?) async throws -> Me {
        var body: [String: Any] = ["identityToken": identityToken]
        if let name { body["name"] = name }
        let me: Me = try await request("POST", "/v1/auth/apple", body)
        token = me.token
        return me
    }

    func me() async throws -> Me { try await request("GET", "/v1/me") }

    func updateProfile(_ fields: [String: Any]) async throws -> Me { try await request("PATCH", "/v1/me", fields) }

    func deleteAccount() async throws {
        let _: Done = try await request("DELETE", "/v1/me")
        token = nil
        if isDemo, let local = transport as? LocalTransport { await local.reset() }
    }

    /// One-time link that opens the PickleHeat website already signed in (payments, payouts).
    func webLink(to: String) async throws -> URL {
        let r: URLPayload = try await request("POST", "/v1/auth/handoff", ["to": to])
        guard let url = URL(string: r.url) else { throw ServiceError(message: "Bad link") }
        return url
    }

    // MARK: DUPR

    func duprConnectURL() async throws -> URL? {
        if isDemo { return nil }
        let r: URLPayload = try await request("POST", "/v1/dupr/connect-session", ["client": "app"])
        return URL(string: r.url)
    }

    /// Demo: links the stand-in DUPR account directly (the real flow uses DUPR's own login page).
    func connectDemoDupr() async throws {
        struct R: Decodable { var connected: Bool }
        let _: R = try await request("POST", "/v1/dupr/link", ["userToken": "mock-demo", "refreshToken": "refresh-demo"])
    }

    func syncDupr() async throws -> Me { try await request("POST", "/v1/dupr/sync") }
    func disconnectDupr() async throws -> Me { try await request("DELETE", "/v1/dupr/link") }

    // MARK: home

    func form() async throws -> FormPayload { try await request("GET", "/v1/me/form") }
    func live() async throws -> LivePayload { try await request("GET", "/v1/me/live") }
    func discover() async throws -> DiscoverPayload { try await request("GET", "/v1/discover") }

    func recommended(lat: Double?, lng: Double?, radius: Double?) async throws -> RecommendedPayload {
        var q: [String: String] = [:]
        if let lat, let lng { q["lat"] = String(lat); q["lng"] = String(lng) }
        if let radius { q["radius"] = String(Int(radius)) }
        return try await request("GET", "/v1/tournaments/recommended", query: q)
    }

    // MARK: events

    func myEvents() async throws -> [EventCard] {
        struct R: Decodable { var events: [EventCard] }
        let r: R = try await request("GET", "/v1/events")
        return r.events
    }

    func event(_ id: String) async throws -> EventDetail { try await request("GET", "/v1/events/\(id)") }

    func createEvent(_ draft: EventDraft) async throws -> PickleHeatEvent {
        struct R: Decodable { var event: PickleHeatEvent }
        let data = try JSONEncoder().encode(draft)
        let obj = (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let r: R = try await request("POST", "/v1/events", obj)
        return r.event
    }

    func publish(_ eventID: String) async throws {
        struct R: Decodable { var event: PickleHeatEvent }
        let _: R = try await request("POST", "/v1/events/\(eventID)/publish")
    }

    func buildSchedule(_ eventID: String) async throws {
        struct R: Decodable { var matches: [EventMatch] }
        let _: R = try await request("POST", "/v1/events/\(eventID)/schedule")
    }

    func register(_ eventID: String, partnerDuprIDs: [String], teamName: String?) async throws -> RegisterResult {
        var body: [String: Any] = ["partnerDuprIds": partnerDuprIDs]
        if let teamName, !teamName.isEmpty { body["teamName"] = teamName }
        return try await request("POST", "/v1/events/\(eventID)/register", body, query: ["client": "app"])
    }

    func withdraw(_ eventID: String) async throws {
        struct R: Decodable { var entry: Entry }
        let _: R = try await request("POST", "/v1/events/\(eventID)/withdraw")
    }

    func closeRegistration(_ eventID: String) async throws {
        struct R: Decodable { var event: PickleHeatEvent }
        let _: R = try await request("POST", "/v1/events/\(eventID)/close")
    }

    func refund(_ eventID: String, entryID: String) async throws {
        struct R: Decodable { var entry: Entry }
        let _: R = try await request("POST", "/v1/events/\(eventID)/entries/\(entryID)/refund")
    }

    func invite(_ eventID: String, csv: String) async throws -> (added: Int, joined: Int) {
        struct R: Decodable { var added: Int; var joinedNow: Int }
        let r: R = try await request("POST", "/v1/events/\(eventID)/invites", ["csv": csv])
        return (r.added, r.joinedNow)
    }

    /// Demo only: completes payment the way the website would.
    func demoPay(entryID: String) async throws {
        struct R: Decodable { var entry: Entry? }
        let _: R = try await request("POST", "/v1/demo/pay/\(entryID)")
    }

    func rankings(_ eventID: String, round: Int? = nil) async throws -> RankingsPayload {
        try await request("GET", "/v1/events/\(eventID)/rankings", query: round.map { ["round": String($0)] } ?? [:])
    }

    func stats(_ eventID: String) async throws -> StatsPayload { try await request("GET", "/v1/events/\(eventID)/stats") }

    // MARK: rounds

    func round(_ id: String) async throws -> RoundView { try await request("GET", "/v1/rounds/\(id)") }
    func startRound(_ eventID: String) async throws -> RoundView { try await request("POST", "/v1/events/\(eventID)/rounds/start") }
    func closeRound(_ id: String) async throws -> RoundView { try await request("POST", "/v1/rounds/\(id)/close") }
    func attendance(_ roundID: String, going: Bool) async throws -> RoundView {
        try await request("POST", "/v1/rounds/\(roundID)/attendance", ["status": going ? "confirmed" : "declined"])
    }
    func requestSub(_ roundID: String) async throws -> RoundView { try await request("POST", "/v1/rounds/\(roundID)/subs") }
    func acceptSub(_ subID: String) async throws -> RoundView { try await request("POST", "/v1/subs/\(subID)/accept") }
    func cancelSub(_ subID: String) async throws -> RoundView { try await request("POST", "/v1/subs/\(subID)/cancel") }

    // MARK: scores

    func reportScore(_ matchID: String, games: [GameScore]) async throws -> EventMatch {
        struct R: Decodable { var match: EventMatch }
        let r: R = try await request("POST", "/v1/matches/\(matchID)/score", ["games": games.map { ["us": $0.us, "them": $0.them] }])
        return r.match
    }

    func reportLines(_ matchID: String, lines: [[GameScore]]) async throws -> EventMatch {
        struct R: Decodable { var match: EventMatch }
        let body: [String: Any] = ["lines": lines.map { ["games": $0.map { ["us": $0.us, "them": $0.them] }] }]
        let r: R = try await request("POST", "/v1/matches/\(matchID)/score", body)
        return r.match
    }

    func confirmScore(_ matchID: String) async throws -> EventMatch {
        struct R: Decodable { var match: EventMatch }
        let r: R = try await request("POST", "/v1/matches/\(matchID)/confirm")
        return r.match
    }

    // MARK: clubs

    func clubs() async throws -> ClubsPayload { try await request("GET", "/v1/clubs") }
    func club(_ id: String) async throws -> ClubDetail { try await request("GET", "/v1/clubs/\(id)") }
    func joinClub(_ id: String) async throws -> ClubDetail { try await request("POST", "/v1/clubs/\(id)/join") }
    func leaveClub(_ id: String) async throws -> ClubDetail { try await request("POST", "/v1/clubs/\(id)/leave") }
    func setRole(_ clubID: String, userID: String, role: ClubRole) async throws -> ClubDetail {
        try await request("PATCH", "/v1/clubs/\(clubID)/members/\(userID)", ["role": role.rawValue])
    }
    func createClub(name: String, description: String, city: String, state: String, lat: Double?, lng: Double?) async throws -> ClubDetail {
        var body: [String: Any] = ["name": name, "description": description, "city": city, "state": state]
        if let lat, let lng { body["lat"] = lat; body["lng"] = lng }
        return try await request("POST", "/v1/clubs", body)
    }

    // MARK: chat & notifications

    func chats() async throws -> ChatsPayload { try await request("GET", "/v1/chats") }
    func messages(_ chatID: String, after: String? = nil) async throws -> MessagesPayload {
        try await request("GET", "/v1/chats/\(chatID)/messages", query: after.map { ["after": $0] } ?? [:])
    }
    func send(_ chatID: String, text: String) async throws -> ChatMessage {
        struct R: Decodable { var message: ChatMessage }
        let r: R = try await request("POST", "/v1/chats/\(chatID)/messages", ["text": text])
        return r.message
    }
    func react(_ chatID: String, messageID: String, emoji: String) async throws -> ChatMessage {
        struct R: Decodable { var message: ChatMessage }
        let r: R = try await request("POST", "/v1/chats/\(chatID)/messages/\(messageID)/react", ["emoji": emoji])
        return r.message
    }
    func startChat(with userIDs: [String]) async throws -> Chat {
        struct R: Decodable { var chat: Chat }
        let r: R = try await request("POST", "/v1/chats", ["userIds": userIDs])
        return r.chat
    }

    func notifications() async throws -> [AppNotification] {
        let r: NotificationsPayload = try await request("GET", "/v1/notifications")
        return r.notifications
    }
    func markAllRead() async throws {
        struct R: Decodable { var updated: Int }
        let _: R = try await request("POST", "/v1/notifications/read", [:])
    }

    // MARK: payouts (demo shortcut; real setup happens on the website)

    func demoLinkPayouts() async throws {
        let _: URLPayload = try await request("POST", "/v1/payouts/onboard")
        struct R: Decodable { var linked: Bool }
        let _: R = try await request("GET", "/v1/payouts/status")
    }
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
