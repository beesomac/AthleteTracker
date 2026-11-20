import SwiftUI

/// Log a WOD score: typed the way the board shows it (mm:ss, reps, kg, rounds+reps).
struct LogScoreSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let scoreType: String
    var timeCap: Int? = nil
    let save: (Double, Bool, Date, String) async throws -> Void

    @State private var text = ""
    @State private var capped = false
    @State private var rx = true
    @State private var day = Date.now
    @State private var note = ""
    @State private var busy = false
    @State private var error: String?

    private var score: Double? { WodScore.parse(scoreType, text, capped: capped) }

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
        }
        .presentationDetents([.medium, .large])
    }

    private var capLabel: String {
        if let timeCap, timeCap > 0 { return "Didn't finish in the cap (\(WodScore.format("time", Double(timeCap))))" }
        return "Didn't finish in the time cap"
    }

    private func submit() {
        guard let score else { return }
        busy = true
        error = nil
        Task {
            do {
                try await save(score, rx, day, note.trimmingCharacters(in: .whitespacesAndNewlines))
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
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
