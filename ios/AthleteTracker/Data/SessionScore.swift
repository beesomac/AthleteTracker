import Foundation
import Supabase

// A library WOD with rounds (21.1) scores itself from the session: the ticks on each movement,
// the reps typed on a movement that wasn't finished, and the time typed under each round.

/// The score a WOD block's ticks add up to.
nonisolated struct SessionScore: Sendable, Hashable {
    enum State: Sendable, Hashable {
        case score(Double)          // ready to save
        case needsTimes(missing: Int) // everything ticked, some round times still blank
        case inProgress             // nothing to score yet
    }
    var state: State
    var reps: Int
    var detail: WodDetail

    var score: Double? {
        if case .score(let s) = state { return s }
        return nil
    }

    /// For time: a movement with reps below its target means time ran out there, so the score is
    /// CAP + every rep done up to and including it. Everything ticked + every round time = the
    /// total time. For reps: the reps done so far.
    static func make(rounds: [[WodSet]], scoreType: String, entries: [[SetEntry?]],
                     times: [Int: Double], session: String, block: String) -> SessionScore {
        var reps = 0
        var partial = false
        var allDone = true
        var any = false
        var out: [WodDetail.Round] = []
        for (i, round) in rounds.enumerated() {
            var sets: [WodDetail.SetDetail] = []
            for (j, m) in round.enumerated() {
                var actual: String? = nil
                if i < entries.count, j < entries[i].count, let e = entries[i][j] {
                    any = true
                    if let r = e.reps, m.reps <= 0 || Int(r) < m.reps {
                        partial = true
                        reps += Int(r)
                        actual = SessionFormat.number(r) + " reps"
                    } else {
                        reps += m.reps
                        actual = m.target
                    }
                } else {
                    allDone = false
                }
                sets.append(WodDetail.SetDetail(name: m.name, target: m.target, actual: actual))
            }
            out.append(WodDetail.Round(time: times[i + 1], sets: sets))
        }
        if !times.isEmpty { any = true }
        let detail = WodDetail(rounds: out, session: session, block: block)

        let state: State
        switch scoreType {
        case "time":
            if partial {
                state = .score(WodScore.capped(reps: reps))
            } else if allDone {
                let missing = (1...max(rounds.count, 1)).filter { times[$0] == nil }.count
                state = missing == 0
                    ? .score((rounds.indices.reduce(0) { $0 + (times[$1 + 1] ?? 0) } * 10).rounded() / 10)
                    : .needsTimes(missing: missing)
            } else {
                state = .inProgress
            }
        case "reps":
            state = any ? .score(Double(reps)) : .inProgress
        default:
            state = .inProgress
        }
        return SessionScore(state: state, reps: reps, detail: detail)
    }
}

extension Block {
    /// The program exercise behind a movement in a round: same position, else same name.
    func exercise(for set: WodSet, at j: Int, roundSize: Int) -> Exercise? {
        if exercises.count == roundSize, j < exercises.count { return exercises[j] }
        return exercises.first { $0.name.lowercased() == set.name.lowercased() }
    }

    /// The rounds that score from the session: a library WOD's fixed rounds (not an AMRAP).
    var scoredRounds: [[WodSet]]? {
        guard let lib = WodLibrary.find(wod), !lib.roundRepeat,
              let rounds = lib.roundSets, !rounds.isEmpty else { return nil }
        return rounds
    }
}

extension AppModel {

    /// The leaderboard for a WOD block: the one the trainer picked, else an open one for the same library WOD.
    func board(for block: Block) -> WodRow? {
        if let id = block.board, let b = wods.first(where: { $0.id == id }) { return b }
        if let lib = block.wod { return wods.first { $0.libraryId == lib && $0.isOpen } }
        return nil
    }

    private static func timesId(_ block: Block) -> String { "wod-times__" + block.key }
    private func scoreKey(_ program: ProgramRow, _ block: Block) -> String { program.id + "__" + block.key }

    /// Round times typed in the session (round number → seconds). They're kept in the ticks table
    /// under a made-up exercise id, so nothing new is needed in the database.
    func roundTimes(_ program: ProgramRow, _ block: Block) -> [Int: Double] {
        var out: [Int: Double] = [:]
        for (k, e) in ticks[program.id + "__" + Self.timesId(block)]?.sets ?? [:] {
            if let n = Int(k), let s = e.secs { out[n] = s }
        }
        return out
    }

    func setRoundTime(_ program: ProgramRow, _ block: Block, round: Int, secs: Double?) async throws {
        try await setRoundTick(program, exerciseId: Self.timesId(block), round: round,
                               entry: secs.map { SetEntry(at: Date.now.ISO8601Format(), secs: $0) })
    }

    func sessionScore(_ program: ProgramRow, _ block: Block) -> SessionScore? {
        guard let rounds = block.scoredRounds else { return nil }
        let type = board(for: block)?.scoreType ?? WodLibrary.find(block.wod)?.score ?? "time"
        let entries: [[SetEntry?]] = rounds.enumerated().map { (i: Int, round: [WodSet]) -> [SetEntry?] in
            round.enumerated().map { (j: Int, m: WodSet) -> SetEntry? in
                guard let ex = block.exercise(for: m, at: j, roundSize: round.count) else { return nil }
                return tick(program, ex)?.sets[String(i + 1)]
            }
        }
        return SessionScore.make(
            rounds: rounds, scoreType: type, entries: entries,
            times: roundTimes(program, block), session: program.id, block: block.key
        )
    }

    /// The score saved from this session's WOD block, if there is one.
    func sessionResult(_ program: ProgramRow, _ block: Block) -> ResultRow? {
        results.first { $0.detail?.session == program.id && $0.detail?.block == block.key }
    }

    /// Save (or change, or take back) the block's score after a tick or a round time changes.
    /// Runs one at a time per block, each time from the latest ticks.
    func syncSessionScore(_ program: ProgramRow, _ block: Block) {
        let key = scoreKey(program, block)
        let previous = scoreTasks[key]
        scoreTasks[key] = Task {
            await previous?.value
            do {
                try await saveSessionScore(program, block)
                scoreErrors[key] = nil
            } catch {
                scoreErrors[key] = error.localizedDescription
            }
        }
    }

    func scoreError(_ program: ProgramRow, _ block: Block) -> String? { scoreErrors[scoreKey(program, block)] }

    private func saveSessionScore(_ program: ProgramRow, _ block: Block) async throws {
        guard let athlete = athleteEmail, let s = sessionScore(program, block) else { return }
        let existing = sessionResult(program, block)
        guard let score = s.score else {
            // Not a score any more (a part-done movement was cleared): take the saved one back.
            if let existing {
                try await supabase.from("wod_results").delete().eq("id", value: existing.id).execute()
                await loadBenchmarks(for: athlete)
            }
            return
        }
        if let existing {
            if existing.score == score && existing.detail == s.detail { return }
            try await supabase.from("wod_results")
                .update(SessionScorePayload(score: score, detail: s.detail))
                .eq("id", value: existing.id).execute()
            await loadBenchmarks(for: athlete)
            return
        }
        let day = program.day ?? .now
        if let b = board(for: block) {
            guard b.isOpen else { throw SessionScoreError.boardClosed }
            try await logResult(on: b, score: score, rx: true, on: day, note: "", detail: s.detail)
        } else if let lib = WodLibrary.find(block.wod) {
            try await logBenchmark(lib, score: score, rx: true, on: day, note: "", detail: s.detail)
        }
    }
}

enum SessionScoreError: LocalizedError {
    case boardClosed
    var errorDescription: String? { "This leaderboard is closed, so the score can't be saved." }
}

private nonisolated struct SessionScorePayload: Encodable, Sendable {
    let score: Double
    let detail: WodDetail
}
