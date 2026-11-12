import SwiftUI

struct ContentView: View {
    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                Image(systemName: "figure.strengthtraining.traditional")
                    .font(.system(size: 56))
                    .foregroundStyle(.tint)
                Text("AthleteTracker")
                    .font(.title.bold())
                Text("Rehab sessions for Trae")
                    .foregroundStyle(.secondary)
            }
            .padding()
            .navigationTitle("Sessions")
        }
    }
}

#Preview {
    ContentView()
}
