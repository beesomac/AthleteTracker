import SwiftUI

/// Every leaderboard the trainer has opened: open ones first, then closed.
struct LeaderboardsView: View {
    @Environment(AppModel.self) private var model
    /// The open board, if any. MainTabView sets it when a push is tapped.
    @Binding var path: [WodRow]

    private var open: [WodRow] { model.wods.filter(\.isOpen) }
    private var closed: [WodRow] { model.wods.filter { !$0.isOpen } }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if !open.isEmpty {
                    Section("Open") { ForEach(open) { row($0) } }
                }
                if !closed.isEmpty {
                    Section("Closed") { ForEach(closed) { row($0) } }
                }
            }
            .overlay {
                if model.wods.isEmpty && !model.isLoading {
                    ContentUnavailableView("No leaderboards yet", systemImage: "trophy",
                                           description: Text("Leaderboards appear when your trainer adds a WOD."))
                }
            }
            .navigationTitle("Leaderboards")
            .navigationDestination(for: WodRow.self) { LeaderboardDetailView(wod: $0) }
            .refreshable { await model.reload() }
            .toolbar { AccountMenu() }
        }
    }

    private func row(_ wod: WodRow) -> some View {
        let rows = model.boardRows(wod)
        let mine = rows.first { $0.row.isMe }
        return NavigationLink(value: wod) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(wod.name).font(.headline)
                    Text("\(WodScore.label(wod.scoreType)) · \(rows.count) \(rows.count == 1 ? "score" : "scores")")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
                if let mine {
                    Text("#\(mine.rank)").font(.headline.monospacedDigit()).foregroundStyle(.tint)
                        .accessibilityLabel("You're ranked \(mine.rank)")
                }
            }
        }
    }
}

/// One leaderboard: the workout, everyone's best scores, and your own scores (swipe to delete one
/// entered by mistake).
struct LeaderboardDetailView: View {
    @Environment(AppModel.self) private var model
    let wod: WodRow
    @State private var logging = false
    @State private var deleting: ResultRow?
    @State private var deleteError: String?

    private var plan: WodPlan { WodPlan.make(library: WodLibrary.find(wod.libraryId), board: wod) }
    private var canDelete: Bool { wod.isOpen || model.isTrainer }

    var body: some View {
        List {
            workoutSection
            boardSection
            historySection
        }
        .navigationTitle(wod.name)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.reload() }
        .toolbar {
            if wod.isOpen {
                ToolbarItem(placement: .primaryAction) {
                    Button("Log score") { logging = true }
                }
            }
        }
        .sheet(isPresented: $logging) {
            LogScoreSheet(title: wod.name, scoreType: wod.scoreType, timeCap: wod.timeCapSeconds, plan: plan, save: saver)
        }
        .confirmationDialog("Delete this score?", isPresented: deletingShown, titleVisibility: .visible,
                            presenting: deleting) { (r: ResultRow) in
            Button("Delete \(WodScore.format(wod.scoreType, r.score))", role: .destructive) { delete(r) }
        } message: { (r: ResultRow) in
            Text(r.performedOn.map { SessionDate.label($0) } ?? "")
        }
        .alert("Couldn't delete", isPresented: errorShown) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(deleteError ?? "")
        }
    }

    private var deletingShown: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    }

    private var errorShown: Binding<Bool> {
        Binding(get: { deleteError != nil }, set: { if !$0 { deleteError = nil } })
    }

    /// Saves a score on this board.
    private var saver: ScoreSaver {
        let model: AppModel = self.model
        let wod: WodRow = self.wod
        let save: ScoreSaver = { score, rx, day, note, detail in
            try await model.logResult(on: wod, score: score, rx: rx, on: day, note: note, detail: detail)
        }
        return save
    }

    private func delete(_ r: ResultRow) {
        deleting = nil
        Task {
            do { try await model.deleteResult(r) } catch { deleteError = error.localizedDescription }
        }
    }

    @ViewBuilder private var workoutSection: some View {
        Section("Workout") {
            if let d = wod.description, !d.isEmpty { Text(d) }
            if let cap = wod.timeCapSeconds, cap > 0 {
                LabeledContent("Time cap", value: WodScore.format("time", Double(cap)))
            }
        }
    }

    @ViewBuilder private var boardSection: some View {
        let rows: [RankedRow] = model.boardRows(wod)
        Section("Scores") {
            if rows.isEmpty {
                Text("No scores yet.").foregroundStyle(.secondary)
            }
            ForEach(rows) { (item: RankedRow) in
                BoardLine(rank: item.rank, row: item.row, scoreType: wod.scoreType)
            }
        }
    }

    @ViewBuilder private var historySection: some View {
        let mine: [ResultRow] = model.history(for: wod)
        if !mine.isEmpty {
            Section {
                ForEach(mine) { (r: ResultRow) in
                    HistoryLine(result: r, scoreType: wod.scoreType)
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            if canDelete {
                                Button("Delete", role: .destructive) { deleting = r }
                            }
                        }
                }
            } header: {
                Text("My history")
            } footer: {
                if canDelete { Text("Entered one wrong? Swipe left on it to delete it.") }
            }
        }
    }
}

/// One of your own scores: date, score, Rx, note and round times.
struct HistoryLine: View {
    let result: ResultRow
    let scoreType: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(result.performedOn.map { SessionDate.label($0) } ?? "").foregroundStyle(.secondary)
                Spacer()
                Text(WodScore.format(scoreType, result.score)).font(.body.monospacedDigit().weight(.semibold))
                Text(result.rx ? "Rx" : "Scaled").font(.caption2).foregroundStyle(.secondary)
            }
            if let note = result.note, !note.isEmpty {
                Text(note).font(.caption).foregroundStyle(.secondary)
            }
            if let summary = result.detail?.summary {
                Text(summary).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct BoardLine: View {
    let rank: Int
    let row: BoardRow
    let scoreType: String

    var body: some View {
        HStack(spacing: 12) {
            Text("\(rank)")
                .font(.headline.monospacedDigit())
                .frame(minWidth: 28)
                .foregroundStyle(rank <= 3 ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
            VStack(alignment: .leading, spacing: 2) {
                Text(row.athleteName ?? "Athlete").fontWeight(row.isMe ? .bold : .regular)
                if let on = row.performedOn {
                    Text(SessionDate.label(on)).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(WodScore.format(scoreType, row.score)).font(.body.monospacedDigit())
                Text(row.rx ? "Rx" : "Scaled").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .listRowBackground(row.isMe ? Color.accentColor.opacity(0.08) : nil)
    }
}
