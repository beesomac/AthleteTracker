import UIKit

/// The iPhone app is portrait, but the WOD timer turns the phone sideways so the clock can be
/// as big as possible. The app delegate asks this which way up the app may be.
enum OrientationLock {
    static var mask: UIInterfaceOrientationMask {
        UIDevice.current.userInterfaceIdiom == .phone ? phoneMask : .all
    }

    private static var phoneMask: UIInterfaceOrientationMask = .portrait

    /// Landscape on (the timer is running) or back to portrait.
    static func landscape(_ on: Bool) {
        guard UIDevice.current.userInterfaceIdiom == .phone else { return }
        let next: UIInterfaceOrientationMask = on ? .landscape : .portrait
        guard next != phoneMask else { return }
        phoneMask = next
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            for window in scene.windows {
                var vc: UIViewController? = window.rootViewController
                while let v = vc {
                    v.setNeedsUpdateOfSupportedInterfaceOrientations()
                    vc = v.presentedViewController
                }
            }
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: on ? .landscapeRight : .portrait)) { _ in }
        }
    }
}
