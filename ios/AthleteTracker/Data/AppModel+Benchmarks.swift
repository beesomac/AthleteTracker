import Foundation
import Supabase

// Leaderboards, benchmark WODs and 1RMs: loading and logging.
extension AppModel {

    // MARK: Loading

    /// Each part is optional, so an older database without a table still shows the rest.
    func loadBenchmarks(for athlete: String) async {
        let wodRows: [WodRow] = (try? await supabase.from("wods")
            .select("id, name, description, score_type, time_cap_seconds, wod_date, status, library_id")
            .order("created_at", ascending: false)
            .execute().value) ?? []
        wods = wodRows.filter { $0.status != "draft" }

        let boardRows: [BoardRow] = (try? await supabase.rpc("wod_board").execute().value) ?? []
        board = boardRows

        let resultRows: [ResultRow] = (try? await supabase.from("wod_results")
            .select("id, wod_id, score, rx, performed_on, note")
            .eq("athlete_email", value: athlete)
            .order("performed_on", ascending: false)
            .execute().value) ?? []
        results = resultRows

        let maxRows: [LiftMax] = (try? await supabase.from("lift_maxes")
            .select("lift_key, lift_name, kg, tested_on")
            .eq("athlete_email", value: athlete)
            .execute().value) ?? []
        maxes = Dictionary(maxRows.map { ($0.liftKey, $0) }, uniquingKeysWith: { a, _ in a })
    }

    // MARK: Lookups

    func boardRows(_ wod: WodRow) -> [RankedRow] {
        WodScore.ranked(wod.scoreType, board.filter { $0.wodId == wod.id })
    }

    /// Boards for a library benchmark (there can be more than one over time).
    func boards(for lib: LibraryWod) -> [WodRow] {
        wods.filter { $0.libraryId == lib.id }
    }

    /// The athlete's scores on a benchmark, newest first.
    func history(for lib: LibraryWod) -> [ResultRow] {
        let ids = Set(boards(for: lib).map(\.id))
        return results.filter { ids.contains($0.wodId) }
    }

    func best(for lib: LibraryWod) -> ResultRow? {
        history(for: lib).min { WodScore.isBetter(lib.score, ($0.score, $0.rx), than: ($1.score, $1.rx)) }
    }

    func history(for wod: WodRow) -> [ResultRow] {
        results.filter { $0.wodId == wod.id }
    }

    func oneRepMax(_ exercise: Exercise) -> LiftMax? { maxes[exercise.liftKey] }

    /// 1RM rows: the standard lifts plus any other lift that has a number.
    var liftList: [LiftLine] {
        var seen = Set<String>()
        var out: [LiftLine] = []
        for name in Lift.standard {
            let k = Lift.key(name)
            seen.insert(k)
            out.append(LiftLine(key: k, name: name, max: maxes[k]))
        }
        for (k, m) in maxes.sorted(by: { $0.key < $1.key }) where !seen.contains(k) {
            out.append(LiftLine(key: k, name: m.liftName ?? k.capitalized, max: m))
        }
        return out
    }

    // MARK: Logging scores

    /// Log a score on a leaderboard. Athletes can only add to open boards (database rule).
    func logResult(on wod: WodRow, score: Double, rx: Bool, on day: Date, note: String) async throws {
        guard let athlete = athleteEmail else { return }
        try await supabase.from("wod_results").insert(NewResult(
            wod_id: wod.id, athlete_email: athlete, score: score, rx: rx,
            performed_on: SessionDate.string(day), note: note.isEmpty ? nil : note, entered_by_email: email
        )).execute()
        await loadBenchmarks(for: athlete)
    }

    /// Log a benchmark WOD. Uses its open leaderboard if there is one; otherwise the database
    /// opens one (supabase/008_benchmarks.sql).
    func logBenchmark(_ lib: LibraryWod, score: Double, rx: Bool, on day: Date, note: String) async throws {
        if let open = boards(for: lib).first(where: \.isOpen) {
            try await logResult(on: open, score: score, rx: rx, on: day, note: note)
            return
        }
        guard let athlete = athleteEmail else { return }
        do {
            try await supabase.rpc("log_benchmark", params: BenchmarkParams(
                p_library_id: lib.id, p_name: lib.name, p_score_type: lib.score, p_score: score, p_rx: rx,
                p_performed_on: SessionDate.string(day), p_note: note.isEmpty ? nil : note,
                p_description: lib.description, p_athlete: athlete
            )).execute()
        } catch {
            if "\(error)".contains("log_benchmark") || "\(error)".contains("PGRST202") {
                throw BenchmarkError.needsMigration
            }
            throw error
        }
        await loadBenchmarks(for: athlete)
    }

    // MARK: 1RMs

    func saveMax(key: String, name: String, kg: Double, on day: Date) async throws {
        guard let athlete = athleteEmail else { return }
        try await supabase.from("lift_maxes").upsert(MaxPayload(
            athlete_email: athlete, lift_key: key, lift_name: name, kg: kg,
            tested_on: SessionDate.string(day), updated_by_email: email, updated_at: Date.now.ISO8601Format()
        ), onConflict: "athlete_email,lift_key").execute()
        await loadBenchmarks(for: athlete)
    }

    func deleteMax(key: String) async throws {
        guard let athlete = athleteEmail else { return }
        try await supabase.from("lift_maxes").delete()
            .eq("athlete_email", value: athlete).eq("lift_key", value: key).execute()
        await loadBenchmarks(for: athlete)
    }

    /// Log a 1RM attempt from a program: ticks the exercise with the weight, and fills in the
    /// 1RM benchmark when it beats (or is the first) number for that lift.
    /// Returns true when the benchmark changed.
    @discardableResult
    func logOneRepMax(_ program: ProgramRow, _ exercise: Exercise, kg: Double) async throws -> Bool {
        guard let athlete = athleteEmail else { return false }
        var sets = tick(program, exercise)?.sets ?? [:]
        let next = (sets.keys.compactMap(Int.init).max() ?? 0) + 1
        let now = Date.now.ISO8601Format()
        sets[String(next)] = SetEntry(at: now, reps: 1, kg: kg)
        try await supabase.from("ticks").upsert(TickPayload(
            athlete_email: athlete, session_id: program.id, exercise_id: exercise.id, sets: sets,
            skipped: false, skip_reason: nil, updated_by_email: email, updated_at: now
        ), onConflict: "athlete_email,session_id,exercise_id").execute()

        var changed = false
        if kg > (oneRepMax(exercise)?.kg ?? 0) {
            try await saveMax(key: exercise.liftKey, name: Lift.displayName(exercise.name), kg: kg, on: .now)
            changed = true
        }
        await reload()
        return changed
    }
}

enum BenchmarkError: LocalizedError {
    case needsMigration
    var errorDescription: String? {
        "There's no leaderboard for this yet. Ask your trainer to start one, or to run supabase/008_benchmarks.sql so the first score opens one."
    }
}

// MARK: - Payloads (snake_case to match the columns)

private nonisolated struct NewResult: Encodable, Sendable {
    let wod_id: String
    let athlete_email: String
    let score: Double
    let rx: Bool
    let performed_on: String
    let note: String?
    let entered_by_email: String?
}

private nonisolated struct BenchmarkParams: Encodable, Sendable {
    let p_library_id: String
    let p_name: String
    let p_score_type: String
    let p_score: Double
    let p_rx: Bool
    let p_performed_on: String
    let p_note: String?
    let p_description: String?
    let p_athlete: String
}

private nonisolated struct MaxPayload: Encodable, Sendable {
    let athlete_email: String
    let lift_key: String
    let lift_name: String
    let kg: Double
    let tested_on: String
    let updated_by_email: String?
    let updated_at: String
}

private nonisolated struct TickPayload: Encodable, Sendable {
    let athlete_email: String
    let session_id: String
    let exercise_id: String
    let sets: [String: SetEntry]
    let skipped: Bool
    let skip_reason: String?
    let updated_by_email: String?
    let updated_at: String
}
