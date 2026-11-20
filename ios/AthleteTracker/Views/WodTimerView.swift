import SwiftUI
import AudioToolbox

/// Full-screen WOD timer: count up, count down (21.1 = 15:00) or work/rest intervals.
/// Double-tap anywhere records a split; splits become round (or movement) times on the score.
/// The screen stays awake while it's open.
struct WodTimerView: View {
    @Environment(\.dismiss) private var dismiss
    let plan: WodPlan
    let canLog: Bool
    /// Called with the result when you tap Log score; the timer closes first.
    let onLog: (TimerResult) -> Void

    enum Phase { case setup, running, paused, done }

    @State private var phase: Phase = .setup
    @State private var spec: TimerSpec
    @State private var by: WodPlan.SplitBy
    @State private var startedAt: Date?
    @State private var pausedAt: Date?
    @State private var pausedTotal: TimeInterval = 0
    @State private var splits: [Double] = []
    @State private var elapsed: Double = 0
    @State private var hitLimit = false
    @State private var lastBeep = ""
    @State private var flash = false
    @State private var minutesText = ""
    @State private var workText = ""
    @State private var restText = ""
    @State private var roundsText = ""

    private static let lead: Double = 10   // seconds of "get ready"

    init(plan: WodPlan, canLog: Bool, onLog: @escaping (TimerResult) -> Void) {
        self.plan = plan
        self.canLog = canLog
        self.onLog = onLog
        _spec = State(initialValue: plan.timer)
        _by = State(initialValue: plan.defaultSplitBy)
    }

    var body: some View {
        ZStack {
            background.ignoresSafeArea()
            switch phase {
            case .setup: setup
            case .running, .paused: running
            case .done: done
            }
        }
        .preferredColorScheme(.dark)
        .statusBarHidden(phase == .running || phase == .paused)
        .persistentSystemOverlays(.hidden)
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true; fillSetupFields() }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        .sensoryFeedback(.impact(weight: .heavy), trigger: splits.count)
        .task(id: phase) {
            // Beeps and the automatic stop; the clock itself redraws in a TimelineView.
            while phase == .running && !Task.isCancelled {
                tick()
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }

    // MARK: Time

    private func t(_ now: Date = .now) -> Double {
        guard let startedAt else { return -Self.lead }
        return (pausedAt ?? now).timeIntervalSince(startedAt) - pausedTotal - Self.lead
    }

    private var isRest: Bool {
        guard phase == .running || phase == .paused, spec.mode == .intervals else { return false }
        let x = t()
        return x >= 0 && x.truncatingRemainder(dividingBy: Double(spec.period)) >= Double(spec.workSecs)
    }

    private var background: Color {
        isRest ? Color(red: 0.06, green: 0.16, blue: 0.11) : Color(red: 0.05, green: 0.07, blue: 0.09)
    }

    private func tick() {
        let x = t()
        var mark = ""
        if x < 0 {
            let n = Int(ceil(-x))
            if n <= 3 { mark = "lead\(n)" }
        } else if spec.mode == .intervals {
            let per = Double(spec.period), inP = x.truncatingRemainder(dividingBy: per)
            let work = inP < Double(spec.workSecs)
            let left = (work ? Double(spec.workSecs) : per) - inP
            if left <= 3 { mark = "iv\(Int(x / per))\(work ? "w" : "r")\(Int(ceil(left)))" }
        } else if let lim = spec.limit, lim - x <= 3 {
            mark = "end\(Int(ceil(lim - x)))"
        }
        if !mark.isEmpty && mark != lastBeep {
            lastBeep = mark
            AudioServicesPlaySystemSound(1057)
        }
        if x >= 0 && lastBeep.hasPrefix("lead") {
            lastBeep = "go"
            AudioServicesPlaySystemSound(1052)
        }
        if let lim = spec.limit, x >= lim { finish(hitLimit: true) }
    }

    private func split() {
        guard phase == .running else { return }
        let x = t()
        guard x >= 0.5 else { return }
        if let last = splits.last, x - last < 1 { return }   // a bounce, not a split
        splits.append((x * 10).rounded() / 10)
        AudioServicesPlaySystemSound(1057)
        flash = true
        withAnimation(.easeOut(duration: 0.35)) { flash = false }
    }

    private func start() {
        readSetupFields()
        startedAt = .now
        pausedTotal = 0
        pausedAt = nil
        phase = .running
    }

    private func togglePause() {
        if phase == .running {
            pausedAt = .now
            phase = .paused
        } else if phase == .paused, let p = pausedAt {
            pausedTotal += Date.now.timeIntervalSince(p)
            pausedAt = nil
            phase = .running
        }
    }

    private func finish(hitLimit: Bool) {
        if let p = pausedAt { pausedTotal += Date.now.timeIntervalSince(p); pausedAt = nil }
        var x = max(0, t())
        if let lim = spec.limit { x = min(x, lim) }
        elapsed = (x * 10).rounded() / 10
        self.hitLimit = hitLimit
        // Finishing by hand ends the last round (or movement) too, unless you just split.
        if !hitLimit && x > 0.5 && (splits.last.map { x - $0 > 3 } ?? true) { splits.append(elapsed) }
        phase = .done
        AudioServicesPlaySystemSound(1052)
    }

    private var result: TimerResult {
        TimerResult(elapsed: elapsed, hitLimit: hitLimit, splits: splits, by: by, timer: spec)
    }

    // MARK: Setup

    private var setup: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text(plan.title).font(.system(size: 34, weight: .bold, design: .rounded))
                VStack(alignment: .leading, spacing: 8) {
                    caption("Timer")
                    Picker("Timer", selection: $spec.mode) {
                        Text("Countdown").tag(TimerSpec.Mode.down)
                        Text("Count up").tag(TimerSpec.Mode.up)
                        Text("Intervals").tag(TimerSpec.Mode.intervals)
                    }
                    .pickerStyle(.segmented)
                }
                switch spec.mode {
                case .down:
                    field("Minutes", text: $minutesText, prompt: "15:00")
                case .intervals:
                    HStack(spacing: 12) {
                        field("Work", text: $workText, prompt: "1:00")
                        field("Rest", text: $restText, prompt: "0:00")
                        field("Rounds", text: $roundsText, prompt: "∞", keyboard: .numberPad)
                    }
                case .up:
                    if let cap = plan.cap, cap > 0 {
                        Text("Counts up. Cap \(WodClock.text(Double(cap))).").foregroundStyle(.secondary)
                    }
                }
                if !plan.rounds.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        caption("Double-tap records")
                        Picker("Double-tap records", selection: $by) {
                            Text("Each round").tag(WodPlan.SplitBy.round)
                            Text("Each movement").tag(WodPlan.SplitBy.set)
                        }
                        .pickerStyle(.segmented)
                    }
                }
                Text("Double-tap anywhere on the timer to record a split. Your screen stays on while it runs.")
                    .foregroundStyle(.secondary)
                HStack(spacing: 12) {
                    Button("Cancel") { dismiss() }
                        .buttonStyle(TimerButtonStyle())
                    Button("Start") { start() }
                        .buttonStyle(TimerButtonStyle(prominent: true))
                }
            }
            .padding(24)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private func caption(_ s: String) -> some View {
        Text(s.uppercased()).font(.caption.weight(.semibold)).tracking(1.2).foregroundStyle(.secondary)
    }

    private func field(_ label: String, text: Binding<String>, prompt: String, keyboard: UIKeyboardType = .numbersAndPunctuation) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            caption(label)
            TextField(prompt, text: text)
                .keyboardType(keyboard)
                .font(.title2.monospacedDigit())
                .padding(10)
                .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private func fillSetupFields() {
        minutesText = WodClock.text(Double(spec.secs ?? plan.cap ?? 600))
        workText = WodClock.text(Double(spec.workSecs))
        restText = WodClock.text(Double(spec.restSecs))
        roundsText = (spec.rounds ?? 0) > 0 ? "\(spec.rounds!)" : ""
    }

    private func readSetupFields() {
        switch spec.mode {
        case .down: spec.secs = max(1, WodClock.parse(minutesText) ?? spec.secs ?? 600)
        case .intervals:
            spec.work = max(1, WodClock.parse(workText) ?? spec.workSecs)
            spec.rest = max(0, WodClock.parse(restText) ?? 0)
            spec.rounds = Int(roundsText) ?? 0
        case .up: break
        }
    }

    // MARK: Running

    private var running: some View {
        VStack(spacing: 0) {
            HStack {
                Text(plan.title).font(.headline).lineLimit(1)
                Spacer()
                Button { finish(hitLimit: false) } label: {
                    Image(systemName: "xmark").font(.headline).frame(width: 36, height: 36)
                }
                .buttonStyle(.bordered).clipShape(Circle())
                .accessibilityLabel("Stop timer")
            }
            .padding(.horizontal, 20).padding(.top, 8)

            TimelineView(.animation(minimumInterval: 0.1, paused: phase != .running)) { ctx in
                face(t(ctx.date))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            HStack(spacing: 10) {
                Button(phase == .paused ? "Resume" : "Pause") { togglePause() }
                    .buttonStyle(TimerButtonStyle())
                Button("Split") { split() }
                    .buttonStyle(TimerButtonStyle())
                Button("Finish") { finish(hitLimit: false) }
                    .buttonStyle(TimerButtonStyle(prominent: true))
            }
            .padding(.horizontal, 20).padding(.bottom, 12)
        }
        .background(Color.orange.opacity(flash ? 0.35 : 0).ignoresSafeArea())
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { split() }
        .accessibilityAction(named: "Record split") { split() }
    }

    @ViewBuilder
    private func face(_ x: Double) -> some View {
        VStack(spacing: 8) {
            let texts = clockTexts(x)
            Text(texts.label.uppercased()).font(.subheadline.weight(.semibold)).tracking(2)
                .foregroundStyle(isRest ? .green : .secondary)
            Text(texts.big)
                .font(.system(size: 160, weight: .bold, design: .rounded).monospacedDigit())
                .minimumScaleFactor(0.3).lineLimit(1)
                .padding(.horizontal, 12)
            Text(texts.sub).font(.title3.monospacedDigit()).foregroundStyle(.secondary)
            if x >= 0 { roundView(x).padding(.top, 14) }
            Text(lastSplitText(x)).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary).padding(.top, 14)
        }
    }

    private func clockTexts(_ x: Double) -> (label: String, big: String, sub: String) {
        if x < 0 { return ("Get ready", "\(Int(ceil(-x)))", spec.label) }
        switch spec.mode {
        case .down:
            let lim = spec.limit ?? 0
            return ("Time left", WodClock.text(lim - x), "\(WodClock.text(x)) gone")
        case .intervals:
            let per = Double(spec.period), i = Int(x / per), inP = x.truncatingRemainder(dividingBy: per)
            let work = inP < Double(spec.workSecs)
            let left = (work ? Double(spec.workSecs) : per) - inP
            let of = (spec.rounds ?? 0) > 0 ? " of \(spec.rounds!)" : ""
            return (work ? "Work" : "Rest", WodClock.text(left), "Round \(i + 1)\(of) · \(WodClock.text(x)) total")
        case .up:
            return ("Time", WodClock.text(x.rounded(.down)), plan.cap.map { "cap \(WodClock.text(Double($0)))" } ?? "")
        }
    }

    private func lastSplitText(_ x: Double) -> String {
        guard let last = splits.last else { return "Double-tap anywhere to record a split" }
        let n = splits.count
        let prev = n > 1 ? splits[n - 2] : 0
        return "Split \(n): \(WodClock.text(last - prev, tenths: true)) · this one \(WodClock.text(x - last))"
    }

    /// The round you're on: from the interval, or from how many splits so far.
    @ViewBuilder
    private func roundView(_ x: Double) -> some View {
        let r = plan.rounds
        if spec.mode == .intervals {
            let i = Int(x / Double(spec.period))
            setsList(plan.round(i), current: -1)
        } else if !r.isEmpty {
            let perRound = max(1, r[0].count)
            let round = by == .set ? splits.count / perRound : splits.count
            let set = by == .set ? splits.count % perRound : -1
            if !plan.repeats && round >= r.count {
                Text("All rounds done").font(.title2.bold()).foregroundStyle(.orange)
            } else {
                VStack(spacing: 6) {
                    Text("Round \(round + 1)\(plan.repeats ? "" : " of \(r.count)")")
                        .font(.title2.bold()).foregroundStyle(.orange)
                    setsList(plan.round(round), current: set)
                }
            }
        }
    }

    private func setsList(_ sets: [WodSet], current: Int) -> some View {
        VStack(spacing: 4) {
            ForEach(Array(sets.enumerated()), id: \.offset) { i, s in
                HStack(spacing: 6) {
                    Text(s.target).font(.title3.bold())
                        .foregroundStyle(i == current ? .orange : .primary)
                    Text(s.name).font(.title3)
                }
                .opacity(current >= 0 && i < current ? 0.4 : 1)
                .strikethrough(current >= 0 && i < current)
            }
        }
    }

    // MARK: Done

    private var done: some View {
        let mapped = plan.map(splits: splits, by: by)
        let timed = mapped.rounds.enumerated().filter { $0.element.time != nil || $0.element.sets.contains { $0.time != nil } }
        return ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text(plan.title).font(.system(size: 34, weight: .bold, design: .rounded))
                Text(hitLimit && spec.mode == .down ? "Time's up" : WodClock.text(elapsed, tenths: true))
                    .font(.system(size: 72, weight: .bold, design: .rounded).monospacedDigit())
                Text("\(spec.label) · \(splits.count) split\(splits.count == 1 ? "" : "s")").foregroundStyle(.secondary)
                if !timed.isEmpty {
                    VStack(spacing: 8) {
                        ForEach(timed, id: \.offset) { i, r in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text("Round \(i + 1)")
                                    Spacer()
                                    Text(r.time.map { WodClock.text($0, tenths: true) } ?? "–").bold().monospacedDigit()
                                }
                                if by == .set {
                                    Text(r.sets.compactMap { s in s.time.map { "\(s.set.name) \(WodClock.text($0, tenths: true))" } }.joined(separator: " · "))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Divider()
                        }
                    }
                }
                if !plan.rounds.isEmpty && !splits.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        caption("Splits were")
                        Picker("Splits were", selection: $by) {
                            Text("Rounds").tag(WodPlan.SplitBy.round)
                            Text("Movements").tag(WodPlan.SplitBy.set)
                        }
                        .pickerStyle(.segmented)
                    }
                }
                HStack(spacing: 12) {
                    Button("Close") { dismiss() }
                        .buttonStyle(TimerButtonStyle())
                    if canLog {
                        Button("Log score") {
                            let r = result
                            onLog(r)
                            dismiss()
                        }
                        .buttonStyle(TimerButtonStyle(prominent: true))
                    }
                }
            }
            .padding(24)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
    }
}

struct TimerButtonStyle: ButtonStyle {
    var prominent = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 54)
            .foregroundStyle(.white)
            .background(prominent ? Color(red: 0.85, green: 0.28, blue: 0.11) : Color.white.opacity(0.1),
                        in: RoundedRectangle(cornerRadius: 14))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

// MARK: - Starting a WOD from any screen

/// A plan to show in the full-screen timer.
struct WodTimerItem: Identifiable {
    let id = UUID()
    let plan: WodPlan
}

extension View {
    /// Shows the WOD timer for `item`; when the athlete taps Log score, opens the score sheet
    /// with the time, rounds and splits filled in. `log` is nil when there's nowhere to log.
    func wodTimer(
        _ item: Binding<WodTimerItem?>,
        log: ((Double, Bool, Date, String, WodDetail?) async throws -> Void)?
    ) -> some View {
        modifier(WodTimerHost(item: item, log: log))
    }
}

private struct WodTimerHost: ViewModifier {
    @Binding var item: WodTimerItem?
    let log: ((Double, Bool, Date, String, WodDetail?) async throws -> Void)?
    @State private var queued: (WodPlan, TimerResult)?
    @State private var scoring: ScoreItem?

    struct ScoreItem: Identifiable {
        let id = UUID()
        let plan: WodPlan
        let result: TimerResult
    }

    func body(content: Content) -> some View {
        content
            .fullScreenCover(item: $item, onDismiss: {
                if let q = queued { scoring = ScoreItem(plan: q.0, result: q.1); queued = nil }
            }) { it in
                WodTimerView(plan: it.plan, canLog: log != nil) { r in queued = (it.plan, r) }
            }
            .sheet(item: $scoring) { s in
                LogScoreSheet(title: s.plan.title, scoreType: s.plan.scoreType, timeCap: s.plan.cap,
                              plan: s.plan, prefill: s.result) { score, rx, day, note, detail in
                    try await log?(score, rx, day, note, detail)
                }
            }
    }
}

/// A saved score's rounds: each round's time, and anything done differently from the plan.
struct RoundTimesView: View {
    let detail: WodDetail

    var body: some View {
        ForEach(Array(detail.rounds.enumerated()), id: \.offset) { i, r in
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text("Round \(i + 1)")
                    Spacer()
                    Text(r.time.map { WodClock.text($0, tenths: true) } ?? "–").monospacedDigit()
                }
                let changed = r.sets.filter { $0.actual != nil }
                if !changed.isEmpty {
                    Text(changed.map { "\($0.name): \($0.actual!)" }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}
