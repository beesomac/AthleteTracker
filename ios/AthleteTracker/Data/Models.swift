import Foundation

// Rows and JSON shapes from the shared Supabase database.
// See the README section "Data for other apps (iOS)".

/// Result of the `whoami()` RPC: who the signed-in person is.
nonisolated struct WhoAmI: Decodable, Sendable {
    let email: String?
    let displayName: String?
    let role: String?

    enum CodingKeys: String, CodingKey {
        case email, role
        case displayName = "display_name"
    }
}

/// A row in `members` (only trainers can list everyone).
nonisolated struct Member: Decodable, Sendable, Identifiable, Hashable {
    let email: String
    let displayName: String?
    let role: String
    let active: Bool?
    let alsoAthlete: Bool?

    var id: String { email }
    var name: String { displayName ?? email.components(separatedBy: "@").first ?? email }

    enum CodingKeys: String, CodingKey {
        case email, role, active
        case displayName = "display_name"
        case alsoAthlete = "also_athlete"
    }
}

/// A published program (one training session) from `programs`.
nonisolated struct ProgramRow: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    let athleteEmail: String?
    let date: String          // "YYYY-MM-DD"
    let title: String?
    let body: SessionBody

    enum CodingKeys: String, CodingKey {
        case id, date, title, body
        case athleteEmail = "athlete_email"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        athleteEmail = try c.decodeIfPresent(String.self, forKey: .athleteEmail)
        date = (try? c.decode(String.self, forKey: .date)) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: .title)
        body = (try? c.decode(SessionBody.self, forKey: .body)) ?? SessionBody()
    }

    var displayTitle: String { title ?? body.title ?? "Session" }
    var day: Date? { SessionDate.parse(date) }

    /// Every tick circle in the session (sets × rounds don't multiply: each exercise has its own `sets`).
    var totalSets: Int { body.blocks.flatMap(\.exercises).reduce(0) { $0 + $1.setCount } }

    static func == (a: ProgramRow, b: ProgramRow) -> Bool { a.id == b.id && a.athleteEmail == b.athleteEmail }
    func hash(into h: inout Hasher) { h.combine(id); h.combine(athleteEmail) }
}

/// The session JSON (same shape as the files in sessions/).
nonisolated struct SessionBody: Decodable, Sendable {
    var short: String?
    var title: String?
    var summary: String?
    var summaryLabel: String?
    var blocks: [Block] = []
    var next: [String] = []
    var planUrl: String?
    var planLabel: String?
    /// True when the program runs in session order instead of on fixed days (the date only keeps the order).
    var sequence: Bool = false

    init() {}

    enum CodingKeys: String, CodingKey { case short, title, summary, summaryLabel, blocks, next, planUrl, planLabel, sequence }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        short = c.lossyString(.short)
        title = c.lossyString(.title)
        summary = c.lossyString(.summary)
        summaryLabel = c.lossyString(.summaryLabel)
        blocks = (try? c.decode([Block].self, forKey: .blocks)) ?? []
        next = (try? c.decode([String].self, forKey: .next)) ?? []
        planUrl = c.lossyString(.planUrl)
        planLabel = c.lossyString(.planLabel)
        sequence = (try? c.decode(Bool.self, forKey: .sequence)) ?? false
    }
}

nonisolated struct Block: Decodable, Sendable, Identifiable {
    var key: String
    var name: String?
    var rounds: String?
    /// Free text shown above the block, e.g. the full write-up of a WOD from the console's library.
    var note: String?
    /// A WOD from the console's library (wods.json id), and the leaderboard picked for it.
    var wod: String?
    var board: String?
    var exercises: [Exercise]

    var id: String { key + (name ?? "") }
    var isWod: Bool { wod != nil || board != nil }

    enum CodingKeys: String, CodingKey { case key, name, rounds, note, wod, board, exercises }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = c.lossyString(.key) ?? ""
        name = c.lossyString(.name)
        rounds = c.lossyString(.rounds)
        note = c.lossyString(.note)
        wod = c.lossyString(.wod)
        board = c.lossyString(.board)
        exercises = (try? c.decode([Exercise].self, forKey: .exercises)) ?? []
    }
}

nonisolated struct Exercise: Decodable, Sendable, Identifiable {
    var id: String
    var name: String
    var sets: Double?
    var target: String?
    var status: String?
    var cue: String?
    var extra: String?
    var search: String?
    var video: String?
    var log: String?
    var suggestKg: Double?

    var setCount: Int { max(0, Int(sets ?? 0)) }

    /// A 1RM test: `log: "1rm"`, or a target/name like "1RM", "build to 1 rep max".
    /// Logging one fills in that lift's 1RM benchmark.
    var isOneRepMax: Bool {
        log == "1rm" || Lift.mentionsOneRepMax(name) || Lift.mentionsOneRepMax(target ?? "")
    }
    var liftKey: String { Lift.key(name) }

    enum CodingKeys: String, CodingKey { case id, name, sets, target, status, cue, extra, search, video, log, suggestKg }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lossyString(.id) ?? UUID().uuidString
        name = c.lossyString(.name) ?? "Exercise"
        sets = c.lossyDouble(.sets)
        target = c.lossyString(.target)
        status = c.lossyString(.status)
        cue = c.lossyString(.cue)
        extra = c.lossyString(.extra)
        search = c.lossyString(.search)
        video = c.lossyString(.video)
        log = c.lossyString(.log)
        suggestKg = c.lossyDouble(.suggestKg)
    }

    /// The exercise's demo: its own video link, or a YouTube search.
    var demoURL: URL? {
        if let video, let url = URL(string: video) { return url }
        let words = search ?? name
        var parts = URLComponents(string: "https://www.youtube.com/results")!
        parts.queryItems = [URLQueryItem(name: "search_query", value: words)]
        return parts.url
    }
}

/// A row in `ticks`: which sets of one exercise are done, with what was entered.
nonisolated struct TickRow: Decodable, Sendable {
    let sessionId: String
    let exerciseId: String
    let sets: [String: SetEntry]
    let skipped: Bool
    let skipReason: String?

    enum CodingKeys: String, CodingKey {
        case sets, skipped
        case sessionId = "session_id"
        case exerciseId = "exercise_id"
        case skipReason = "skip_reason"
    }

    init(sessionId: String, exerciseId: String, sets: [String: SetEntry], skipped: Bool = false, skipReason: String? = nil) {
        self.sessionId = sessionId
        self.exerciseId = exerciseId
        self.sets = sets
        self.skipped = skipped
        self.skipReason = skipReason
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        exerciseId = try c.decode(String.self, forKey: .exerciseId)
        sets = (try? c.decode([String: SetEntry].self, forKey: .sets)) ?? [:]
        skipped = (try? c.decode(Bool.self, forKey: .skipped)) ?? false
        skipReason = try? c.decode(String.self, forKey: .skipReason)
    }
}

nonisolated struct SetEntry: Codable, Sendable {
    var at: String?
    var reps: Double?
    var kg: Double?
    var secs: Double?

    enum CodingKeys: String, CodingKey { case at, reps, kg, secs }

    init(at: String? = nil, reps: Double? = nil, kg: Double? = nil, secs: Double? = nil) {
        self.at = at; self.reps = reps; self.kg = kg; self.secs = secs
    }

    init(from decoder: Decoder) throws {
        // Older ticks stored `true` for a done set; treat anything as "done".
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        at = c.lossyString(.at)
        reps = c.lossyDouble(.reps)
        kg = c.lossyDouble(.kg)
        secs = c.lossyDouble(.secs)
    }

    var label: String? {
        var bits: [String] = []
        if let kg { bits.append("\(SessionFormat.number(kg)) kg") }
        if let reps { bits.append("× \(SessionFormat.number(reps))") }
        if let secs { bits.append("\(SessionFormat.number(secs)) s") }
        return bits.isEmpty ? nil : bits.joined(separator: " ")
    }
}

/// A row in `session_finishes`.
nonisolated struct FinishRow: Decodable, Sendable {
    let sessionId: String
    let finishedAt: String?

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case finishedAt = "finished_at"
    }
}

// MARK: - Helpers

nonisolated extension KeyedDecodingContainer {
    /// A string, or a number written as a string. nil when missing or unusable.
    func lossyString(_ key: Key) -> String? {
        if let s = try? decode(String.self, forKey: key) { return s }
        if let d = try? decode(Double.self, forKey: key) { return SessionFormat.number(d) }
        return nil
    }

    /// A number, or a string holding a number.
    func lossyDouble(_ key: Key) -> Double? {
        if let d = try? decode(Double.self, forKey: key) { return d }
        if let s = try? decode(String.self, forKey: key) { return Double(s) }
        return nil
    }
}

nonisolated enum SessionFormat {
    static func number(_ d: Double) -> String {
        d.formatted(.number.grouping(.never))
    }
}

nonisolated enum SessionDate {
    /// Parses "YYYY-MM-DD" as a local calendar day.
    static func parse(_ s: String) -> Date? {
        let parts = s.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    /// Today as "YYYY-MM-DD" in the phone's time zone, to compare with program dates.
    static var today: String {
        string(.now)
    }

    /// Parses a timestamp from the database, with or without fractional seconds.
    static func timestamp(_ s: String) -> Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(s))
            ?? (try? Date.ISO8601FormatStyle().parse(s))
    }

    /// A local calendar day as "YYYY-MM-DD".
    static func string(_ d: Date) -> String {
        d.formatted(Date.ISO8601FormatStyle(timeZone: .current).year().month().day())
    }

    static func label(_ s: String) -> String {
        guard let d = parse(s) else { return s }
        return d.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    }
}
