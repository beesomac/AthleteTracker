import SwiftUI

/// The start screen: Program, Leaderboards and Benchmarks.
struct MainTabView: View {
    enum TabID: String { case program, leaderboards, benchmarks }
    @SceneStorage("tab") private var tab: TabID = .program
    @Environment(AppModel.self) private var model
    @State private var boardPath: [WodRow] = []

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
        }
        .onAppear { follow(Push.shared.route) }
        .onChange(of: Push.shared.route) { _, route in follow(route) }
    }

    /// A tapped push: a score or board invite opens that leaderboard (fresh, so the new score shows);
    /// "you've done this before" opens Program.
    /// Everything happens after a reload: on a cold start the tab and the session are still being
    /// restored when the tap arrives, and switching straight away gets undone.
    private func follow(_ route: Push.Route?) {
        guard let route else { return }
        Push.shared.route = nil
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
