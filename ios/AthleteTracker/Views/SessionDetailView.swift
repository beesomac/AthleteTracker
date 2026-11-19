import SwiftUI

/// One session, block by block. Read-only: shows what's planned and what's been logged.
struct SessionDetailView: View {
    @Environment(AppModel.self) private var model
    let program: ProgramRow

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
                    ForEach(block.exercises) { ex in
                        ExerciseRow(exercise: ex, tick: model.tick(program, ex))
                    }
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
    }

    private func finishedLabel(_ iso: String) -> String {
        SessionDate.timestamp(iso)?.formatted(date: .abbreviated, time: .shortened) ?? ""
    }
}

struct ExerciseRow: View {
    let exercise: Exercise
    let tick: TickRow?

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
