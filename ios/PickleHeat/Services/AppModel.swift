import CoreLocation
import Foundation
import SwiftUI

/// App-wide state: who is signed in, their DUPR link, form, recommendations and events.
@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable { case launching, signedOut, needsDupr, ready }

    @Published private(set) var phase: Phase = .launching
    @Published private(set) var me: Me?
    @Published private(set) var formPayload: FormPayload?
    @Published private(set) var recommendations: RecommendedPayload?
    @Published private(set) var myEvents: [PickleHeatEvent] = []
    @Published var busy = false
    @Published var errorMessage: String?
    @Published var selectedTab: Tab = .home
    /// An event to show in the Events tab (deep links, screenshots).
    @Published var openEventID: String?
    /// Opens the Create sheet on Home (screenshots).
    @Published var pendingCreate: EventKind?

    enum Tab: Hashable { case home, events, insights, profile }

    let service: PickleHeatService
    private let location = LocationProvider()
    let web = WebAuth()

    init(service: PickleHeatService) {
        self.service = service
    }

    var isDemo: Bool { service.isDemo }
    var userID: String { me?.user.id ?? "" }

    // MARK: lifecycle

    /// App Store screenshots: the screenshot workflow launches the simulator app with `-screenshot <scene>`.
    /// Only honoured in demo mode, so it can never touch a real account.
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
        do {
            if let me = try await service.restore() {
                apply(me)
                await refreshAll()
            } else {
                phase = .signedOut
            }
        } catch {
            phase = .signedOut
        }
    }

    private func stage(_ scene: String) async {
        if scene == "signin" { phase = .signedOut; return }
        _ = try? await service.signIn(identityToken: "demo", name: nil)
        if scene == "connect" {
            if let me = try? await service.me() { apply(me) }
            return
        }
        if let me = try? await service.completeDuprConnect() { apply(me) }
        await refreshAll()
        switch scene {
        case "insights": selectedTab = .insights
        case "events": selectedTab = .events
        case "league":
            selectedTab = .events
            openEventID = SampleData.shared.leagues.first?.id
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
        async let f: () = loadForm()
        async let r: () = loadRecommendations()
        async let e: () = loadEvents()
        _ = await (f, r, e)
    }

    /// Runs an action, showing a spinner and any error.
    func run(_ action: @escaping () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do { try await action() } catch {
            if (error as? ServiceError)?.status == 401 { phase = .signedOut }
            errorMessage = error.localizedDescription
        }
    }

    // MARK: account

    func signIn(identityToken: String, name: String?) async {
        await run {
            let me = try await self.service.signIn(identityToken: identityToken, name: name)
            self.apply(me)
            await self.refreshAll()
        }
    }

    func signOut() {
        service.signOut()
        me = nil
        formPayload = nil
        recommendations = nil
        myEvents = []
        selectedTab = .home
        phase = .signedOut
    }

    func deleteAccount() async {
        await run {
            try await self.service.deleteAccount()
            self.signOut()
        }
    }

    func updateProfile(name: String? = nil, lat: Double? = nil, lng: Double? = nil, maxDistanceMiles: Double? = nil, formats: [EventFormat]? = nil) async {
        await run {
            self.me = try await self.service.updateProfile(name: name, lat: lat, lng: lng, maxDistanceMiles: maxDistanceMiles, formats: formats)
            await self.loadRecommendations()
        }
    }

    // MARK: DUPR (one-time connect, then automatic)

    func connectDupr() async {
        await run {
            if let url = try await self.service.duprConnectURL() {
                guard let back = try await self.web.open(url) else { return } // closed the sheet
                if URLComponents(url: back, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "status" })?.value != "connected" { return }
            }
            let me = try await self.service.completeDuprConnect()
            self.apply(me)
            await self.refreshAll()
        }
    }

    func syncDupr() async {
        await run {
            self.apply(try await self.service.syncDupr())
            await self.refreshAll()
        }
    }

    func disconnectDupr() async {
        await run { self.apply(try await self.service.disconnectDupr()) }
    }

    // MARK: data

    func loadForm() async {
        do { formPayload = try await service.form() } catch { errorMessage = error.localizedDescription }
    }

    func loadEvents() async {
        do { myEvents = try await service.events() } catch { errorMessage = error.localizedDescription }
    }

    func loadRecommendations() async {
        do {
            var lat = me?.user.lat, lng = me?.user.lng
            if lat == nil || lng == nil, let here = await location.current() {
                lat = here.latitude
                lng = here.longitude
                me = try? await service.updateProfile(name: nil, lat: lat, lng: lng, maxDistanceMiles: nil, formats: nil)
            }
            guard lat != nil, lng != nil else { return }
            recommendations = try await service.recommended(lat: lat, lng: lng, radius: me?.user.maxDistanceMiles)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func useCurrentLocation() async {
        guard let here = await location.current() else {
            errorMessage = "Location is off. Type your city instead, or allow location in Settings."
            return
        }
        await updateProfile(lat: here.latitude, lng: here.longitude)
    }

    func setHome(city: String) async {
        guard let c = await LocationProvider.geocode(city) else {
            errorMessage = "Couldn't find \(city). Try \"City, State\"."
            return
        }
        await updateProfile(lat: c.latitude, lng: c.longitude)
    }

    // MARK: payouts

    func linkPayouts() async {
        await run {
            if let url = try await self.service.onboardPayouts() {
                _ = try await self.web.open(url)
            }
            let status = try await self.service.payoutStatus()
            if var me = self.me {
                me.payouts = status
                self.me = me
            }
        }
    }

    /// Opens a checkout page; returns when the person comes back to the app.
    func pay(_ checkoutURL: URL) async {
        await run { _ = try await self.web.open(checkoutURL) }
    }

    // MARK: deep links (pickleheat://events/<id>)

    func handle(url: URL) {
        guard url.scheme == AppConfig.callbackScheme else { return }
        if url.host == "events" {
            let id = url.pathComponents.dropFirst().first
            if let id { selectedTab = .events; openEventID = id }
        }
    }
}
