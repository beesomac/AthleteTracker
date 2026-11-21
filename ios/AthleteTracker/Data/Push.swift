import Foundation
import Observation
import Supabase
import UIKit
import UserNotifications

/// Apple push notifications. After sign-in the app asks once for permission, registers with
/// APNs and saves this phone's token in `device_tokens` (supabase/009_push.sql). New rows in
/// `notifications` are then pushed by the "push" edge function. Signing out removes the token.
@Observable
final class Push {
    static let shared = Push()

    /// Where a tapped notification should take you. MainTabView follows it (and clears it) as soon
    /// as it's on screen, so it works whether the tap launched the app or brought it back.
    struct Route: Equatable {
        let id: String?
        let kind: String?
        let wodId: String?
        let at = Date()        // two taps on the same board are still two changes
    }
    var route: Route?

    /// Posted when a notification is tapped, so MainTabView can follow `route` straight away.
    static let tapped = Notification.Name("PushTapped")

    private var token: String?
    private var signedIn = false

    /// Debug builds from Xcode get sandbox tokens; TestFlight and App Store builds get production.
    /// (The edge function corrects a wrong guess by itself.)
    private var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    /// Call after a member signs in. Only the first call shows the permission prompt.
    func signedInAsMember() async {
        signedIn = true
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        guard granted else { return }
        UIApplication.shared.registerForRemoteNotifications()
        if token != nil { await upload() }
    }

    /// Call before signing out, while the session can still delete the token.
    func signingOut() async {
        signedIn = false
        guard let token else { return }
        _ = try? await supabase.rpc("unregister_device_token", params: ["p_token": token]).execute()
    }

    func gotToken(_ data: Data) {
        token = data.map { String(format: "%02x", $0) }.joined()
        Task { await upload() }
    }

    private func upload() async {
        guard signedIn, let token else { return }
        do {
            try await supabase.rpc("register_device_token",
                                   params: ["p_token": token, "p_environment": environment]).execute()
        } catch {
            print("Push: couldn't save device token:", error)
        }
    }

    /// A notification was tapped. MainTabView opens it (and marks it read) once the app is signed in
    /// and loaded, which on a cold start is a moment after this runs.
    func opened(id: String?, kind: String?, wodId: String?) {
        print("Push: tapped id=\(id ?? "-") kind=\(kind ?? "-") wod=\(wodId ?? "-")")
        route = Route(id: id, kind: kind, wodId: wodId)
        NotificationCenter.default.post(name: Self.tapped, object: nil)
        // Mark it read straight away when we're already signed in (resumed from the background);
        // on a cold start MainTabView does it again once the session is back.
        if let id { Task { await markRead(id) } }
    }

    /// Same as clicking it in the web bell. Needs the signed-in session, so it runs from MainTabView.
    func markRead(_ id: String) async {
        _ = try? await supabase.from("notifications")
            .update(["read_at": ISO8601DateFormatter().string(from: Date())])
            .eq("id", value: id)
            .execute()
    }
}

/// Receives the APNs token and notification taps from iOS.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    /// iPhone: portrait, except while the WOD timer runs (OrientationLock). iPad: any way up.
    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        OrientationLock.mask
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Push.shared.gotToken(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("Push: registration failed:", error.localizedDescription)
    }

    /// Show the banner even when the app is open.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        print("Push: didReceive \(info.keys.map { "\($0)" }.sorted())")
        let id = info["id"] as? String
        let kind = info["kind"] as? String
        let wodId = info["wod_id"] as? String
        await MainActor.run { Push.shared.opened(id: id, kind: kind, wodId: wodId) }
    }
}
