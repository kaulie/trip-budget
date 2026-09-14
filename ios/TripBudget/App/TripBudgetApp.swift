import SwiftUI

@main
struct TripBudgetApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .task { await model.bootstrap() }
        }
        .onChange(of: scenePhase) { _, phase in
            // Coming back from the background is exactly when other devices'
            // expenses should show up.
            guard phase == .active, model.phase == .ready else { return }
            Task { await model.sync() }
        }
    }
}
