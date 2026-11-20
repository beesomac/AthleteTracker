import SwiftUI

/// 1RMs and benchmark WODs (the Girls and the CrossFit Open), with the athlete's best.
struct BenchmarksView: View {
    @Environment(AppModel.self) private var model
    enum Kind: String, CaseIterable, Identifiable {
        case lifts = "1RM", girls = "Girls", open = "Open"
        var id: String { rawValue }
    }
    @SceneStorage("benchmark-kind") private var kind: Kind = .lifts
    @State private var editing: LiftEdit?

    struct LiftEdit: Identifiable {
        let key: String
        let name: String
        let max: LiftMax?
        var id: String { key }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Benchmarks", selection: $kind) {
                        ForEach(Kind.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                switch kind {
                case .lifts: lifts
                case .girls: Section { ForEach(WodLibrary.girls) { wodRow($0) } }
                case .open: openSections
                }
            }
            .navigationTitle("Benchmarks")
            .navigationDestination(for: LibraryWod.self) { BenchmarkDetailView(wod: $0) }
            .refreshable { await model.reload() }
            .toolbar { AccountMenu() }
            .sheet(item: $editing) { e in
                OneRepMaxSheet(
                    title: e.name,
                    current: e.max?.kg,
                    testedOn: e.max?.testedOn.flatMap(SessionDate.parse),
                    canRemove: e.max != nil,
                    onRemove: { try await model.deleteMax(key: e.key) },
                    save: { kg in try await model.saveMax(key: e.key, name: e.name, kg: kg, on: .now) },
                    saveWithDate: { kg, day in try await model.saveMax(key: e.key, name: e.name, kg: kg, on: day) }
                )
            }
        }
    }

    @ViewBuilder private var lifts: some View {
        Section {
            ForEach(model.liftList) { lift in
                Button {
                    editing = LiftEdit(key: lift.key, name: lift.name, max: lift.max)
                } label: {
                    HStack {
                        Text(lift.name).foregroundStyle(.primary)
                        Spacer()
                        if let m = lift.max {
                            VStack(alignment: .trailing, spacing: 2) {
                                Text("\(SessionFormat.number(m.kg)) kg").font(.body.monospacedDigit().bold())
                                if let on = m.testedOn {
                                    Text(SessionDate.label(on)).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        } else {
                            Text("Add").foregroundStyle(.tint)
                        }
                    }
                }
            }
        } footer: {
            Text("Logging a 1RM in a program fills these in automatically when it beats your number.")
        }
    }

    @ViewBuilder private var openSections: some View {
        let years = Dictionary(grouping: WodLibrary.open, by: { $0.year ?? 0 }).sorted { $0.key > $1.key }
        ForEach(years, id: \.key) { entry in
            Section(entry.key > 0 ? String(entry.key) : "Open") {
                ForEach(entry.value) { wodRow($0) }
            }
        }
    }

    private func wodRow(_ wod: LibraryWod) -> some View {
        NavigationLink(value: wod) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(wod.name).font(.headline)
                    Text(wod.format ?? WodScore.label(wod.score)).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
                if let best = model.best(for: wod) {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(WodScore.format(wod.score, best.score)).font(.body.monospacedDigit().bold())
                        Text(best.rx ? "Rx" : "Scaled").font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

/// One benchmark WOD: the workout, the athlete's history, and Log score.
struct BenchmarkDetailView: View {
    @Environment(AppModel.self) private var model
    let wod: LibraryWod
    @State private var logging = false
    @State private var timer: WodTimerItem?

    private var plan: WodPlan { WodPlan.make(library: wod) }

    var body: some View {
        List {
            Section {
                if let d = wod.description, !d.isEmpty { Text(d) }
                if let f = wod.format { LabeledContent("Format", value: f) }
                LabeledContent("Score", value: WodScore.label(wod.score))
                Button {
                    timer = WodTimerItem(plan: plan)
                } label: {
                    Label("Start WOD", systemImage: "stopwatch")
                }
            }

            Section("Your scores") {
                let history = model.history(for: wod)
                if history.isEmpty {
                    Text("Not done yet.").foregroundStyle(.secondary)
                }
                let best = model.best(for: wod)
                ForEach(history) { r in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(r.performedOn.map(SessionDate.label) ?? "")
                            if let note = r.note, !note.isEmpty {
                                Text(note).font(.caption).foregroundStyle(.secondary)
                            }
                            if let d = r.detail, !d.roundTimes.isEmpty {
                                Text("Rounds " + d.roundTimes.map { WodClock.text($0, tenths: true) }.joined(separator: " · "))
                                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        if r.id == best?.id { Image(systemName: "star.fill").foregroundStyle(.yellow).accessibilityLabel("Best") }
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(WodScore.format(wod.score, r.score)).font(.body.monospacedDigit())
                            Text(r.rx ? "Rx" : "Scaled").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }

            let boards = model.boards(for: wod)
            if !boards.isEmpty {
                Section("Leaderboards") {
                    ForEach(boards) { b in
                        NavigationLink(value: b) {
                            LabeledContent(b.name, value: b.isOpen ? "Open" : "Closed")
                        }
                    }
                }
            }
        }
        .navigationTitle(wod.name)
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: WodRow.self) { LeaderboardDetailView(wod: $0) }
        .refreshable { await model.reload() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Log score") { logging = true }
            }
        }
        .sheet(isPresented: $logging) {
            LogScoreSheet(title: wod.name, scoreType: wod.score, timeCap: wod.cap, plan: plan) { score, rx, day, note, detail in
                try await model.logBenchmark(wod, score: score, rx: rx, on: day, note: note, detail: detail)
            }
        }
        .wodTimer($timer) { score, rx, day, note, detail in
            try await model.logBenchmark(wod, score: score, rx: rx, on: day, note: note, detail: detail)
        }
    }
}
