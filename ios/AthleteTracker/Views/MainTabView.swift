import SwiftUI

/// The start screen: Program, Leaderboards and Benchmarks.
struct MainTabView: View {
    enum TabID: String { case program, leaderboards, benchmarks }
    @SceneStorage("tab") private var tab: TabID = .program

    var body: some View {
        TabView(selection: $tab) {
            Tab("Program", systemImage: "calendar", value: .program) {
                SessionsListView()
            }
            Tab("Leaderboards", systemImage: "trophy", value: .leaderboards) {
                LeaderboardsView()
            }
            Tab("Benchmarks", systemImage: "chart.bar.xaxis", value: .benchmarks) {
                BenchmarksView()
            }
        }
        .onAppear(perform: openFromPush)
        .onChange(of: Push.shared.openedKind) { openFromPush() }
    }

    /// A tapped push: scores and board invites open Leaderboards, "done this before" opens Program.
    private func openFromPush() {
        guard let kind = Push.shared.openedKind else { return }
        Push.shared.openedKind = nil
        tab = kind == "wod_again" ? .program : .leaderboards
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
