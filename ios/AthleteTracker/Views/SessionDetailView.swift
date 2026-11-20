import SwiftUI

/// One session, block by block. Read-only: shows what's planned and what's been logged.
struct SessionDetailView: View {
    @Environment(AppModel.self) private var model
    let program: ProgramRow
    @State private var timer: WodTimerItem?
    @State private var timerBlock: Block?

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(SessionDate.label(program.date)).foregroundStyle(.secondary)
                    if program.totalSets > 0 {
                        ProgressView(value: Double(model.doneSets(program)), total: Double(program.totalSets)) {
                            Text("\(model.doneSets(program)) of \(program.totalSets) sets done")
                                .font(.footnote)
                        }
                    }
                    if let f = model.finished[program.id] {
                        Label("Finished\(f.finishedAt.map { " " + finishedLabel($0) } ?? "")",
                              systemImage: "checkmark.seal.fill")
                            .foregroundStyle(.green)
                            .font(.subheadline)
                    }
                }
                if let summary = program.body.summary, !summary.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(program.body.summaryLabel ?? "Ankle check").font(.caption.bold()).foregroundStyle(.secondary)
                        Text(summary)
                    }
                }
            }

            ForEach(program.body.blocks) { block in
                Section {
                    if let note = block.note, !note.isEmpty {
                        Text(note).font(.callout).foregroundStyle(.secondary)
                    }
                    if block.isWod {
                        Button { startWod(block) } label: {
                            Label("Start WOD", systemImage: "stopwatch")
                        }
                    }
                    blockRows(block)
                } header: {
                    HStack {
                        Text([block.key, block.name].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        Spacer()
                        if let rounds = block.rounds, !rounds.isEmpty { Text(rounds) }
                    }
                }
            }

            if !program.body.next.isEmpty {
                Section("Next progressions") {
                    ForEach(program.body.next, id: \.self) { Text($0) }
                }
            }
            if let plan = program.body.planUrl, let url = URL(string: plan) {
                Section { Link(program.body.planLabel ?? "Full plan", destination: url) }
            }
        }
        .navigationTitle(program.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.reload() }
        .wodTimer($timer, log: logger(for: timerBlock))
    }

    /// A library WOD with rounds shows round by round (21.1: 1 + 10, 3 + 30, …);
    /// everything else shows its exercises.
    @ViewBuilder
    private func blockRows(_ block: Block) -> some View {
        let lib: LibraryWod? = WodLibrary.find(block.wod)
        if let lib, let rounds = lib.roundSets, !rounds.isEmpty {
            WodRoundsList(rounds: rounds, repeats: lib.roundRepeat)
        } else {
            ForEach(block.exercises) { (ex: Exercise) in
                ExerciseRow(program: program, exercise: ex, tick: model.tick(program, ex))
            }
        }
    }

    private func startWod(_ block: Block) {
        let lib: LibraryWod? = WodLibrary.find(block.wod)
        let plan: WodPlan = WodPlan.make(library: lib, block: block, board: board(for: block))
        timerBlock = block
        timer = WodTimerItem(plan: plan)
    }

    /// The leaderboard for a WOD block: the one the trainer picked, else an open one for the same library WOD.
    private func board(for block: Block) -> WodRow? {
        if let id = block.board, let b = model.wods.first(where: { $0.id == id }) { return b }
        if let lib = block.wod { return model.wods.first { $0.libraryId == lib && $0.isOpen } }
        return nil
    }

    /// Where a score from the timer goes: the block's open board, or the benchmark (which opens a
    /// board). nil when there's nowhere to log it (the timer then just shows the splits).
    private func logger(for block: Block?) -> ScoreSaver? {
        guard let block else { return nil }
        if let b = board(for: block) {
            guard b.isOpen else { return nil }
            return { score, rx, day, note, detail in
                try await model.logResult(on: b, score: score, rx: rx, on: day, note: note, detail: detail)
            }
        }
        if let lib = WodLibrary.find(block.wod) {
            return { score, rx, day, note, detail in
                try await model.logBenchmark(lib, score: score, rx: rx, on: day, note: note, detail: detail)
            }
        }
        return nil
    }

    private func finishedLabel(_ iso: String) -> String {
        SessionDate.timestamp(iso)?.formatted(date: .abbreviated, time: .shortened) ?? ""
    }
}

struct ExerciseRow: View {
    @Environment(AppModel.self) private var model
    let program: ProgramRow
    let exercise: Exercise
    let tick: TickRow?
    @State private var loggingMax = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(exercise.name).font(.body.weight(.semibold))
                if let status = exercise.status, !status.isEmpty {
                    Text(status.uppercased())
                        .font(.caption2.bold())
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(.tint.opacity(0.15), in: Capsule())
                }
                Spacer()
                if let url = exercise.demoURL {
                    Link(destination: url) { Image(systemName: "play.rectangle") }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Watch demo")
                }
            }

            HStack(spacing: 8) {
                if exercise.setCount > 0 && exercise.log != "tick" { Text("\(exercise.setCount) ×") }
                if let target = exercise.target, !target.isEmpty { Text(target) }
                if let unit = unitLabel { Text(unit).foregroundStyle(.tertiary) }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)

            if exercise.isOneRepMax {
                HStack {
                    if let m = model.oneRepMax(exercise) {
                        Label("1RM \(SessionFormat.number(m.kg)) kg", systemImage: "trophy")
                    } else {
                        Label("No 1RM yet", systemImage: "trophy")
                    }
                    Spacer()
                    Button("Log 1RM") { loggingMax = true }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                }
                .font(.footnote)
                .sheet(isPresented: $loggingMax) {
                    OneRepMaxSheet(
                        title: Lift.displayName(exercise.name),
                        current: model.oneRepMax(exercise)?.kg,
                        save: { kg in _ = try await model.logOneRepMax(program, exercise, kg: kg) }
                    )
                }
            }

            if let cue = exercise.cue, !cue.isEmpty {
                Text(cue).font(.footnote).foregroundStyle(.secondary)
            }
            if let extra = exercise.extra, !extra.isEmpty {
                Text(extra).font(.footnote).foregroundStyle(.secondary).italic()
            }

            if let tick, tick.skipped {
                Label("Skipped\(tick.skipReason.map { ": \($0)" } ?? "")", systemImage: "forward.fill")
                    .font(.footnote).foregroundStyle(.orange)
            } else if exercise.setCount > 0 {
                SetDots(total: exercise.setCount, tick: tick)
            }
        }
        .padding(.vertical, 4)
    }

    private var unitLabel: String? {
        switch exercise.log {
        case "kg": return "kg"
        case "reps": return "reps"
        case "secs": return "secs"
        default: return nil
        }
    }
}

/// One circle per set, filled when done, with what was logged underneath.
struct SetDots: View {
    let total: Int
    let tick: TickRow?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            ForEach(1...max(total, 1), id: \.self) { n in
                let entry = tick?.sets[String(n)]
                VStack(spacing: 2) {
                    Image(systemName: entry != nil ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(entry != nil ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
                        .font(.title3)
                    if let label = entry?.label {
                        Text(label).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(tick?.sets.count ?? 0) of \(total) sets done")
    }
}

/// A WOD's rounds, one line each: "Round 3 · 6 reps Wall Walk, 60 reps Double-under".
struct WodRoundsList: View {
    let rounds: [[WodSet]]
    let repeats: Bool

    var body: some View {
        ForEach(rounds.indices, id: \.self) { (i: Int) in
            WodRoundLine(label: repeats ? "Each round" : "Round \(i + 1)", sets: rounds[i])
        }
    }
}

struct WodRoundLine: View {
    let label: String
    let sets: [WodSet]

    private var text: String {
        sets.map { "\($0.target) \($0.name)" }.joined(separator: "\n")
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                .frame(minWidth: 70, alignment: .leading)
            Text(text).font(.body)
            Spacer(minLength: 0)
        }
    }
}
