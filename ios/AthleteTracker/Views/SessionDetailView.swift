import SwiftUI

/// One session, block by block. Read-only: shows what's planned and what's been logged.
struct SessionDetailView: View {
    @Environment(AppModel.self) private var model
    let program: ProgramRow
    @State private var timer: WodTimerItem?
    @State private var timerBlock: Block?
    @State private var scoring: ScoreItem?

    struct ScoreItem: Identifiable {
        let id = UUID()
        let plan: WodPlan
        let actuals: [[String]]
        let save: ScoreSaver
    }

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
                        if block.scoredRounds == nil, let save = logger(for: block) {
                            Button { logScore(block, save: save) } label: {
                                Label("Log score", systemImage: "square.and.pencil")
                            }
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
        .sheet(item: $scoring) { (item: ScoreItem) in
            LogScoreSheet(title: item.plan.title, scoreType: item.plan.scoreType, timeCap: item.plan.cap,
                          plan: item.plan, actuals: item.actuals, save: item.save)
        }
    }

    /// A library WOD with rounds shows round by round (21.1: 1 + 10, 3 + 30, …);
    /// everything else shows its exercises.
    @ViewBuilder
    private func blockRows(_ block: Block) -> some View {
        let lib: LibraryWod? = WodLibrary.find(block.wod)
        if let lib, let rounds = lib.roundSets, !rounds.isEmpty {
            WodRoundsList(program: program, block: block, rounds: rounds, repeats: lib.roundRepeat)
        } else {
            ForEach(block.exercises) { (ex: Exercise) in
                ExerciseRow(program: program, exercise: ex, tick: model.tick(program, ex))
            }
        }
    }

    /// Log a score by hand: round times typed in, and the reps from any movement ticked
    /// as not finished in the session.
    private func logScore(_ block: Block, save: @escaping ScoreSaver) {
        let lib: LibraryWod? = WodLibrary.find(block.wod)
        let plan: WodPlan = WodPlan.make(library: lib, block: block, board: board(for: block))
        scoring = ScoreItem(plan: plan, actuals: actuals(block, plan: plan), save: save)
    }

    private func actuals(_ block: Block, plan: WodPlan) -> [[String]] {
        var out: [[String]] = []
        for (i, round) in plan.rounds.enumerated() {
            var line: [String] = []
            for (j, m) in round.enumerated() {
                let ex: Exercise? = block.exercises.count == round.count && j < block.exercises.count
                    ? block.exercises[j]
                    : block.exercises.first { $0.name.lowercased() == m.name.lowercased() }
                var text = ""
                if let ex, let reps = model.tick(program, ex)?.sets[String(i + 1)]?.reps, Int(reps) < max(1, m.reps) {
                    text = SessionFormat.number(reps)
                }
                line.append(text)
            }
            out.append(line)
        }
        return out
    }

    private func startWod(_ block: Block) {
        let lib: LibraryWod? = WodLibrary.find(block.wod)
        let plan: WodPlan = WodPlan.make(library: lib, block: block, board: board(for: block))
        timerBlock = block
        timer = WodTimerItem(plan: plan)
    }

    private func board(for block: Block) -> WodRow? { model.board(for: block) }

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

/// A WOD's rounds: a tick box for every movement in every round, a box for the reps done when
/// a movement wasn't finished, and a time box under each round. The score works itself out from
/// those and is saved as you go. An AMRAP (repeating round) just lists its round.
struct WodRoundsList: View {
    let program: ProgramRow
    let block: Block
    let rounds: [[WodSet]]
    let repeats: Bool

    var body: some View {
        ForEach(rounds.indices, id: \.self) { (i: Int) in
            if repeats {
                WodRoundLine(label: "Each round", sets: rounds[i])
            } else {
                Text("Round \(i + 1)")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                    .listRowSeparator(.hidden, edges: .bottom)
                ForEach(rounds[i].indices, id: \.self) { (j: Int) in
                    WodMovementRow(program: program, block: block,
                                   exercise: block.exercise(for: rounds[i][j], at: j, roundSize: rounds[i].count),
                                   round: i + 1, movement: rounds[i][j])
                }
                WodRoundTimeRow(program: program, block: block, round: i + 1)
            }
        }
        if !repeats {
            WodScoreLine(program: program, block: block)
        }
    }
}

/// The time a round took, typed under the round (m:ss).
struct WodRoundTimeRow: View {
    @Environment(AppModel.self) private var model
    let program: ProgramRow
    let block: Block
    let round: Int

    @State private var text = ""
    @State private var error: String?
    @FocusState private var focused: Bool

    private var saved: Double? { model.roundTimes(program, block)[round] }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "stopwatch").foregroundStyle(.secondary).frame(width: 28)
            VStack(alignment: .leading, spacing: 1) {
                Text("Round \(round) time").foregroundStyle(.secondary)
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
            }
            Spacer(minLength: 4)
            TextField("m:ss", text: $text)
                .keyboardType(.numbersAndPunctuation)
                .multilineTextAlignment(.trailing)
                .textFieldStyle(.roundedBorder)
                .frame(width: 80)
                .focused($focused)
                .submitLabel(.done)
                .onSubmit { focused = false }
                .accessibilityLabel("Round \(round) time")
        }
        .onAppear { syncText() }
        .onChange(of: saved) { if !focused { syncText() } }
        .onChange(of: focused) { if !focused { save() } }
    }

    private func syncText() {
        text = saved.map { WodClock.text($0, tenths: true) } ?? ""
    }

    private func save() {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        let secs: Double?
        if trimmed.isEmpty {
            guard saved != nil else { return }
            secs = nil
        } else {
            guard let t = WodScore.parse("time", trimmed), t > 0 else { syncText(); return }
            if t == saved { syncText(); return }
            secs = t
        }
        error = nil
        Task {
            do {
                try await model.setRoundTime(program, block, round: round, secs: secs)
                syncText()
                model.syncSessionScore(program, block)
            } catch {
                self.error = "Couldn't save: \(error.localizedDescription)"
            }
        }
    }
}

/// The score the ticks add up to, and whether it's on the leaderboard.
struct WodScoreLine: View {
    @Environment(AppModel.self) private var model
    let program: ProgramRow
    let block: Block

    private var type: String { model.board(for: block)?.scoreType ?? WodLibrary.find(block.wod)?.score ?? "time" }

    var body: some View {
        if let s = model.sessionScore(program, block) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Score").font(.headline)
                    Spacer()
                    Text(scoreText(s)).font(.headline.monospacedDigit())
                        .foregroundStyle(s.score == nil ? Color.secondary : Color.primary)
                }
                Text(status(s)).font(.caption).foregroundStyle(statusIsError ? Color.red : Color.secondary)
            }
            .padding(.vertical, 4)
        }
    }

    private func scoreText(_ s: SessionScore) -> String {
        if let score = s.score { return WodScore.format(type, score) }
        return "–"
    }

    private var statusIsError: Bool { model.scoreError(program, block) != nil }

    private func status(_ s: SessionScore) -> String {
        if let error = model.scoreError(program, block) { return "Couldn't save the score: \(error)" }
        switch s.state {
        case .score:
            if let saved = model.sessionResult(program, block), saved.score == s.score {
                return "Logged on the leaderboard."
            }
            return "Saving…"
        case .needsTimes(let missing):
            return "All done. Add \(missing == 1 ? "the last round time" : "\(missing) round times") for your time."
        case .inProgress:
            return type == "time"
                ? "Tick each movement as you finish it. If time runs out, type the reps you got on that movement and that's your score (CAP + reps)."
                : "Tick each movement as you finish it."
        }
    }
}

/// One movement in one round: tick it when done, or type the reps you got.
struct WodMovementRow: View {
    @Environment(AppModel.self) private var model
    let program: ProgramRow
    let block: Block
    let exercise: Exercise?
    let round: Int
    let movement: WodSet

    @State private var text = ""
    @State private var error: String?
    @FocusState private var focused: Bool

    private var entry: SetEntry? {
        guard let exercise else { return nil }
        return model.tick(program, exercise)?.sets[String(round)]
    }

    /// Done as written: ticked with no reps, or reps at least the target.
    private var isDone: Bool {
        guard let entry else { return false }
        guard let reps = entry.reps else { return true }
        let target = movement.reps
        return target > 0 && Int(reps) >= target
    }

    private var isPartial: Bool { entry != nil && !isDone }

    private var symbol: String {
        if isDone { return "checkmark.circle.fill" }
        if isPartial { return "circle.lefthalf.filled" }
        return "circle"
    }

    var body: some View {
        HStack(spacing: 10) {
            Button { toggle() } label: {
                Image(systemName: symbol)
                    .font(.title2)
                    .foregroundStyle(entry != nil ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
            }
            .buttonStyle(.borderless)
            .disabled(exercise == nil)
            .accessibilityLabel(isDone ? "Done" : "Not done")

            VStack(alignment: .leading, spacing: 1) {
                Text("\(movement.target) \(movement.name)")
                    .strikethrough(isDone)
                    .foregroundStyle(isDone ? .secondary : .primary)
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
            }
            Spacer(minLength: 4)
            TextField("reps", text: $text)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
                .textFieldStyle(.roundedBorder)
                .frame(width: 70)
                .focused($focused)
                .disabled(exercise == nil)
                .accessibilityLabel("Reps done, \(movement.name), round \(round)")
        }
        .onAppear { syncText() }
        .onChange(of: entry?.reps) { if !focused { syncText() } }
        .onChange(of: focused) { if !focused { saveReps() } }
        .toolbar {
            if focused {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { focused = false }
                }
            }
        }
    }

    private func syncText() {
        if let reps = entry?.reps { text = SessionFormat.number(reps) } else { text = "" }
    }

    private func toggle() {
        let next: SetEntry? = entry == nil || isPartial ? SetEntry(at: Date.now.ISO8601Format()) : nil
        if next != nil { text = "" }
        save(next)
    }

    private func saveReps() {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            if entry?.reps != nil { save(nil) }
            return
        }
        guard let n = Double(trimmed), n >= 0 else { syncText(); return }
        if entry?.reps == n { return }
        save(SetEntry(at: Date.now.ISO8601Format(), reps: n))
    }

    private func save(_ next: SetEntry?) {
        guard let exercise else { return }
        error = nil
        Task {
            do {
                try await model.setRoundTick(program, exercise, round: round, entry: next)
                model.syncSessionScore(program, block)
            } catch {
                self.error = "Couldn't save: \(error.localizedDescription)"
            }
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
