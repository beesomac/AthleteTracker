import SwiftUI

/// The start screen: Program, Leaderboards, Benchmarks and Profile.
struct MainTabView: View {
    enum TabID: String { case program, leaderboards, benchmarks, profile }
    @SceneStorage("tab") private var tab: TabID = .program
    @Environment(AppModel.self) private var model
    @State private var boardPath: [WodRow] = []
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView(selection: $tab) {
            Tab("Program", systemImage: "calendar", value: .program) {
                SessionsListView()
            }
            Tab("Leaderboards", systemImage: "trophy", value: .leaderboards) {
                LeaderboardsView(path: $boardPath)
            }
            Tab("Benchmarks", systemImage: "chart.bar.xaxis", value: .benchmarks) {
                BenchmarksView()
            }
            Tab("Profile", systemImage: "person.crop.circle", value: .profile) {
                ProfileView()
            }
        }
        // Three ways in, so a tap is never missed: the view appearing (cold start), the tap itself
        // (app already running), and the app coming back to the front (resumed from the background).
        .onAppear { follow(Push.shared.route) }
        .onReceive(NotificationCenter.default.publisher(for: Push.tapped)) { _ in follow(Push.shared.route) }
        .onChange(of: scenePhase) { _, phase in if phase == .active { follow(Push.shared.route) } }
    }

    /// A tapped push: a score or board invite opens that leaderboard (fresh, so the new score shows);
    /// "you've done this before" opens Program.
    /// Everything happens after a reload: on a cold start the tab and the session are still being
    /// restored when the tap arrives, and switching straight away gets undone.
    private func follow(_ route: Push.Route?) {
        guard let route else { return }
        print("Push: following kind=\(route.kind ?? "-") wod=\(route.wodId ?? "-")")
        Push.shared.route = nil
        // Switch now (enough when the app was already running), and again after the reload below
        // in case a cold start restores the old tab in between.
        tab = route.kind == "wod_again" ? .program : .leaderboards
        Task {
            await model.reload()
            if let id = route.id { await Push.shared.markRead(id) }
            if route.kind == "wod_again" {
                tab = .program
                return
            }
            tab = .leaderboards
            if let wodId = route.wodId?.lowercased(),
               let wod = model.wods.first(where: { $0.id.lowercased() == wodId }) {
                boardPath = [wod]
                print("Push: opened board \(wod.name)")
            } else {
                print("Push: board \(route.wodId ?? "-") not in \(model.wods.count) boards")
            }
        }
    }
}

/// Person menu in every tab: a trainer's athlete picker, and sign out.
struct AccountMenu: ToolbarContent {
    @Environment(AppModel.self) private var model

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if model.isTrainer && !model.athletes.isEmpty {
                    Picker("Athlete", selection: Binding(
                        get: { model.athleteEmail ?? "" },
                        set: { email in Task { await model.pickAthlete(email) } }
                    )) {
                        ForEach(model.athletes) { Text($0.name).tag($0.email) }
                    }
                    Divider()
                }
                if let email = model.email { Text(email) }
                Button("Sign out", role: .destructive) { Task { await model.signOut() } }
            } label: {
                Image(systemName: model.isTrainer ? "person.2.circle" : "person.circle")
            }
        }
    }
}
