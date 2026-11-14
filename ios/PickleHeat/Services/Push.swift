import UIKit
import UserNotifications

/// Carries push events from UIKit's app delegate to the SwiftUI app model.
/// Events that arrive before the model is listening (a cold start from a tapped notification) are kept.
@MainActor
final class PushBridge {
    static let shared = PushBridge()

    var onToken: ((String) -> Void)? { didSet { flush() } }
    var onOpen: ((String) -> Void)? { didSet { flush() } }
    var onArrive: (() -> Void)?

    private var pendingToken: String?
    private var pendingLink: String?

    func token(_ t: String) { pendingToken = t; flush() }
    func open(_ link: String) { pendingLink = link; flush() }

    private func flush() {
        if let t = pendingToken, let onToken { pendingToken = nil; onToken(t) }
        if let l = pendingLink, let onOpen { pendingLink = nil; onOpen(l) }
    }

    /// TestFlight and App Store builds talk to Apple's production push service; Xcode builds use the sandbox.
    static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    /// Asks once for permission (iOS remembers the answer), then asks Apple for this phone's token.
    func enable() async {
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
        if granted { UIApplication.shared.registerForRemoteNotifications() }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in PushBridge.shared.token(hex) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // No token (simulator, no network): the app works the same, just without lock-screen alerts.
    }

    /// App is open: still show the banner, and refresh the badges.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        await MainActor.run { PushBridge.shared.onArrive?() }
        return [.banner, .sound]
    }

    /// The player tapped a notification: open what it's about.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let link = response.notification.request.content.userInfo["link"] as? String
        if let link {
            await MainActor.run { PushBridge.shared.open(link) }
        }
    }
}
