import Foundation

// WOD rounds, the WOD timer's settings, and the round detail saved with a score.
// Same rules as the website's wodtimer.js; the detail is wod_results.detail (supabase/011).

/// Saves a WOD score: score, Rx, date, note, and the round detail.
typealias ScoreSaver = (Double, Bool, Date, String, WodDetail?) async throws -> Void

/// One movement in a round, e.g. Wall Walk "3 reps".
nonisolated struct WodSet: Codable, Sendable, Hashable {
    let name: String
    let target: String

    init(name: String, target: String) { self.name = name; self.target = target }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = (try? c.decode(String.self, forKey: .name)) ?? "Movement"
        target = c.lossyString(.target) ?? ""
    }

    /// Reps in a target like "21 reps", "15 cal", "21 @ 43/29 kg". Distances don't count.
    var reps: Int { WodPlan.reps(in: target) }
}

/// How the timer runs: count up, count down, or work/rest intervals (rounds 0 = until stopped).
nonisolated struct TimerSpec: Codable, Sendable, Hashable {
    enum Mode: String, Codable, Sendable, CaseIterable { case up, down, intervals }
    var mode: Mode
    var secs: Int?
    var work: Int?
    var rest: Int?
    var rounds: Int?

    init(mode: Mode, secs: Int? = nil, work: Int? = nil, rest: Int? = nil, rounds: Int? = nil) {
        self.mode = mode; self.secs = secs; self.work = work; self.rest = rest; self.rounds = rounds
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = (try? c.decode(Mode.self, forKey: .mode)) ?? .up
        secs = try? c.decode(Int.self, forKey: .secs)
        work = try? c.decode(Int.self, forKey: .work)
        rest = try? c.decode(Int.self, forKey: .rest)
        rounds = try? c.decode(Int.self, forKey: .rounds)
    }

    var workSecs: Int { max(1, work ?? 60) }
    var restSecs: Int { max(0, rest ?? 0) }
    var period: Int { workSecs + restSecs }

    /// Seconds until the timer stops on its own; nil when it runs until you finish.
    var limit: Double? {
        switch mode {
        case .down: return Double(max(1, secs ?? 600))
        case .intervals:
            guard let r = rounds, r > 0 else { return nil }
            return Double(r * period - restSecs)
        case .up: return nil
        }
    }

    var label: String {
        switch mode {
        case .down: return "\(WodClock.text(Double(secs ?? 600))) countdown"
        case .intervals:
            let r = (rounds ?? 0) > 0 ? "\(rounds!) × " : ""
            let rest = restSecs > 0 ? " / \(WodClock.text(Double(restSecs))) rest" : ""
            return "\(r)\(WodClock.text(Double(workSecs))) work\(rest)\((rounds ?? 0) > 0 ? "" : ", until stopped")"
        case .up: return "Count up"
        }
    }
}

/// What a WOD's rounds hold and how its timer starts.
nonisolated struct WodPlan: Sendable, Hashable {
    var title: String
    var rounds: [[WodSet]]      // empty when the WOD has no fixed rounds
    var repeats: Bool           // an AMRAP: the round repeats until time's up
    var timer: TimerSpec
    var scoreType: String
    var cap: Int?

    /// From the library (a program block's `wod`, or a leaderboard's `library_id`), else from
    /// the program block's own exercises (block rounds × exercises).
    static func make(library: LibraryWod?, block: Block? = nil, board: WodRow? = nil) -> WodPlan {
        var rounds = library?.roundSets ?? []
        var repeats = library?.roundRepeat ?? false
        if rounds.isEmpty, let block, !block.exercises.isEmpty {
            let ex = block.exercises.filter { $0.status != "hold" }
            let n = Int(block.rounds?.prefix { $0.isNumber } ?? "") ?? max(1, ex.map(\.setCount).max() ?? 1)
            let one = ex.map { WodSet(name: $0.name, target: $0.target ?? "") }
            rounds = Array(repeating: one, count: min(max(n, 1), 50))
            repeats = false
        }
        let cap = board?.timeCapSeconds ?? library?.cap
        let timer = library?.timer ?? (cap.map { TimerSpec(mode: .down, secs: $0) } ?? TimerSpec(mode: .up))
        return WodPlan(
            title: board?.name ?? library?.name ?? block?.name ?? "WOD",
            rounds: rounds, repeats: repeats, timer: timer,
            scoreType: board?.scoreType ?? library?.score ?? "time", cap: cap
        )
    }

    /// Single-round chippers split per movement; everything else per round.
    var defaultSplitBy: SplitBy {
        rounds.count == 1 && !repeats && rounds[0].count > 1 ? .set : .round
    }

    func round(_ i: Int) -> [WodSet] {
        guard !rounds.isEmpty else { return [] }
        return repeats ? rounds[i % rounds.count] : rounds[min(i, rounds.count - 1)]
    }

    static func reps(in target: String) -> Int {
        let t = target.trimmingCharacters(in: .whitespaces)
        guard let m = t.firstMatch(of: /^(\d+)\s*(reps?\b|cal\b|@|,|$)/.ignoresCase()) else { return 0 }
        return Int(m.1) ?? 0
    }

    // MARK: Splits → round and movement times

    enum SplitBy: String, Codable, Sendable { case round, set }

    struct Mapped: Sendable {
        var rounds: [RoundTimes]
        var doneRounds: Int
        var reps: Int
    }
    struct RoundTimes: Sendable {
        var time: Double?
        var sets: [(set: WodSet, time: Double?)]
    }

    /// splits are seconds from the start. With .round each split ends a round; with .set each one
    /// ends a movement, and a round's time is the sum of its movements.
    func map(splits: [Double], by: SplitBy) -> Mapped {
        let times = splits.enumerated().map { i, t in ((t - (i > 0 ? splits[i - 1] : 0)) * 10).rounded() / 10 }
        guard !rounds.isEmpty else {
            return Mapped(rounds: times.map { RoundTimes(time: $0, sets: []) }, doneRounds: times.count, reps: 0)
        }
        let perRound = max(1, rounds[0].count)
        let n = repeats ? max(1, by == .set ? times.count / perRound + 1 : times.count + 1) : rounds.count
        var out = (0..<n).map { i in RoundTimes(time: nil, sets: round(i).map { ($0, nil) }) }
        var doneRounds = 0, reps = 0
        switch by {
        case .set:
            var k = 0
            for r in out.indices {
                for s in out[r].sets.indices where k < times.count {
                    out[r].sets[s].time = times[k]; k += 1
                    reps += out[r].sets[s].set.reps
                }
                if !out[r].sets.isEmpty, out[r].sets.allSatisfy({ $0.time != nil }) {
                    out[r].time = (out[r].sets.reduce(0) { $0 + ($1.time ?? 0) } * 10).rounded() / 10
                    doneRounds += 1
                }
            }
        case .round:
            for (i, t) in times.enumerated() where i < out.count {
                out[i].time = t
                doneRounds += 1
                reps += out[i].sets.reduce(0) { $0 + $1.set.reps }
            }
        }
        return Mapped(rounds: out, doneRounds: doneRounds, reps: reps)
    }
}

/// What the timer hands back when you finish.
nonisolated struct TimerResult: Sendable, Identifiable {
    let id = UUID()
    var elapsed: Double
    var hitLimit: Bool
    var splits: [Double]
    var by: WodPlan.SplitBy
    var timer: TimerSpec
}

/// wod_results.detail: round by round, with what was actually done and the timer splits.
nonisolated struct WodDetail: Codable, Sendable, Hashable {
    nonisolated struct SetDetail: Codable, Sendable, Hashable {
        var name: String
        var target: String?
        var actual: String?
        var time: Double?
    }
    nonisolated struct Round: Codable, Sendable, Hashable {
        var time: Double?
        var sets: [SetDetail]
    }
    var rounds: [Round]
    var splits: [Double]?
    var splitBy: String?
    var timer: String?

    enum CodingKeys: String, CodingKey {
        case rounds, splits, timer
        case splitBy = "split_by"
    }

    init(rounds: [Round], splits: [Double]? = nil, splitBy: String? = nil, timer: String? = nil) {
        self.rounds = rounds; self.splits = splits; self.splitBy = splitBy; self.timer = timer
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rounds = (try? c.decode([Round].self, forKey: .rounds)) ?? []
        splits = try? c.decode([Double].self, forKey: .splits)
        splitBy = try? c.decode(String.self, forKey: .splitBy)
        timer = try? c.decode(String.self, forKey: .timer)
    }

    var roundTimes: [Double] { rounds.compactMap(\.time) }

    /// "Rounds 0:41, 1:17, …" for a note, when the database can't hold the detail yet.
    var summary: String? {
        let t = roundTimes
        return t.isEmpty ? nil : "Rounds " + t.map { WodClock.text($0, tenths: true) }.joined(separator: ", ")
    }
}

nonisolated enum WodClock {
    /// 754.3 → "12:34" (or "12:34.3" with tenths).
    static func text(_ secs: Double, tenths: Bool = false) -> String {
        let s = max(0, secs)
        let whole = tenths ? Int(s.rounded(.down)) : Int((s - 0.05).rounded(.up))
        let h = whole / 3600, m = (whole % 3600) / 60, sec = whole % 60
        var out = h > 0 ? "\(h):" + String(format: "%02d", m) : "\(m)"
        out += ":" + String(format: "%02d", sec)
        if tenths {
            let f = Int(((s - Double(whole)) * 10).rounded(.down))
            if f > 0 { out += ".\(f)" }
        }
        return out
    }

    /// "12:30", "90s", "12" (minutes) → seconds.
    static func parse(_ text: String) -> Int? {
        let s = text.trimmingCharacters(in: .whitespaces).lowercased()
        if s.isEmpty { return nil }
        if s.hasSuffix("s"), let n = Double(s.dropLast()) { return Int(n) }
        if let n = Double(s) { return Int(n * 60) }
        let p = s.split(separator: ":")
        if p.count == 2, let m = Int(p[0]), let sec = Int(p[1]), sec < 60 { return m * 60 + sec }
        return nil
    }
}
