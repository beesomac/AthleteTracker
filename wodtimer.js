// WOD rounds and the full-screen WOD timer, shared by app.js (and readable by console.js).
//
//   WodTimer.library()            → the wods.json list (fetched once)
//   WodTimer.plan({...})          → { title, rounds: [[{name, target}]], repeat, timer, scoreType }
//   WodTimer.mapSplits(plan, splits, by) → round/set times from timer splits
//   WodTimer.open({ plan, onLog }) → full-screen timer; double-tap anywhere records a split
//
// Splits are seconds from the start. With by = "round" each split ends a round; with by = "set"
// each split ends one movement (set) inside a round, and a round's time is the sum of its sets.
(function () {
  let LIB = null, libLoading = null;
  function library() {
    if (LIB) return Promise.resolve(LIB);
    if (!libLoading) libLoading = fetch("wods.json", { cache: "no-cache" }).then((r) => r.json()).then((d) => (LIB = d.wods || [])).catch(() => (LIB = []));
    return libLoading;
  }
  const find = (id) => (id && LIB ? LIB.find((w) => w.id === id) : null);

  // ─── Plan: what each round holds, and how the timer starts ───────────────────────────────
  // libraryId: a wods.json id (program block .wod, or a leaderboard's library_id)
  // block: a program block (fallback when the WOD isn't in the library: block rounds × exercises)
  function plan({ libraryId, block, cap, scoreType, title }) {
    const lib = find(libraryId);
    let rounds = lib && lib.round_sets ? lib.round_sets : null;
    let repeat = !!(lib && lib.round_repeat);
    if (!rounds && block && (block.exercises || []).length) {
      const ex = block.exercises.filter((e) => e.status !== "hold");
      const n = parseInt(block.rounds, 10) || Math.max(1, ...ex.map((e) => +e.sets || 1));
      const one = ex.map((e) => ({ name: e.name, target: e.target || "" }));
      rounds = Array.from({ length: Math.min(n, 50) }, () => one);
    }
    const capSecs = cap || (lib && lib.cap) || 0;
    const timer = Object.assign({}, (lib && lib.timer) || (capSecs ? { mode: "down", secs: capSecs } : { mode: "up" }));
    return { title: title || (lib && lib.name) || (block && block.name) || "WOD", rounds, repeat, timer, scoreType: scoreType || (lib && lib.score) || "time", cap: capSecs };
  }

  // Reps in a target like "21 reps", "15 cal", "21 @ 43/29 kg" (distances don't count).
  function repsOf(target) {
    const m = /^(\d+)\s*(reps?\b|cal\b|@|,|$)/i.exec(String(target || "").trim());
    return m ? +m[1] : 0;
  }

  // What a split means by default: single-round chippers split per movement, the rest per round.
  const defaultBy = (p) => (p && p.rounds && p.rounds.length === 1 && !p.repeat && p.rounds[0].length > 1 ? "set" : "round");

  function mapSplits(p, splits, by) {
    splits = splits || [];
    const times = splits.map((t, i) => Math.round((t - (i ? splits[i - 1] : 0)) * 10) / 10);
    const R = (p && p.rounds) || [];
    if (!R.length) return { rounds: times.map((t) => ({ time: t, sets: [] })), doneRounds: times.length, doneSets: 0, reps: 0 };
    const perRound = R[0].length || 1;
    const n = p.repeat ? Math.max(1, by === "set" ? Math.floor(times.length / perRound) + 1 : times.length + 1) : R.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const r = R[p.repeat ? i % R.length : i];
      if (!r) break;
      out.push({ time: null, sets: r.map((s) => ({ name: s.name, target: s.target, time: null })) });
    }
    let doneRounds = 0, doneSets = 0, reps = 0;
    if (by === "set") {
      let k = 0;
      for (const r of out) {
        for (const s of r.sets) { if (k >= times.length) break; s.time = times[k++]; doneSets++; reps += repsOf(s.target); }
        if (r.sets.length && r.sets.every((s) => s.time != null)) { r.time = Math.round(r.sets.reduce((a, s) => a + s.time, 0) * 10) / 10; doneRounds++; }
      }
    } else {
      times.forEach((t, i) => { if (out[i]) { out[i].time = t; doneRounds++; doneSets += out[i].sets.length; reps += out[i].sets.reduce((a, s) => a + repsOf(s.target), 0); } });
    }
    return { rounds: out, doneRounds, doneSets, reps };
  }

  // ─── Small helpers ───────────────────────────────────────────────────────────────────────
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function clock(secs, tenths) {
    secs = Math.max(0, secs);
    const whole = tenths ? Math.floor(secs) : Math.ceil(secs - 0.05);
    const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
    const t = (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
    return tenths ? t + "." + Math.floor((secs - whole) * 10) : t;
  }
  function timerLabel(t) {
    if (t.mode === "down") return clock(t.secs) + " countdown";
    if (t.mode === "intervals") return `${t.rounds ? t.rounds + " × " : ""}${clock(t.work)} work${t.rest ? " / " + clock(t.rest) + " rest" : ""}${t.rounds ? "" : ", until stopped"}`;
    return "Count up";
  }
  // "12:30", "12", "90s" → seconds
  function parseClock(v) {
    const s = String(v || "").trim();
    if (!s) return 0;
    if (/^\d+(\.\d+)?s$/i.test(s)) return parseFloat(s);
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 60);
    const m = /^(\d+):(\d{1,2})$/.exec(s);
    return m ? +m[1] * 60 + +m[2] : 0;
  }

  let audio = null;
  function beep(freq, ms) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = freq; o.connect(g); g.connect(audio.destination);
      g.gain.setValueAtTime(0.25, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + ms / 1000);
      o.start(); o.stop(audio.currentTime + ms / 1000);
    } catch (e) {}
  }

  // ─── The full-screen timer ───────────────────────────────────────────────────────────────
  const LEAD = 10; // seconds of "get ready"

  function open({ plan: p, onLog }) {
    const el = document.createElement("div");
    el.className = "wt";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "WOD timer");
    document.body.appendChild(el);
    document.documentElement.classList.add("wt-open");

    const st = { phase: "setup", timer: Object.assign({ mode: "up" }, p.timer), by: defaultBy(p), splits: [], start: 0, pausedAt: 0, pausedTotal: 0, lastTap: 0, lastBeep: null, hitLimit: false, elapsed: 0 };
    let raf = 0, lock = null;

    async function keepAwake() {
      try { if ("wakeLock" in navigator && document.visibilityState === "visible") lock = await navigator.wakeLock.request("screen"); } catch (e) {}
    }
    const onVis = () => { if (document.visibilityState === "visible" && st.phase !== "setup" && st.phase !== "done") keepAwake(); };
    document.addEventListener("visibilitychange", onVis);

    const now = () => performance.now();
    // Seconds since the start (negative during get ready); stops while paused.
    const t = () => ((st.phase === "paused" ? st.pausedAt : now()) - st.start - st.pausedTotal) / 1000 - LEAD;
    const total = () => {
      const T = st.timer;
      if (T.mode === "down") return T.secs;
      if (T.mode === "intervals" && T.rounds) return T.rounds * (T.work + (T.rest || 0)) - (T.rest || 0);
      return 0;
    };

    function close() {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
      document.removeEventListener("keydown", onKey);
      try { lock && lock.release(); } catch (e) {}
      try { document.fullscreenElement && document.exitFullscreen(); } catch (e) {}
      document.documentElement.classList.remove("wt-open");
      el.remove();
    }

    function split() {
      if (st.phase !== "run") return;
      const x = t();
      if (x < 0.5) return;
      if (st.splits.length && x - st.splits[st.splits.length - 1] < 1) return; // a bounce, not a split
      st.splits.push(Math.round(x * 10) / 10);
      try { navigator.vibrate && navigator.vibrate(40); } catch (e) {}
      beep(1320, 90);
      el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
      draw();
    }

    function finish(hitLimit) {
      const lim = total();
      let x = Math.max(0, t());
      if (lim && x > lim) x = lim;
      st.hitLimit = !!hitLimit;
      st.elapsed = Math.round(x * 10) / 10;
      // Finishing by hand ends the last round (or movement) too, unless you just split.
      if (!hitLimit && x > 0.5 && (!st.splits.length || x - st.splits[st.splits.length - 1] > 3)) st.splits.push(st.elapsed);
      st.phase = "done";
      cancelAnimationFrame(raf);
      try { lock && lock.release(); } catch (e) {}
      beep(660, 600);
      draw();
    }

    function result() {
      const m = mapSplits(p, st.splits, st.by);
      return { elapsed: st.elapsed, hitLimit: st.hitLimit, splits: st.splits.slice(), by: st.by, timer: timerLabel(st.timer), timerSpec: st.timer, mapped: m };
    }

    function tick() {
      if (st.phase !== "run") return;
      const x = t(), lim = total();
      // Beeps: 3-2-1 before the start, the last 3 seconds of a countdown, and interval changes.
      let mark = null;
      if (x < 0) mark = Math.ceil(-x) <= 3 ? "lead" + Math.ceil(-x) : null;
      else if (st.timer.mode === "intervals") {
        const T = st.timer, per = T.work + (T.rest || 0), inP = x % per, left = (inP < T.work ? T.work : per) - inP;
        mark = left <= 3 ? "iv" + Math.floor(x / per) + (inP < T.work ? "w" : "r") + Math.ceil(left) : null;
      } else if (lim && lim - x <= 3) mark = "end" + Math.ceil(lim - x);
      if (mark && mark !== st.lastBeep) { st.lastBeep = mark; beep(880, 120); }
      if (x >= 0 && st.lastBeep && st.lastBeep.startsWith("lead")) { st.lastBeep = "go"; beep(1760, 350); }
      if (lim && x >= lim) { finish(true); return; }
      drawClock();
      raf = requestAnimationFrame(tick);
    }

    // Round shown on the clock: from the interval, or from how many splits so far.
    function current() {
      const R = p.rounds || [];
      const n = st.splits.length;
      if (st.timer.mode === "intervals") {
        const per = st.timer.work + (st.timer.rest || 0);
        const i = Math.max(0, Math.floor(Math.max(0, t()) / per));
        return { round: i, set: -1, sets: R.length ? R[p.repeat ? i % R.length : Math.min(i, R.length - 1)] : [] };
      }
      if (!R.length) return { round: n, set: -1, sets: [] };
      if (st.by === "set") {
        const per = R[0].length || 1;
        const round = Math.floor(n / per), set = n % per;
        return { round, set, sets: R[p.repeat ? round % R.length : Math.min(round, R.length - 1)] || [] };
      }
      return { round: n, set: -1, sets: R[p.repeat ? n % R.length : Math.min(n, R.length - 1)] || [] };
    }

    function drawClock() {
      const x = t(), T = st.timer, lim = total();
      const big = el.querySelector(".wt-time"), sub = el.querySelector(".wt-sub"), phase = el.querySelector(".wt-phase");
      if (!big) return;
      el.classList.toggle("rest", false);
      if (x < 0) {
        big.textContent = String(Math.ceil(-x));
        phase.textContent = "Get ready";
        sub.textContent = timerLabel(T);
        return;
      }
      if (T.mode === "down") {
        big.textContent = clock(T.secs - x);
        phase.textContent = "Time left";
        sub.textContent = clock(x) + " gone";
      } else if (T.mode === "intervals") {
        const per = T.work + (T.rest || 0), i = Math.floor(x / per), inP = x % per, work = inP < T.work;
        big.textContent = clock((work ? T.work : per) - inP);
        phase.textContent = work ? "Work" : "Rest";
        el.classList.toggle("rest", !work);
        sub.textContent = `Round ${i + 1}${T.rounds ? " of " + T.rounds : ""} · ${clock(x)} total`;
      } else {
        big.textContent = clock(x, false);
        phase.textContent = "Time";
        sub.textContent = lim ? "cap " + clock(lim) : "";
      }
      const last = el.querySelector(".wt-last");
      if (last) {
        const n = st.splits.length, prev = n ? st.splits[n - 1] : 0;
        last.textContent = n ? `Split ${n}: ${clock(prev - (n > 1 ? st.splits[n - 2] : 0), true)} · this one ${clock(x - prev)}` : "Double-tap anywhere to record a split";
      }
    }

    function roundHTML() {
      const R = p.rounds || [];
      if (!R.length && st.timer.mode !== "intervals") return "";
      const c = current();
      const label = st.timer.mode === "intervals" ? "" : R.length ? `Round ${c.round + 1}${p.repeat ? "" : " of " + R.length}` : "";
      const done = !p.repeat && st.timer.mode !== "intervals" && R.length && c.round >= R.length;
      return `<div class="wt-round">${label ? `<div class="wt-rlabel">${esc(done ? "All rounds done" : label)}</div>` : ""}
        ${done ? "" : `<ul>${(c.sets || []).map((s, i) => `<li class="${i === c.set ? "now" : i < c.set ? "did" : ""}"><b>${esc(s.target)}</b> ${esc(s.name)}</li>`).join("")}</ul>`}</div>`;
    }

    function setupHTML() {
      const T = st.timer;
      const R = p.rounds || [];
      return `<div class="wt-setup">
        <div class="wt-title">${esc(p.title)}</div>
        <div class="wt-field"><span>Timer</span><div class="wt-seg" role="radiogroup">
          ${[["down", "Countdown"], ["up", "Count up"], ["intervals", "Intervals"]].map(([v, l]) => `<button type="button" data-wt="mode" data-v="${v}" aria-pressed="${T.mode === v}">${l}</button>`).join("")}
        </div></div>
        ${T.mode === "down" ? `<label class="wt-field"><span>Minutes</span><input data-wt-in="secs" inputmode="decimal" value="${esc(clock(T.secs || 600))}"></label>` : ""}
        ${T.mode === "intervals" ? `<div class="wt-row">
          <label class="wt-field"><span>Work</span><input data-wt-in="work" value="${esc(clock(T.work || 60))}"></label>
          <label class="wt-field"><span>Rest</span><input data-wt-in="rest" value="${esc(clock(T.rest || 0))}"></label>
          <label class="wt-field"><span>Rounds</span><input data-wt-in="rounds" inputmode="numeric" value="${esc(T.rounds || "")}" placeholder="until stopped"></label></div>` : ""}
        ${R.length ? `<div class="wt-field"><span>Double-tap records</span><div class="wt-seg">
          <button type="button" data-wt="by" data-v="round" aria-pressed="${st.by === "round"}">Each round</button>
          <button type="button" data-wt="by" data-v="set" aria-pressed="${st.by === "set"}">Each movement</button></div></div>` : ""}
        <p class="wt-hint">Double-tap anywhere on the timer to record a split. Your screen stays on while it runs.</p>
        <div class="wt-actions"><button type="button" class="wt-btn" data-wt="close">Cancel</button><button type="button" class="wt-btn go" data-wt="start">Start</button></div>
      </div>`;
    }

    function doneHTML() {
      const r = result(), m = r.mapped;
      const rows = m.rounds.filter((x) => x.time != null || x.sets.some((s) => s.time != null));
      return `<div class="wt-setup wt-done">
        <div class="wt-title">${esc(p.title)}</div>
        <div class="wt-total">${r.hitLimit && st.timer.mode === "down" ? "Time's up" : clock(r.elapsed, true)}</div>
        <div class="wt-sub2">${esc(r.timer)} · ${r.splits.length} split${r.splits.length === 1 ? "" : "s"}</div>
        ${rows.length ? `<ol class="wt-splits">${rows.map((x, i) => `<li><span>Round ${i + 1}</span><b>${x.time != null ? clock(x.time, true) : "–"}</b>${st.by === "set" ? `<small>${x.sets.filter((s) => s.time != null).map((s) => `${esc(s.name)} ${clock(s.time, true)}`).join(" · ")}</small>` : ""}</li>`).join("")}</ol>` : r.splits.length ? `<ol class="wt-splits">${r.splits.map((s, i) => `<li><span>Split ${i + 1}</span><b>${clock(s - (i ? r.splits[i - 1] : 0), true)}</b></li>`).join("")}</ol>` : ""}
        ${(p.rounds || []).length ? `<div class="wt-field"><span>Splits were</span><div class="wt-seg">
          <button type="button" data-wt="by" data-v="round" aria-pressed="${st.by === "round"}">Rounds</button>
          <button type="button" data-wt="by" data-v="set" aria-pressed="${st.by === "set"}">Movements</button></div></div>` : ""}
        <div class="wt-actions"><button type="button" class="wt-btn" data-wt="close">Close</button>${onLog ? `<button type="button" class="wt-btn go" data-wt="log">Log score</button>` : ""}</div>
      </div>`;
    }

    function draw() {
      if (st.phase === "setup") el.innerHTML = setupHTML();
      else if (st.phase === "done") el.innerHTML = doneHTML();
      else {
        el.innerHTML = `<div class="wt-top"><span class="wt-name">${esc(p.title)}</span><button type="button" class="wt-x" data-wt="quit" aria-label="Stop timer">✕</button></div>
          <div class="wt-main"><div class="wt-phase"></div><div class="wt-time"></div><div class="wt-sub"></div></div>
          <div class="wt-side">${roundHTML()}<div class="wt-last"></div></div>
          <div class="wt-bottom"><button type="button" class="wt-btn" data-wt="pause">${st.phase === "paused" ? "Resume" : "Pause"}</button><button type="button" class="wt-btn" data-wt="split">Split</button><button type="button" class="wt-btn go" data-wt="finish">Finish</button></div>`;
        drawClock();
      }
    }

    function readSetup() {
      const T = st.timer;
      el.querySelectorAll("[data-wt-in]").forEach((i) => {
        const k = i.dataset.wtIn;
        if (k === "rounds") T.rounds = Math.max(0, parseInt(i.value, 10) || 0);
        else T[k] = parseClock(i.value);
      });
      if (T.mode === "down" && !(T.secs > 0)) T.secs = 600;
      if (T.mode === "intervals" && !(T.work > 0)) T.work = 60;
    }

    el.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-wt]");
      if (!b) return;
      const a = b.dataset.wt;
      if (a === "mode") { readSetup(); st.timer.mode = b.dataset.v; if (b.dataset.v === "down" && !st.timer.secs) st.timer.secs = p.cap || 600; draw(); }
      else if (a === "by") { if (st.phase === "setup") readSetup(); st.by = b.dataset.v; draw(); }
      else if (a === "close") close();
      else if (a === "start") {
        readSetup();
        beep(1, 1); // unlocks audio on this tap
        // Full screen, and sideways where the browser allows it (Android); iPhone users turn the phone.
        try { el.requestFullscreen && el.requestFullscreen().then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock("landscape").catch(() => {})).catch(() => {}); } catch (e) {}
        keepAwake();
        st.phase = "run"; st.start = now(); st.pausedTotal = 0;
        draw(); raf = requestAnimationFrame(tick);
      } else if (a === "pause") {
        if (st.phase === "run") { st.phase = "paused"; st.pausedAt = now(); cancelAnimationFrame(raf); draw(); }
        else if (st.phase === "paused") { st.pausedTotal += now() - st.pausedAt; st.phase = "run"; draw(); raf = requestAnimationFrame(tick); }
      } else if (a === "split") split();
      else if (a === "finish") { if (st.phase === "paused") { st.pausedTotal += now() - st.pausedAt; st.phase = "run"; } if (t() < 0) close(); else finish(false); }
      else if (a === "quit") { if (st.phase === "paused") { st.pausedTotal += now() - st.pausedAt; st.phase = "run"; } if (t() < 1) close(); else finish(false); }
      else if (a === "log") { const r = result(); close(); onLog(r); }
    });
    // Double-tap anywhere (but not on a button) records a split.
    el.addEventListener("pointerdown", (ev) => {
      if (st.phase !== "run" || ev.target.closest("button")) return;
      const n = now();
      if (n - st.lastTap < 380) { st.lastTap = 0; split(); } else st.lastTap = n;
    });
    el.addEventListener("dblclick", (ev) => ev.preventDefault());
    const onKey = (ev) => { if (st.phase === "run" && (ev.key === " " || ev.key === "Enter") && !ev.target.closest("input")) { ev.preventDefault(); split(); } if (ev.key === "Escape" && st.phase === "setup") close(); };
    document.addEventListener("keydown", onKey);

    draw();
    return { close };
  }

  window.WodTimer = { library, find, plan, mapSplits, repsOf, defaultBy, open, clock, parseClock, timerLabel };
})();
