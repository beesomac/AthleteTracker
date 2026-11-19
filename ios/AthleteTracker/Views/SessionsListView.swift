import SwiftUI

/// The athlete's published sessions: coming up first, then past ones.
struct SessionsListView: View {
    @Environment(AppModel.self) private var model

    private var today: String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: .now)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
    private var upcoming: [ProgramRow] { model.programs.filter { $0.date >= today } }
    private var past: [ProgramRow] { model.programs.filter { $0.date < today }.reversed() }

    var body: some View {
        NavigationStack {
            List {
                if let error = model.loadError {
                    Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
                }
                if !upcoming.isEmpty {
                    Section("Coming up") { ForEach(upcoming) { row($0) } }
                }
                if !past.isEmpty {
                    Section("Earlier") { ForEach(past) { row($0) } }
                }
            }
            .overlay {
                if model.programs.isEmpty {
                    if model.isLoading {
                        ProgressView()
                    } else if model.loadError == nil {
                        ContentUnavailableView("No sessions yet", systemImage: "calendar",
                                               description: Text("Published sessions show up here."))
                    }
                }
            }
            .navigationTitle(model.athleteName.isEmpty ? "Sessions" : model.athleteName)
            .navigationDestination(for: ProgramRow.self) { SessionDetailView(program: $0) }
            .refreshable { await model.reload() }
            .toolbar { toolbar }
        }
    }

    private func row(_ p: ProgramRow) -> some View {
        NavigationLink(value: p) {
            SessionRow(program: p, done: model.doneSets(p), finished: model.finished[p.id] != nil)
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
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

struct SessionRow: View {
    let program: ProgramRow
    let done: Int
    let finished: Bool

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(program.displayTitle).font(.headline)
                HStack(spacing: 6) {
                    Text(SessionDate.label(program.date))
                    if let short = program.body.short, short != program.displayTitle {
                        Text("· \(short)")
                    }
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
            Spacer()
            if finished {
                Image(systemName: "checkmark.seal.fill").foregroundStyle(.green)
                    .accessibilityLabel("Finished")
            } else if program.totalSets > 0 && done > 0 {
                Text("\(done)/\(program.totalSets)")
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}
