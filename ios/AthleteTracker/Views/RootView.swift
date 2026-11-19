import SwiftUI

/// Picks the screen from the sign-in state.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.phase {
        case .starting:
            ProgressView()
        case .signedOut:
            SignInView()
        case .notAMember(let email):
            NotAMemberView(email: email)
        case .signedIn:
            SessionsListView()
        }
    }
}

struct NotAMemberView: View {
    @Environment(AppModel.self) private var model
    let email: String

    var body: some View {
        ContentUnavailableView {
            Label("Not set up yet", systemImage: "person.crop.circle.badge.questionmark")
        } description: {
            Text("\(email) can sign in, but isn't on the athlete list. Ask your trainer to add you in the console.")
        } actions: {
            Button("Sign out") { Task { await model.signOut() } }
                .buttonStyle(.bordered)
        }
    }
}
