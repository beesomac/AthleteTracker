import SwiftUI

/// The athlete's published sessions: coming up first, then past ones.
struct SessionsListView: View {
    @Environment(AppModel.self) private var model

    private var today: String { SessionDate.today }
    // In-order programs (body.sequence) split by done / not done; dated ones by today's date.
    private var upcoming: [ProgramRow] { model.programs.filter { $0.body.sequence ? !model.isDone($0) : $0.date >= today } }
    private var past: [ProgramRow] { model.programs.filter { $0.body.sequence ? model.isDone($0) : $0.date < today }.reversed() }

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
            .toolbar { AccountMenu() }
        }
    }

    private func row(_ p: ProgramRow) -> some View {
        NavigationLink(value: p) {
            SessionRow(program: p, when: model.whenLabel(p), done: model.doneSets(p), finished: model.finished[p.id] != nil)
        }
    }
}

struct SessionRow: View {
    let program: ProgramRow
    let when: String
    let done: Int
    let finished: Bool

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(program.displayTitle).font(.headline)
                HStack(spacing: 6) {
                    Text(when)
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
