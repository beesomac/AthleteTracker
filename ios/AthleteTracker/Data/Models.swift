import Foundation

// Rows and JSON shapes from the shared Supabase database.
// See the README section "Data for other apps (iOS)".

/// Result of the `whoami()` RPC: who the signed-in person is.
struct WhoAmI: Decodable, Sendable {
    let email: String?
    let displayName: String?
    let role: String?

    enum CodingKeys: String, CodingKey {
        case email, role
        case displayName = "display_name"
    }
}

/// A row in `members` (only trainers can list everyone).
struct Member: Decodable, Sendable, Identifiable, Hashable {
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
struct ProgramRow: Decodable, Sendable, Identifiable, Hashable {
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
struct SessionBody: Decodable, Sendable {
    var short: String?
    var title: String?
    var summary: String?
    var summaryLabel: String?
    var blocks: [Block] = []
    var next: [String] = []
    var planUrl: String?
    var planLabel: String?

    init() {}

    enum CodingKeys: String, CodingKey { case short, title, summary, summaryLabel, blocks, next, planUrl, planLabel }

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
    }
}

struct Block: Decodable, Sendable, Identifiable {
    var key: String
    var name: String?
    var rounds: String?
    var exercises: [Exercise]

    var id: String { key + (name ?? "") }

    enum CodingKeys: String, CodingKey { case key, name, rounds, exercises }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = c.lossyString(.key) ?? ""
        name = c.lossyString(.name)
        rounds = c.lossyString(.rounds)
        exercises = (try? c.decode([Exercise].self, forKey: .exercises)) ?? []
    }
}

struct Exercise: Decodable, Sendable, Identifiable {
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
struct TickRow: Decodable, Sendable {
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

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        exerciseId = try c.decode(String.self, forKey: .exerciseId)
        sets = (try? c.decode([String: SetEntry].self, forKey: .sets)) ?? [:]
        skipped = (try? c.decode(Bool.self, forKey: .skipped)) ?? false
        skipReason = try? c.decode(String.self, forKey: .skipReason)
    }
}

struct SetEntry: Decodable, Sendable {
    var reps: Double?
    var kg: Double?
    var secs: Double?

    enum CodingKeys: String, CodingKey { case reps, kg, secs }

    init(from decoder: Decoder) throws {
        // Older ticks stored `true` for a done set; treat anything as "done".
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
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
struct FinishRow: Decodable, Sendable {
    let sessionId: String
    let finishedAt: String?

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case finishedAt = "finished_at"
    }
}

// MARK: - Helpers

extension KeyedDecodingContainer {
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

enum SessionFormat {
    static func number(_ d: Double) -> String {
        d.rounded() == d ? String(Int(d)) : String(format: "%g", d)
    }
}

enum SessionDate {
    /// Parses "YYYY-MM-DD" as a local calendar day.
    static func parse(_ s: String) -> Date? {
        let parts = s.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    static func label(_ s: String) -> String {
        guard let d = parse(s) else { return s }
        return d.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    }
}
