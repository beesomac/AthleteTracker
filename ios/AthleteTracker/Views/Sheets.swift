import SwiftUI

/// Log a WOD score: typed the way the board shows it (mm:ss, reps, kg, rounds+reps).
/// With a plan, each round can take a time and what was actually done; a timer result fills
/// in the score, the round times and the splits.
struct LogScoreSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let scoreType: String
    var timeCap: Int? = nil
    var plan: WodPlan? = nil
    var prefill: TimerResult? = nil
    /// Reps typed in the session for movements not finished: [round][movement], "" when done.
    var actuals: [[String]]? = nil
    let save: ScoreSaver

    @State private var text = ""
    @State private var capped = false
    @State private var rx = true
    @State private var day = Date.now
    @State private var note = ""
    @State private var busy = false
    @State private var error: String?
    @State private var rounds: [EditRound] = []
    @State private var by: WodPlan.SplitBy = .round
    @State private var ready = false

    struct EditSet: Identifiable {
        let id = UUID()
        var name: String
        var target: String
        var time: Double?
        var actual = ""
    }
    struct EditRound: Identifiable {
        let id = UUID()
        var time = ""
        var sets: [EditSet]
    }

    private var score: Double? { WodScore.parse(scoreType, text, capped: capped) }
    private var splits: [Double] { prefill?.splits ?? [] }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if scoreType == "time" {
                        Toggle(capLabel, isOn: $capped)
                    }
                    TextField(capped ? "Reps done at the cap" : WodScore.hint(scoreType), text: $text)
                        .keyboardType(capped ? .numberPad : scoreType == "load" ? .decimalPad : .numbersAndPunctuation)
                        .font(.title2.monospacedDigit())
                    if let score {
                        Text(WodScore.format(scoreType, score)).foregroundStyle(.secondary)
                    }
                } header: {
                    Text(WodScore.label(scoreType))
                } footer: {
                    if capped {
                        Text("Total reps finished before time ran out. Scores CAP + reps, ranked below everyone who finished.")
                    }
                }
                Section {
                    Toggle("Rx", isOn: $rx)
                    DatePicker("Date", selection: $day, in: ...Date.now, displayedComponents: .date)
                    TextField("Note (optional)", text: $note, axis: .vertical)
                }
                if !splits.isEmpty, let plan, !plan.rounds.isEmpty {
                    Section {
                        Picker("Splits were", selection: $by) {
                            Text("Rounds").tag(WodPlan.SplitBy.round)
                            Text("Movements").tag(WodPlan.SplitBy.set)
                        }
                        .pickerStyle(.segmented)
                    } header: {
                        Text("\(splits.count) split\(splits.count == 1 ? "" : "s") from the timer")
                    }
                }
                ForEach(roundIDs, id: \.self) { (id: UUID) in
                    RoundEditorSection(index: index(of: id), isLast: id == roundIDs.last, round: binding(for: id))
                }
                if let plan, plan.repeats || plan.rounds.isEmpty, !rounds.isEmpty || plan.repeats {
                    Section {
                        Button("Add round") { addRound() }
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { submit() }.disabled(score == nil || busy)
                }
            }
            .onAppear(perform: setUp)
            .onChange(of: by) { remap() }
        }
        .presentationDetents(plan?.rounds.isEmpty == false ? [.large] : [.medium, .large])
    }

    private var capLabel: String {
        if let timeCap, timeCap > 0 { return "Didn't finish in the cap (\(WodScore.format("time", Double(timeCap))))" }
        return "Didn't finish in the time cap"
    }

    private var roundIDs: [UUID] { rounds.map(\.id) }

    private func index(of id: UUID) -> Int { rounds.firstIndex { $0.id == id } ?? 0 }

    /// A binding to one round by id, safe if the list changes underneath it.
    private func binding(for id: UUID) -> Binding<EditRound> {
        Binding(
            get: { rounds.first { $0.id == id } ?? EditRound(sets: []) },
            set: { new in if let i = rounds.firstIndex(where: { $0.id == id }) { rounds[i] = new } }
        )
    }

    private func setUp() {
        guard !ready, let plan else { return }
        ready = true
        by = prefill?.by ?? plan.defaultSplitBy
        remap()
        if let actuals {
            for i in rounds.indices where i < actuals.count {
                for j in rounds[i].sets.indices where j < actuals[i].count && rounds[i].sets[j].actual.isEmpty {
                    rounds[i].sets[j].actual = actuals[i][j]
                }
            }
        }
        guard let r = prefill else { return }
        let m = plan.map(splits: r.splits, by: r.by)
        switch scoreType {
        case "time":
            if r.hitLimit && r.timer.mode == .down {
                capped = true
                text = m.reps > 0 ? "\(m.reps)" : ""
            } else {
                text = WodClock.text(r.elapsed, tenths: true)
            }
        case "rounds_reps" where plan.repeats:
            let perRound = plan.rounds.first?.reduce(0) { $0 + $1.reps } ?? 0
            let extra = max(0, m.reps - m.doneRounds * perRound)
            text = "\(m.doneRounds)" + (extra > 0 ? "+\(extra)" : "")
        case "reps" where m.reps > 0:
            text = "\(m.reps)"
        default: break
        }
    }

    /// Round and movement times from the splits; keeps whatever was typed as "actual".
    private func remap() {
        guard let plan, !plan.rounds.isEmpty || !splits.isEmpty else { return }
        let m = plan.map(splits: splits, by: by)
        let old = rounds
        rounds = m.rounds.enumerated().map { i, r in
            EditRound(
                time: r.time.map { WodClock.text($0, tenths: true) } ?? (splits.isEmpty && i < old.count ? old[i].time : ""),
                sets: r.sets.enumerated().map { j, s in
                    EditSet(name: s.set.name, target: s.set.target, time: s.time,
                            actual: i < old.count && j < old[i].sets.count ? old[i].sets[j].actual : "")
                }
            )
        }
        // Rounds added by hand beyond what the splits cover stay.
        if old.count > rounds.count { rounds.append(contentsOf: old[rounds.count...].map { r in
            EditRound(time: "", sets: r.sets.map { EditSet(name: $0.name, target: $0.target, actual: $0.actual) })
        }) }
    }

    private func addRound() {
        guard let plan else { return }
        let sets = plan.round(rounds.count)
        rounds.append(EditRound(sets: sets.map { EditSet(name: $0.name, target: $0.target) }))
    }

    private var detail: WodDetail? {
        guard !rounds.isEmpty || !splits.isEmpty else { return nil }
        let out = rounds.map { r in
            WodDetail.Round(
                time: WodScore.parse("time", r.time),
                sets: r.sets.map { s in
                    let a = s.actual.trimmingCharacters(in: .whitespaces)
                    return WodDetail.SetDetail(name: s.name, target: s.target, actual: a.isEmpty ? nil : String(a.prefix(60)), time: s.time)
                }
            )
        }
        let any = !splits.isEmpty || out.contains { $0.time != nil || $0.sets.contains { $0.actual != nil } }
        guard any else { return nil }
        return WodDetail(rounds: out, splits: splits.isEmpty ? nil : splits,
                         splitBy: splits.isEmpty ? nil : by.rawValue, timer: prefill?.timer.label)
    }

    private func submit() {
        guard let score else { return }
        busy = true
        error = nil
        let detail = self.detail
        Task {
            do {
                try await save(score, rx, day, note.trimmingCharacters(in: .whitespacesAndNewlines), detail)
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

/// One round on the score sheet: its time, and what was done for each movement.
struct RoundEditorSection: View {
    let index: Int
    let isLast: Bool
    @Binding var round: LogScoreSheet.EditRound

    var body: some View {
        Section {
            ForEach($round.sets) { (set: Binding<LogScoreSheet.EditSet>) in
                SetEditorRow(roundIndex: index, set: set)
            }
        } header: {
            HStack {
                Text("Round \(index + 1)")
                Spacer()
                TextField("time", text: $round.time)
                    .keyboardType(.numbersAndPunctuation)
                    .multilineTextAlignment(.trailing)
                    .font(.body.monospacedDigit())
                    .frame(maxWidth: 100)
                    .accessibilityLabel("Round \(index + 1) time")
            }
            .textCase(nil)
        } footer: {
            if isLast {
                Text("Round times are optional (mm:ss). Leave a movement blank if you did it as written.")
            }
        }
    }
}

struct SetEditorRow: View {
    let roundIndex: Int
    @Binding var set: LogScoreSheet.EditSet

    private var detailText: String {
        var bits: [String] = []
        if !set.target.isEmpty { bits.append(set.target) }
        if let t = set.time { bits.append(WodClock.text(t, tenths: true)) }
        return bits.joined(separator: " · ")
    }

    private var placeholder: String {
        let first: String = set.target.split(whereSeparator: { " ,@".contains($0) }).first.map(String.init) ?? ""
        return first.isEmpty ? "done" : first
    }

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(set.name)
                Text(detailText).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            TextField(placeholder, text: $set.actual)
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 110)
                .accessibilityLabel("\(set.name), round \(roundIndex + 1), what you did")
        }
    }
}

/// Enter or log a 1RM in kg.
struct OneRepMaxSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let current: Double?
    var testedOn: Date? = nil
    var canRemove = false
    var onRemove: (() async throws -> Void)? = nil
    let save: (Double) async throws -> Void
    /// When set, the sheet also asks for the test date (Benchmarks); otherwise it's today (a program).
    var saveWithDate: ((Double, Date) async throws -> Void)? = nil

    @State private var text = ""
    @State private var day = Date.now
    @State private var busy = false
    @State private var error: String?

    private var kg: Double? {
        guard let n = Double(text.replacingOccurrences(of: ",", with: ".")), n > 0, n < 1000 else { return nil }
        return n
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        TextField("kg", text: $text)
                            .keyboardType(.decimalPad)
                            .font(.title2.monospacedDigit())
                        Text("kg").foregroundStyle(.secondary)
                    }
                    if saveWithDate != nil {
                        DatePicker("Tested", selection: $day, in: ...Date.now, displayedComponents: .date)
                    }
                } header: {
                    Text("1RM")
                } footer: {
                    if let current {
                        Text("Current 1RM: \(SessionFormat.number(current)) kg")
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
                if canRemove, let onRemove {
                    Section {
                        Button("Remove 1RM", role: .destructive) {
                            run { try await onRemove() }
                        }
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        guard let kg else { return }
                        run {
                            if let saveWithDate { try await saveWithDate(kg, day) } else { try await save(kg) }
                        }
                    }
                    .disabled(kg == nil || busy)
                }
            }
            .onAppear {
                if saveWithDate != nil, let current { text = SessionFormat.number(current) }
                if let testedOn { day = testedOn }
            }
        }
        .presentationDetents([.medium])
    }

    private func run(_ work: @escaping () async throws -> Void) {
        busy = true
        error = nil
        Task {
            do {
                try await work()
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}
