import SwiftUI
import UIKit

final class CrossSyncAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        guard identifier == BackgroundUploadSession.identifier else {
            completionHandler()
            return
        }
        BackgroundUploadSession.shared.setBackgroundCompletionHandler(completionHandler)
    }
}

@main
struct CrossSyncMobileApp: App {
    @UIApplicationDelegateAdaptor(CrossSyncAppDelegate.self) private var appDelegate
    @StateObject private var model = TransferViewModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
        }
    }
}

