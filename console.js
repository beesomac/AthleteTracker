// Trainer console: athletes, programs, exercise and WOD library, feedback and WOD leaderboards.
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
    fileSessions: [], librarySeed: null, wodSeed: null, wodDraft: null, pendingWod: null,
    boardMembers: null, boardAsk: null, reorder: null, copyWeek: null, weekGroup: "",   // reorder: { athlete, ids } while reordering programs   // boardMembers null = 007_wod_boards.sql not run yet
    builder: { query: "", cat: "", target: null, open: new Set(), confirm: null, libTab: "ex", wodGroup: "open", wodInfo: null },
    libPage: { query: "", cat: "", wodGroup: "open", open: null },
  };
  const PB = window.ProgramBuilder;
  const PS = window.ProgramScale;

  // ─── helpers ──────────────────────────────────────────────────────────────────────────
  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function fmtDate(iso) { if (!iso) return ""; try { return new Date(String(iso).slice(0, 10) + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }); } catch (e) { return iso; } }
  function fmtWhen(iso) { try { const d = new Date(iso); return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }
  function today() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  // A trainer flagged also_athlete (006) trains too, so they count as an athlete everywhere here.
  const isAthlete = (m) => m.role === "athlete" || !!m.also_athlete;
  const athletes = () => state.members.filter(isAthlete);
  // The inbox is for what athletes wrote; trainers' own replies don't need reviewing here.
  const byTrainer = (n) => state.members.some((m) => m.role === "trainer" && m.email === String(n.author_email || "").toLowerCase());
  const needsReview = (n) => !n.reviewed && !byTrainer(n);
  const activeAthletes = () => athletes().filter((m) => m.active);
  function nameOf(email) {
    if (!email) return "Someone";
    const m = state.members.find((x) => x.email === String(email).toLowerCase());
    return m && m.display_name ? m.display_name : String(email).split("@")[0];
  }
  // ─── WOD boards and history (007) ───────────────────────────────────────────────────────
  const boardsReady = () => state.boardMembers !== null;
  const libWod = (id) => (state.wodSeed && state.wodSeed.wods.find((w) => w.id === id)) || null;
  // Leaderboards that are this WOD: same library id, or the same name.
  function boardsFor(libId, name) {
    const n = String(name || "").trim().toLowerCase();
    return state.wods.filter((w) => (libId && w.library_id === libId) || (n && w.name.trim().toLowerCase() === n));
  }
  // An athlete's earlier scores on this WOD, newest first, across all its boards.
  function historyFor(email, libId, name) {
    const ids = new Set(boardsFor(libId, name).map((w) => w.id));
    return state.results.filter((r) => ids.has(r.wod_id) && r.athlete_email === email && !r.hidden)
      .map((r) => Object.assign({ type: (state.wods.find((w) => w.id === r.wod_id) || {}).score_type }, r))
      .sort((a, b) => String(b.performed_on).localeCompare(String(a.performed_on)));
  }
  function bestOf(rows) { return rows.length ? W.rank(rows[0].type, rows.slice())[0] : null; }
  const scoreText = (r) => `${W.format(r.type, r.score)}${r.rx ? " Rx" : " scaled"}`;
  function historyLine(rows) {
    if (!rows.length) return "";
    const last = rows[0], best = bestOf(rows);
    return `Last ${scoreText(last)} on ${fmtDate(last.performed_on)}${rows.length > 1 && best !== last ? ` · best ${scoreText(best)} on ${fmtDate(best.performed_on)}` : ""}${rows.length > 1 ? ` · done ${rows.length}×` : ""}`;
  }
  const isWodBlock = (b) => b && (b.wod || b.board) && Array.isArray(b.exercises) && b.exercises.length;
  function programAthletes(email) { return email ? [email] : activeAthletes().map((a) => a.email); }

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
    // Board members come with 007_wod_boards.sql; before that the console works as it did.
    const bm = await sb.from("wod_board_members").select("*");
    state.boardMembers = bm.error ? null : bm.data;
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
    if (h === "week") return { kind: "week", week: null };
    if (/^week-\d{4}-\d{2}-\d{2}$/.test(h)) return { kind: "week", week: h.slice(5) };
    if (h === "program-new") return { kind: "program", id: null };
    if (h.startsWith("program-")) return { kind: "program", id: decodeURIComponent(h.slice(8)) };
    if (h === "feedback") return { kind: "feedback" };
    if (h === "library") return { kind: "library", tab: "ex" };
    if (h === "library-wods") return { kind: "library", tab: "wod" };
    if (h === "boards") return { kind: "boards" };
    if (h === "plans") return { kind: "plans" };
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
      ["week", "Week", v === "week"],
      ["library", "Library", v === "library"],
      ["feedback", `Feedback${open ? ` <span class="count">${open}</span>` : ""}`, v === "feedback"],
      ["boards", "Leaderboards", v === "boards" || v === "board"],
      ["plans", "Plans", v === "plans"],
    ];
    tabs.innerHTML = items.map(([h, label, cur]) => `<a href="#${h}" ${cur ? 'aria-current="page"' : ""}>${label}</a>`).join("")
      + `<a href="profile.html" class="out">Profile ↗</a><a href="index.html" class="out" style="margin-left:0">Athlete view ↗</a>`;
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
          ${"also_athlete" in m ? `<label class="check"><input type="checkbox" name="also_athlete" ${m.also_athlete ? "checked" : ""}> Trainer also trains (shows as an athlete)</label>` : ""}
          ${groupsReady() ? `<label class="wide">Groups<input name="groups" value="${esc((m.groups || []).join(", "))}" placeholder="e.g. Rehab, Morning crew" list="group-names"></label><datalist id="group-names">${allGroups().map((g) => `<option value="${esc(g)}">`).join("")}</datalist>` : ""}
          <div class="row"><button type="button" class="btn" data-act="cancel-member">Cancel</button><button class="btn primary">Save</button></div></form></td></tr>`;
        continue;
      }
      const progs = state.programs.filter((p) => p.athlete_email === m.email).length;
      const open = state.notes.filter((n) => n.athlete_email === m.email && needsReview(n)).length;
      const fin = state.finishes.find((f) => f.athlete_email === m.email);
      html += `<tr class="${m.active ? "" : "inactive"}">
        <td data-l="Name"><b>${esc(m.display_name || "")}</b>${m.email === state.me ? ` <span class="extra">(you)</span>` : ""}</td>
        <td data-l="Email" class="mono">${esc(m.email)}</td>
        <td data-l="Role"><span class="chip ${m.role === "trainer" ? "info" : "back"}">${m.role}</span>${m.role === "trainer" && m.also_athlete ? ` <span class="chip back">athlete</span>` : ""}${m.active ? "" : ` <span class="chip hold">inactive</span>`}${(m.groups || []).map((g) => ` <span class="chip">${esc(g)}</span>`).join("")}</td>
        <td data-l="Programs">${isAthlete(m) ? progs : ""}</td>
        <td data-l="Open notes">${isAthlete(m) ? (open ? `<a href="#feedback" data-act="filter-athlete" data-email="${esc(m.email)}">${open}</a>` : "0") : ""}</td>
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
        ${f && ownPrograms(f).length > 1 && !state.reorder ? `<button class="btn" data-act="reorder-start">Reorder sessions</button>` : ""}
        ${!state.copyWeek && athletes().some((a) => ownPrograms(a.email).length) ? `<button class="btn" data-act="copyweek-start">Copy a week</button>` : ""}
        <a class="btn primary" href="#program-new">New program</a></div></section>`;
    if (state.copyWeek) return html + copyWeekHTML();
    if (state.reorder && state.reorder.athlete === f) return html + reorderHTML();
    state.reorder = null;
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
        <td class="actions"><a class="btn" href="#program-${encodeURIComponent(p.id)}">Edit</a><button class="btn" data-act="toggle-publish" data-id="${esc(p.id)}">${p.published ? "Unpublish" : "Publish"}</button>
          <button class="btn" data-act="copy-session" data-id="${esc(p.id)}">Copy to…</button>
          <button class="btn danger" data-act="del-program" data-id="${esc(p.id)}">${state.confirm === key ? "Tap again to delete" : "Delete"}</button></td></tr>`;
    }
    return html + `</tbody></table></div>`;
  }

  // ─── reorder an athlete's sessions ─────────────────────────────────────────────────────
  // Athletes see sessions in date order, so reordering keeps the same dates and moves the
  // programs between them: the first in the new order gets the earliest date, and so on.
  // Programs for "All athletes" aren't included, because moving them would move them for everyone.
  const byDate = (a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id));
  function ownPrograms(email) { return state.programs.filter((p) => p.athlete_email === email).sort(byDate); }
  const isSessionLabel = (s) => /^Session \d+$/.test(String(s || "").trim());
  function reorderHTML() {
    const r = state.reorder, progs = ownPrograms(r.athlete), slots = progs.map((p) => p.date);
    const byId = Object.fromEntries(progs.map((p) => [p.id, p]));
    // Someone else added or deleted a program meanwhile: keep the order, drop gone ones, add new ones at the end.
    r.ids = r.ids.filter((id) => byId[id]).concat(progs.map((p) => p.id).filter((id) => !r.ids.includes(id)));
    const canRenumber = progs.every((p) => !p.body.short || isSessionLabel(p.body.short));
    const rows = r.ids.map((id, i) => {
      const p = byId[id]; const moved = p.date !== slots[i];
      return `<li draggable="true" data-i="${i}" class="${moved ? "moved" : ""}"><span class="grip" aria-hidden="true"></span><span class="pos">${i + 1}</span>
        <span class="slot">${esc(fmtDate(slots[i]))}${moved ? " ←" : ""}</span>
        <span class="ttl"><b>${esc(p.title)}</b> <span class="extra">${esc(p.body.short || "")}${p.published ? "" : " · draft"}</span></span>
        <button type="button" data-act="reorder-move" data-i="${i}" data-d="-1" ${i === 0 ? "disabled" : ""} aria-label="Move ${esc(p.title)} earlier">↑</button>
        <button type="button" data-act="reorder-move" data-i="${i}" data-d="1" ${i === r.ids.length - 1 ? "disabled" : ""} aria-label="Move ${esc(p.title)} later">↓</button></li>`;
    }).join("");
    return `<section class="card"><div class="card-head"><h3>Reorder ${esc(nameOf(r.athlete))}'s sessions</h3></div>
      <div class="extra">Drag sessions, or use the arrows. The dates stay where they are and the sessions move between them; a date in orange is changing. Programs for all athletes aren't moved.</div>
      <ol class="reorder-list" id="reorder-list">${rows}</ol>
      ${canRenumber ? `<label class="check"><input type="checkbox" id="reorder-renumber" ${r.renumber ? "checked" : ""}> Renumber the tabs (Session 1, Session 2…) to match</label>` : ""}
      <div class="row"><button class="btn" data-act="reorder-cancel">Cancel</button><button class="btn primary" data-act="reorder-save">Save order</button></div></section>`;
  }
  async function saveReorder() {
    const r = state.reorder, progs = ownPrograms(r.athlete), slots = progs.map((p) => p.date);
    const byId = Object.fromEntries(progs.map((p) => [p.id, p]));
    const renumber = !!($("#reorder-renumber") && $("#reorder-renumber").checked);
    const now = new Date().toISOString(), jobs = [];
    r.ids.forEach((id, i) => {
      const p = byId[id], upd = {};
      if (p.date !== slots[i]) upd.date = slots[i];
      if (renumber && (p.body.short || "") !== "Session " + (i + 1)) upd.body = Object.assign({}, p.body, { short: "Session " + (i + 1) });
      if (Object.keys(upd).length) jobs.push(sb.from("programs").update(Object.assign(upd, { updated_at: now })).eq("id", id));
    });
    if (!jobs.length) { state.reorder = null; render(); return; }
    const res = await Promise.all(jobs);
    const bad = res.find((x) => x.error);
    if (bad) return failed(bad.error);
    state.reorder = null;
    await loadAll(); render(); flash(`New order saved (${jobs.length} session${jobs.length > 1 ? "s" : ""} changed).`, "ok");
  }
  function reorderMove(from, to) {
    const ids = state.reorder.ids; if (to < 0 || to >= ids.length || from === to) return;
    const [id] = ids.splice(from, 1); ids.splice(to, 0, id); render();
  }
  {
    let dragI = null;
    app.addEventListener("dragstart", (ev) => { const li = ev.target.closest && ev.target.closest("#reorder-list li"); if (!li) return; dragI = Number(li.dataset.i); li.classList.add("dragging"); ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", "session"); });
    app.addEventListener("dragover", (ev) => {
      if (dragI == null) return; const list = ev.target.closest && ev.target.closest("#reorder-list"); if (!list) return;
      ev.preventDefault(); list.querySelectorAll(".drop-before").forEach((x) => x.classList.remove("drop-before"));
      const li = ev.target.closest("li"); if (li) li.classList.add("drop-before");
    });
    app.addEventListener("drop", (ev) => {
      if (dragI == null) return; const li = ev.target.closest && ev.target.closest("#reorder-list li"); if (!li) return;
      ev.preventDefault(); let to = Number(li.dataset.i); const from = dragI; dragI = null;
      if (to > from) to--; reorderMove(from, to);
    });
    app.addEventListener("dragend", () => { dragI = null; app.querySelectorAll("#reorder-list .dragging,#reorder-list .drop-before").forEach((x) => x.classList.remove("dragging", "drop-before")); });
  }

  // ─── copy a week to another athlete, scaled ────────────────────────────────────────────
  // Every program the source athlete has in one Monday–Sunday week is copied as a NEW program
  // for the other athlete (nothing is overwritten, so both histories stay), on the same weekdays
  // of the chosen week. Reps, bar weights and dumbbells are scaled by scale.js; dumbbells and
  // kettlebells come out as a choice of real sizes, which the trainer confirms here.
  const SIZES_KEY = "console.weightSizes";
  function loadSizes() {
    let saved = {}; try { saved = JSON.parse(localStorage.getItem(SIZES_KEY) || "{}") || {}; } catch (e) { saved = {}; }
    return { db: PS.parseSizes(saved.db, PS.DUMBBELLS), kb: PS.parseSizes(saved.kb, PS.KETTLEBELLS) };
  }
  function keptReps() { try { return localStorage.getItem("console.keepReps") === "1"; } catch (e) { return false; } }
  function saveSizes(sz) { try { localStorage.setItem(SIZES_KEY, JSON.stringify({ db: sz.db.join(", "), kb: sz.kb.join(", ") })); } catch (e) { /* private window */ } }
  function addDays(iso, n) { const d = new Date(String(iso).slice(0, 10) + "T12:00:00"); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function mondayOf(iso) { const d = new Date(String(iso).slice(0, 10) + "T12:00:00"); return addDays(iso, -((d.getDay() + 6) % 7)); }
  const daysBetween = (a, b) => Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 864e5);
  function weeksOf(email) {
    const m = new Map();
    for (const p of ownPrograms(email)) { const w = mondayOf(p.date); if (!m.has(w)) m.set(w, []); m.get(w).push(p); }
    return [...m.entries()].map(([week, progs]) => ({ week, progs }));
  }
  const weekLabel = (w) => `${fmtDate(w)} – ${fmtDate(addDays(w, 6))}`;
  // mode "week": every program the athlete has in a week. mode "session": one program (pid),
  // which can also be an "All athletes" one. Started from the Programs list or the program editor.
  function startCopyWeek(mode = "week", pid = null) {
    const p = pid && state.programs.find((x) => x.id === pid);
    const withProgs = athletes().filter((a) => ownPrograms(a.email).length);
    const from = p ? p.athlete_email : (withProgs.find((a) => a.email === state.athleteFilter) || withProgs[0]).email;
    let w;
    if (p) w = mondayOf(p.date);
    else {
      const weeks = weeksOf(from), thisWeek = mondayOf(today());
      w = (weeks.find((x) => x.week === thisWeek) || weeks.find((x) => x.week > thisWeek) || weeks[weeks.length - 1]).week;
    }
    const to = (athletes().find((a) => a.email !== from && a.active) || { email: from }).email;
    state.copyWeek = { mode: p && mode === "session" ? "session" : "week", pid: p ? p.id : null, from, week: w, to, toWeek: w, toDate: p ? p.date : w, pct: 80, repPct: null, keepReps: keptReps(), publish: false, picks: {}, sizes: loadSizes(), ...freshLines() };
  }
  // Line-by-line overrides on top of the scaling, keyed "<program id>|<block index>|<exercise index or note>":
  //   edits[key + "|" + field] = what the trainer typed (sets, target, suggestKg, extra, note)
  //   undo[key] = keep this line exactly as the original;  skip[program id] = don't copy that session
  //   dates[program id] = a different date for that session;  all[program id] = show unchanged lines too
  function freshLines() { return { edits: {}, undo: {}, skip: {}, dates: {}, all: {} }; }
  const LINE_FIELDS = ["sets", "target", "suggestKg", "extra"];
  function applyLineEdits(c, p, body) {
    const src = p.body || {};
    (body.blocks || []).forEach((b, bi) => {
      const sb0 = (src.blocks || [])[bi] || {};
      (b.exercises || []).forEach((ex, ei) => {
        const key = `${p.id}|${bi}|${ei}`, orig = (sb0.exercises || [])[ei] || {};
        if (c.undo[key]) { for (const f of LINE_FIELDS) { if (orig[f] === undefined) delete ex[f]; else ex[f] = orig[f]; } return; }
        for (const f of LINE_FIELDS) {
          const v = c.edits[key + "|" + f]; if (v === undefined) continue;
          if (v === "") delete ex[f];
          else ex[f] = f === "sets" ? Math.max(1, Math.round(Number(v)) || 1) : f === "suggestKg" ? (isFinite(Number(v)) ? Number(v) : ex[f]) : v;
        }
      });
      if (b.note != null) {
        const key = `${p.id}|${bi}|note`;
        if (c.undo[key]) b.note = sb0.note; else if (c.edits[key + "|note"] !== undefined) b.note = c.edits[key + "|note"];
      }
    });
    return body;
  }
  // The scaled copies, worked out fresh from the current choices.
  // Weight % is c.pct; reps follow it unless "Keep reps the same" is ticked or Reps % was set on its own.
  const repPct = (c) => (c.keepReps ? 100 : c.repPct != null ? c.repPct : c.pct);
  const scaleLabel = (c) => (repPct(c) === c.pct ? `${c.pct}%` : `weight ${c.pct}%, reps ${repPct(c)}%`);
  function copyWeekPlan() {
    const c = state.copyWeek, scale = { weight: c.pct / 100, reps: repPct(c) / 100 };
    const one = c.mode === "session" ? state.programs.find((x) => x.id === c.pid) : null;
    const progs = c.mode === "session" ? (one ? [one] : []) : ((weeksOf(c.from).find((x) => x.week === c.week) || {}).progs || []);
    const shift = daysBetween(c.week, c.toWeek);
    return progs.map((p) => {
      const r = PS.scaleBody(p.body, scale, { prefix: p.id, picks: c.picks, dumbbells: c.sizes.db, kettlebells: c.sizes.kb });
      const scaled = JSON.parse(JSON.stringify(r.body));
      applyLineEdits(c, p, r.body);
      const date = c.mode === "session" ? c.toDate : (c.dates[p.id] || addDays(p.date, shift));
      return Object.assign(r, { src: p, scaled, date, skip: !!c.skip[p.id] });
    });
  }
  // One row per exercise (and WOD description): the original, then editable boxes holding what
  // will be copied. Undo keeps the original line; Reset drops what was typed and goes back to the
  // scaled version. Unchanged lines are hidden until "Show the other exercises".
  const showVal = (ex, f) => (ex[f] == null ? "" : String(ex[f]));
  const origText = (ex) => [`${ex.sets || 1} × ${ex.target || "–"}`, ex.suggestKg != null ? ex.suggestKg + " kg" : "", ex.extra || ""].filter(Boolean).join(" · ");
  function copyLinesHTML(c, x) {
    let html = "", shown = 0, hidden = 0;
    const src = x.src.body || {};
    (x.body.blocks || []).forEach((b, bi) => {
      const sb0 = (src.blocks || [])[bi] || {}, sc = (x.scaled.blocks || [])[bi] || {};
      (b.exercises || []).forEach((ex, ei) => {
        const key = `${x.src.id}|${bi}|${ei}`, orig = (sb0.exercises || [])[ei] || {}, scl = (sc.exercises || [])[ei] || {};
        const edited = LINE_FIELDS.some((f) => c.edits[key + "|" + f] !== undefined), undone = !!c.undo[key];
        const changed = LINE_FIELDS.some((f) => showVal(orig, f) !== showVal(scl, f));
        if (!changed && !edited && !undone && !c.all[x.src.id]) { hidden++; return; }
        shown++;
        const k = esc(key);
        const inputs = undone ? `<span class="extra">Kept as the original</span>` : `
            <input class="cw-sets" data-cw-edit="${k}|sets" type="number" min="1" max="20" inputmode="numeric" value="${esc(showVal(ex, "sets"))}" aria-label="Sets">
            <span class="x">×</span><input class="cw-target" data-cw-edit="${k}|target" value="${esc(showVal(ex, "target"))}" aria-label="Target">
            ${orig.suggestKg != null || scl.suggestKg != null ? `<input class="cw-kg" data-cw-edit="${k}|suggestKg" type="number" step="0.5" min="0" inputmode="decimal" value="${esc(showVal(ex, "suggestKg"))}" aria-label="Suggested kg"><span class="x">kg</span>` : ""}
            ${orig.extra != null || scl.extra != null || c.edits[key + "|extra"] !== undefined ? `<input class="cw-extra" data-cw-edit="${k}|extra" value="${esc(showVal(ex, "extra"))}" aria-label="Extra" placeholder="Extra (RPE, loads)">` : ""}`;
        html += `<li class="${undone ? "undone" : edited ? "edited" : changed ? "" : "same"}"><div class="cw-line-head"><span class="cw-name">${esc(b.key || "")} · ${esc(ex.name)}</span>
            ${edited && !undone ? `<span class="chip info">edited</span>` : ""}
            <span class="cw-btns">${edited && !undone ? `<button type="button" class="link" data-act="copyline-reset" data-key="${k}">Reset</button>` : ""}
              ${undone ? `<button type="button" class="link" data-act="copyline-undo" data-key="${k}">Use the scaled line</button>` : changed || edited ? `<button type="button" class="link danger" data-act="copyline-undo" data-key="${k}">Undo</button>` : ""}</span></div>
          <div class="cw-was"><s>${esc(origText(orig))}</s></div>
          <div class="cw-edit">${inputs}</div></li>`;
      });
      if (b.note != null) {
        const key = `${x.src.id}|${bi}|note`, k = esc(key);
        const edited = c.edits[key + "|note"] !== undefined, undone = !!c.undo[key], changed = sb0.note !== sc.note;
        if (!changed && !edited && !undone && !c.all[x.src.id]) { hidden++; return; }
        shown++;
        html += `<li class="${undone ? "undone" : edited ? "edited" : ""}"><div class="cw-line-head"><span class="cw-name">${esc(b.key || "")} · ${esc(b.name || "Block")} (description)</span>
            ${edited && !undone ? `<span class="chip info">edited</span>` : ""}
            <span class="cw-btns">${edited && !undone ? `<button type="button" class="link" data-act="copyline-reset" data-key="${k}">Reset</button>` : ""}
              ${undone ? `<button type="button" class="link" data-act="copyline-undo" data-key="${k}">Use the scaled description</button>` : changed || edited ? `<button type="button" class="link danger" data-act="copyline-undo" data-key="${k}">Undo</button>` : ""}</span></div>
          ${undone ? `<div class="cw-was pre">${esc(sb0.note)}</div><span class="extra">Kept as the original</span>` : `<textarea class="cw-note" data-cw-edit="${k}|note" rows="${Math.min(8, String(b.note).split("\n").length + 1)}" aria-label="Description">${esc(b.note)}</textarea>`}</li>`;
      }
    });
    return { html, shown, hidden };
  }
  function copyWeekHTML() {
    const c = state.copyWeek;
    const fromOpts = athletes().filter((a) => ownPrograms(a.email).length).map((a) => `<option value="${esc(a.email)}" ${a.email === c.from ? "selected" : ""}>${esc(a.display_name || a.email)}</option>`).join("");
    const weekOpts = weeksOf(c.from).map((w) => `<option value="${w.week}" ${w.week === c.week ? "selected" : ""}>${esc(weekLabel(w.week))} · ${w.progs.length} session${w.progs.length > 1 ? "s" : ""}</option>`).join("");
    const plan = copyWeekPlan(), toName = nameOf(c.to), taking = plan.filter((x) => !x.skip).length;
    const clash = plan.filter((x) => state.programs.some((p) => p.athlete_email === c.to && p.date === x.date));
    let sessions = "";
    for (const x of plan) {
      const picks = x.choices.map((ch) => `<label class="cw-pick"><span><b>${esc(ch.label)}</b> ${esc(PSfmt(ch.from))} kg ${ch.kind === "kb" ? "kettlebell" : "dumbbell"} × ${c.pct}% = ${esc(PSfmt(ch.scaled))} kg</span>
          <select data-cw-pick="${esc(ch.key)}">${ch.options.map((o) => `<option value="${o}" ${o === ch.pick ? "selected" : ""}>${esc(PSfmt(o))} kg</option>`).join("")}</select></label>`).join("");
      const { html: lines, shown, hidden } = copyLinesHTML(c, x);
      const pid = esc(x.src.id);
      sessions += `<div class="cw-session${x.skip ? " skipped" : ""}"><div class="cw-head">
          <label class="check cw-take"><input type="checkbox" data-cw-skip="${pid}" ${x.skip ? "" : "checked"}><h4>${esc(fmtDate(x.src.date))} → ${esc(fmtDate(x.date))} · ${x.src.body.short ? esc(x.src.body.short) + " · " : ""}${esc(x.src.title)}</h4></label>
          ${c.mode === "week" && !x.skip ? `<label class="cw-date">Date<input type="date" data-cw-date="${pid}" value="${esc(x.date)}"></label>` : ""}</div>
        ${x.skip ? `<div class="extra">Not copied. Tick it to bring it back.</div>` : `
        ${picks ? `<div class="cw-picks"><div class="extra">Pick the ${x.choices.some((ch) => ch.kind === "kb") ? "dumbbell or kettlebell" : "dumbbell"}${c.pct < 100 ? " to drop to" : c.pct > 100 ? " to go up to" : ""}:</div>${picks}</div>` : ""}
        ${shown ? `<ul class="cw-lines">${lines}</ul>` : `<div class="extra">Nothing to scale in this one (times, holds and ticks stay as they are).</div>`}
        ${hidden || c.all[x.src.id] ? `<button type="button" class="link" data-act="copyweek-all" data-id="${pid}">${c.all[x.src.id] ? "Show only the changes" : `Show the other ${hidden} exercise${hidden === 1 ? "" : "s"} to edit them too`}</button>` : ""}`}</div>`;
    }
    const single = c.mode === "session", src = single && plan[0] ? plan[0].src : null;
    const fromFields = single
      ? `<label class="wide">Session<input readonly value="${src ? esc((src.athlete_email ? nameOf(src.athlete_email) : "All athletes") + " · " + fmtDate(src.date) + " · " + src.title) : "Not found"}"></label>`
      : `<label>From<select id="cw-from">${fromOpts}</select></label>
        <label>Week<select id="cw-week">${weekOpts}</select></label>`;
    const whenField = single ? `<label>On<input id="cw-todate" type="date" value="${esc(c.toDate)}"></label>` : `<label>Into the week of<input id="cw-toweek" type="date" value="${esc(c.toWeek)}"></label>`;
    return `<section class="card"><div class="card-head"><h3>${single ? "Copy a session" : "Copy a week"}</h3>
        ${single && src && src.athlete_email ? `<button type="button" class="btn" data-act="copyweek-whole">Copy the whole week instead</button>` : ""}</div>
      <div class="extra">${single ? "The session is added as a new program for the athlete you pick, on the date you pick" : "Every session in the week is added as a new program for the other athlete, on the same weekdays"}, so both keep their history. It copies the saved version. Reps scale to the nearest whole rep, bar weights to the nearest 5 kg, and dumbbells and kettlebells to a real size you pick. Sets, times, distances and the first athlete's past loads aren't copied over.</div>
      <div class="fields cw-fields">
        ${fromFields}
        <label>To<select id="cw-to">${athleteOptions(c.to)}</select></label>
        ${whenField}
        <label>Weight %<input id="cw-pct" type="number" min="10" max="300" step="5" inputmode="numeric" value="${c.pct}"></label>
        <label>Reps %<input id="cw-reppct" type="number" min="10" max="300" step="5" inputmode="numeric" value="${repPct(c)}" ${c.keepReps ? "disabled" : ""}></label>
      </div>
      <div class="lib-cats">${[60, 70, 80, 90, 100, 110, 120].map((n) => `<button type="button" class="chip-btn${n === c.pct ? " on" : ""}" data-act="copyweek-pct" data-n="${n}">${n}%</button>`).join("")}</div>
      <label class="check"><input type="checkbox" id="cw-keepreps" ${c.keepReps ? "checked" : ""}> Keep the reps the same, only scale the weight</label>
      <details class="cw-sizes"><summary>Dumbbell and kettlebell sizes in your gym</summary>
        <div class="fields"><label class="wide">Dumbbells (kg)<input id="cw-db" value="${esc(c.sizes.db.join(", "))}"></label>
        <label class="wide">Kettlebells (kg)<input id="cw-kb" value="${esc(c.sizes.kb.join(", "))}"></label></div></details>
      ${clash.length ? `<div class="banner warn">${esc(toName)} already has a program on ${[...new Set(clash.map((x) => x.date))].map((d) => esc(fmtDate(d))).join(", ")}. The copies are added alongside, nothing is replaced.</div>` : ""}
      <div class="cw-list">${sessions || `<div class="extra">No sessions that week.</div>`}</div>
      <label class="check"><input type="checkbox" id="cw-publish" ${c.publish ? "checked" : ""}> Publish straight away (otherwise they're saved as drafts to check first)</label>
      <div class="row"><button class="btn" data-act="copyweek-cancel">Cancel</button><button class="btn primary" data-act="copyweek-save" ${taking ? "" : "disabled"}>Copy ${taking} session${taking === 1 ? "" : "s"} to ${esc(toName)}</button></div></section>`;
  }
  const PSfmt = (n) => String(Math.round(n * 100) / 100);
  async function saveCopyWeek() {
    const c = state.copyWeek, plan = copyWeekPlan().filter((x) => !x.skip); if (!plan.length) return;
    const now = new Date().toISOString();
    const rows = plan.map((x) => ({
      id: newProgramId(x.date), athlete_email: c.to, date: x.date, title: x.src.title, published: c.publish,
      body: Object.assign(x.body, { copiedFrom: { program: x.src.id, scale: c.pct, repScale: repPct(c) } }), created_by_email: state.me, updated_at: now,
    }));
    const { error } = await sb.from("programs").insert(rows);
    if (error) return failed(error);
    // WOD blocks keep their leaderboard; put the new athlete on it, as saving a program does.
    if (boardsReady()) {
      const ups = [];
      for (const r of rows) for (const b of r.body.blocks || []) if (b && b.board) ups.push({ wod_id: b.board, athlete_email: c.to, added_by_email: state.me });
      if (ups.length) { const r = await sb.from("wod_board_members").upsert(ups, { onConflict: "wod_id,athlete_email", ignoreDuplicates: true }); if (r.error) console.warn(r.error); }
    }
    if (c.publish) for (const r of rows) await notifyWodAgain(r.id, r);
    saveSizes(c.sizes);
    state.copyWeek = null; state.athleteFilter = c.to;
    await loadAll();
    if (c.returnTo) location.hash = c.returnTo; else render();
    flash(`Copied ${rows.length} session${rows.length > 1 ? "s" : ""} to ${nameOf(c.to)} at ${scaleLabel(c)}${c.publish ? "" : " as drafts"}.`, "ok");
  }

  // ─── week board: every athlete's week side by side ─────────────────────────────────────
  // One row per athlete, one column per day. Drag a session to another day in the same row to
  // move it, or onto another athlete to copy it there (the copy screen opens with the scaling).
  // "Copy week" on a row copies that athlete's whole week. Groups come from 012_member_groups.sql.
  const groupsReady = () => state.members.some((m) => Array.isArray(m.groups));
  const allGroups = () => [...new Set(state.members.flatMap((m) => m.groups || []))].sort((a, b) => a.localeCompare(b));
  function renderWeek(v) {
    const wk = mondayOf(v.week || today()), days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(wk, i));
    const groups = groupsReady() ? allGroups() : [];
    if (state.weekGroup && !groups.includes(state.weekGroup)) state.weekGroup = "";
    const rows = activeAthletes().filter((a) => !state.weekGroup || (a.groups || []).includes(state.weekGroup));
    const inWeek = (p) => p.date >= days[0] && p.date <= days[6];
    const chip = (p, own) => `<a class="wk-chip${p.published ? "" : " draft"}${own ? "" : " shared"}" href="#program-${encodeURIComponent(p.id)}" draggable="true" data-pid="${esc(p.id)}" title="${esc(p.title)}${p.published ? "" : " (draft)"}">
        ${p.body && p.body.short ? `<span class="wk-short">${esc(p.body.short)}</span>` : ""}<span class="wk-title">${esc(p.title)}</span>${p.published ? "" : `<span class="wk-draft">draft</span>`}</a>`;
    const head = `<tr><th></th>${days.map((d) => `<th class="${d === today() ? "today" : ""}">${esc(fmtDate(d))}</th>`).join("")}</tr>`;
    const everyone = state.programs.filter((p) => !p.athlete_email && inWeek(p));
    let body = everyone.length ? `<tr class="wk-everyone"><th><b>All athletes</b><span class="extra">drag to copy to one athlete</span></th>${days.map((d) => `<td>${everyone.filter((p) => p.date === d).map((p) => chip(p, false)).join("")}</td>`).join("")}</tr>` : "";
    for (const a of rows) {
      const mine = state.programs.filter((p) => p.athlete_email === a.email && inWeek(p));
      body += `<tr><th><b>${esc(a.display_name || a.email)}</b>${(a.groups || []).length ? `<span class="extra">${esc(a.groups.join(", "))}</span>` : ""}
          ${mine.length ? `<button type="button" class="link" data-act="copy-week-row" data-email="${esc(a.email)}" data-week="${wk}">Copy week…</button>` : ""}</th>
        ${days.map((d) => `<td class="wk-cell" data-email="${esc(a.email)}" data-date="${d}">${mine.filter((p) => p.date === d).sort((x, y) => String(x.id).localeCompare(String(y.id))).map((p) => chip(p, true)).join("")}</td>`).join("")}</tr>`;
    }
    if (!rows.length) body += `<tr><td colspan="8"><div class="extra">No active athletes${state.weekGroup ? " in " + esc(state.weekGroup) : ""}.</div></td></tr>`;
    return `<section class="hero"><div class="eyebrow">All athletes</div><h2>Week</h2>
      <div class="toolbar"><a class="btn" href="#week-${addDays(wk, -7)}" aria-label="Previous week">‹</a><span class="wk-label">${esc(weekLabel(wk))}</span><a class="btn" href="#week-${addDays(wk, 7)}" aria-label="Next week">›</a>
        ${wk !== mondayOf(today()) ? `<a class="btn" href="#week">This week</a>` : ""}</div>
      ${groups.length ? `<div class="lib-cats wk-groups"><button type="button" class="chip-btn${state.weekGroup ? "" : " on"}" data-act="week-group" data-g="">Everyone</button>${groups.map((g) => `<button type="button" class="chip-btn${g === state.weekGroup ? " on" : ""}" data-act="week-group" data-g="${esc(g)}">${esc(g)}</button>`).join("")}</div>`
        : `<div class="extra">${groupsReady() ? "Add athletes to groups (Athletes → Edit) to filter this board." : "Run supabase/012_member_groups.sql to put athletes in groups and filter this board."}</div>`}
      <div class="extra">Drag a session to another day to move it, or onto another athlete to copy it there, scaled. Tap a session to open it.</div></section>
      <div class="card table-card wk-card"><div class="wk-scroll"><table class="wk-grid">${head}${body}</table></div></div>`;
  }
  // Drag and drop on the week board.
  {
    let dragPid = null;
    app.addEventListener("dragstart", (ev) => {
      const c = ev.target.closest && ev.target.closest(".wk-chip"); if (!c) return;
      dragPid = c.dataset.pid; c.classList.add("dragging"); ev.dataTransfer.effectAllowed = "copyMove"; ev.dataTransfer.setData("text/plain", dragPid);
    });
    app.addEventListener("dragover", (ev) => {
      if (!dragPid) return; const cell = ev.target.closest && ev.target.closest(".wk-cell"); if (!cell) return;
      ev.preventDefault();
      const p = state.programs.find((x) => x.id === dragPid);
      ev.dataTransfer.dropEffect = p && p.athlete_email === cell.dataset.email ? "move" : "copy";
      app.querySelectorAll(".wk-cell.over").forEach((x) => x !== cell && x.classList.remove("over")); cell.classList.add("over");
    });
    app.addEventListener("drop", async (ev) => {
      if (!dragPid) return; const cell = ev.target.closest && ev.target.closest(".wk-cell"); if (!cell) return;
      ev.preventDefault();
      const pid = dragPid; dragPid = null;
      const p = state.programs.find((x) => x.id === pid); if (!p) return;
      const { email, date } = cell.dataset;
      if (p.athlete_email === email) {
        if (p.date === date) { render(); return; }
        await run(sb.from("programs").update({ date, updated_at: new Date().toISOString() }).eq("id", pid), `Moved ${p.title} to ${fmtDate(date)}.`);
        return;
      }
      startCopyWeek("session", pid);
      Object.assign(state.copyWeek, { to: email, toDate: date, returnTo: location.hash.slice(1) || "week" });
      location.hash = "programs";
    });
    app.addEventListener("dragend", () => { dragPid = null; app.querySelectorAll(".wk-chip.dragging,.wk-cell.over").forEach((x) => x.classList.remove("dragging", "over")); });
  }

  // A new program starts with the usual block layout, empty; drag exercises in from the library.
  const TEMPLATE = {
    short: "",
    blocks: [
      { key: "A", name: "Prep", rounds: "2 rounds", exercises: [] },
      { key: "B", name: "Speed & Power", rounds: "3 rounds", exercises: [] },
      { key: "C", name: "Primary Strength", rounds: "4 rounds", exercises: [] },
      { key: "D", name: "Secondary Strength", rounds: "3 rounds", exercises: [] },
      { key: "E", name: "Accessories", rounds: "3 rounds", exercises: [] },
      { key: "F", name: "Resilience", rounds: "3 rounds", exercises: [] },
    ],
    next: [],
  };
  // Empty blocks are fine while building; they're left out when the program is saved.
  function withoutEmptyBlocks(body) {
    const b = Object.assign({}, body);
    if (Array.isArray(b.blocks)) b.blocks = b.blocks.filter((x) => !(x && Array.isArray(x.exercises) && !x.exercises.length))
      .map((x) => { if (x && x.note != null && !String(x.note).trim()) { const y = Object.assign({}, x); delete y.note; return y; } return x; });
    // Lettered blocks close up after empty ones are dropped (A, C, E → A, B, C). Ids don't change.
    if (Array.isArray(b.blocks) && b.blocks.length <= 26 && b.blocks.every((x) => x && /^[A-Z]$/.test(String(x.key || ""))))
      b.blocks = b.blocks.map((x, i) => Object.assign({}, x, { key: String.fromCharCode(65 + i) }));
    return b;
  }

  // Checks a pasted session. Returns { body, errors, warnings }.
  function checkProgram(text) {
    let body;
    try { body = JSON.parse(text); } catch (e) { return { errors: ["Not valid JSON: " + e.message] }; }
    const errors = [], warnings = [];
    if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: ["The program should be one JSON object { … }."] };
    if (!Array.isArray(body.blocks) || !body.blocks.some((b) => b && Array.isArray(b.exercises) && b.exercises.length)) errors.push("Needs at least one block with an exercise in it.");
    const ids = new Set();
    (body.blocks || []).forEach((b, i) => {
      const where = `Block ${b && b.key ? b.key : i + 1}`;
      if (!b || typeof b !== "object") { errors.push(`${where} isn't an object.`); return; }
      if (!b.name) warnings.push(`${where} has no name.`);
      if (!Array.isArray(b.exercises)) { errors.push(`${where} needs an "exercises" list.`); return; }
      if (!b.exercises.length) { warnings.push(`${where}${b.name ? " (" + b.name + ")" : ""} is empty and will be left out when you save.`); return; }
      b.exercises.forEach((ex, j) => {
        const w2 = `${where}, exercise ${j + 1}`;
        if (!ex || !ex.name) errors.push(`${w2} needs a "name".`);
        if (!ex || !ex.id) errors.push(`${w2} needs an "id".`);
        else if (ids.has(String(ex.id))) errors.push(`Exercise id "${ex.id}" is used twice; ids must be unique in a program.`);
        else ids.add(String(ex.id));
        if (ex && ex.sets != null && !(Number.isInteger(ex.sets) && ex.sets >= 1 && ex.sets <= 20)) errors.push(`${w2}: "sets" should be a whole number from 1 to 20.`);
        if (ex && ex.pct != null && !(ex.pct > 0 && ex.pct <= 1.2)) warnings.push(`${w2}: "pct" is a fraction, e.g. 0.75 for 75%.`);
        if (ex && ex.video != null && !/^https:\/\//.test(String(ex.video))) errors.push(`${w2}: "video" should be a full https:// link.`);
        if (ex && ex.log != null && !["kg", "reps", "secs", "tick"].includes(ex.log)) errors.push(`${w2}: "log" should be "kg" (weight), "reps" (bodyweight reps), "secs" (a timed hold) or "tick" (done/not done).`);
        else if (ex && ex.log == null) warnings.push(`${w2}: no "log", so the athlete sees a ${/^\s*\d+(\s*[-–]\s*\d+)?\s*(s|sec|secs|seconds)\b/i.test(String(ex.target || "")) ? "seconds" : "kg"} box. Add "log": "kg", "reps", "secs" or "tick" to be sure.`);
      });
    });
    return { body, errors, warnings };
  }

  function previewHTML(body) {
    if (!body || !Array.isArray(body.blocks)) return "";
    return `<div class="preview">${body.summary ? `<div class="status">${esc(body.summary)}</div>` : ""}${body.blocks.map((b) => `<div class="pv-block"><div class="block-head"><span class="letter">${esc(b.key || "")}</span><h3>${esc(b.name || "")}</h3>${b.rounds ? `<span class="rounds">${esc(b.rounds)}</span>` : ""}</div>${b.note ? `<div class="block-note">${esc(b.note)}</div>` : ""}
      <ul>${(b.exercises || []).map((ex) => `<li><span>${esc(ex.name || "?")}${ex.status ? ` <span class="chip ${esc(ex.status)}">${esc(ex.status)}</span>` : ""}</span><span class="extra">${esc(ex.sets || 1)} × ${esc(ex.target || "")}${ex.pct ? ` · ${Math.round(ex.pct * 100)}%` : ""}${ex.log ? ` · logs ${esc({ kg: "kg", reps: "reps", secs: "seconds", tick: "tick" }[ex.log] || ex.log)}` : ""}</span></li>`).join("")}</ul></div>`).join("")}</div>`;
  }

  function startEdit(id) {
    const p = id ? state.programs.find((x) => x.id === id) : null;
    if (id && !p) return null;
    const body = JSON.parse(JSON.stringify(p ? p.body : TEMPLATE));
    delete body.id; delete body.date; delete body.title;
    if (!p) {
      const who = state.athleteFilter || (activeAthletes()[0] || {}).email;
      body.short = "Session " + (state.programs.filter((x) => !who || x.athlete_email === who || !x.athlete_email).length + 1);
      // "New program with this WOD" from the library: the WOD goes in as block A's neighbour, after Prep.
      const w = state.pendingWod && state.wodSeed && state.wodSeed.wods.find((x) => x.id === state.pendingWod);
      if (w) state.askAfterRender = PB.wodBlock(body, w, 1);
    }
    state.pendingWod = null;
    state.edit = {
      id: p ? p.id : null,
      athlete: p ? p.athlete_email || "" : state.athleteFilter || (activeAthletes()[0] || {}).email || "",
      date: p ? p.date : today(),
      title: p ? p.title : "",
      published: p ? p.published : false,
      text: JSON.stringify(body, null, 1),
      body, mode: "builder",
      hasFeedback: p ? state.notes.some((n) => n.session_id === p.id) || state.finishes.some((f) => f.session_id === p.id) : false,
    };
    Object.assign(state.builder, { query: "", cat: "", target: null, open: new Set(), confirm: null });
    if (p == null && body.blocks.some((b) => b.wod)) Object.assign(state.builder, { target: body.blocks.findIndex((b) => b.wod), libTab: "wod" });
    return state.edit;
  }

  // Exercise library: exercises.json plus everything already done in published programs and the
  // sessions/ files, so "Last" shows what this athlete did most recently.
  function library() {
    const e = state.edit || {};
    const forAthlete = (p) => !e.athlete || !p.athlete_email || p.athlete_email === e.athlete;
    const sessions = state.programs.filter((p) => p.published && p.id !== e.id && forAthlete(p)).map((p) => ({ date: p.date, blocks: p.body.blocks }));
    const legacy = athletes().find((a) => a.legacy_files);
    if (!e.athlete || !legacy || legacy.email === e.athlete) {
      for (const f of state.fileSessions) if (f.id !== e.id && !state.programs.some((p) => p.id === f.id)) sessions.push({ date: f.date, blocks: f.blocks });
    }
    return Object.assign(PB.buildLibrary(state.librarySeed, sessions), { wods: state.wodSeed });
  }
  function setEditText(text) {
    state.edit.text = text;
    try { const b = JSON.parse(text); if (b && typeof b === "object" && !Array.isArray(b)) { if (!Array.isArray(b.blocks)) b.blocks = []; state.edit.body = b; } } catch (e) { /* keep the last good body */ }
  }
  function refreshCheck() {
    const chk = checkProgram(state.edit.text);
    const c = $("#program-check"); if (c) c.innerHTML = checkHTML(chk);
    const pv = $("#program-preview"); if (pv && chk.body) pv.innerHTML = previewHTML(chk.body);
    const save = $("#program-form .sticky-actions button.primary"); if (save) save.disabled = !!(chk.errors && chk.errors.length);
    return chk;
  }
  function renderBuilder(opts = {}) {
    const root = $("#builder-root"); if (!root || !state.edit) return;
    const list = root.querySelector(".lib-list"), top = list ? list.scrollTop : 0, y = window.scrollY;
    root.innerHTML = PB.render(state.edit.body, library(), state.builder);
    const nl = root.querySelector(".lib-list"); if (nl) nl.scrollTop = top;
    window.scrollTo(0, y);
    if (opts.focus) { const el = root.querySelector(opts.focus); if (el) el.focus(); }
    if (opts.flashBlock != null) { const el = root.querySelector(`.bblock[data-b="${opts.flashBlock}"]`); if (el) { el.classList.add("just-added"); el.scrollIntoView({ block: "nearest" }); } }
    if (opts.flashRow) { const el = root.querySelector(`.bex[data-b="${opts.flashRow[0]}"][data-e="${opts.flashRow[1]}"]`); if (el) { el.classList.add("just-added"); el.scrollIntoView({ block: "nearest" }); } }
  }
  // Under a WOD block in the builder: its leaderboard, and how the athlete did before.
  state.builder.wodInfo = (b) => {
    if (!state.edit) return "";
    const parts = [];
    const board = b.board && state.wods.find((w) => w.id === b.board);
    const bi = state.edit.body.blocks.indexOf(b);
    parts.push((board ? `Leaderboard: <a href="#board-${esc(board.id)}">${esc(board.name)}</a>` : b.board === null ? "No leaderboard" : "You'll be asked about a leaderboard when you save")
      + (bi >= 0 && "board" in b ? ` <button type="button" class="btn" data-act="board-change" data-bi="${bi}">Change</button>` : ""));
    for (const email of state.edit.athlete ? [state.edit.athlete] : []) {
      const h = historyFor(email, b.wod, b.name);
      parts.push(h.length ? `<b>${esc(nameOf(email))} has done this before.</b> ${esc(historyLine(h))}` : `First time for ${esc(nameOf(email))}`);
    }
    return parts.join(" · ");
  };
  PB.mount(app, {
    // A WOD dropped into the program: ask about its leaderboard straight away.
    wodAdded: (bi) => { if (state.edit) openBoardAsk([bi], state.edit.athlete || null, { onSave: false }); },
    body: () => state.edit.body,
    lib: () => library(),
    ui: state.builder,
    change(structural, opts) {
      if (!state.edit) return;
      state.edit.text = JSON.stringify(state.edit.body, null, 1);
      if (structural) renderBuilder(opts);
      refreshCheck();
    },
  });

  // ─── "Add to leaderboard?" ─────────────────────────────────────────────────────────────
  // The board already picked for this athlete and WOD: the newest other program of theirs whose
  // block for this WOD points at a board that's still open, else an open board they're on.
  function rememberedBoard(email, b) {
    if (!email) return null;
    const open = (id) => state.wods.some((w) => w.id === id && w.status === "open");
    const same = (x) => x && x.board && open(x.board) && ((b.wod && x.wod === b.wod) || (!b.wod && String(x.name || "").trim().toLowerCase() === String(b.name || "").trim().toLowerCase()));
    const progs = state.programs.filter((p) => p.athlete_email === email && p.id !== (state.edit && state.edit.id) && p.body && Array.isArray(p.body.blocks))
      .sort((x, y) => String(y.date).localeCompare(String(x.date)));
    for (const p of progs) { const hit = p.body.blocks.find(same); if (hit) return hit.board; }
    const boards = boardsFor(b.wod, b.name).filter((w) => w.status === "open");
    const mine = (state.boardMembers || []).filter((m) => m.athlete_email === email);
    const on = boards.filter((w) => mine.some((m) => m.wod_id === w.id)).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
    return on.length ? on[0].id : null;
  }
  function openBoardAsk(blockIdx, athleteEmail, opts = {}) {
    const body = state.edit.body;
    const athletes = programAthletes(athleteEmail);
    // One athlete with a board already picked for this WOD: use it without asking ("Change" re-asks).
    if (!opts.force && athletes.length === 1) {
      const set = [];
      blockIdx = blockIdx.filter((bi) => {
        const b = bi >= 0 && body.blocks[bi], id = b && rememberedBoard(athletes[0], b);
        if (!id) return true;
        b.board = id; set.push(b); return false;
      });
      if (set.length) {
        state.edit.text = JSON.stringify(body, null, 1);
        const w = state.wods.find((x) => x.id === set[0].board);
        flash(`${set[0].name || "WOD"}: on the ${w ? w.name : "same"} leaderboard as last time. Use Change under the WOD to pick another.`, "ok");
      }
      if (!blockIdx.filter((i) => i >= 0).length) {
        if (opts.onSave !== false) { const f = $("#program-form"); if (f) f.requestSubmit(); } else renderBuilder();
        return;
      }
    }
    state.boardAsk = {
      onSave: opts.onSave !== false,
      athletes,
      items: blockIdx.filter((i) => i >= 0).map((bi) => {
        const b = body.blocks[bi], boards = boardsFor(b.wod, b.name).filter((w) => w.status !== "closed");
        return { bi, choice: boards.length ? boards[0].id : "new" };
      }),
    };
    render();
    const d = $(".board-ask"); if (d) d.focus();
  }
  function boardAskHTML() {
    const a = state.boardAsk, body = state.edit && state.edit.body; if (!a || !body) return "";
    const who = a.athletes.length === 1 ? nameOf(a.athletes[0]) : a.athletes.length ? `All ${a.athletes.length} active athletes` : "Nobody";
    const items = a.items.map((it, k) => {
      const b = body.blocks[it.bi], boards = boardsFor(b.wod, b.name);
      const hist = a.athletes.map((em) => ({ em, h: historyFor(em, b.wod, b.name) })).filter((x) => x.h.length);
      const opt = (val, label, extra) => `<label class="ask-opt"><input type="radio" name="ask-${k}" value="${esc(val)}" data-ask="${k}" ${it.choice === val ? "checked" : ""}><span>${label}${extra ? ` <span class="extra">${extra}</span>` : ""}</span></label>`;
      return `<fieldset class="ask-item"><legend>${esc(b.name || "WOD")}</legend>
        ${hist.length ? `<div class="ask-hist">${hist.map((x) => `<div><b>${esc(nameOf(x.em))} has done this before.</b> ${esc(historyLine(x.h))}</div>`).join("")}</div>` : ""}
        ${boards.map((w) => opt(w.id, `Add to the <b>${esc(w.name)}</b> board`, `${w.status === "closed" ? "closed · " : w.status === "draft" ? "draft · " : ""}${state.results.filter((r) => r.wod_id === w.id).length} scores${w.wod_date ? " · " + esc(fmtDate(w.wod_date)) : ""}`)).join("")}
        ${opt("new", boards.length ? "Start a new board for this date" : `Start a leaderboard for <b>${esc(b.name)}</b>`, "")}
        ${opt("none", "No leaderboard", "")}
      </fieldset>`;
    }).join("");
    return `<div class="modal-back"><div class="modal board-ask" role="dialog" aria-modal="true" aria-labelledby="ask-title" tabindex="-1">
      <h3 id="ask-title">Add to leaderboard?</h3>
      <div class="extra">${esc(who)} ${a.athletes.length === 1 ? "goes" : "go"} on the board. Everyone on a board gets a notification when someone adds a score.${boardsReady() ? "" : " <b>Run supabase/007_wod_boards.sql to turn on board members and notifications;</b> until then the board is just linked."}</div>
      ${items}
      <div class="row"><button type="button" class="btn" data-act="ask-cancel">${a.onSave ? "Back to editing" : "Decide when saving"}</button><button type="button" class="btn primary" data-act="ask-confirm">${a.onSave ? "Save program" : "OK"}</button></div>
    </div></div>`;
  }
  async function confirmBoardAsk() {
    const a = state.boardAsk, e = state.edit; if (!a || !e) return;
    for (const it of a.items) {
      const b = e.body.blocks[it.bi]; let id = null;
      if (it.choice === "new") {
        const lw = libWod(b.wod) || {};
        const row = { name: b.name || lw.name || "WOD", description: b.note || lw.description || null, score_type: lw.score || "time", time_cap_seconds: lw.cap || null, wod_date: e.date || null, status: "open", created_by_email: state.me };
        if (boardsReady() && b.wod) row.library_id = b.wod;
        const { data, error } = await sb.from("wods").insert(row).select().single();
        if (error) return failed(error);
        id = data.id;
      } else if (it.choice !== "none") id = it.choice;
      b.board = id;
      if (id && boardsReady() && a.athletes.length) {
        const { error } = await sb.from("wod_board_members").upsert(a.athletes.map((em) => ({ wod_id: id, athlete_email: em, added_by_email: state.me })), { onConflict: "wod_id,athlete_email", ignoreDuplicates: true });
        if (error) return failed(error);
      }
    }
    e.text = JSON.stringify(e.body, null, 1);
    const thenSave = a.onSave;
    state.boardAsk = null; render();
    if (thenSave) { const f = $("#program-form"); if (f) f.requestSubmit(); }
    else { const b = e.body.blocks.find((x, i) => a.items.some((it) => it.bi === i)); flash(b && b.board ? `${b.name}: leaderboard set.` : "No leaderboard for this WOD.", "ok"); }
  }
  // Published with a WOD an athlete has done before: tell them, with how they did. Once per
  // athlete, program and WOD (a unique index in 007), however often the program is saved.
  async function notifyWodAgain(pid, row) {
    if (!boardsReady()) return;
    const label = (row.body.short ? row.body.short + " · " : "") + (row.title || "your program");
    const rows = [];
    for (const b of row.body.blocks.filter(isWodBlock)) for (const em of programAthletes(row.athlete_email)) {
      const h = historyFor(em, b.wod, b.name); if (!h.length) continue;
      rows.push({ recipient_email: em, kind: "wod_again", title: `${b.name} is back in your program`, body: `${label} on ${fmtDate(row.date)}. ${historyLine(h)}.`, session_id: pid, ref: b.wod || String(b.name).toLowerCase(), wod_id: b.board || null });
    }
    if (rows.length) {
      const { error } = await sb.from("notifications").upsert(rows, { onConflict: "recipient_email,kind,session_id,ref", ignoreDuplicates: true });
      if (error) console.warn(error); else flash(`Told ${rows.length === 1 ? nameOf(rows[0].recipient_email) : rows.length + " athletes"} how they did on this WOD before.`, "ok");
    }
  }

  function renderProgram(v) {
    if (!state.edit || state.edit.id !== v.id) if (!startEdit(v.id)) return `<div class="empty"><strong>Program not found</strong><span><a href="#programs">Back to programs</a></span></div>`;
    const e = state.edit;
    const chk = checkProgram(e.text);
    const saved = e.id && state.programs.find((p) => p.id === e.id);
    return `<section class="hero"><div class="eyebrow"><a href="#programs">Programs</a> /</div><h2>${e.id ? "Edit program" : "New program"}</h2>
      ${saved ? `<div class="toolbar"><button type="button" class="btn" data-act="copy-session" data-id="${esc(e.id)}" title="Copy this session to another athlete or date, scaled">Copy session to…</button>${saved.athlete_email ? `<button type="button" class="btn" data-act="copy-week-of" data-id="${esc(e.id)}" title="Copy every session in this week to another athlete, scaled">Copy week to…</button>` : ""}</div>` : ""}</section>
      <form id="program-form" class="editor">
        <div class="card fields">
          <label>Athlete<select name="athlete">${athleteOptions(e.athlete, { all: true })}</select></label>
          <label>Date<input name="date" type="date" required value="${esc(e.date)}"></label>
          <label class="wide">Title<input name="title" required maxlength="120" value="${esc(e.title)}" placeholder="e.g. Speed & Power"></label>
          <label class="check"><input name="published" type="checkbox" ${e.published ? "checked" : ""}> Published (athlete can see it)</label>
          <label class="file btn"><input type="file" accept=".json,application/json" id="program-file">Upload .json</label>
        </div>
        ${e.hasFeedback ? `<div class="banner warn">This program already has ticks or notes. Keep exercise ids the same, or that feedback won't line up any more.</div>` : ""}
        <div class="mode-tabs" role="tablist"><button type="button" role="tab" data-act="edit-mode" data-mode="builder" aria-selected="${e.mode === "builder"}">Builder</button><button type="button" role="tab" data-act="edit-mode" data-mode="json" aria-selected="${e.mode === "json"}">JSON</button></div>
        ${e.mode === "builder" ? `<div id="builder-root">${PB.render(e.body, library(), state.builder)}</div><div id="program-check" class="builder-check">${checkHTML(chk)}</div>` : `<div class="split">
          <div class="card"><div class="card-head"><h3>Session JSON</h3><span class="extra">Same fields as the sessions/ files (see README)</span></div>
            <textarea id="program-json" spellcheck="false" aria-label="Session JSON">${esc(e.text)}</textarea>
            <div id="program-check">${checkHTML(chk)}</div></div>
          <div class="card"><div class="card-head"><h3>Preview</h3></div><div id="program-preview">${previewHTML(chk.body)}</div></div>
        </div>`}
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

  // ─── library ──────────────────────────────────────────────────────────────────────────
  // Browse the exercise library (by movement family) and the WOD library (Open, Girls, Heroes,
  // tests, or by primary movement). Both drag into a program from the builder's side panel.
  function libExercisesHTML() {
    const lib = library(), ui = state.libPage, q = String(ui.query || "").toLowerCase().trim();
    let html = "";
    for (const c of lib.categories) {
      if (ui.cat && ui.cat !== c) continue;
      const items = lib.items.filter((i) => i.category === c && (!q || i.name.toLowerCase().includes(q)));
      if (!items.length) continue;
      html += `<section class="libp-group"><h3>${esc(c)} <span class="extra">${items.length}</span></h3><ul class="libp-ex">${items.map((i) => `<li><b>${esc(i.name)}</b><span class="extra">${esc(i.sets || 1)} × ${esc(i.target || "–")}${i.log ? ` · logs ${esc(i.log)}` : ""}</span>${i.search || i.video ? `<a class="extra" target="_blank" rel="noopener" href="${esc(i.video || "https://www.youtube.com/results?search_query=" + encodeURIComponent(i.search))}">Video ↗</a>` : ""}</li>`).join("")}</ul></section>`;
    }
    return html || `<div class="empty"><span>${state.librarySeed ? `No exercise called “${esc(ui.query)}”.` : "Loading the library…"}</span></div>`;
  }
  function libWodsHTML() {
    const ui = state.libPage;
    if (!state.wodSeed) return `<div class="empty"><span>Loading WODs…</span></div>`;
    const secs = PB.wodSections(state.wodSeed, ui.query ? "" : ui.wodGroup, ui.query);
    if (!secs.length) return `<div class="empty"><span>No WOD matches “${esc(ui.query)}”.</span></div>`;
    return secs.map((sec) => `<section class="libp-group"><h3>${esc(sec.title)} <span class="extra">${sec.wods.length}</span></h3><div class="libp-wods">${sec.wods.map((w) => `<article class="wod-card">
        <div class="wod-card-head"><b>${esc(w.name)}</b><span class="chip info">${esc(w.primary)}</span></div>
        <div class="extra">${esc(PB.wodMeta(w))}${w.rounds ? ` · ${w.rounds} rounds` : ""} · scored by ${esc((W.TYPES[w.score] || {}).label || w.score)}</div>
        <div class="pre wod-desc">${esc(w.description)}</div>
        <div class="row"><button type="button" class="btn" data-act="wod-to-program" data-id="${esc(w.id)}">New program with this</button><button type="button" class="btn" data-act="wod-to-board" data-id="${esc(w.id)}">Start a leaderboard</button></div>
      </article>`).join("")}</div></section>`).join("");
  }
  function renderLibrary(v) {
    const ui = state.libPage, wod = v.tab === "wod";
    const nEx = library().items.length, nW = state.wodSeed ? state.wodSeed.wods.length : 0;
    const chips = wod
      ? [["open", "CrossFit Open"], ["girls", "The Girls"], ["hero", "Heroes"], ["test", "Tests"], ["movement", "By movement"]].map(([g, l]) => `<button type="button" class="chip-btn${ui.wodGroup === g ? " on" : ""}" data-act="libp-group" data-g="${g}">${l}</button>`).join("")
      : ["", ...library().categories].map((c) => `<button type="button" class="chip-btn${(ui.cat || "") === c ? " on" : ""}" data-act="libp-cat" data-c="${esc(c)}">${esc(c || "All")}</button>`).join("");
    return `<section class="hero"><div class="eyebrow">Library</div><h2>${wod ? "WODs" : "Exercises"}</h2>
        <div class="extra">${wod ? "Open workouts 2011–2025, benchmark Girls, Hero WODs and tests. Loads are Rx men/women in kg." : "Grouped by movement family. Exercises used in your programs join automatically."} In a program, drag any of these from the builder's side panel into the athlete's session.</div></section>
      <div class="mode-tabs" role="tablist"><a role="tab" href="#library" aria-selected="${!wod}">Exercises <span class="extra">${nEx}</span></a><a role="tab" href="#library-wods" aria-selected="${wod}">WODs <span class="extra">${nW}</span></a></div>
      <div class="libp-tools"><input type="search" id="libp-search" placeholder="${wod ? "Search WODs or movements, e.g. thruster" : "Search exercises"}" value="${esc(ui.query)}" aria-label="Search"><div class="lib-cats">${chips}</div></div>
      <div id="libp-list">${wod ? libWodsHTML() : libExercisesHTML()}</div>`;
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
    return html + `<section class="card" id="new-wod"><h3>New WOD</h3>${state.wodDraft ? `<div class="extra">From the library. Check it, then create the board.</div>` : `<div class="extra">Or start from one in the <a href="#library-wods">WOD library</a>.</div>`}${wodFormHTML(state.wodDraft)}</section>`;
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
        ${w.score_type === "time" ? `<label class="check"><input type="checkbox" name="capped" data-hint="${esc(t.hint)}"> Didn't finish in the cap${w.time_cap_seconds ? ` (${esc(W.format("time", w.time_cap_seconds))})` : ""}: score is reps done</label>` : ""}
        <label>Date<input name="on" type="date" value="${esc(w.wod_date || today())}"></label>
        <label class="check"><input type="checkbox" name="rx" checked> Rx</label>
        <label class="full">Note<input name="note" maxlength="500" placeholder="Optional"></label>
        <div class="row"><button class="btn primary">Add score</button></div></form></section></div>`;
    if (boardsReady()) {
      const mem = state.boardMembers.filter((m) => m.wod_id === w.id);
      const out = athletes().filter((a) => !mem.some((m) => m.athlete_email === a.email));
      html += `<section class="card"><h3>On this board <span class="extra">(${mem.length})</span></h3>
        <div class="extra">They get a notification in their training log whenever someone adds a score. Athletes join when the WOD goes into their program, or when they log a score.</div>
        <div class="chips board-members">${mem.map((m) => `<span class="chip info">${esc(nameOf(m.athlete_email))} <button type="button" class="x" data-act="board-del-member" data-id="${esc(w.id)}" data-email="${esc(m.athlete_email)}" aria-label="Take ${esc(nameOf(m.athlete_email))} off the board">✕</button></span>`).join("") || `<span class="extra">Nobody yet.</span>`}</div>
        ${out.length ? `<div class="row"><select id="board-member-pick" aria-label="Athlete">${out.map((a) => `<option value="${esc(a.email)}">${esc(a.display_name || a.email)}</option>`).join("")}</select><button type="button" class="btn" data-act="board-add-member" data-id="${esc(w.id)}">Add to board</button></div>` : ""}</section>`;
    }
    html += `<section class="card table-card"><h3>Every score <span class="extra">(${all.length})</span></h3>`;
    if (all.length) {
      html += `<table class="grid"><thead><tr><th>Athlete</th><th>Score</th><th>Rx</th><th>Date</th><th>Note</th><th>Entered by</th><th></th></tr></thead><tbody>`;
      for (const r of all) {
        const k = "del-result-" + r.id;
        html += `<tr class="${r.hidden ? "inactive" : ""}"><td data-l="Athlete">${esc(nameOf(r.athlete_email))}</td><td data-l="Score"><b>${esc(W.format(w.score_type, r.score))}</b></td><td data-l="Rx">${r.rx ? "Rx" : "Scaled"}</td>
          <td data-l="Date">${esc(fmtDate(r.performed_on))}</td><td data-l="Note">${esc(r.note || "")}${r.detail && Array.isArray(r.detail.rounds) && r.detail.rounds.some((x) => x.time != null) ? `<div class="extra">Rounds: ${r.detail.rounds.filter((x) => x.time != null).map((x) => esc(W.format("time", x.time))).join(" · ")}</div>` : ""}</td><td data-l="Entered by">${esc(nameOf(r.entered_by_email))}</td>
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
    else if (v.kind === "week") html = renderWeek(v);
    else if (v.kind === "program") {
      html = renderProgram(v);
      if (state.askAfterRender != null && state.edit) { const bi = state.askAfterRender; state.askAfterRender = null; openBoardAsk([bi], state.edit.athlete || null, { onSave: false }); return; }
      html += boardAskHTML();
    }
    else if (v.kind === "feedback") html = renderFeedback();
    else if (v.kind === "library") html = renderLibrary(v);
    else if (v.kind === "boards") html = renderBoards();
    else if (v.kind === "board") html = renderBoard(v);
    else if (v.kind === "plans") html = window.ConsolePlans.render({ sb, esc, flash, fmtDate, members: () => state.members, rerender: () => render() });
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
        const upd = { display_name: val(f, "name"), role: val(f, "role"), active: checked(f, "active") };
        if (f.elements.also_athlete) upd.also_athlete = upd.role === "trainer" && checked(f, "also_athlete");
        if (f.elements.groups) upd.groups = [...new Set(val(f, "groups").split(",").map((g) => g.trim()).filter(Boolean))];
        await run(sb.from("members").update(upd).eq("email", email));
      } else if (f.id === "program-form") {
        const e = state.edit; const chk = checkProgram(e.text);
        if (chk.errors.length) { flash("Fix the problems in the JSON first."); return; }
        const body = withoutEmptyBlocks(chk.body); delete body.id; delete body.date; delete body.title;
        const row = { athlete_email: val(f, "athlete") || null, date: val(f, "date"), title: val(f, "title"), published: checked(f, "published"), body, created_by_email: state.me, updated_at: new Date().toISOString() };
        // A WOD that hasn't been asked about yet: "Add to leaderboard?" first, then save.
        const ask = chk.body.blocks.map((b, bi) => (isWodBlock(b) && !("board" in b) ? bi : -1)).filter((bi) => bi >= 0);
        if (ask.length) { setEditText(e.text); openBoardAsk(ask, row.athlete_email); return; }
        // Athlete may have changed since the board was picked: make sure they're on it.
        if (boardsReady()) {
          const ups = [];
          for (const b of body.blocks) if (b && b.board) for (const em of programAthletes(row.athlete_email)) ups.push({ wod_id: b.board, athlete_email: em, added_by_email: state.me });
          if (ups.length) { const r = await sb.from("wod_board_members").upsert(ups, { onConflict: "wod_id,athlete_email", ignoreDuplicates: true }); if (r.error) console.warn(r.error); }
        }
        const pid = e.id || newProgramId(row.date);
        const q = e.id ? sb.from("programs").update(row).eq("id", e.id) : sb.from("programs").insert(Object.assign({ id: pid }, row));
        if (await run(q, "Program saved.")) {
          state.edit = null; location.hash = "programs";
          if (row.published) await notifyWodAgain(pid, row);
        }
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
        if (f.id === "wod-add" && state.wodDraft && state.wodDraft.library_id && boardsReady()) row.library_id = state.wodDraft.library_id;
        if (f.id === "wod-add") {
          const { data, error } = await sb.from("wods").insert(Object.assign({ created_by_email: state.me }, row)).select().single();
          if (error) return failed(error);
          state.wodDraft = null;
          await loadAll(); location.hash = "board-" + data.id; render();
        } else {
          state.editingWod = false;
          await run(sb.from("wods").update(row).eq("id", f.dataset.id), "Saved.");
        }
      } else if (f.id === "result-add") {
        const cap = !!(f.elements.capped && f.elements.capped.checked);
        const score = W.parse(f.dataset.type, val(f, "score"), cap);
        if (!val(f, "athlete")) { flash("Choose an athlete."); return; }
        if (score == null) { flash(cap ? "Enter the total reps done before the cap, e.g. 45." : "That score doesn't look right. Use " + W.TYPES[f.dataset.type].hint + (f.dataset.type === "time" ? ", or tick \"Didn't finish\" for CAP + reps." : ".")); return; }
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
    if (ev.target.id === "libp-search") {
      state.libPage.query = ev.target.value;
      const l = $("#libp-list"); if (l) l.innerHTML = view().tab === "wod" ? libWodsHTML() : libExercisesHTML();
      return;
    }
    if (ev.target.id === "program-json" && state.edit) {
      setEditText(ev.target.value);
      refreshCheck();
    } else if (ev.target.form && ev.target.form.id === "program-form" && state.edit && !ev.target.closest(".builder")) {
      const f = ev.target.form;
      Object.assign(state.edit, { athlete: val(f, "athlete"), date: val(f, "date"), title: f.elements.title.value, published: checked(f, "published") });
    }
  });
  app.addEventListener("change", async (ev) => {
    const el = ev.target;
    if (el.dataset.ask != null && state.boardAsk) { state.boardAsk.items[Number(el.dataset.ask)].choice = el.value; return; }
    if (el.id === "reorder-renumber" && state.reorder) { state.reorder.renumber = el.checked; return; }
    if (state.copyWeek && el.dataset.cwEdit) {
      // A typed line: keep it, then redraw once focus has moved on so Tab still goes to the next box.
      const c = state.copyWeek, k = el.dataset.cwEdit;
      c.edits[k] = el.tagName === "TEXTAREA" ? el.value : el.value.trim();
      setTimeout(() => {
        const ae = document.activeElement, again = ae && ae.dataset && ae.dataset.cwEdit;
        render();
        if (again) { const n = app.querySelector(`[data-cw-edit="${CSS.escape(again)}"]`); if (n) n.focus(); }
      }, 0);
      return;
    }
    if (state.copyWeek && (el.dataset.cwSkip || el.dataset.cwDate)) {
      const c = state.copyWeek;
      if (el.dataset.cwSkip) c.skip[el.dataset.cwSkip] = !el.checked;
      else if (el.value) c.dates[el.dataset.cwDate] = el.value;
      render(); return;
    }
    if (state.copyWeek && (el.id || "").startsWith("cw-") || (state.copyWeek && el.dataset.cwPick)) {
      const c = state.copyWeek;
      if (el.dataset.cwPick) c.picks[el.dataset.cwPick] = Number(el.value);
      else if (el.id === "cw-from") { c.from = el.value; const w = weeksOf(c.from); c.week = c.toWeek = (w.find((x) => x.week >= mondayOf(today())) || w[w.length - 1]).week; c.picks = {}; Object.assign(c, freshLines());
        if (c.to === c.from) c.to = (athletes().find((a) => a.email !== c.from && a.active) || { email: c.to }).email; }
      else if (el.id === "cw-week") { c.week = el.value; c.toWeek = el.value; c.picks = {}; Object.assign(c, freshLines()); }
      else if (el.id === "cw-to") c.to = el.value;
      else if (el.id === "cw-toweek") { if (el.value) { c.toWeek = mondayOf(el.value); c.dates = {}; } }
      else if (el.id === "cw-todate") { if (el.value) c.toDate = el.value; }
      else if (el.id === "cw-pct") { const n = Math.round(Number(el.value)); if (n >= 10 && n <= 300) { c.pct = n; c.picks = {}; } }
      else if (el.id === "cw-reppct") { const n = Math.round(Number(el.value)); if (n >= 10 && n <= 300) c.repPct = n; }
      else if (el.id === "cw-keepreps") { c.keepReps = el.checked; try { localStorage.setItem("console.keepReps", el.checked ? "1" : "0"); } catch (e) { /* private window */ } }
      else if (el.id === "cw-db" || el.id === "cw-kb") { c.sizes[el.id === "cw-db" ? "db" : "kb"] = PS.parseSizes(el.value, el.id === "cw-db" ? PS.DUMBBELLS : PS.KETTLEBELLS); c.picks = {}; }
      else if (el.id === "cw-publish") { c.publish = el.checked; return; }
      const open = !!($(".cw-sizes") && $(".cw-sizes").open);
      render(); if (open && $(".cw-sizes")) $(".cw-sizes").open = true;
      return;
    }
    if (el.name === "capped" && el.form && el.form.id === "result-add") { el.form.elements.score.placeholder = el.checked ? "reps done, e.g. 45" : el.dataset.hint; return; }
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
        setEditText(JSON.stringify(body, null, 1));
      } else { state.edit.text = text; state.edit.mode = "json"; }
      render();
    }
    if (el.form && el.form.id === "program-form" && state.edit && !el.closest(".builder")) {
      const f = el.form;
      Object.assign(state.edit, { athlete: val(f, "athlete"), date: val(f, "date"), title: f.elements.title.value, published: checked(f, "published") });
      if (el.name === "athlete" && state.edit.mode === "builder") renderBuilder();
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
    else if (act === "edit-mode" && state.edit) {
      if (btn.dataset.mode === "builder") {
        try { JSON.parse(state.edit.text); } catch (e) { flash("Fix the JSON first: " + e.message); return; }
        setEditText(state.edit.text);
      }
      state.edit.mode = btn.dataset.mode; render();
    }
    else if (act === "toggle-publish") {
      const p = state.programs.find((x) => x.id === id); if (!p) return;
      await run(sb.from("programs").update({ published: !p.published, updated_at: new Date().toISOString() }).eq("id", id), p.published ? "Unpublished." : "Published.");
    } else if (act === "reorder-start") {
      const f = state.athleteFilter; state.reorder = { athlete: f, ids: ownPrograms(f).map((p) => p.id), renumber: false }; render();
    } else if (act === "reorder-move") { reorderMove(Number(btn.dataset.i), Number(btn.dataset.i) + Number(btn.dataset.d)); }
    else if (act === "reorder-cancel") { state.reorder = null; render(); }
    else if (act === "reorder-save") { btn.disabled = true; await saveReorder(); }
    else if (act === "copyweek-start" || act === "copy-session" || act === "copy-week-of") {
      // From a program row or the editor: btn.dataset.id is the program.
      state.reorder = null; state.edit = null;
      startCopyWeek(act === "copy-session" ? "session" : "week", id || null);
      if (location.hash !== "#programs") location.hash = "programs"; else render();
    }
    else if (act === "copyline-undo" && state.copyWeek) {
      const c = state.copyWeek, k = btn.dataset.key;
      if (c.undo[k]) delete c.undo[k]; else { c.undo[k] = true; for (const f of LINE_FIELDS.concat("note")) delete c.edits[k + "|" + f]; }
      render();
    }
    else if (act === "copyline-reset" && state.copyWeek) { const c = state.copyWeek, k = btn.dataset.key; for (const f of LINE_FIELDS.concat("note")) delete c.edits[k + "|" + f]; render(); }
    else if (act === "copyweek-all" && state.copyWeek) { const c = state.copyWeek; c.all[id] = !c.all[id]; render(); }
    else if (act === "copyweek-whole" && state.copyWeek) { startCopyWeek("week", state.copyWeek.pid); render(); }
    else if (act === "copyweek-pct" && state.copyWeek) { Object.assign(state.copyWeek, { pct: Number(btn.dataset.n), repPct: null, picks: {} }); render(); }
    else if (act === "copyweek-cancel") { const back = state.copyWeek && state.copyWeek.returnTo; state.copyWeek = null; if (back) location.hash = back; else render(); }
    else if (act === "week-group") { state.weekGroup = btn.dataset.g || ""; render(); }
    else if (act === "copy-week-row") {
      startCopyWeek("week");
      const c = state.copyWeek; c.from = btn.dataset.email; c.week = c.toWeek = btn.dataset.week; c.picks = {};
      if (c.to === c.from) c.to = (athletes().find((a) => a.email !== c.from && a.active) || { email: c.to }).email;
      c.returnTo = location.hash.slice(1) || "week"; location.hash = "programs";
    }
    else if (act === "copyweek-save" && state.copyWeek) { btn.disabled = true; await saveCopyWeek(); }
    else if (act === "duplicate") {
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
    else if (act === "ask-cancel") { state.boardAsk = null; render(); }
    else if (act === "board-change" && state.edit) { openBoardAsk([Number(btn.dataset.bi)], state.edit.athlete || null, { onSave: false, force: true }); }
    else if (act === "ask-confirm") { btn.disabled = true; await confirmBoardAsk(); }
    else if (act === "board-add-member") {
      const sel = $("#board-member-pick"); if (!sel || !sel.value) return;
      await run(sb.from("wod_board_members").upsert({ wod_id: id, athlete_email: sel.value, added_by_email: state.me }, { onConflict: "wod_id,athlete_email", ignoreDuplicates: true }), "Added to the board.");
    } else if (act === "board-del-member") {
      await run(sb.from("wod_board_members").delete().eq("wod_id", id).eq("athlete_email", btn.dataset.email));
    }
    else if (act === "libp-cat") { state.libPage.cat = btn.dataset.c; render(); }
    else if (act === "libp-group") { state.libPage.wodGroup = btn.dataset.g; state.libPage.query = ""; render(); }
    else if (act === "wod-to-program") { state.pendingWod = id; state.edit = null; if (location.hash === "#program-new") render(); else location.hash = "program-new"; }
    else if (act === "wod-to-board") {
      const w = state.wodSeed && state.wodSeed.wods.find((x) => x.id === id); if (!w) return;
      state.wodDraft = { name: w.name, score_type: w.score, time_cap_seconds: w.cap || null, status: "draft", description: w.description, library_id: w.id };
      location.hash = "boards"; setTimeout(() => { const el = $("#new-wod"); if (el) el.scrollIntoView({ block: "start" }); }, 0);
    }
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
    if (view().kind !== "boards") state.wodDraft = null;
    state.boardAsk = null;
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
    const getJSON = (u) => fetch(u, { cache: "no-cache" }).then((r) => r.json()).catch(() => null);
    Promise.all([loadFileSessions(), getJSON("exercises.json"), getJSON("wods.json")]).then(([files, seed, wods]) => {
      Object.assign(state, { fileIds: files.map((s) => s.id), fileSessions: files, librarySeed: seed, wodSeed: wods });
      if (view().kind === "programs" || view().kind === "library") softRender();
      else if (view().kind === "program" && state.edit && state.edit.mode === "builder") renderBuilder();
    });
    if (channel) sb.removeChannel(channel);
    channel = sb.channel("trainer-console");
    for (const table of ["members", "programs", "notes", "session_finishes", "wods", "wod_results", "ticks", "wod_board_members"]) channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, scheduleReload);
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
  if (window.TrainingStore.watchForUpdates) window.TrainingStore.watchForUpdates(["console.js", "builder.js", "store.js", "wod.js"]);
})();
