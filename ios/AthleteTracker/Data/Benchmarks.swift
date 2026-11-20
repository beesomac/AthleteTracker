import Foundation

// Leaderboards, benchmark WODs and 1RMs. Same tables the website uses:
// wods, wod_results, wod_board(), lift_maxes. See the README "Data for other apps".

/// A leaderboard (`wods` row). `libraryId` links it to a benchmark in wods.json.
nonisolated struct WodRow: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    let name: String
    let description: String?
    let scoreType: String
    let timeCapSeconds: Int?
    let wodDate: String?
    let status: String
    let libraryId: String?

    enum CodingKeys: String, CodingKey {
        case id, name, description, status
        case scoreType = "score_type"
        case timeCapSeconds = "time_cap_seconds"
        case wodDate = "wod_date"
        case libraryId = "library_id"
    }

    var isOpen: Bool { status == "open" }
}

/// One line of `wod_board()`: each athlete's best visible score on a board.
nonisolated struct BoardRow: Decodable, Sendable, Identifiable {
    let resultId: String
    let wodId: String
    let athleteName: String?
    let isMe: Bool
    let score: Double
    let rx: Bool
    let performedOn: String?
    let note: String?

    var id: String { resultId }

    enum CodingKeys: String, CodingKey {
        case score, rx, note
        case resultId = "result_id"
        case wodId = "wod_id"
        case athleteName = "athlete_name"
        case isMe = "is_me"
        case performedOn = "performed_on"
    }
}

/// One of the athlete's own scores (`wod_results`).
nonisolated struct ResultRow: Decodable, Sendable, Identifiable {
    let id: String
    let wodId: String
    let score: Double
    let rx: Bool
    let performedOn: String?
    let note: String?

    enum CodingKeys: String, CodingKey {
        case id, score, rx, note
        case wodId = "wod_id"
        case performedOn = "performed_on"
    }
}

/// A known 1RM (`lift_maxes`), keyed by the lift's normalised name.
nonisolated struct LiftMax: Decodable, Sendable {
    let liftKey: String
    let liftName: String?
    let kg: Double
    let testedOn: String?

    enum CodingKeys: String, CodingKey {
        case kg
        case liftKey = "lift_key"
        case liftName = "lift_name"
        case testedOn = "tested_on"
    }
}

// MARK: - Benchmark library (a copy of the web's wods.json, bundled in the app)

nonisolated struct LibraryWod: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    let name: String
    let group: String
    let year: Int?
    let primary: String?
    let format: String?
    let score: String          // score type: time | reps | load | rounds_reps
    let description: String?
    let movements: [Movement]
    let cap: Int?              // time cap in seconds, for "for time" WODs

    nonisolated struct Movement: Decodable, Sendable, Hashable {
        let name: String
        let target: String?
    }

    enum CodingKeys: String, CodingKey { case id, name, group, year, primary, format, score, description, movements, cap }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        group = (try? c.decode(String.self, forKey: .group)) ?? "other"
        year = try? c.decode(Int.self, forKey: .year)
        primary = try? c.decode(String.self, forKey: .primary)
        format = try? c.decode(String.self, forKey: .format)
        score = (try? c.decode(String.self, forKey: .score)) ?? "time"
        description = try? c.decode(String.self, forKey: .description)
        movements = (try? c.decode([Movement].self, forKey: .movements)) ?? []
    }
}

nonisolated enum WodLibrary {
    /// Every library WOD, in file order.
    static let all: [LibraryWod] = {
        nonisolated struct File: Decodable { let wods: [LibraryWod] }
        guard let url = Bundle.main.url(forResource: "wods", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let file = try? JSONDecoder().decode(File.self, from: data) else { return [] }
        return file.wods
    }()

    static var girls: [LibraryWod] { all.filter { $0.group == "girls" } }
    static var open: [LibraryWod] { all.filter { $0.group == "open" } }

    static func find(_ id: String?) -> LibraryWod? {
        guard let id else { return nil }
        return all.first { $0.id == id }
    }
}

// MARK: - 1RM lifts

nonisolated enum Lift {
    /// The lifts always listed under Benchmarks → 1RM, even before there's a number.
    static let standard = [
        "Back Squat", "Front Squat", "Overhead Squat", "Deadlift", "Bench Press",
        "Strict Press", "Push Press", "Push Jerk", "Split Jerk",
        "Clean", "Power Clean", "Clean & Jerk", "Snatch", "Power Snatch", "Thruster",
    ]

    private static let oneRepMax = #"\b(1\s*rm|1\s*rep\s*max|one\s*rep\s*max)\b"#

    static func mentionsOneRepMax(_ text: String) -> Bool {
        text.range(of: oneRepMax, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// Same key as the website's liftKey(): lower case, no brackets, no "1RM", words only.
    /// "Back Squat (high bar) 1RM" → "back squat".
    static func key(_ name: String) -> String {
        name.lowercased()
            .replacingOccurrences(of: #"\(.*?\)"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: oneRepMax, with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: "[^a-z0-9]+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }

    /// The lift's name without the "1RM" wording, for display and lift_maxes.lift_name.
    static func displayName(_ name: String) -> String {
        name.replacingOccurrences(of: oneRepMax, with: "", options: [.regularExpression, .caseInsensitive])
            .trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "-–·:")))
    }
}

// MARK: - Scores (same rules as the website's wod.js)

nonisolated enum WodScore {
    //   time        → seconds, lower wins
    //   reps        → reps, higher wins
    //   load        → kg, higher wins
    //   rounds_reps → rounds * 1000 + reps
    // A capped "for time" score (didn't finish in the cap) is "CAP + reps", stored as
    // capBase * 2 - reps: above every real time, and more reps sorts lower (better).

    static let capBase = 1_000_000.0

    static func capped(reps: Int) -> Double { capBase * 2 - Double(min(max(reps, 0), Int(capBase) - 1)) }
    static func isCapped(_ type: String, _ score: Double) -> Bool { type == "time" && score >= capBase }
    static func cappedReps(_ score: Double) -> Int { Int((capBase * 2 - score).rounded()) }

    /// Reps done at the cap, typed as "45", "cap 45" or "CAP+45" → stored score.
    static func parseCapped(_ text: String) -> Double? {
        var s = text.filter { !$0.isWhitespace }.lowercased()
        if s.hasPrefix("cap") { s.removeFirst(3) }
        if s.hasPrefix("+") { s.removeFirst() }
        if s.hasSuffix("reps") { s.removeLast(4) } else if s.hasSuffix("rep") { s.removeLast(3) }
        guard !s.isEmpty, s.allSatisfy(\.isNumber), let n = Int(s), Double(n) < capBase else { return nil }
        return capped(reps: n)
    }

    static func label(_ type: String) -> String {
        switch type {
        case "time": "For time"
        case "reps": "Max reps"
        case "load": "Max load"
        case "rounds_reps": "AMRAP"
        default: type
        }
    }

    static func hint(_ type: String) -> String {
        switch type {
        case "time": "mm:ss"
        case "reps": "reps"
        case "load": "kg"
        case "rounds_reps": "rounds+reps, e.g. 5+12"
        default: ""
        }
    }

    static func lowerWins(_ type: String) -> Bool { type == "time" }

    /// Text typed by a person → the stored number, or nil if it doesn't make sense.
    static func parse(_ type: String, _ text: String, capped isCap: Bool = false) -> Double? {
        if type == "time" && (isCap || text.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("cap")) {
            return parseCapped(text)
        }
        let s = text.filter { !$0.isWhitespace }
        guard !s.isEmpty else { return nil }
        switch type {
        case "time":
            let parts = s.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
            guard (1...3).contains(parts.count) else { return nil }
            var secs = 0.0
            for (i, part) in parts.enumerated() {
                let isLast = i == parts.count - 1
                guard !part.isEmpty, part.allSatisfy({ $0.isNumber || (isLast && $0 == ".") }),
                      let n = Double(part) else { return nil }
                if i > 0 && n >= 60 { return nil }
                secs = secs * 60 + n
            }
            return secs > 0 ? (secs * 10).rounded() / 10 : nil
        case "rounds_reps":
            let parts = s.split(separator: "+", omittingEmptySubsequences: false)
            guard (1...2).contains(parts.count), let rounds = Int(parts[0]) else { return nil }
            let reps = parts.count == 2 ? Int(parts[1]) : 0
            guard let reps, reps < 1000, rounds >= 0 else { return nil }
            return Double(rounds * 1000 + reps)
        default:
            let trimmed = s.lowercased().replacingOccurrences(of: #"(kg|reps)$"#, with: "", options: .regularExpression)
            guard let n = Double(trimmed), n > 0, n.isFinite else { return nil }
            return type == "reps" ? n.rounded() : (n * 100).rounded() / 100
        }
    }

    /// Stored number → text for people.
    static func format(_ type: String, _ score: Double) -> String {
        switch type {
        case "time":
            if score >= capBase { return "CAP + \(cappedReps(score)) reps" }
            let whole = Int(score), frac = Int(((score - Double(whole)) * 10).rounded())
            let h = whole / 3600, m = (whole % 3600) / 60, sec = whole % 60
            let ss = String(sec).leftPad(2) + (frac > 0 ? ".\(frac)" : "")
            return h > 0 ? "\(h):\(String(m).leftPad(2)):\(ss)" : "\(m):\(ss)"
        case "rounds_reps":
            let r = Int(score) / 1000, reps = Int(score) % 1000
            return reps > 0 ? "\(r) + \(reps)" : "\(r) rds"
        case "load": return "\(SessionFormat.number(score)) kg"
        case "reps": return "\(SessionFormat.number(score)) reps"
        default: return SessionFormat.number(score)
        }
    }

    /// Rx ahead of scaled, then by score.
    static func isBetter(_ type: String, _ a: (score: Double, rx: Bool), than b: (score: Double, rx: Bool)) -> Bool {
        if a.rx != b.rx { return a.rx }
        return lowerWins(type) ? a.score < b.score : a.score > b.score
    }

    /// Board rows in order, with ranks (ties share a rank).
    static func ranked(_ type: String, _ rows: [BoardRow]) -> [RankedRow] {
        let sorted = rows.sorted { isBetter(type, ($0.score, $0.rx), than: ($1.score, $1.rx)) }
        var out: [RankedRow] = []
        for (i, r) in sorted.enumerated() {
            if let prev = out.last, prev.row.rx == r.rx, prev.row.score == r.score {
                out.append(RankedRow(rank: prev.rank, row: r))
            } else {
                out.append(RankedRow(rank: i + 1, row: r))
            }
        }
        return out
    }
}

nonisolated struct RankedRow: Identifiable, Sendable {
    let rank: Int
    let row: BoardRow
    var id: String { row.id }
}

/// One line under Benchmarks → 1RM.
nonisolated struct LiftLine: Identifiable, Sendable {
    let key: String
    let name: String
    let max: LiftMax?
    var id: String { key }
}

private extension String {
    nonisolated func leftPad(_ n: Int) -> String { count >= n ? self : String(repeating: "0", count: n - count) + self }
}
