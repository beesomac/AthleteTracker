// Trainer console: athletes, programs, feedback and WOD leaderboards.
// Reads and writes the same Supabase tables as the athlete site (see supabase/004_trainer_console.sql);
// row-level security only lets members with role "trainer" change any of it.
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const app = $("#app"), tabs = $("#tabs"), whoEl = $("#who");
  const W = window.WodScore;
  const sb = window.TrainingStore.createClient();

  const state = {
    me: null, name: null, role: null, loaded: false, error: null, needsMigration: false,
    members: [], programs: [], notes: [], finishes: [], wods: [], results: [],
    login: {}, athleteFilter: "", notesFilter: "open", confirm: null,
    editingMember: null, edit: null, reply: null, editingWod: false, fileIds: null,
  };

  // ─── helpers ──────────────────────────────────────────────────────────────────────────
  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function fmtDate(iso) { if (!iso) return ""; try { return new Date(String(iso).slice(0, 10) + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }); } catch (e) { return iso; } }
  function fmtWhen(iso) { try { const d = new Date(iso); return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }
  function today() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  const athletes = () => state.members.filter((m) => m.role === "athlete");
  // The inbox is for what athletes wrote; trainers' own replies don't need reviewing here.
  const byTrainer = (n) => state.members.some((m) => m.role === "trainer" && m.email === String(n.author_email || "").toLowerCase());
  const needsReview = (n) => !n.reviewed && !byTrainer(n);
  const activeAthletes = () => athletes().filter((m) => m.active);
  function nameOf(email) {
    if (!email) return "Someone";
    const m = state.members.find((x) => x.email === String(email).toLowerCase());
    return m && m.display_name ? m.display_name : String(email).split("@")[0];
  }
  function programTitle(sid) {
    const p = state.programs.find((x) => x.id === sid);
    return p ? (p.body && p.body.short ? p.body.short + " · " : "") + p.title : sid;
  }
  function athleteOptions(selected, { all = false, none = false } = {}) {
    let h = "";
    if (none) h += `<option value="">Choose athlete…</option>`;
    if (all) h += `<option value="" ${!selected ? "selected" : ""}>All athletes</option>`;
    for (const a of athletes()) h += `<option value="${esc(a.email)}" ${a.email === selected ? "selected" : ""}>${esc(a.display_name || a.email)}${a.active ? "" : " (inactive)"}</option>`;
    return h;
  }
  function flash(msg, kind) {
    const b = document.createElement("div"); b.className = "banner" + (kind ? " " + kind : ""); b.textContent = msg;
    app.prepend(b); setTimeout(() => b.remove(), 6000);
  }
  function failed(e) { console.warn(e); flash("That didn't save: " + ((e && e.message) || "check your connection") + "."); }
  function armed(key) { if (state.confirm === key) { state.confirm = null; return true; } state.confirm = key; render(); return false; }

  // ─── data ─────────────────────────────────────────────────────────────────────────────
  async function loadAll() {
    const [m, p, n, f, w, r] = await Promise.all([
      sb.from("members").select("*").order("display_name"),
      sb.from("programs").select("*").order("date", { ascending: false }),
      sb.from("notes").select("*").order("created_at", { ascending: false }),
      sb.from("session_finishes").select("*").order("finished_at", { ascending: false }),
      sb.from("wods").select("*").order("created_at", { ascending: false }),
      sb.from("wod_results").select("*").order("created_at", { ascending: false }),
    ]);
    for (const x of [m, p, n, f, w, r]) if (x.error) throw x.error;
    Object.assign(state, { members: m.data, programs: p.data, notes: n.data, finishes: f.data, wods: w.data, results: r.data, loaded: true });
  }
  let reloadTimer = null, pendingRender = false;
  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => { try { await loadAll(); softRender(); } catch (e) { console.warn(e); } }, 300);
  }
  // Don't wipe out what the trainer is typing when someone else's change arrives.
  function softRender() {
    const ae = document.activeElement;
    if (ae && app.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) { pendingRender = true; renderTabs(); return; }
    render();
  }
  app.addEventListener("focusout", () => setTimeout(() => {
    const ae = document.activeElement;
    if (pendingRender && !(ae && app.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))) { pendingRender = false; render(); }
  }, 0));

  // ─── views ────────────────────────────────────────────────────────────────────────────
  function view() {
    const h = (location.hash || "").slice(1);
    if (h === "programs") return { kind: "programs" };
    if (h === "program-new") return { kind: "program", id: null };
    if (h.startsWith("program-")) return { kind: "program", id: decodeURIComponent(h.slice(8)) };
    if (h === "feedback") return { kind: "feedback" };
    if (h === "boards") return { kind: "boards" };
    if (h.startsWith("board-")) return { kind: "board", id: h.slice(6) };
    return { kind: "athletes" };
  }

  function renderTabs() {
    if (!state.loaded || state.role !== "trainer") { tabs.innerHTML = ""; return; }
    const v = view().kind;
    const open = state.notes.filter(needsReview).length;
    const items = [
      ["athletes", "Athletes", v === "athletes"],
      ["programs", "Programs", v === "programs" || v === "program"],
      ["feedback", `Feedback${open ? ` <span class="count">${open}</span>` : ""}`, v === "feedback"],
      ["boards", "Leaderboards", v === "boards" || v === "board"],
    ];
    tabs.innerHTML = items.map(([h, label, cur]) => `<a href="#${h}" ${cur ? 'aria-current="page"' : ""}>${label}</a>`).join("")
      + `<a href="index.html" class="out">Athlete view ↗</a>`;
  }
  function renderWho() {
    if (!state.me) { whoEl.innerHTML = ""; return; }
    whoEl.innerHTML = `<span></span><button class="signout" data-act="signout">Sign out</button>`;
    whoEl.querySelector("span").textContent = state.name || state.me;
  }

  function renderAthletes() {
    const list = state.members.slice().sort((a, b) => (a.role === b.role ? (a.display_name || a.email).localeCompare(b.display_name || b.email) : a.role === "trainer" ? -1 : 1));
    let html = `<section class="hero"><div class="eyebrow">Who can sign in</div><h2>Athletes</h2>
      <div class="extra">Add someone here, then they sign in on the athlete site with an email link (or give them a password in Supabase → Authentication → Users).</div></section>`;
    html += `<div class="card table-card"><table class="grid"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Programs</th><th>Open notes</th><th>Last finished</th><th></th></tr></thead><tbody>`;
    for (const m of list) {
      if (state.editingMember === m.email) {
        html += `<tr class="editing"><td colspan="7"><form class="inline-form" id="member-edit" data-email="${esc(m.email)}">
          <label>Name<input name="name" value="${esc(m.display_name || "")}" maxlength="80" required></label>
          <label>Role<select name="role"><option value="athlete" ${m.role === "athlete" ? "selected" : ""}>Athlete</option><option value="trainer" ${m.role === "trainer" ? "selected" : ""}>Trainer</option></select></label>
          <label class="check"><input type="checkbox" name="active" ${m.active ? "checked" : ""}> Can sign in</label>
          <div class="row"><button type="button" class="btn" data-act="cancel-member">Cancel</button><button class="btn primary">Save</button></div></form></td></tr>`;
        continue;
      }
      const progs = state.programs.filter((p) => p.athlete_email === m.email).length;
      const open = state.notes.filter((n) => n.athlete_email === m.email && needsReview(n)).length;
      const fin = state.finishes.find((f) => f.athlete_email === m.email);
      html += `<tr class="${m.active ? "" : "inactive"}">
        <td data-l="Name"><b>${esc(m.display_name || "")}</b>${m.email === state.me ? ` <span class="extra">(you)</span>` : ""}</td>
        <td data-l="Email" class="mono">${esc(m.email)}</td>
        <td data-l="Role"><span class="chip ${m.role === "trainer" ? "info" : "back"}">${m.role}</span>${m.active ? "" : ` <span class="chip hold">inactive</span>`}</td>
        <td data-l="Programs">${m.role === "athlete" ? progs : ""}</td>
        <td data-l="Open notes">${m.role === "athlete" ? (open ? `<a href="#feedback" data-act="filter-athlete" data-email="${esc(m.email)}">${open}</a>` : "0") : ""}</td>
        <td data-l="Last finished">${fin ? `${esc(programTitle(fin.session_id))} <span class="extra">${esc(fmtWhen(fin.finished_at))}</span>` : `<span class="extra">–</span>`}</td>
        <td class="actions"><button class="btn" data-act="edit-member" data-email="${esc(m.email)}">Edit</button></td></tr>`;
    }
    html += `</tbody></table></div>`;
    html += `<section class="card"><h3>Add someone</h3><form class="inline-form" id="member-add">
      <label>Email<input name="email" type="email" required autocomplete="off" placeholder="athlete@example.com"></label>
      <label>Name<input name="name" required maxlength="80" placeholder="First name"></label>
      <label>Role<select name="role"><option value="athlete">Athlete</option><option value="trainer">Trainer</option></select></label>
      <div class="row"><button class="btn primary">Add</button></div></form></section>`;
    return html;
  }

  function renderPrograms() {
    const f = state.athleteFilter;
    const list = state.programs.filter((p) => !f || p.athlete_email === f || !p.athlete_email);
    const missingFiles = (state.fileIds || []).filter((id) => !state.programs.some((p) => p.id === id));
    let html = `<section class="hero"><div class="eyebrow">Session plans</div><h2>Programs</h2>
      <div class="toolbar"><select class="filter-athlete" aria-label="Athlete">${athleteOptions(f, { all: true })}</select>
        <a class="btn primary" href="#program-new">New program</a></div></section>`;
    if (missingFiles.length && activeAthletes().length) {
      html += `<section class="card callout"><b>${missingFiles.length} session file${missingFiles.length > 1 ? "s" : ""} not imported yet.</b>
        <span class="extra">The sessions/ folder in the repo still has programs the console hasn't got. Import them for:</span>
        <form class="inline-form" id="import-files"><label>Athlete<select name="athlete">${athleteOptions((athletes().find((a) => a.legacy_files) || {}).email)}</select></label>
        <label class="check"><input type="checkbox" name="publish" checked> Publish straight away</label>
        <div class="row"><button class="btn primary">Import ${missingFiles.length}</button></div></form></section>`;
    }
    if (!list.length) return html + `<div class="empty"><strong>No programs yet</strong><span>Press New program, then paste or upload a session in the same JSON format as the sessions/ files.</span></div>`;
    html += `<div class="card table-card"><table class="grid"><thead><tr><th>Date</th><th>Program</th><th>Athlete</th><th>Status</th><th>Sets</th><th>Feedback</th><th></th></tr></thead><tbody>`;
    for (const p of list) {
      const sets = (p.body.blocks || []).reduce((a, b) => a + (b.exercises || []).filter((e) => e.status !== "hold").reduce((x, e) => x + (e.sets || 1), 0), 0);
      const notes = state.notes.filter((n) => n.session_id === p.id).length;
      const fins = state.finishes.filter((x) => x.session_id === p.id).length;
      const key = "del-program-" + p.id;
      html += `<tr><td data-l="Date">${esc(fmtDate(p.date))}</td>
        <td data-l="Program"><a href="#program-${encodeURIComponent(p.id)}"><b>${esc(p.title)}</b></a>${p.body.short ? ` <span class="extra">${esc(p.body.short)}</span>` : ""}</td>
        <td data-l="Athlete">${p.athlete_email ? esc(nameOf(p.athlete_email)) : `<span class="extra">All athletes</span>`}</td>
        <td data-l="Status">${p.published ? `<span class="chip back">Published</span>` : `<span class="chip hold">Draft</span>`}</td>
        <td data-l="Sets">${sets}</td>
        <td data-l="Feedback">${notes ? `${notes} note${notes > 1 ? "s" : ""}` : ""}${notes && fins ? " · " : ""}${fins ? `${fins} finished` : ""}${!notes && !fins ? `<span class="extra">–</span>` : ""}</td>
        <td class="actions"><button class="btn" data-act="toggle-publish" data-id="${esc(p.id)}">${p.published ? "Unpublish" : "Publish"}</button>
          <button class="btn" data-act="duplicate" data-id="${esc(p.id)}">Duplicate</button>
          <button class="btn danger" data-act="del-program" data-id="${esc(p.id)}">${state.confirm === key ? "Tap again to delete" : "Delete"}</button></td></tr>`;
    }
    return html + `</tbody></table></div>`;
  }

  const TEMPLATE = {
    short: "Session 1",
    summary: "",
    blocks: [
      { key: "A", name: "Prep", rounds: "2 rounds", exercises: [{ id: "a1", name: "Deadbug", sets: 2, target: "10 reps", search: "dead bug exercise" }] },
      { key: "B", name: "Strength", exercises: [{ id: "b1", name: "Trap Bar Deadlift", sets: 4, target: "6 reps", pct: 0.75, cue: "Even weight through both feet." }] },
    ],
    next: [],
  };

  // Checks a pasted session. Returns { body, errors, warnings }.
  function checkProgram(text) {
    let body;
    try { body = JSON.parse(text); } catch (e) { return { errors: ["Not valid JSON: " + e.message] }; }
    const errors = [], warnings = [];
    if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: ["The program should be one JSON object { … }."] };
    if (!Array.isArray(body.blocks) || !body.blocks.length) errors.push("Needs a \"blocks\" list with at least one block.");
    const ids = new Set();
    (body.blocks || []).forEach((b, i) => {
      const where = `Block ${b && b.key ? b.key : i + 1}`;
      if (!b || typeof b !== "object") { errors.push(`${where} isn't an object.`); return; }
      if (!b.name) warnings.push(`${where} has no name.`);
      if (!Array.isArray(b.exercises) || !b.exercises.length) { errors.push(`${where} needs an "exercises" list.`); return; }
      b.exercises.forEach((ex, j) => {
        const w2 = `${where}, exercise ${j + 1}`;
        if (!ex || !ex.name) errors.push(`${w2} needs a "name".`);
        if (!ex || !ex.id) errors.push(`${w2} needs an "id".`);
        else if (ids.has(String(ex.id))) errors.push(`Exercise id "${ex.id}" is used twice; ids must be unique in a program.`);
        else ids.add(String(ex.id));
        if (ex && ex.sets != null && !(Number.isInteger(ex.sets) && ex.sets >= 1 && ex.sets <= 20)) errors.push(`${w2}: "sets" should be a whole number from 1 to 20.`);
        if (ex && ex.pct != null && !(ex.pct > 0 && ex.pct <= 1.2)) warnings.push(`${w2}: "pct" is a fraction, e.g. 0.75 for 75%.`);
      });
    });
    return { body, errors, warnings };
  }

  function previewHTML(body) {
    if (!body || !Array.isArray(body.blocks)) return "";
    return `<div class="preview">${body.summary ? `<div class="status">${esc(body.summary)}</div>` : ""}${body.blocks.map((b) => `<div class="pv-block"><div class="block-head"><span class="letter">${esc(b.key || "")}</span><h3>${esc(b.name || "")}</h3>${b.rounds ? `<span class="rounds">${esc(b.rounds)}</span>` : ""}</div>
      <ul>${(b.exercises || []).map((ex) => `<li><span>${esc(ex.name || "?")}${ex.status ? ` <span class="chip ${esc(ex.status)}">${esc(ex.status)}</span>` : ""}</span><span class="extra">${esc(ex.sets || 1)} × ${esc(ex.target || "")}${ex.pct ? ` · ${Math.round(ex.pct * 100)}%` : ""}</span></li>`).join("")}</ul></div>`).join("")}</div>`;
  }

  function startEdit(id) {
    const p = id ? state.programs.find((x) => x.id === id) : null;
    if (id && !p) return null;
    const body = Object.assign({}, p ? p.body : TEMPLATE);
    delete body.id; delete body.date; delete body.title;
    state.edit = {
      id: p ? p.id : null,
      athlete: p ? p.athlete_email || "" : state.athleteFilter || (activeAthletes()[0] || {}).email || "",
      date: p ? p.date : today(),
      title: p ? p.title : "",
      published: p ? p.published : false,
      text: JSON.stringify(body, null, 1),
      hasFeedback: p ? state.notes.some((n) => n.session_id === p.id) || state.finishes.some((f) => f.session_id === p.id) : false,
    };
    return state.edit;
  }

  function renderProgram(v) {
    if (!state.edit || state.edit.id !== v.id) if (!startEdit(v.id)) return `<div class="empty"><strong>Program not found</strong><span><a href="#programs">Back to programs</a></span></div>`;
    const e = state.edit;
    const chk = checkProgram(e.text);
    return `<section class="hero"><div class="eyebrow"><a href="#programs">Programs</a> /</div><h2>${e.id ? "Edit program" : "New program"}</h2></section>
      <form id="program-form" class="editor">
        <div class="card fields">
          <label>Athlete<select name="athlete">${athleteOptions(e.athlete, { all: true })}</select></label>
          <label>Date<input name="date" type="date" required value="${esc(e.date)}"></label>
          <label class="wide">Title<input name="title" required maxlength="120" value="${esc(e.title)}" placeholder="e.g. Speed & Power"></label>
          <label class="check"><input name="published" type="checkbox" ${e.published ? "checked" : ""}> Published (athlete can see it)</label>
          <label class="file btn"><input type="file" accept=".json,application/json" id="program-file">Upload .json</label>
        </div>
        ${e.hasFeedback ? `<div class="banner warn">This program already has ticks or notes. Keep exercise ids the same, or that feedback won't line up any more.</div>` : ""}
        <div class="split">
          <div class="card"><div class="card-head"><h3>Session JSON</h3><span class="extra">Same fields as the sessions/ files (see README)</span></div>
            <textarea id="program-json" spellcheck="false" aria-label="Session JSON">${esc(e.text)}</textarea>
            <div id="program-check">${checkHTML(chk)}</div></div>
          <div class="card"><div class="card-head"><h3>Preview</h3></div><div id="program-preview">${previewHTML(chk.body)}</div></div>
        </div>
        <div class="row sticky-actions"><a class="btn" href="#programs">Cancel</a><button class="btn primary" ${chk.errors && chk.errors.length ? "disabled" : ""}>Save program</button></div>
      </form>`;
  }
  function checkHTML(chk) {
    if (chk.errors && chk.errors.length) return `<ul class="problems">${chk.errors.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
    const w = chk.warnings || [];
    return `<div class="ok">Looks good.</div>${w.length ? `<ul class="problems warn">${w.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}`;
  }

  function renderFeedback() {
    const f = state.athleteFilter;
    const notes = state.notes.filter((n) => (!f || n.athlete_email === f) && (state.notesFilter === "all" || needsReview(n)));
    const open = state.notes.filter((n) => (!f || n.athlete_email === f) && needsReview(n)).length;
    const fins = state.finishes.filter((x) => !f || x.athlete_email === f).slice(0, 12);
    let html = `<section class="hero"><div class="eyebrow">From athletes</div><h2>Feedback</h2>
      <div class="toolbar"><select class="filter-athlete" aria-label="Athlete">${athleteOptions(f, { all: true })}</select>
      <div class="filter"><button class="btn" data-act="notes-filter" data-f="open" aria-pressed="${state.notesFilter === "open"}">Open (${open})</button><button class="btn" data-act="notes-filter" data-f="all" aria-pressed="${state.notesFilter === "all"}">All</button></div></div></section>`;
    html += `<div class="split"><section><h3 class="section-h">Notes</h3>`;
    if (!notes.length) html += `<div class="empty"><strong>${state.notesFilter === "open" ? "All caught up" : "No notes yet"}</strong><span>Notes athletes leave on an exercise or a session show up here.</span></div>`;
    else html += `<div class="review-list">${notes.map((n) => {
      const replyOpen = state.reply === n.id;
      return `<div class="review-item${n.reviewed ? " reviewed" : ""}"><div class="where"><b>${esc(nameOf(n.athlete_email))}</b> · ${esc(programTitle(n.session_id))}${n.exercise_name ? " · " + esc(n.exercise_name) : " · Whole session"}</div>
        <div class="note-text">${esc(n.body)}</div>
        <div class="note-meta"><span>${esc(nameOf(n.author_email))} · ${esc(fmtWhen(n.created_at))}</span>${n.reviewed ? `<span>✓ Reviewed${n.reviewed_by_email ? " by " + esc(nameOf(n.reviewed_by_email)) : ""}</span>` : ""}
          ${byTrainer(n) ? "" : `<button data-act="review" data-id="${esc(n.id)}">${n.reviewed ? "Reopen" : "Mark reviewed"}</button>`}
          <button data-act="reply" data-id="${esc(n.id)}">Reply</button></div>
        ${replyOpen ? `<form class="composer reply-form" data-id="${esc(n.id)}"><textarea name="body" required placeholder="Shows on ${esc(nameOf(n.athlete_email))}'s log next to this ${n.exercise_id ? "exercise" : "session"}"></textarea>
          <label class="check"><input type="checkbox" name="review" checked> Mark their note reviewed</label>
          <div class="row"><button type="button" class="btn" data-act="reply" data-id="">Cancel</button><button class="btn primary">Send reply</button></div></form>` : ""}</div>`;
    }).join("")}</div>`;
    html += `</section><section><h3 class="section-h">Finished sessions</h3>`;
    if (!fins.length) html += `<div class="empty"><span>Nothing finished yet.</span></div>`;
    else html += `<div class="review-list">${fins.map((x) => `<div class="review-item"><div class="where"><b>${esc(nameOf(x.athlete_email))}</b> · ${esc(programTitle(x.session_id))}</div>
      <div class="note-text pre">${esc(x.summary || "")}</div><div class="note-meta"><span>${esc(fmtWhen(x.finished_at))}</span></div></div>`).join("")}</div>`;
    return html + `</section></div>`;
  }

  function wodFormHTML(w) {
    w = w || {};
    const type = w.score_type || "time";
    return `<form class="inline-form wod-form" id="${w.id ? "wod-edit" : "wod-add"}" ${w.id ? `data-id="${esc(w.id)}"` : ""}>
      <label class="wide">Name<input name="name" required maxlength="120" value="${esc(w.name || "")}" placeholder="e.g. Fran"></label>
      <label>Scored by<select name="score_type">${Object.entries(W.TYPES).map(([k, t]) => `<option value="${k}" ${k === type ? "selected" : ""}>${esc(t.label)} (${esc(t.hint)})</option>`).join("")}</select></label>
      <label>Time cap<input name="cap" placeholder="mm:ss, optional" value="${w.time_cap_seconds ? esc(W.format("time", w.time_cap_seconds)) : ""}"></label>
      <label>Date<input name="date" type="date" value="${esc(w.wod_date || "")}"></label>
      <label>Board<select name="status"><option value="draft" ${w.status === "draft" ? "selected" : ""}>Draft (hidden)</option><option value="open" ${!w.status || w.status === "open" ? "selected" : ""}>Open</option><option value="closed" ${w.status === "closed" ? "selected" : ""}>Closed</option></select></label>
      <label class="full">Workout<textarea name="description" rows="4" placeholder="21-15-9&#10;Thrusters 43/30 kg&#10;Pull-ups">${esc(w.description || "")}</textarea></label>
      <div class="row">${w.id ? `<button type="button" class="btn" data-act="cancel-wod">Cancel</button>` : ""}<button class="btn primary">${w.id ? "Save" : "Create WOD"}</button></div></form>`;
  }

  function renderBoards() {
    let html = `<section class="hero"><div class="eyebrow">WODs</div><h2>Leaderboards</h2>
      <div class="extra">Open boards take scores from athletes; closed boards stay visible but are locked; drafts are hidden.</div></section>`;
    if (state.wods.length) {
      html += `<div class="card table-card"><table class="grid"><thead><tr><th>WOD</th><th>Scored by</th><th>Board</th><th>Scores</th><th>Leader</th><th></th></tr></thead><tbody>`;
      for (const w of state.wods) {
        const rows = W.bestPerAthlete(w.score_type, state.results.filter((r) => r.wod_id === w.id && !r.hidden), (r) => r.athlete_email);
        const lead = rows[0];
        html += `<tr><td data-l="WOD"><a href="#board-${esc(w.id)}"><b>${esc(w.name)}</b></a>${w.wod_date ? ` <span class="extra">${esc(fmtDate(w.wod_date))}</span>` : ""}</td>
          <td data-l="Scored by">${esc((W.TYPES[w.score_type] || {}).label || w.score_type)}</td>
          <td data-l="Board">${statusChip(w.status)}</td>
          <td data-l="Scores">${rows.length}</td>
          <td data-l="Leader">${lead ? `${esc(nameOf(lead.athlete_email))} <span class="extra">${esc(W.format(w.score_type, lead.score))}</span>` : `<span class="extra">–</span>`}</td>
          <td class="actions"><a class="btn" href="#board-${esc(w.id)}">Open</a></td></tr>`;
      }
      html += `</tbody></table></div>`;
    } else html += `<div class="empty"><strong>No WODs yet</strong><span>Create one below and its leaderboard shows on every athlete's log.</span></div>`;
    return html + `<section class="card"><h3>New WOD</h3>${wodFormHTML(null)}</section>`;
  }
  function statusChip(s) { return s === "open" ? `<span class="chip back">Open</span>` : s === "closed" ? `<span class="chip info">Closed</span>` : `<span class="chip hold">Draft</span>`; }

  function renderBoard(v) {
    const w = state.wods.find((x) => x.id === v.id);
    if (!w) return `<div class="empty"><strong>WOD not found</strong><span><a href="#boards">Back to leaderboards</a></span></div>`;
    const t = W.TYPES[w.score_type] || W.TYPES.reps;
    const all = state.results.filter((r) => r.wod_id === w.id);
    const board = W.bestPerAthlete(w.score_type, all.filter((r) => !r.hidden), (r) => r.athlete_email);
    const delKey = "del-wod-" + w.id;
    let html = `<section class="hero"><div class="eyebrow"><a href="#boards">Leaderboards</a> /</div><h2>${esc(w.name)}</h2>
      <div class="toolbar">${statusChip(w.status)}<span class="extra">${esc(t.label)}${w.time_cap_seconds ? ` · cap ${esc(W.format("time", w.time_cap_seconds))}` : ""}${w.wod_date ? ` · ${esc(fmtDate(w.wod_date))}` : ""}</span>
        <span class="spacer"></span>
        ${["draft", "open", "closed"].filter((s) => s !== w.status).map((s) => `<button class="btn" data-act="wod-status" data-id="${esc(w.id)}" data-s="${s}">${s === "open" ? "Open board" : s === "closed" ? "Close board" : "Hide (draft)"}</button>`).join("")}
        <button class="btn" data-act="edit-wod">Edit</button>
        <button class="btn danger" data-act="del-wod" data-id="${esc(w.id)}">${state.confirm === delKey ? "Tap again to delete" : "Delete"}</button></div>
      ${w.description ? `<div class="cue wod-desc">${esc(w.description)}</div>` : ""}</section>`;
    if (state.editingWod) html += `<section class="card"><h3>Edit WOD</h3>${wodFormHTML(w)}</section>`;
    html += `<div class="split"><section class="card"><h3>Leaderboard</h3>
      ${board.length ? `<ol class="ranks">${board.map((r) => `<li><span class="rank">${r.rank}</span><span class="who">${esc(nameOf(r.athlete_email))}${r.rx ? "" : ` <span class="chip swap">Scaled</span>`}</span><span class="score">${esc(W.format(w.score_type, r.score))}</span></li>`).join("")}</ol>` : `<div class="extra">No scores yet.</div>`}
      </section>
      <section class="card"><h3>Add a score</h3>
      <form class="inline-form" id="result-add" data-wod="${esc(w.id)}" data-type="${esc(w.score_type)}">
        <label>Athlete<select name="athlete" required>${athleteOptions("", { none: true })}</select></label>
        <label>Score<input name="score" required placeholder="${esc(t.hint)}" autocomplete="off"></label>
        <label>Date<input name="on" type="date" value="${esc(w.wod_date || today())}"></label>
        <label class="check"><input type="checkbox" name="rx" checked> Rx</label>
        <label class="full">Note<input name="note" maxlength="500" placeholder="Optional"></label>
        <div class="row"><button class="btn primary">Add score</button></div></form></section></div>`;
    html += `<section class="card table-card"><h3>Every score <span class="extra">(${all.length})</span></h3>`;
    if (all.length) {
      html += `<table class="grid"><thead><tr><th>Athlete</th><th>Score</th><th>Rx</th><th>Date</th><th>Note</th><th>Entered by</th><th></th></tr></thead><tbody>`;
      for (const r of all) {
        const k = "del-result-" + r.id;
        html += `<tr class="${r.hidden ? "inactive" : ""}"><td data-l="Athlete">${esc(nameOf(r.athlete_email))}</td><td data-l="Score"><b>${esc(W.format(w.score_type, r.score))}</b></td><td data-l="Rx">${r.rx ? "Rx" : "Scaled"}</td>
          <td data-l="Date">${esc(fmtDate(r.performed_on))}</td><td data-l="Note">${esc(r.note || "")}</td><td data-l="Entered by">${esc(nameOf(r.entered_by_email))}</td>
          <td class="actions"><button class="btn" data-act="toggle-hidden" data-id="${esc(r.id)}">${r.hidden ? "Show" : "Hide"}</button>
          <button class="btn danger" data-act="del-result" data-id="${esc(r.id)}">${state.confirm === k ? "Tap again" : "Delete"}</button></td></tr>`;
      }
      html += `</tbody></table>`;
    }
    return html + `</section>`;
  }

  function renderLogin() {
    const l = state.login;
    if (l.sent) return `<div class="login"><h2>Check your email</h2><p>We sent a sign-in link to <strong>${esc(l.email)}</strong>.</p><button class="btn" data-act="login-again">Use a different email</button></div>`;
    return `<form class="login" id="login-form"><h2>Trainer sign-in</h2><p>For trainers only. Athletes use the <a href="index.html">training log</a>.</p>
      <label for="login-email" class="eyebrow">Email</label>
      <input id="login-email" type="email" autocomplete="email" required value="${esc(l.email || "")}">
      <label for="login-password" class="eyebrow">Password</label>
      <input id="login-password" type="password" autocomplete="current-password" placeholder="Leave blank to get an email link instead">
      ${l.error ? `<div class="banner">${esc(l.error)}</div>` : ""}
      <button class="btn primary" type="submit" ${l.sending ? "disabled" : ""}>${l.sending ? "Signing in…" : "Sign in"}</button></form>`;
  }

  function render() {
    pendingRender = false;
    renderTabs(); renderWho();
    const v = view();
    let html;
    if (!sb) html = `<div class="empty"><strong>No database connected</strong><span>Fill in config.js with the Supabase project URL and anon key. The console needs the shared database.</span></div>`;
    else if (state.error) html = `<div class="empty"><strong>Something went wrong</strong><span>${esc(state.error)}</span></div>`;
    else if (!state.me) html = renderLogin();
    else if (state.loaded === "checking") html = `<div class="hero"><div class="eyebrow">Loading</div><h2>Opening the console…</h2></div><div class="skeleton"></div>`;
    else if (state.needsMigration) html = `<div class="empty"><strong>One database step first</strong><span>Run <code>supabase/004_trainer_console.sql</code> in Supabase → SQL Editor, then reload this page.</span></div>`;
    else if (state.role === "athlete") html = `<div class="empty"><strong>Trainers only</strong><span>This page is for trainers. Your training log is <a href="index.html">here</a>.</span></div>`;
    else if (state.role !== "trainer") html = `<div class="empty"><strong>Not on the list</strong><span>${esc(state.me)} isn't set up as a trainer. <button class="signout" data-act="signout">Sign out</button></span></div>`;
    else if (!state.loaded) html = `<div class="hero"><div class="eyebrow">Loading</div><h2>Opening the console…</h2></div><div class="skeleton"></div>`;
    else if (v.kind === "programs") html = renderPrograms();
    else if (v.kind === "program") html = renderProgram(v);
    else if (v.kind === "feedback") html = renderFeedback();
    else if (v.kind === "boards") html = renderBoards();
    else if (v.kind === "board") html = renderBoard(v);
    else html = renderAthletes();
    app.innerHTML = html;
  }

  // ─── actions ──────────────────────────────────────────────────────────────────────────
  const val = (f, n) => (f.elements[n] ? f.elements[n].value.trim() : "");
  const checked = (f, n) => !!(f.elements[n] && f.elements[n].checked);

  async function run(promise, okMsg) {
    const { error } = await promise;
    if (error) { failed(error); return false; }
    await loadAll(); render();
    if (okMsg) flash(okMsg, "ok");
    return true;
  }
  function newProgramId(date) { return date + "-" + Math.random().toString(36).slice(2, 6); }

  app.addEventListener("submit", async (ev) => {
    const f = ev.target;
    ev.preventDefault();
    if (f.id === "login-form") return signIn();
    const btn = f.querySelector("button:not([type=button])"); if (btn) btn.disabled = true;
    try {
      if (f.id === "member-add") {
        const email = val(f, "email").toLowerCase();
        if (state.members.some((m) => m.email === email)) { flash("They're already on the list."); return; }
        await run(sb.from("members").insert({ email, display_name: val(f, "name"), role: val(f, "role") }), "Added " + val(f, "name") + ".");
      } else if (f.id === "member-edit") {
        const email = f.dataset.email;
        if (email === state.me && (val(f, "role") !== "trainer" || !checked(f, "active"))) { flash("You can't remove your own trainer access here."); return; }
        state.editingMember = null;
        await run(sb.from("members").update({ display_name: val(f, "name"), role: val(f, "role"), active: checked(f, "active") }).eq("email", email));
      } else if (f.id === "program-form") {
        const e = state.edit; const chk = checkProgram($("#program-json").value);
        if (chk.errors.length) { flash("Fix the problems in the JSON first."); return; }
        const body = Object.assign({}, chk.body); delete body.id; delete body.date; delete body.title;
        const row = { athlete_email: val(f, "athlete") || null, date: val(f, "date"), title: val(f, "title"), published: checked(f, "published"), body, created_by_email: state.me, updated_at: new Date().toISOString() };
        const q = e.id ? sb.from("programs").update(row).eq("id", e.id) : sb.from("programs").insert(Object.assign({ id: newProgramId(row.date) }, row));
        if (await run(q, "Program saved.")) { state.edit = null; location.hash = "programs"; }
      } else if (f.id === "import-files") {
        await importFiles(val(f, "athlete"), checked(f, "publish"));
      } else if (f.classList.contains("reply-form")) {
        const n = state.notes.find((x) => x.id === f.dataset.id); if (!n) return;
        const body = val(f, "body"); if (!body) return;
        const ok = await run(sb.from("notes").insert({ athlete_email: n.athlete_email, session_id: n.session_id, exercise_id: n.exercise_id, exercise_name: n.exercise_name, body, author_email: state.me }), "Reply sent.");
        if (ok && checked(f, "review") && !n.reviewed) await run(sb.from("notes").update({ reviewed: true, reviewed_by_email: state.me }).eq("id", n.id));
        if (ok) { state.reply = null; render(); }
      } else if (f.id === "wod-add" || f.id === "wod-edit") {
        const capText = val(f, "cap");
        const cap = capText ? W.parse("time", capText) : null;
        if (capText && cap == null) { flash("Time cap should look like 12:00."); return; }
        const row = { name: val(f, "name"), score_type: val(f, "score_type"), time_cap_seconds: cap, wod_date: val(f, "date") || null, status: val(f, "status"), description: val(f, "description") || null };
        if (f.id === "wod-add") {
          const { data, error } = await sb.from("wods").insert(Object.assign({ created_by_email: state.me }, row)).select().single();
          if (error) return failed(error);
          await loadAll(); location.hash = "board-" + data.id; render();
        } else {
          state.editingWod = false;
          await run(sb.from("wods").update(row).eq("id", f.dataset.id), "Saved.");
        }
      } else if (f.id === "result-add") {
        const score = W.parse(f.dataset.type, val(f, "score"));
        if (!val(f, "athlete")) { flash("Choose an athlete."); return; }
        if (score == null) { flash("That score doesn't look right. Use " + W.TYPES[f.dataset.type].hint + "."); return; }
        await run(sb.from("wod_results").insert({ wod_id: f.dataset.wod, athlete_email: val(f, "athlete"), score, rx: checked(f, "rx"), performed_on: val(f, "on") || undefined, note: val(f, "note") || null, entered_by_email: state.me }), "Score added.");
      }
    } finally { if (btn && document.contains(btn)) btn.disabled = false; }
  });

  // Copies sessions/*.json from the site into programs, keeping their ids so existing ticks still match.
  async function importFiles(athlete, publish) {
    if (!athlete) { flash("Choose an athlete."); return; }
    const files = await loadFileSessions();
    const rows = files.filter((s) => !state.programs.some((p) => p.id === s.id)).map((s) => {
      const body = Object.assign({}, s); delete body.id; delete body.date; delete body.title;
      return { id: s.id, athlete_email: athlete, date: s.date, title: s.title || s.short || s.id, body, published: publish, created_by_email: state.me };
    });
    if (!rows.length) return flash("Nothing new to import.");
    await run(sb.from("programs").insert(rows), `Imported ${rows.length} program${rows.length > 1 ? "s" : ""}.`);
  }
  async function loadFileSessions() {
    try {
      const idx = await fetch("sessions/index.json", { cache: "no-cache" }).then((r) => r.json());
      return await Promise.all(idx.sessions.map((f) => fetch("sessions/" + f, { cache: "no-cache" }).then((r) => r.json())));
    } catch (e) { return []; }
  }

  // Live check and preview while editing JSON.
  app.addEventListener("input", (ev) => {
    if (ev.target.id === "program-json" && state.edit) {
      state.edit.text = ev.target.value;
      const chk = checkProgram(ev.target.value);
      $("#program-check").innerHTML = checkHTML(chk);
      if (chk.body) $("#program-preview").innerHTML = previewHTML(chk.body);
      const save = $("#program-form button:not([type=button])"); if (save) save.disabled = !!chk.errors.length;
    } else if (ev.target.form && ev.target.form.id === "program-form" && state.edit) {
      const f = ev.target.form;
      Object.assign(state.edit, { athlete: val(f, "athlete"), date: val(f, "date"), title: f.elements.title.value, published: checked(f, "published") });
    }
  });
  app.addEventListener("change", async (ev) => {
    const el = ev.target;
    if (el.classList.contains("filter-athlete")) { state.athleteFilter = el.value; render(); return; }
    if (el.id === "program-file" && el.files && el.files[0]) {
      const text = await el.files[0].text();
      const chk = checkProgram(text);
      const f = $("#program-form");
      if (chk.body) {
        if (chk.body.title && !val(f, "title")) f.elements.title.value = chk.body.title;
        if (chk.body.date) f.elements.date.value = chk.body.date;
        Object.assign(state.edit, { title: f.elements.title.value, date: f.elements.date.value });
        const body = Object.assign({}, chk.body); delete body.id; delete body.date; delete body.title;
        state.edit.text = JSON.stringify(body, null, 1);
      } else state.edit.text = text;
      render();
    }
    if (el.form && el.form.id === "program-form" && state.edit) {
      const f = el.form;
      Object.assign(state.edit, { athlete: val(f, "athlete"), date: val(f, "date"), title: f.elements.title.value, published: checked(f, "published") });
    }
  });

  document.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-act]"); if (!btn) return;
    const act = btn.dataset.act, id = btn.dataset.id;
    if (!/^del-/.test(act)) state.confirm = null;
    if (act === "signout") { await sb.auth.signOut(); Object.assign(state, { me: null, role: null, loaded: false }); render(); }
    else if (act === "login-again") { state.login = {}; render(); }
    else if (act === "edit-member") { state.editingMember = btn.dataset.email; render(); }
    else if (act === "cancel-member") { state.editingMember = null; render(); }
    else if (act === "filter-athlete") { state.athleteFilter = btn.dataset.email; }
    else if (act === "toggle-publish") {
      const p = state.programs.find((x) => x.id === id); if (!p) return;
      await run(sb.from("programs").update({ published: !p.published, updated_at: new Date().toISOString() }).eq("id", id), p.published ? "Unpublished." : "Published.");
    } else if (act === "duplicate") {
      const p = state.programs.find((x) => x.id === id); if (!p) return;
      const copyId = newProgramId(today());
      const ok = await run(sb.from("programs").insert({ id: copyId, athlete_email: p.athlete_email, date: today(), title: p.title + " (copy)", body: p.body, published: false, created_by_email: state.me }), "Copied as a draft. Change the athlete or date and save.");
      if (ok) { state.edit = null; location.hash = "program-" + encodeURIComponent(copyId); }
    } else if (act === "del-program") {
      if (!armed("del-program-" + id)) return;
      await run(sb.from("programs").delete().eq("id", id), "Program deleted. Its ticks and notes are kept.");
    } else if (act === "notes-filter") { state.notesFilter = btn.dataset.f; render(); }
    else if (act === "review") {
      const n = state.notes.find((x) => x.id === id); if (!n) return;
      await run(sb.from("notes").update({ reviewed: !n.reviewed, reviewed_by_email: n.reviewed ? null : state.me }).eq("id", id));
    } else if (act === "reply") { state.reply = id || null; render(); const t = $(".reply-form textarea"); if (t) t.focus(); }
    else if (act === "wod-status") { await run(sb.from("wods").update({ status: btn.dataset.s }).eq("id", id)); }
    else if (act === "edit-wod") { state.editingWod = !state.editingWod; render(); }
    else if (act === "cancel-wod") { state.editingWod = false; render(); }
    else if (act === "del-wod") {
      if (!armed("del-wod-" + id)) return;
      if (await run(sb.from("wods").delete().eq("id", id), "WOD and its scores deleted.")) location.hash = "boards";
    } else if (act === "toggle-hidden") {
      const r = state.results.find((x) => x.id === id); if (!r) return;
      await run(sb.from("wod_results").update({ hidden: !r.hidden }).eq("id", id));
    } else if (act === "del-result") {
      if (!armed("del-result-" + id)) return;
      await run(sb.from("wod_results").delete().eq("id", id));
    }
  });

  window.addEventListener("hashchange", () => {
    state.confirm = null; state.editingMember = null; state.reply = null; state.editingWod = false;
    if (view().kind !== "program") state.edit = null;
    render(); window.scrollTo(0, 0);
  });

  // ─── sign-in ──────────────────────────────────────────────────────────────────────────
  async function signIn() {
    const email = $("#login-email").value.trim(), password = $("#login-password").value;
    if (!email) return;
    state.login = { email, sending: true }; render();
    try {
      if (password) {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) state.login.error = "That email and password didn't match.";
      } else {
        const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: false } });
        if (error) state.login.error = /rate limit/i.test(error.message || "") ? "Too many sign-in emails in the last hour. Use a password or wait a bit." : "Couldn't send the link: " + error.message;
        else state.login.sent = true;
      }
    } finally { state.login.sending = false; render(); }
  }

  let channel = null;
  async function enter(email) {
    state.me = email.toLowerCase(); state.loaded = "checking"; state.error = null; render();
    const w = await sb.rpc("whoami");
    if (w.error) {
      state.needsMigration = /whoami|function|schema cache|PGRST202/i.test((w.error.message || "") + (w.error.code || ""));
      if (!state.needsMigration) state.error = w.error.message;
      state.loaded = false; render(); return;
    }
    const row = (w.data || [])[0];
    state.role = row ? row.role : null; state.name = row ? row.display_name : null;
    if (state.role !== "trainer") { state.loaded = false; render(); return; }
    try { await loadAll(); } catch (e) { state.error = e.message; render(); return; }
    loadFileSessions().then((files) => { state.fileIds = files.map((s) => s.id); if (view().kind === "programs") softRender(); });
    if (channel) sb.removeChannel(channel);
    channel = sb.channel("trainer-console");
    for (const table of ["members", "programs", "notes", "session_finishes", "wods", "wod_results", "ticks"]) channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, scheduleReload);
    channel.subscribe();
    document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleReload(); });
    render();
  }

  async function boot() {
    if (!sb) { render(); return; }
    const { data } = await sb.auth.getSession();
    sb.auth.onAuthStateChange((_e, session) => {
      const next = session ? session.user.email.toLowerCase() : null;
      if (next && next !== state.me) enter(next);
      else if (!next && state.me) { Object.assign(state, { me: null, role: null, loaded: false }); render(); }
    });
    if (data.session) await enter(data.session.user.email); else render();
  }
  boot();
})();
