import SwiftUI

/// Every leaderboard the trainer has opened: open ones first, then closed.
struct LeaderboardsView: View {
    @Environment(AppModel.self) private var model

    private var open: [WodRow] { model.wods.filter(\.isOpen) }
    private var closed: [WodRow] { model.wods.filter { !$0.isOpen } }

    var body: some View {
        NavigationStack {
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

struct LeaderboardDetailView: View {
    @Environment(AppModel.self) private var model
    let wod: WodRow
    @State private var logging = false
    @State private var timer: WodTimerItem?

    private var plan: WodPlan { WodPlan.make(library: WodLibrary.find(wod.libraryId), board: wod) }

    var body: some View {
        List {
            infoSection
            lastRoundsSection
            boardSection
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
            LogScoreSheet(title: wod.name, scoreType: wod.scoreType, timeCap: wod.timeCapSeconds, plan: plan, save: logScore)
        }
        .wodTimer($timer, log: wod.isOpen ? logScore : nil)
    }

    private func logScore(_ score: Double, _ rx: Bool, _ day: Date, _ note: String, _ detail: WodDetail?) async throws {
        try await model.logResult(on: wod, score: score, rx: rx, on: day, note: note, detail: detail)
    }

    @ViewBuilder private var infoSection: some View {
        Section {
            if let d = wod.description, !d.isEmpty { Text(d) }
            LabeledContent("Score", value: WodScore.label(wod.scoreType))
            if let cap = wod.timeCapSeconds, cap > 0 {
                LabeledContent("Time cap", value: WodScore.format("time", Double(cap)))
            }
            if let lib = WodLibrary.find(wod.libraryId) {
                NavigationLink("Benchmark history") { BenchmarkDetailView(wod: lib) }
            }
            Button {
                timer = WodTimerItem(plan: plan)
            } label: {
                Label("Start WOD", systemImage: "stopwatch")
            }
        }
    }

    /// The athlete's latest score here that has round times.
    private var lastDetail: WodDetail? {
        let rows: [ResultRow] = model.history(for: wod)
        for r in rows {
            if let d = r.detail, !d.roundTimes.isEmpty { return d }
        }
        return nil
    }

    @ViewBuilder private var lastRoundsSection: some View {
        if let d = lastDetail {
            Section("Your last rounds") { RoundTimesView(detail: d) }
        }
    }

    @ViewBuilder private var boardSection: some View {
        let rows: [RankedRow] = model.boardRows(wod)
        Section("Leaderboard") {
            if rows.isEmpty {
                Text("No scores yet. Be the first.").foregroundStyle(.secondary)
            }
            ForEach(rows) { (item: RankedRow) in
                BoardLine(rank: item.rank, row: item.row, scoreType: wod.scoreType)
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
