// Run with: node tests/scale.test.js
const assert = require("assert");
const S = require("../scale.js");
const t = (text, scale, equipment) => S.scaleText(text, { scale, equipment, sizes: { db: S.DUMBBELLS, kb: S.KETTLEBELLS }, picks: {}, out: [], key: "k" });
const cases = [
  ["10 reps", 0.8, "bar", "8 reps"],
  ["8 / leg", 0.8, "bar", "6 / leg"],
  ["10 + 10", 0.8, "bar", "8 + 8"],
  ["3 reps", 0.8, "bar", "2 reps"],
  ["20 s", 0.8, "bar", "20 s"],
  ["400 m", 0.8, "bar", "400 m"],
  ["15 reps, 60/50 cm", 0.8, "bar", "12 reps, 60/50 cm"],
  ["9 reps @ 70/45 kg", 0.8, "bar", "7 reps @ 55/35 kg"],
  ["15, 13, 11, 9, 7 reps rising from 61/38 kg", 0.8, "bar", "12, 10, 9, 7, 6 reps rising from 50/30 kg"],
  ["4 reps @ 2 × 22.5/15 kg DB", 0.8, "db", "3 reps @ 2 × 17.5/12.5 kg DB"],
  ["21-15-9 reps", 0.8, "bar", "17-12-7 reps"],
  ["3x10", 0.8, "bar", "3x8"],
  ["RPE 7", 0.8, "bar", "RPE 7"],
  ["AMRAP in 10 minutes:\n30 double-unders\n15 power snatches, 34/25 kg", 0.8, "auto", "AMRAP in 10 minutes:\n24 double-unders\n12 power snatches, 25/20 kg"],
  ["5 rounds for time:\n10 DB snatches, 22.5 kg", 0.8, "auto", "5 rounds for time:\n8 DB snatches, 17.5 kg"],
  ["12:00 cap", 0.8, "bar", "12:00 cap"],
  ["10 reps", 1.2, "bar", "12 reps"],
  ["1 rep", 0.5, "bar", "1 rep"],
];
for (const [inp, sc, eq, want] of cases) assert.strictEqual(t(inp, sc, eq), want, inp);
// john's example: 22.5 kg dumbbell at 80% → 17.5 picked, 20 / 17.5 / 15 offered
const c = S.choices(22.5 * 0.8, S.DUMBBELLS, 0.8);
assert.strictEqual(c.pick, 17.5); assert.deepStrictEqual(c.options, [20, 17.5, 15]);
assert.strictEqual(S.roundBar(77.5 * 0.8), 60); assert.strictEqual(S.roundBar(61 * 0.8), 50);
assert.strictEqual(S.equipmentOf("DB Bench Press"), "db"); assert.strictEqual(S.equipmentOf("KB Romanian Deadlift"), "kb"); assert.strictEqual(S.equipmentOf("BB Box Squat"), "bar");
assert.strictEqual(S.scaleExtra("RPE 7 · last 3 × 10 × 22.5 kg (a PB, best was 8)", { scale: 0.8 }), "RPE 7");
// whole body: picks, choices and history
const body = { blocks: [{ key: "C", name: "Strength", exercises: [
  { id: "a", name: "DB Bench Press", sets: 3, target: "10 reps", extra: "RPE 7 · last 3 × 10 × 22.5 kg", suggestKg: 22.5 },
  { id: "b", name: "BB Box Squat", sets: 4, target: "8 reps", extra: "RPE 6, 6, 7, 7 · try 65 / 72.5 / 77.5 / 77.5 kg · last 60 / 70 / 75 / 75 kg × 8", suggestKg: 65 },
  { id: "c", name: "Copenhagen plank", sets: 3, target: "30 s", log: "secs" },
] }] };
let r = S.scaleBody(body, 0.8, { prefix: "p1" });
const [a, b, cc] = r.body.blocks[0].exercises;
assert.strictEqual(a.target, "8 reps"); assert.strictEqual(a.suggestKg, 17.5); assert.strictEqual(a.extra, "RPE 7");
assert.strictEqual(b.suggestKg, 50); assert.strictEqual(b.extra, "RPE 6, 6, 7, 7 · try 50 / 60 / 60 / 60 kg");
assert.strictEqual(cc.target, "30 s");
assert.strictEqual(r.choices.length, 1); assert.deepStrictEqual(r.choices[0].options, [20, 17.5, 15]);
r = S.scaleBody(body, 0.8, { prefix: "p1", picks: { [r.choices[0].key]: 15 } });
assert.strictEqual(r.body.blocks[0].exercises[0].suggestKg, 15);
assert.strictEqual(body.blocks[0].exercises[0].suggestKg, 22.5, "source untouched");
// WOD note dumbbell follows the movement's pick
const wod = { blocks: [{ key: "B", name: "DT-ish", wod: "x", note: "5 rounds:\n10 DB snatches, 22.5 kg", exercises: [{ id: "m1", name: "DB Snatch", sets: 5, target: "10 reps @ 22.5 kg", log: "tick" }] }] };
r = S.scaleBody(wod, 0.8, { prefix: "p", picks: { "p|Bm1|22.5": 15 } });
assert.strictEqual(r.choices.length, 1, "one question per dumbbell");
assert.strictEqual(r.body.blocks[0].note, "5 rounds:\n8 DB snatches, 15 kg");
assert.strictEqual(S.parseSizes("2.5, 5 7.5;10", S.DUMBBELLS).join(), "2.5,5,7.5,10");
console.log("scale.js: all " + (cases.length + 20) + " checks passed");
const note = S.scaleBody({ blocks: [{ key: "A", name: "Open 19.2", note: "Repeat of 16.2, starting with 8 minutes. Rounds to 8, 12, 16, 20 min:\n25 toes-to-bars, 50 double-unders, then\n15 squat cleans 61/38 kg · 13 at 84/52 kg", exercises: [] }] }, 0.8).body.blocks[0].note;
assert.strictEqual(note, "Repeat of 16.2, starting with 8 minutes. Rounds to 8, 12, 16, 20 min:\n20 toes-to-bars, 40 double-unders, then\n12 squat cleans 50/30 kg · 10 at 65/40 kg");
const thr = S.scaleBody({ blocks: [{ key: "A", name: "Open 20.2", note: "AMRAP in 20 minutes:\n4 DB thrusters (two 22.5/15 kg DBs)\n6 toes-to-bars", exercises: [{ id: "g1", name: "DB Thruster", log: "tick", sets: 1, target: "4 reps @ 2 × 22.5/15 kg DB" }] }] }, 0.8);
assert.strictEqual(thr.choices.length, 2); assert.strictEqual(thr.body.blocks[0].note, "AMRAP in 20 minutes:\n3 DB thrusters (two 17.5/12.5 kg DBs)\n5 toes-to-bars");
console.log("WOD notes ok");
// keep reps, scale weight only (and the other way round)
const kr = S.scaleBody({ blocks: [{ key: "A", name: "Open 20.2", note: "AMRAP in 20 minutes:\n4 DB thrusters (two 22.5/15 kg DBs)\n6 toes-to-bars", exercises: [{ id: "g1", name: "DB Thruster", sets: 1, target: "4 reps @ 2 × 22.5/15 kg DB" }, { id: "g2", name: "Toes-to-Bar", sets: 1, target: "6 reps" }, { id: "g3", name: "BB Squat", sets: 3, target: "8 reps", suggestKg: 100 }] }] }, { reps: 1, weight: 0.8 });
assert.strictEqual(kr.body.blocks[0].exercises[0].target, "4 reps @ 2 × 17.5/12.5 kg DB");
assert.strictEqual(kr.body.blocks[0].exercises[1].target, "6 reps");
assert.strictEqual(kr.body.blocks[0].exercises[2].target, "8 reps"); assert.strictEqual(kr.body.blocks[0].exercises[2].suggestKg, 80);
assert.strictEqual(kr.body.blocks[0].note, "AMRAP in 20 minutes:\n4 DB thrusters (two 17.5/12.5 kg DBs)\n6 toes-to-bars");
const kw = S.scaleBody({ blocks: [{ key: "A", exercises: [{ id: "a", name: "BB Squat", sets: 3, target: "10 reps @ 100 kg", suggestKg: 100 }] }] }, { reps: 0.8, weight: 1 });
assert.strictEqual(kw.body.blocks[0].exercises[0].target, "8 reps @ 100 kg"); assert.strictEqual(kw.body.blocks[0].exercises[0].suggestKg, 100); assert.strictEqual(kw.choices.length, 0);
console.log("separate reps / weight ok");
