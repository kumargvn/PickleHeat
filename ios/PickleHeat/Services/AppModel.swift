import CoreLocation
import Foundation
import SwiftUI
import UIKit

/// App-wide state: who is signed in, DUPR, home data, unread counts, navigation.
@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable { case launching, signedOut, needsDupr, ready }
    enum Tab: Hashable { case home, events, chats, insights, profile }

    @Published private(set) var phase: Phase = .launching
    @Published private(set) var me: Me?
    @Published private(set) var formPayload: FormPayload?
    @Published private(set) var live: LivePayload?
    @Published private(set) var myEvents: [EventCard] = []
    @Published private(set) var discover: DiscoverPayload?
    @Published private(set) var recommendations: RecommendedPayload?
    @Published var busy = false
    @Published var errorMessage: String?
    @Published var notice: String?
    @Published var selectedTab: Tab = .home
    /// Pushes an event page in the Events tab (deep links, notifications, screenshots).
    @Published var openEventID: String?
    /// Opens a chat in the Chats tab.
    @Published var openChatID: String?
    /// Opens the Create sheet on Home (screenshots).
    @Published var pendingCreate: EventKind?

    let api: APIClient
    private let location = LocationProvider()
    let web = WebAuth()

    init(api: APIClient) {
        self.api = api
    }

    var isDemo: Bool { api.isDemo }
    var userID: String { me?.user.id ?? "" }

    // MARK: lifecycle

    /// App Store screenshots: the screenshot workflow launches the simulator with `-screenshot <scene>`.
    /// Only honoured in demo mode, so it never touches a real account.
    static var screenshotScene: String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-screenshot"), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    func start() async {
        if isDemo, let scene = Self.screenshotScene {
            await stage(scene)
            return
        }
        guard api.signedIn else { phase = .signedOut; return }
        do {
            apply(try await api.me())
            await refreshAll()
        } catch {
            phase = .signedOut
        }
    }

    private func stage(_ scene: String) async {
        if scene == "signin" { phase = .signedOut; return }
        _ = try? await api.signInWithApple(identityToken: "dev:demo", name: nil)
        if scene != "connect" { try? await api.connectDemoDupr() }
        if let me = try? await api.me() { apply(me) }
        await refreshAll()
        switch scene {
        case "insights": selectedTab = .insights
        case "events": selectedTab = .events
        case "league":
            selectedTab = .events
            openEventID = myEvents.first { $0.event.style == .flexLadder }?.event.id
        case "chat":
            selectedTab = .chats
            openChatID = live?.items.first?.chatId
        case "create": pendingCreate = .tournament
        default: selectedTab = .home
        }
    }

    private func apply(_ me: Me) {
        self.me = me
        phase = me.dupr.connected ? .ready : .needsDupr
    }

    func refreshAll() async {
        guard phase == .ready else { return }
        async let a: () = loadForm()
        async let b: () = loadHome()
        async let c: () = loadRecommendations()
        _ = await (a, b, c)
    }

    func refreshMe() async {
        if let m = try? await api.me() { me = m }
    }

    /// Runs an action with a spinner; shows any error.
    func run(_ action: @escaping () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do { try await action() } catch {
            if (error as? ServiceError)?.status == 401 { signOut() }
            errorMessage = error.localizedDescription
        }
    }

    // MARK: account

    func signIn(identityToken: String, name: String?) async {
        await run {
            self.apply(try await self.api.signInWithApple(identityToken: identityToken, name: name))
            await self.refreshAll()
        }
    }

    func signOut() {
        api.signOut()
        me = nil
        formPayload = nil
        live = nil
        myEvents = []
        discover = nil
        recommendations = nil
        selectedTab = .home
        phase = .signedOut
    }

    func deleteAccount() async {
        await run {
            try await self.api.deleteAccount()
            self.signOut()
        }
    }

    func updateProfile(_ fields: [String: Any]) async {
        await run {
            self.me = try await self.api.updateProfile(fields)
            await self.loadRecommendations()
        }
    }

    // MARK: DUPR (one-time connect, then automatic)

    func connectDupr() async {
        await run {
            if let url = try await self.api.duprConnectURL() {
                guard let back = try await self.web.open(url) else { return }
                if URLComponents(url: back, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "status" })?.value != "connected" { return }
            } else {
                try await self.api.connectDemoDupr()
            }
            self.apply(try await self.api.me())
            await self.refreshAll()
        }
    }

    func syncDupr() async {
        await run {
            self.apply(try await self.api.syncDupr())
            await self.refreshAll()
        }
    }

    func disconnectDupr() async {
        await run { self.apply(try await self.api.disconnectDupr()) }
    }

    // MARK: data

    func loadForm() async {
        do { formPayload = try await api.form() } catch { errorMessage = error.localizedDescription }
    }

    func loadHome() async {
        do {
            async let l = api.live()
            async let e = api.myEvents()
            async let d = api.discover()
            async let m = api.me()
            live = try await l
            myEvents = try await e
            discover = try await d
            me = try await m
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadRecommendations() async {
        do {
            var lat = me?.user.lat, lng = me?.user.lng
            if lat == nil || lng == nil, let here = await location.current() {
                lat = here.latitude
                lng = here.longitude
                me = try? await api.updateProfile(["lat": here.latitude, "lng": here.longitude])
            }
            guard lat != nil, lng != nil else { return }
            recommendations = try await api.recommended(lat: lat, lng: lng, radius: me?.user.maxDistanceMiles)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func useCurrentLocation() async {
        guard let here = await location.current() else {
            errorMessage = "Location is off. Type your city instead, or allow location in Settings."
            return
        }
        await updateProfile(["lat": here.latitude, "lng": here.longitude])
    }

    func setHome(city: String) async {
        guard let c = await LocationProvider.geocode(city) else {
            errorMessage = "Couldn't find \(city). Try \"City, State\"."
            return
        }
        await updateProfile(["lat": c.latitude, "lng": c.longitude])
    }

    // MARK: payments live on the website

    /// Opens the PickleHeat website, signed in, at `path` (e.g. "events/<id>/register", "entries/<id>/pay", "payouts").
    /// The app itself never takes payment.
    func openOnWeb(_ path: String) async {
        await run {
            let url = try await self.api.webLink(to: path)
            await UIApplication.shared.open(url)
        }
    }

    /// Demo: there's no website behind the demo, so payment completes in place.
    func demoPay(entryID: String) async {
        await run {
            try await self.api.demoPay(entryID: entryID)
            self.notice = "Demo payment complete. In the real app this happens on the PickleHeat website."
            await self.loadHome()
        }
    }

    func setUpPayouts() async {
        if isDemo {
            await run {
                try await self.api.demoLinkPayouts()
                await self.refreshMe()
                self.notice = "Payouts linked (demo). In the real app you set this up on the PickleHeat website."
            }
        } else {
            await openOnWeb("payouts")
        }
    }

    // MARK: deep links: pickleheat://events/<id>, pickleheat://chats/<id>

    func open(link: String) {
        let parts = link.split(separator: "/").map(String.init)
        guard let head = parts.first else { return }
        switch head {
        case "events" where parts.count > 1:
            selectedTab = .events
            openEventID = parts[1]
        case "chats" where parts.count > 1:
            selectedTab = .chats
            openChatID = parts[1]
        case "entries" where parts.count > 1:
            let entryID = parts[1]
            Task {
                if isDemo { await demoPay(entryID: entryID) } else { await openOnWeb(link) }
            }
        default:
            break
        }
    }

    func handle(url: URL) {
        guard url.scheme == AppConfig.callbackScheme, let host = url.host else { return }
        open(link: ([host] + url.pathComponents.dropFirst()).joined(separator: "/"))
        Task { await loadHome() }
    }
}
