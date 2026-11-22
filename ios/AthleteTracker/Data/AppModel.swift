import Foundation
import Observation
import Supabase

/// App state: who is signed in, which athlete we're looking at, and their sessions.
/// Programs are read-only apart from logging a 1RM; leaderboards, benchmarks and 1RMs
/// are in AppModel+Benchmarks.swift.
/// Main-actor isolated by default (SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor).
@Observable
final class AppModel {
    enum Phase: Equatable {
        case starting
        case signedOut
        case notAMember(email: String)
        case signedIn
    }

    var phase: Phase = .starting
    var email: String?
    var me: WhoAmI?
    var isTrainer: Bool { me?.role == "trainer" }

    /// Athletes a trainer can pick from (athletes plus trainers who also train).
    var athletes: [Member] = []
    var athleteEmail: String? {
        didSet {
            if let athleteEmail { UserDefaults.standard.set(athleteEmail, forKey: Self.athleteKey) }
        }
    }

    var programs: [ProgramRow] = []
    var ticks: [String: TickRow] = [:]          // "sessionId__exerciseId"
    var finished: [String: FinishRow] = [:]     // sessionId

    var wods: [WodRow] = []                     // leaderboards (not drafts)
    var board: [BoardRow] = []                  // wod_board(): best score per athlete per board
    var results: [ResultRow] = []               // the athlete's own scores
    var maxes: [String: LiftMax] = [:]          // lift key → 1RM
    var isLoading = false
    var loadError: String?
    /// Why a WOD block's score couldn't be saved, by "sessionId__blockKey".
    var scoreErrors: [String: String] = [:]
    /// One score save at a time per WOD block, so quick edits don't add two scores.
    @ObservationIgnored var scoreTasks: [String: Task<Void, Never>] = [:]

    private static let athleteKey = "athlete-email"
    private var authTask: Task<Void, Never>?

    init() {
        authTask = Task { [weak self] in
            for await (_, session) in supabase.auth.authStateChanges {
                await self?.sessionChanged(session)
            }
        }
    }

    // MARK: Auth (same Supabase sign-in as the website)

    func signIn(email: String, password: String) async throws {
        try await supabase.auth.signIn(
            email: email.trimmingCharacters(in: .whitespaces).lowercased(),
            password: password
        )
    }

    func signOut() async {
        await Push.shared.signingOut()
        try? await supabase.auth.signOut()
    }

    private func sessionChanged(_ session: Session?) async {
        let next = session?.user.email?.lowercased()
        guard next != email || phase == .starting else { return }
        email = next
        guard let next else {
            reset()
            phase = .signedOut
            return
        }
        await loadRole(for: next)
    }

    private func reset() {
        me = nil
        athletes = []
        programs = []
        ticks = [:]
        finished = [:]
        wods = []
        board = []
        results = []
        maxes = [:]
        loadError = nil
    }

    // MARK: Loading

    private func loadRole(for email: String) async {
        do {
            let rows: [WhoAmI] = try await supabase.rpc("whoami").execute().value
            guard let row = rows.first, row.role != nil else {
                phase = .notAMember(email: email)
                return
            }
            me = row
            if row.role == "trainer" {
                let members: [Member] = try await supabase.from("members")
                    .select()
                    .eq("active", value: true)
                    .order("display_name")
                    .execute().value
                athletes = members.filter { $0.role == "athlete" || $0.alsoAthlete == true }
                let saved = UserDefaults.standard.string(forKey: Self.athleteKey)
                athleteEmail = athletes.first(where: { $0.email == saved })?.email ?? athletes.first?.email
            } else {
                athletes = []
                athleteEmail = email
            }
            phase = .signedIn
            Task { await Push.shared.signedInAsMember() }
            await reload()
        } catch {
            loadError = error.localizedDescription
            phase = .signedIn
        }
    }

    func pickAthlete(_ email: String) async {
        athleteEmail = email
        await reload()
    }

    func reload() async {
        guard let athlete = athleteEmail else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let programRows: [ProgramRow] = supabase.from("programs")
                .select("id, athlete_email, date, title, body")
                .eq("published", value: true)
                .order("date")
                .execute().value
            async let tickRows: [TickRow] = supabase.from("ticks")
                .select("session_id, exercise_id, sets, skipped, skip_reason")
                .eq("athlete_email", value: athlete)
                .execute().value

            let all = try await programRows
            programs = all.filter { $0.athleteEmail == nil || $0.athleteEmail?.lowercased() == athlete.lowercased() }

            var t: [String: TickRow] = [:]
            for row in try await tickRows { t[row.sessionId + "__" + row.exerciseId] = row }
            ticks = t

            // Finishes are optional (older databases may not have the table).
            let finishRows: [FinishRow] = (try? await supabase.from("session_finishes")
                .select("session_id, finished_at")
                .eq("athlete_email", value: athlete)
                .execute().value) ?? []
            finished = Dictionary(finishRows.map { ($0.sessionId, $0) }, uniquingKeysWith: { a, _ in a })
            await loadBenchmarks(for: athlete)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    // MARK: Lookups for the views

    var athleteName: String {
        if let a = athletes.first(where: { $0.email == athleteEmail }) { return a.name }
        return me?.displayName ?? email ?? ""
    }

    func tick(_ program: ProgramRow, _ exercise: Exercise) -> TickRow? {
        ticks[program.id + "__" + exercise.id]
    }

    func doneSets(_ program: ProgramRow, _ exercise: Exercise) -> Int {
        guard let t = tick(program, exercise) else { return 0 }
        if t.skipped { return exercise.setCount }
        return t.sets.count
    }

    func doneSets(_ program: ProgramRow) -> Int {
        program.body.blocks.flatMap(\.exercises).reduce(0) { $0 + min(doneSets(program, $1), $1.setCount) }
    }

    // MARK: Programs that run in session order (body.sequence)

    /// The latest local day any set in the session was ticked, as "YYYY-MM-DD".
    func lastTickDay(_ program: ProgramRow) -> String? {
        program.body.blocks.flatMap(\.exercises)
            .compactMap { tick(program, $0) }
            .flatMap { $0.sets.values.compactMap(\.at) }
            .compactMap { SessionDate.timestamp($0).map(SessionDate.string) }
            .max()
    }

    /// Finished, or ticked on an earlier day (a session ticked today is still the one being worked on).
    func isDone(_ program: ProgramRow) -> Bool {
        if finished[program.id] != nil { return true }
        guard let d = lastTickDay(program) else { return false }
        return d < SessionDate.today
    }

    /// The first in-order session that isn't done yet.
    var nextInOrder: ProgramRow? {
        programs.first { $0.body.sequence && !isDone($0) }
    }

    /// What to show instead of a date: "Done Mon 17 Nov", "Up next" or "Not done yet" for an in-order
    /// session; the planned date otherwise.
    func whenLabel(_ program: ProgramRow) -> String {
        guard program.body.sequence else { return SessionDate.label(program.date) }
        if let f = finished[program.id], let at = f.finishedAt, let d = SessionDate.timestamp(at) {
            return "Done " + SessionDate.label(SessionDate.string(d))
        }
        if let d = lastTickDay(program) { return "Done " + SessionDate.label(d) }
        return nextInOrder?.id == program.id ? "Up next" : "Not done yet"
    }
}
