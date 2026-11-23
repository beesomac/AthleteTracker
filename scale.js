// Scaling rules for copying programs from one athlete to another (console "Copy a week").
// Works on the session JSON's free text (targets like "10 reps @ 22.5/15 kg", WOD notes,
// "try 65 / 72.5 kg" in extra) and on suggestKg. No database changes.
//
//   Reps      × scale, rounded to the nearest whole rep (at least 1).
//   Barbell   × scale, rounded to the nearest 5 kg (anything that isn't a dumbbell or kettlebell).
//   Dumbbell  × scale, then the trainer picks a real dumbbell size; the nearest is preselected,
//   Kettlebell  e.g. 22.5 kg at 80% = 18 kg → 17.5 (picked), 20 or 15.
//
// Left alone: sets, times (20 s, 10 min, 12:00), distances (400 m, 60/50 cm), rounds, RPE,
// "2 ×" counts, decimals in names (Open 11.1) and the athlete's own history in extra
// ("last …", "prev …", "best …"), which is dropped because it belongs to the other athlete.
(function (root) {
  const DUMBBELLS = [];
  for (let k = 2.5; k <= 50; k += 2.5) DUMBBELLS.push(k);
  const KETTLEBELLS = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 44, 48];

  const num = (s) => Number(String(s).replace(",", "."));
  const fmt = (n) => String(Math.round(n * 100) / 100);

  // Which kind of weight a line of text is about. The name decides; for a WOD note each line is
  // its own movement, so the line itself is checked.
  function equipmentOf(text) {
    const t = String(text || "");
    if (/\b(DBs?|dumb-?bells?)\b/i.test(t)) return "db";
    if (/\b(KBs?|kettle-?bells?)\b/i.test(t)) return "kb";
    return "bar";
  }

  function parseSizes(text, fallback) {
    const list = String(text || "").split(/[\s,;]+/).map(num).filter((n) => n > 0 && isFinite(n));
    return list.length ? [...new Set(list)].sort((a, b) => a - b) : fallback.slice();
  }

  // The three real sizes closest to the scaled weight, heaviest first, and the one to preselect
  // (the closest; on a tie the lighter when scaling down and the heavier when scaling up).
  function choices(scaled, sizes, scale) {
    const by = sizes.slice().sort((a, b) => Math.abs(a - scaled) - Math.abs(b - scaled) || (scale < 1 ? a - b : b - a));
    const pick = by[0];
    return { pick, options: by.slice(0, 3).sort((a, b) => b - a) };
  }

  function roundBar(kg) { return Math.max(5, Math.round(kg / 5) * 5); }

  // Reps and weight can scale differently: ctx.repScale / ctx.weightScale, else ctx.scale for both.
  const wScale = (ctx) => (ctx.weightScale != null ? ctx.weightScale : ctx.scale);
  const rScale = (ctx) => (ctx.repScale != null ? ctx.repScale : ctx.scale);
  // Scales one string. ctx: { scale, equipment, sizes: { db, kb }, picks, key, out }
  // picks[key + "|" + original] holds a chosen dumbbell/kettlebell size; every weight that needs
  // a choice is pushed to ctx.out as { key, from, scaled, options, pick, kind }.
  const WEIGHT = /(\d+(?:[.,]\d+)?)((?:\s*\/\s*\d+(?:[.,]\d+)?)*)(\s*kg\b)/gi;
  const SKIP_AFTER = /^\s*(?:s\b|secs?\b|seconds?\b|min\b|mins\b|minutes?\b|m\b|km\b|cm\b|mm\b|in\b|inch|"|'|%|rounds?\b|sets?\b|x\b|×|:|kg\b|lb|hz|hr\b|hours?\b|bpm|°|\.\d|,\d)/i;
  const SKIP_BEFORE = /(?:rpe|rir|week|wk|session|phase|tempo|day|block|amrap|emom|e\d+mom|every|cap|zone|level|open|of|top|round|set|no\.?|#|[:.\d])\s*$/i;

  function scaleWeight(kg, kind, ctx, original) {
    const ws = wScale(ctx);
    if (ws === 1) return kg;
    const scaled = kg * ws;
    if (kind === "bar") return roundBar(scaled);
    const c = choices(scaled, ctx.sizes[kind], ws);
    // A WOD note's weight that a movement in the block already asked about uses that answer.
    const alias = ctx.aliases && ctx.out && ctx.out.find((x) => ctx.aliases.includes(x.key) && x.from === original && x.kind === kind);
    if (alias) return alias.pick;
    const id = ctx.key + "|" + fmt(original);
    const picked = ctx.picks && ctx.picks[id] != null ? ctx.picks[id] : c.pick;
    if (ctx.out && !ctx.out.some((x) => x.key === id)) ctx.out.push({ key: id, from: original, scaled, options: c.options, pick: picked, kind, label: ctx.label || "" });
    return picked;
  }

  function scaleText(text, ctx) {
    if (text == null || text === "" || (wScale(ctx) === 1 && rScale(ctx) === 1)) return text;
    const lines = String(text).split("\n");
    return lines.map((line) => {
      const kind = ctx.equipment === "auto" ? equipmentOf(line) : (ctx.equipment || equipmentOf(line));
      // 1. weights → placeholders, so their numbers aren't taken for reps
      const held = [];
      let s = line.replace(WEIGHT, (all, first, rest, unit) => {
        const nums = [first].concat((rest.match(/\d+(?:[.,]\d+)?/g) || []));
        const seps = rest.match(/\s*\/\s*/g) || [];
        const out = nums.map((n) => fmt(scaleWeight(num(n), kind, ctx, num(n))));
        let r = out[0];
        for (let i = 1; i < out.length; i++) r += seps[i - 1] + out[i];
        held.push(r + unit);
        return "\u0000" + (held.length - 1) + "\u0000";
      });
      // 2. whole numbers (and runs like 21-15-9 or 24/20) that are reps. In a WOD note only the
      // movement lines ("30 double-unders"), not headers like "Rounds to 8, 12, 16, 20 min:".
      if (rScale(ctx) !== 1 && (!ctx.movementLinesOnly || /^\s*\d/.test(line))) s = s.replace(/(\d+(?:\s*[-–\/]\s*\d+)*)/g, (run, _r, at, str) => {
        const before = str.slice(0, at), after = str.slice(at + run.length);
        if (/\u0000$/.test(before) || /^\u0000/.test(after)) return run;          // placeholder index
        if ((/[A-Za-z]$/.test(before) && !/\d\s*x$/i.test(before)) || /^[A-Za-z]\d/.test(after)) return run; // part of a word, e.g. E2MOM
        if (SKIP_BEFORE.test(before) || SKIP_AFTER.test(after)) return run;          // "2 × 22.5", "3x10": the count before × stays
        return run.replace(/\d+/g, (d) => String(Math.max(1, Math.round(Number(d) * rScale(ctx)))));
      });
      return s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[Number(i)]);
    }).join("\n");
  }

  // extra: keep RPE notes and "try …" loads (scaled); drop the other athlete's history.
  function scaleExtra(extra, ctx) {
    if (!extra) return extra;
    const keep = String(extra).split(/\s*·\s*/).filter((seg) => !/^(last|prev|previous|best|pb|was)\b/i.test(seg) && !/^prev\/best/i.test(seg));
    const out = keep.map((seg) => (/^rpe|^rir/i.test(seg) ? seg : scaleText(seg, ctx))).join(" · ");
    return out || undefined;
  }

  // Returns { body, choices, changes } for one program body. picks are the trainer's dumbbell
  // choices so far, keyed "<prefix>|<exercise id>|<original kg>".
  // scale: one number for reps and weight, or { reps, weight }.
  function scaleBody(body, scale, opts = {}) {
    const sc = typeof scale === "object" && scale ? { repScale: scale.reps, weightScale: scale.weight, scale: scale.weight } : { scale };
    const sizes = { db: opts.dumbbells || DUMBBELLS, kb: opts.kettlebells || KETTLEBELLS };
    const picks = opts.picks || {}, prefix = opts.prefix || "", out = [], changes = [];
    const b2 = JSON.parse(JSON.stringify(body || {}));
    for (const b of b2.blocks || []) {
      const asked = out.length;
      for (const ex of b.exercises || []) {
        const equipment = equipmentOf(ex.name + " " + (ex.target || ""));
        const ctx = { ...sc, equipment, sizes, picks, out, key: prefix + "|" + (b.key || "") + ex.id, label: ex.name };
        const before = { target: ex.target, extra: ex.extra, suggestKg: ex.suggestKg };
        if (ex.log !== "secs") ex.target = scaleText(ex.target, ctx);
        if (ex.extra) { const e = scaleExtra(ex.extra, ctx); if (e) ex.extra = e; else delete ex.extra; }
        if (ex.suggestKg != null && isFinite(+ex.suggestKg)) ex.suggestKg = scaleWeight(+ex.suggestKg, equipment, ctx, +ex.suggestKg);
        const parts = [];
        if (before.target !== ex.target) parts.push({ what: "target", from: before.target, to: ex.target });
        if (before.suggestKg !== ex.suggestKg) parts.push({ what: "suggested", from: before.suggestKg + " kg", to: ex.suggestKg + " kg" });
        if (before.extra !== ex.extra) parts.push({ what: "extra", from: before.extra || "", to: ex.extra || "(history removed)" });
        if (parts.length) changes.push({ block: b.key, name: ex.name, parts });
      }
      if (b.note) {
        const ctx = { ...sc, equipment: "auto", movementLinesOnly: true, sizes, picks, out, key: prefix + "|" + (b.key || "") + "note", aliases: out.slice(asked).map((x) => x.key), label: (b.name || "WOD") + " note" };
        const n = scaleText(b.note, ctx);
        if (n !== b.note) { changes.push({ block: b.key, name: (b.name || "Block") + " (description)", parts: [{ what: "note", from: b.note, to: n }] }); b.note = n; }
      }
    }
    return { body: b2, choices: out, changes };
  }

  const api = { scaleBody, scaleText, scaleExtra, equipmentOf, choices, roundBar, parseSizes, DUMBBELLS, KETTLEBELLS };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ProgramScale = api;
})(typeof window !== "undefined" ? window : globalThis);
