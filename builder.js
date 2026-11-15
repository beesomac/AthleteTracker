// Program builder for the trainer console: an exercise library of draggable blocks, and a
// program canvas that edits the same session JSON as the sessions/ files (see README).
// No database changes: the library is exercises.json plus every exercise already used in a
// program or session file, so a new exercise joins the library once a program using it is saved.
(function () {
  const STATUSES = ["", "new", "back", "swap", "watch", "hold"];
  const OPTIONAL = ["status", "cue", "extra", "search", "video"];

  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  const norm = (s) => String(s || "").toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  function shortDate(iso) {
    try { return new Date(String(iso).slice(0, 10) + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" }); } catch (e) { return iso; }
  }
  function categoryOf(blockName) {
    const n = norm(blockName);
    if (/prep|warm|mobil/.test(n)) return "Prep";
    if (/speed|accel|power|plyo|jump|sprint/.test(n)) return "Speed & Power";
    if (/strength/.test(n)) return "Strength";
    if (/access/.test(n)) return "Accessories";
    if (/resil|core|conditioning|carry/.test(n)) return "Resilience";
    return "Other";
  }
  const dose = (ex) => `${ex.sets || 1} × ${ex.target || "–"}`;

  // seed: exercises.json; sessions: [{ date, blocks }] newest or oldest, any order.
  function buildLibrary(seed, sessions) {
    const cats = (seed && seed.categories) || [];
    const byKey = new Map();
    for (const ex of (seed && seed.exercises) || []) {
      byKey.set(norm(ex.name), Object.assign({ key: norm(ex.name), uses: 0, last: null }, ex));
    }
    const sorted = (sessions || []).filter((s) => s && Array.isArray(s.blocks)).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    for (const s of sorted) {
      for (const b of s.blocks) for (const ex of b.exercises || []) {
        if (!ex || !ex.name) continue;
        const key = norm(ex.name);
        let item = byKey.get(key);
        if (!item) {
          item = { key, name: ex.name, category: categoryOf(b.name), sets: ex.sets || 3, target: ex.target || "", uses: 0, last: null };
          if (ex.search) item.search = ex.search;
          if (ex.video) item.video = ex.video;
          byKey.set(key, item);
        }
        if (!item.search && ex.search) item.search = ex.search;
        item.uses++;
        // "hold" means it was written in but not done, so it doesn't count as the last time.
        if (ex.status !== "hold") item.last = { date: s.date, sets: ex.sets, target: ex.target, extra: ex.extra || "" };
      }
    }
    const items = [...byKey.values()];
    const order = (c) => { const i = cats.indexOf(c); return i < 0 ? 99 : i; };
    items.sort((a, b) => order(a.category) - order(b.category) || a.name.localeCompare(b.name));
    const allCats = [...cats];
    for (const it of items) if (!allCats.includes(it.category)) allCats.push(it.category);
    return { items, categories: allCats.filter((c) => items.some((i) => i.category === c)) };
  }

  // ─── body edits ─────────────────────────────────────────────────────────────────────────
  function allIds(body) { const s = new Set(); for (const b of body.blocks || []) for (const e of b.exercises || []) s.add(String(e.id)); return s; }
  function newId(body, block) {
    const ids = allIds(body);
    const p = String(block.key || "x").toLowerCase().replace(/[^a-z0-9]/g, "") || "x";
    let n = (block.exercises || []).length + 1;
    while (ids.has(p + n) || ids.has(String(p + n))) n++;
    return p + n;
  }
  function nextKey(body) {
    const keys = (body.blocks || []).map((b) => String(b.key || ""));
    if (keys.length && keys.every((k) => /^\d+$/.test(k))) return String(Math.max(...keys.map(Number)) + 1);
    const letters = keys.filter((k) => /^[A-Z]$/i.test(k)).map((k) => k.toUpperCase().charCodeAt(0));
    return letters.length ? String.fromCharCode(Math.min(90, Math.max(...letters) + 1)) : "A";
  }
  function fromLibrary(body, block, item) {
    const ex = { id: newId(body, block), name: item.name, sets: item.sets || 3, target: item.target || "" };
    if (item.cue) ex.cue = item.cue;
    if (item.search) ex.search = item.search;
    if (item.video) ex.video = item.video;
    return ex;
  }

  // ─── rendering ──────────────────────────────────────────────────────────────────────────
  function libItemHTML(it, targetLabel) {
    const last = it.last ? `<span class="lib-last">Last ${esc(shortDate(it.last.date))}: ${esc(dose(it.last))}${it.uses > 1 ? ` · ${it.uses}×` : ""}</span>` : `<span class="lib-last never">Not done yet</span>`;
    return `<li class="lib-item" draggable="true" data-lib="${esc(it.key)}" title="Drag into a block">
      <span class="grip" aria-hidden="true"></span>
      <span class="lib-text"><b>${esc(it.name)}</b><span class="extra">${esc(dose(it))}</span>${last}</span>
      <button type="button" class="add" data-bact="add-lib" data-lib="${esc(it.key)}" aria-label="Add ${esc(it.name)} to ${esc(targetLabel)}">+</button></li>`;
  }
  function libListHTML(lib, ui, body) {
    const q = norm(ui.query);
    const tb = (body.blocks || [])[targetIndex(body, ui)];
    const targetLabel = tb ? `block ${tb.key || ""}` : "a new block";
    let html = "";
    for (const c of lib.categories) {
      if (ui.cat && ui.cat !== c) continue;
      const items = lib.items.filter((i) => i.category === c && (!q || norm(i.name).includes(q)));
      if (!items.length) continue;
      html += `<div class="lib-group"><h4>${esc(c)}</h4><ul>${items.map((i) => libItemHTML(i, targetLabel)).join("")}</ul></div>`;
    }
    return html || `<div class="extra lib-empty">No exercise called “${esc(ui.query)}”. Add it to a block with “New exercise” and it joins the library once the program is saved.</div>`;
  }
  function targetIndex(body, ui) {
    const n = (body.blocks || []).length;
    return ui.target != null && ui.target < n ? ui.target : n - 1;
  }
  function exHTML(ex, bi, ei, ui) {
    const open = ui.open && ui.open.has(String(ex.id));
    return `<li class="bex${ex.status === "hold" ? " is-hold" : ""}" draggable="true" data-b="${bi}" data-e="${ei}">
      <span class="grip" title="Drag to move" aria-hidden="true"></span>
      <div class="bex-main">
        <input class="ex-name" data-ef="name" value="${esc(ex.name)}" aria-label="Exercise name" placeholder="Exercise name">
        <span class="dose"><input class="ex-sets" data-ef="sets" type="number" min="1" max="20" inputmode="numeric" value="${esc(ex.sets || "")}" aria-label="Sets"><span class="x">×</span><input class="ex-target" data-ef="target" value="${esc(ex.target)}" aria-label="Target" placeholder="10 reps"></span>
        <select data-ef="status" aria-label="Status">${STATUSES.map((s) => `<option value="${s}" ${(ex.status || "") === s ? "selected" : ""}>${s || "–"}</option>`).join("")}</select>
        <span class="bex-btns"><button type="button" class="icon${open ? " on" : ""}" data-bact="more" aria-expanded="${open ? "true" : "false"}" title="Cue, notes and video">${ex.cue || ex.extra ? "Cue •" : "Cue"}</button><button type="button" class="icon" data-bact="del-ex" aria-label="Remove ${esc(ex.name)}">✕</button></span>
      </div>
      ${open ? `<div class="bex-more">
        <label class="full">Cue<textarea data-ef="cue" rows="2" placeholder="What to watch for">${esc(ex.cue || "")}</textarea></label>
        <label>Extra (RPE, previous loads)<input data-ef="extra" value="${esc(ex.extra || "")}"></label>
        <label>YouTube search<input data-ef="search" value="${esc(ex.search || "")}"></label>
        <label>Video link<input data-ef="video" value="${esc(ex.video || "")}" placeholder="https://youtube.com/…"></label>
        <span class="extra">id ${esc(ex.id)}</span></div>` : ""}
    </li>`;
  }
  function blockHTML(b, bi, n, ui, isTarget) {
    const exs = b.exercises || [];
    const confirm = ui.confirm === "del-block-" + bi;
    return `<section class="bblock${isTarget ? " is-target" : ""}" data-b="${bi}">
      <div class="bblock-head">
        <input class="bkey" data-bf="key" value="${esc(b.key)}" aria-label="Block letter" maxlength="3">
        <input class="bname" data-bf="name" value="${esc(b.name)}" aria-label="Block name" placeholder="Block name">
        <input class="brounds" data-bf="rounds" value="${esc(b.rounds || "")}" aria-label="Rounds" placeholder="e.g. 3 rounds">
        <span class="bblock-btns">
          <button type="button" class="icon" data-bact="block-up" ${bi === 0 ? "disabled" : ""} aria-label="Move block up">↑</button>
          <button type="button" class="icon" data-bact="block-down" ${bi === n - 1 ? "disabled" : ""} aria-label="Move block down">↓</button>
          <button type="button" class="icon danger" data-bact="del-block">${confirm ? "Delete block?" : "✕"}</button>
        </span>
      </div>
      <ol class="drop" data-b="${bi}">${exs.map((ex, ei) => exHTML(ex, bi, ei, ui)).join("")}${exs.length ? "" : `<li class="drop-hint">Drag exercises here</li>`}</ol>
      <div class="bblock-foot"><button type="button" class="link" data-bact="new-ex">+ New exercise</button>${isTarget ? `<span class="extra">+ in the library adds here</span>` : `<button type="button" class="link" data-bact="target">Add library picks here</button>`}</div>
    </section>`;
  }
  function render(body, lib, ui) {
    const blocks = body.blocks || [];
    const t = targetIndex(body, ui);
    return `<div class="builder">
      <aside class="card lib">
        <div class="card-head"><h3>Exercises</h3><span class="extra">Drag into a block, or press +</span></div>
        <input type="search" class="lib-search" placeholder="Search exercises" value="${esc(ui.query || "")}" aria-label="Search exercises">
        <div class="lib-cats">${["", ...lib.categories].map((c) => `<button type="button" class="chip-btn${(ui.cat || "") === c ? " on" : ""}" data-bact="cat" data-cat="${esc(c)}">${esc(c || "All")}</button>`).join("")}</div>
        <div class="lib-list">${libListHTML(lib, ui, body)}</div>
      </aside>
      <div class="canvas">
        <div class="canvas-top">
          <label class="summary-field">Tab label<input data-sf="short" value="${esc(body.short || "")}" placeholder="Session 3"></label>
          <label class="summary-field">Summary (shown at the top for the athlete)<textarea data-sf="summary" rows="2">${esc(body.summary || "")}</textarea></label>
        </div>
        ${blocks.map((b, bi) => blockHTML(b, bi, blocks.length, ui, bi === t)).join("")}
        <div class="drop new-block" data-b="new"><span>Drop here for a new block, or</span> <button type="button" class="btn" data-bact="add-block">+ Add block</button></div>
        <label class="summary-field">Next progressions (one per line)<textarea data-sf="next" rows="3">${esc((body.next || []).join("\n"))}</textarea></label>
      </div>
    </div>`;
  }

  // ─── interaction ────────────────────────────────────────────────────────────────────────
  // ctx: { body(), lib(), ui, change(structural) } — change(true) means re-render the builder.
  function mount(root, ctx) {
    let drag = null;
    const inBuilder = (el) => el && el.closest && el.closest(".builder");
    const indexOf = (el) => ({ b: Number(el.dataset.b), e: el.dataset.e == null ? null : Number(el.dataset.e) });
    function clearMarks() { root.querySelectorAll(".drop-before,.drop-end,.drop-over,.dragging").forEach((x) => x.classList.remove("drop-before", "drop-end", "drop-over", "dragging")); }
    function insertAt(list, y) {
      const rows = [...list.querySelectorAll(":scope > .bex")];
      for (let i = 0; i < rows.length; i++) { const r = rows[i].getBoundingClientRect(); if (y < r.top + r.height / 2) return i; }
      return rows.length;
    }
    function place(body, ex, toB, at) {
      if (toB === "new") {
        const b = { key: nextKey(body), name: "", exercises: [] };
        body.blocks.push(b);
        toB = body.blocks.length - 1;
        if (!ex.id || ex._fresh) ex.id = newId(body, b);
      }
      delete ex._fresh;
      body.blocks[toB].exercises = body.blocks[toB].exercises || [];
      body.blocks[toB].exercises.splice(at, 0, ex);
      ctx.ui.target = toB;
    }

    root.addEventListener("dragstart", (ev) => {
      if (!inBuilder(ev.target)) return;
      const lib = ev.target.closest(".lib-item"), row = ev.target.closest(".bex");
      if (lib) drag = { kind: "lib", key: lib.dataset.lib };
      else if (row) drag = Object.assign({ kind: "ex" }, indexOf(row));
      else return;
      ev.dataTransfer.effectAllowed = drag.kind === "lib" ? "copy" : "move";
      ev.dataTransfer.setData("text/plain", drag.kind === "lib" ? lib.dataset.lib : "exercise");
      (lib || row).classList.add("dragging");
    });
    // Rows hold text fields, so a row only drags when grabbed outside them (text stays selectable).
    root.addEventListener("mousedown", (ev) => {
      const row = inBuilder(ev.target) && ev.target.closest(".bex"); if (!row) return;
      row.draggable = !ev.target.closest("input,textarea,select,button,label");
    });
    root.addEventListener("dragover", (ev) => {
      if (!drag) return;
      const list = ev.target.closest && ev.target.closest(".builder .drop"); if (!list) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = drag.kind === "lib" ? "copy" : "move";
      root.querySelectorAll(".drop-before,.drop-end,.drop-over").forEach((x) => x.classList.remove("drop-before", "drop-end", "drop-over"));
      list.classList.add("drop-over");
      if (list.dataset.b === "new") return;
      const at = insertAt(list, ev.clientY), rows = list.querySelectorAll(":scope > .bex");
      if (rows[at]) rows[at].classList.add("drop-before"); else list.classList.add("drop-end");
    });
    root.addEventListener("dragleave", (ev) => {
      const list = ev.target.closest && ev.target.closest(".builder .drop");
      if (list && !list.contains(ev.relatedTarget)) list.classList.remove("drop-over", "drop-end");
    });
    root.addEventListener("drop", (ev) => {
      if (!drag) return;
      const list = ev.target.closest && ev.target.closest(".builder .drop"); if (!list) return;
      ev.preventDefault();
      const body = ctx.body();
      const toB = list.dataset.b === "new" ? "new" : Number(list.dataset.b);
      let at = toB === "new" ? 0 : insertAt(list, ev.clientY);
      if (drag.kind === "lib") {
        const item = ctx.lib().items.find((i) => i.key === drag.key); if (!item) return;
        const block = toB === "new" ? { key: nextKey(body), exercises: [] } : body.blocks[toB];
        const ex = fromLibrary(body, block, item); if (toB === "new") ex._fresh = true;
        place(body, ex, toB, at);
      } else {
        const from = body.blocks[drag.b].exercises;
        const [ex] = from.splice(drag.e, 1);
        if (toB === drag.b && at > drag.e) at--;
        place(body, ex, toB, at);
      }
      drag = null; clearMarks(); ctx.change(true);
    });
    root.addEventListener("dragend", () => { drag = null; clearMarks(); });

    root.addEventListener("input", (ev) => {
      const el = ev.target; if (!inBuilder(el)) return;
      const body = ctx.body();
      if (el.classList.contains("lib-search")) {
        ctx.ui.query = el.value;
        root.querySelector(".builder .lib-list").innerHTML = libListHTML(ctx.lib(), ctx.ui, body);
        return;
      }
      if (el.dataset.sf === "short") { if (el.value.trim()) body.short = el.value; else delete body.short; return ctx.change(false); }
      if (el.dataset.sf === "summary") { if (el.value.trim()) body.summary = el.value; else delete body.summary; return ctx.change(false); }
      if (el.dataset.sf === "next") { body.next = el.value.split("\n").map((x) => x.trim()).filter(Boolean); return ctx.change(false); }
      const bEl = el.closest("[data-b]"); if (!bEl) return;
      if (el.dataset.bf) {
        const b = body.blocks[Number(el.closest(".bblock").dataset.b)];
        if (el.dataset.bf === "rounds" && !el.value.trim()) delete b.rounds; else b[el.dataset.bf] = el.value;
        return ctx.change(false);
      }
      if (el.dataset.ef) {
        const row = el.closest(".bex"), ex = body.blocks[Number(row.dataset.b)].exercises[Number(row.dataset.e)];
        const f = el.dataset.ef;
        if (f === "sets") { const n = parseInt(el.value, 10); if (n >= 1) ex.sets = n; else delete ex.sets; }
        else if (OPTIONAL.includes(f) && !el.value.trim()) delete ex[f];
        else ex[f] = el.value;
        if (f === "status") row.classList.toggle("is-hold", el.value === "hold");
        return ctx.change(false);
      }
    });
    // Enter in a builder field shouldn't submit (save) the whole program.
    root.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target.tagName === "INPUT" && inBuilder(ev.target)) ev.preventDefault(); });
    root.addEventListener("focusin", (ev) => {
      const blk = inBuilder(ev.target) && ev.target.closest(".bblock"); if (!blk) return;
      const i = Number(blk.dataset.b);
      if (ctx.ui.target !== i) { ctx.ui.target = i; markTarget(); }
    });
    function markTarget() {
      root.querySelectorAll(".builder .bblock").forEach((b) => b.classList.toggle("is-target", Number(b.dataset.b) === targetIndex(ctx.body(), ctx.ui)));
      const list = root.querySelector(".builder .lib-list"); if (list) { const top = list.scrollTop; list.innerHTML = libListHTML(ctx.lib(), ctx.ui, ctx.body()); list.scrollTop = top; }
    }

    root.addEventListener("click", (ev) => {
      const btn = ev.target.closest && ev.target.closest(".builder [data-bact]"); if (!btn) return;
      const act = btn.dataset.bact, body = ctx.body(), ui = ctx.ui;
      const blk = btn.closest(".bblock"), bi = blk ? Number(blk.dataset.b) : null;
      const row = btn.closest(".bex"), ei = row ? Number(row.dataset.e) : null;
      if (act !== "del-block") ui.confirm = null;
      if (act === "cat") { ui.cat = btn.dataset.cat; return ctx.change(true); }
      if (act === "add-lib") {
        const item = ctx.lib().items.find((i) => i.key === btn.dataset.lib); if (!item) return;
        let t = targetIndex(body, ui);
        if (t < 0) { body.blocks.push({ key: nextKey(body), name: "", exercises: [] }); t = 0; }
        const b = body.blocks[t]; b.exercises = b.exercises || [];
        b.exercises.push(fromLibrary(body, b, item)); ui.target = t;
        return ctx.change(true, { flashRow: [t, b.exercises.length - 1] });
      }
      if (act === "target") { ui.target = bi; return ctx.change(true); }
      if (act === "new-ex") {
        const b = body.blocks[bi]; b.exercises = b.exercises || [];
        b.exercises.push({ id: newId(body, b), name: "", sets: 3, target: "10 reps" }); ui.target = bi;
        return ctx.change(true, { focus: `.bblock[data-b="${bi}"] .bex:last-child .ex-name` });
      }
      if (act === "del-ex") { body.blocks[bi].exercises.splice(ei, 1); return ctx.change(true); }
      if (act === "more") {
        const id = String(body.blocks[bi].exercises[ei].id);
        ui.open = ui.open || new Set(); if (ui.open.has(id)) ui.open.delete(id); else ui.open.add(id);
        return ctx.change(true, { focus: ui.open.has(id) ? `.bex[data-b="${bi}"][data-e="${ei}"] textarea` : null });
      }
      if (act === "add-block") {
        body.blocks.push({ key: nextKey(body), name: "", exercises: [] }); ui.target = body.blocks.length - 1;
        return ctx.change(true, { focus: `.bblock[data-b="${body.blocks.length - 1}"] .bname` });
      }
      if (act === "block-up" || act === "block-down") {
        const to = act === "block-up" ? bi - 1 : bi + 1; if (to < 0 || to >= body.blocks.length) return;
        const [b] = body.blocks.splice(bi, 1); body.blocks.splice(to, 0, b); ui.target = to;
        return ctx.change(true);
      }
      if (act === "del-block") {
        const b = body.blocks[bi];
        if ((b.exercises || []).length && ui.confirm !== "del-block-" + bi) { ui.confirm = "del-block-" + bi; return ctx.change(true); }
        ui.confirm = null; body.blocks.splice(bi, 1); ui.target = null;
        return ctx.change(true);
      }
    });
  }

  window.ProgramBuilder = { buildLibrary, render, libListHTML, mount, categoryOf };
})();
