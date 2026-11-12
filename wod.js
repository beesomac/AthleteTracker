// WOD scores: one number per score type so the database can sort them, shared by app.js and console.js.
//   time        → seconds, lower wins         ("12:34", "1:02:03" or plain seconds)
//   reps        → reps, higher wins           ("150")
//   load        → kg, higher wins             ("102.5")
//   rounds_reps → rounds * 1000 + reps        ("5+12", "5 + 12" or "5")
(function () {
  const TYPES = {
    time: { label: "For time", unit: "", hint: "mm:ss", lowerWins: true },
    reps: { label: "Max reps", unit: "reps", hint: "reps", lowerWins: false },
    load: { label: "Max load", unit: "kg", hint: "kg", lowerWins: false },
    rounds_reps: { label: "AMRAP", unit: "", hint: "rounds+reps, e.g. 5+12", lowerWins: false },
  };

  // Text typed by a person → the stored number, or null if it doesn't make sense.
  function parse(type, text) {
    const s = String(text ?? "").trim().replace(/\s+/g, "");
    if (!s) return null;
    if (type === "time") {
      if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return null;
      const parts = s.split(":").map(Number);
      if (parts.slice(1).some((x) => x >= 60)) return null;
      const secs = parts.reduce((acc, x) => acc * 60 + x, 0);
      return secs > 0 ? Math.round(secs * 10) / 10 : null;
    }
    if (type === "rounds_reps") {
      const m = /^(\d+)(?:\+(\d+))?$/.exec(s);
      if (!m) return null;
      const reps = m[2] ? +m[2] : 0;
      if (reps >= 1000) return null;
      return +m[1] * 1000 + reps;
    }
    const n = Number(s.replace(/(kg|reps)$/i, ""));
    if (!isFinite(n) || n <= 0) return null;
    return type === "reps" ? Math.round(n) : Math.round(n * 100) / 100;
  }

  // Stored number → text for people.
  function format(type, score) {
    if (score == null || score === "") return "";
    const n = +score;
    if (type === "time") {
      const whole = Math.floor(n), frac = Math.round((n - whole) * 10);
      const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), sec = whole % 60;
      const ss = String(sec).padStart(2, "0") + (frac ? "." + frac : "");
      return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
    }
    if (type === "rounds_reps") {
      const r = Math.floor(n / 1000), reps = Math.round(n % 1000);
      return reps ? `${r} + ${reps}` : `${r} rds`;
    }
    if (type === "load") return `${n} kg`;
    if (type === "reps") return `${n} reps`;
    return String(n);
  }

  // Rx ahead of scaled, then by score. Adds rank (ties share a rank).
  function rank(type, rows) {
    const lower = TYPES[type] ? TYPES[type].lowerWins : false;
    const sorted = rows.slice().sort((a, b) => (b.rx === a.rx ? (lower ? a.score - b.score : b.score - a.score) : b.rx ? 1 : -1));
    let prev = null;
    sorted.forEach((r, i) => {
      r.rank = prev && prev.rx === r.rx && +prev.score === +r.score ? prev.rank : i + 1;
      prev = r;
    });
    return sorted;
  }

  // Each athlete's best row (for boards built from raw results).
  function bestPerAthlete(type, rows, keyOf) {
    const best = {};
    for (const r of rank(type, rows)) { const k = keyOf(r); if (!best[k]) best[k] = r; }
    return rank(type, Object.values(best));
  }

  window.WodScore = { TYPES, parse, format, rank, bestPerAthlete };
})();
