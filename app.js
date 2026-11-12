(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const app = $("#app"), tabs = $("#tabs"), whoEl = $("#who");
  const cfg = window.TRAINING_CONFIG || {};
  const store = window.TrainingStore.create();
  const tickId = window.TrainingStore.tickKey;

  const state = {
    me: null, sessions: [], ticks: {}, notes: [],
    loaded: false, error: null, login: { sent: false, sending: false, error: null },
    openComposer: null, reviewFilter: "open", confirmDelete: null,
  };

  const ytIcon = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12a31 31 0 0 0 .5 4.8 3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .5-4.8 31 31 0 0 0-.5-4.8zM9.7 15.1V8.9l5.8 3.1-5.8 3.1z"/></svg>';
  const noteIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z"/></svg>';
  const chipLabel = { new: "New", back: "Back in", swap: "Swap", hold: "On hold", watch: "Watch" };

  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function fmtDate(iso) { try { return new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }); } catch (e) { return iso; } }
  function fmtWhen(iso) { try { const d = new Date(iso); return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }
  function ytLink(ex) { return ex.video || "https://www.youtube.com/results?search_query=" + encodeURIComponent((ex.search || ex.name) + " exercise demo"); }
  function nameOf(email) {
    if (!email) return "Someone";
    if (email === state.me) return "You";
    const people = cfg.people || {};
    const key = Object.keys(people).find((k) => k.toLowerCase() === String(email).toLowerCase());
    return key ? people[key] : String(email).split("@")[0];
  }

  function sessionStats(s) {
    let total = 0, done = 0;
    for (const b of s.blocks || []) for (const ex of b.exercises || []) {
      if (ex.status === "hold") continue;
      const n = ex.sets || 1; total += n;
      const t = state.ticks[tickId(s.id, ex.id)];
      if (t && t.sets) for (let i = 1; i <= n; i++) if (t.sets[i]) done++;
    }
    return { total, done };
  }
  const openNotes = () => state.notes.filter((n) => !n.reviewed);

  function currentView() {
    const h = (location.hash || "").slice(1);
    if (h === "notes") return { kind: "notes" };
    if (h.startsWith("session-")) { const id = h.slice(8); if (state.sessions.find((s) => s.id === id)) return { kind: "session", id }; }
    const latest = state.sessions[state.sessions.length - 1];
    return latest ? { kind: "session", id: latest.id } : { kind: "none" };
  }

  function renderTabs(view) {
    if (!state.me || !state.loaded) { tabs.innerHTML = ""; return; }
    const parts = state.sessions.map((s, i) => {
      const st = sessionStats(s);
      const cur = view.kind === "session" && view.id === s.id;
      return `<a href="#session-${esc(s.id)}" ${cur ? 'aria-current="page"' : ""}>${esc(s.short || "Session " + (i + 1))} · ${esc(fmtDate(s.date))}${st.total && st.done === st.total ? " ✓" : ""}</a>`;
    });
    const n = openNotes().length;
    parts.push(`<a href="#notes" ${view.kind === "notes" ? 'aria-current="page"' : ""}>Notes to review${n ? ` <span class="count">${n}</span>` : ""}</a>`);
    tabs.innerHTML = parts.join("");
    const cur = tabs.querySelector('[aria-current="page"]');
    if (cur) cur.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function renderWho() {
    if (!state.me || store.mode === "demo") { whoEl.innerHTML = ""; return; }
    whoEl.innerHTML = `<span></span><button class="signout" data-act="signout">Sign out</button>`;
    whoEl.querySelector("span").textContent = nameOf(state.me) === "You" ? (cfg.people && cfg.people[state.me]) || state.me.split("@")[0] : "";
  }

  function noteHTML(n, showWhere) {
    const s = state.sessions.find((x) => x.id === n.session);
    const where = showWhere
      ? `<div class="where"><a href="#session-${esc(n.session)}">${esc(s ? s.short || s.title : n.session)}</a>${n.exName ? " · " + esc(n.exName) : " · Whole session"}</div>`
      : "";
    const delArmed = state.confirmDelete === n.id;
    const mine = n.by && n.by === state.me;
    return `<div class="${showWhere ? "review-item" : "note"}${n.reviewed ? " reviewed" : ""}">${where}
      <div class="note-text">${esc(n.text)}</div>
      <div class="note-meta"><span>${esc(nameOf(n.by))} · ${esc(fmtWhen(n.at))}</span>${n.reviewed ? `<span>✓ Reviewed${n.reviewedBy ? " by " + esc(nameOf(n.reviewedBy)) : ""}</span>` : ""}
        <button data-act="review" data-id="${esc(n.id)}">${n.reviewed ? "Reopen" : "Mark reviewed"}</button>
        ${mine ? `<button data-act="del" data-id="${esc(n.id)}">${delArmed ? "Tap again to delete" : "Delete"}</button>` : ""}
      </div></div>`;
  }

  function composerHTML(key) {
    return `<div class="composer"><textarea id="note-${esc(key)}" placeholder="How did it feel? Weight used, ankle notes, anything to look at later…"></textarea>
      <div class="row"><button class="btn" data-act="cancel-note">Cancel</button><button class="btn primary" data-act="save-note" data-key="${esc(key)}">Save note</button></div></div>`;
  }

  function renderSession(s) {
    const st = sessionStats(s);
    const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
    let html = `<section class="hero">
      <div class="eyebrow">${esc(fmtDate(s.date))}${s.short ? " · " + esc(s.short) : ""}</div>
      <h2>${esc(s.title)}</h2>
      <div class="meter"><div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div><b>${st.done}/${st.total} sets</b></div>
      ${s.summary ? `<div class="status"><strong>Ankle check:</strong> ${esc(s.summary)}</div>` : ""}
    </section>`;
    for (const b of s.blocks || []) {
      html += `<section class="block"><div class="block-head"><span class="letter">${esc(b.key)}</span><h3>${esc(b.name)}</h3>${b.rounds ? `<span class="rounds">${esc(b.rounds)}</span>` : ""}</div><div class="exlist">`;
      for (const ex of b.exercises || []) {
        const t = state.ticks[tickId(s.id, ex.id)] || {};
        const sets = t.sets || {};
        const n = ex.sets || 1;
        let doneN = 0, pips = "";
        for (let i = 1; i <= n; i++) {
          const on = !!sets[i]; if (on) doneN++;
          pips += `<button class="pip${on ? " on" : ""}" data-act="tick" data-sid="${esc(s.id)}" data-eid="${esc(ex.id)}" data-set="${i}" aria-pressed="${on}" aria-label="${esc(ex.name)} set ${i}">${on ? "✓" : i}</button>`;
        }
        const hold = ex.status === "hold";
        const complete = !hold && doneN === n;
        const exNotes = state.notes.filter((x) => x.session === s.id && x.ex === ex.id);
        const key = s.id + "|" + ex.id;
        html += `<article class="ex${complete ? " complete" : ""}${hold ? " hold" : ""}">
          <div class="ex-top"><div class="ex-name">${esc(ex.name)}</div><div class="ex-target">${esc(ex.target || "")}</div></div>
          ${ex.status && chipLabel[ex.status] ? `<div class="chips"><span class="chip ${esc(ex.status)}">${chipLabel[ex.status]}</span></div>` : ""}
          ${ex.cue ? `<div class="cue">${esc(ex.cue)}</div>` : ""}
          ${ex.extra ? `<div class="extra">${esc(ex.extra)}</div>` : ""}
          <div class="ex-row">
            ${hold ? `<span class="who-ticked">Not this session</span>` : `<div class="pips">${pips}</div>`}
            <div class="tools">
              <a class="btn" href="${esc(ytLink(ex))}" target="_blank" rel="noopener">${ytIcon}${ex.video ? "Video" : "Examples"}</a>
              <button class="btn" data-act="open-note" data-key="${esc(key)}">${noteIcon}Note</button>
            </div>
          </div>
          ${t.by && doneN ? `<div class="who-ticked">Last ticked by ${esc(nameOf(t.by))} · ${esc(fmtWhen(t.at))}</div>` : ""}
          ${exNotes.length ? `<div class="notes">${exNotes.map((x) => noteHTML(x, false)).join("")}</div>` : ""}
          ${state.openComposer === key ? composerHTML(key) : ""}
        </article>`;
      }
      html += `</div></section>`;
    }
    const sNotes = state.notes.filter((x) => x.session === s.id && !x.ex);
    const skey = s.id + "|";
    html += `<section class="session-notes"><h3>Session feedback</h3>
      ${sNotes.length ? `<div class="notes">${sNotes.map((x) => noteHTML(x, false)).join("")}</div>` : `<div class="extra">How did the whole session go? Energy, ankle, anything to change next time.</div>`}
      ${state.openComposer === skey ? composerHTML(skey) : `<div><button class="btn" data-act="open-note" data-key="${esc(skey)}">${noteIcon}Add session note</button></div>`}
    </section>`;
    if (s.next && s.next.length) {
      html += `<section class="next"><h3>Next progressions</h3><ul>${s.next.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        ${s.planUrl ? `<div class="extra"><a href="${esc(s.planUrl)}" target="_blank" rel="noopener">Trae's full rehab plan and return-to-sport tests</a></div>` : ""}</section>`;
    }
    return html;
  }

  function renderNotes() {
    const list = state.notes.filter((n) => state.reviewFilter === "all" || !n.reviewed).slice().sort((a, b) => (a.at < b.at ? 1 : -1));
    let html = `<section class="hero"><div class="eyebrow">Across all sessions</div><h2>Notes to review</h2>
      <div class="filter"><button class="btn" data-act="filter" data-f="open" aria-pressed="${state.reviewFilter === "open"}">Open (${openNotes().length})</button><button class="btn" data-act="filter" data-f="all" aria-pressed="${state.reviewFilter === "all"}">All (${state.notes.length})</button></div></section>`;
    if (!list.length) html += `<div class="empty"><strong>${state.reviewFilter === "open" ? "All caught up" : "No notes yet"}</strong><span>Add a note on any exercise or at the end of a session, and it shows up here until someone marks it reviewed.</span></div>`;
    else html += `<div class="review-list">${list.map((n) => noteHTML(n, true)).join("")}</div>`;
    return html;
  }

  function renderLogin() {
    const l = state.login;
    if (l.sent) return `<div class="login"><h2>Check your email</h2><p>We sent a sign-in link to <strong>${esc(l.email)}</strong>. Open it on this phone and you'll land back here, signed in.</p><button class="btn" data-act="login-again">Use a different email</button></div>`;
    return `<form class="login" id="login-form"><h2>Sign in</h2><p>Only John and Trae can see the log.</p>
      <label for="login-email" class="eyebrow">Email</label>
      <input id="login-email" type="email" autocomplete="email" required placeholder="you@example.com" value="${esc(l.email || "")}">
      <label for="login-password" class="eyebrow">Password</label>
      <input id="login-password" type="password" autocomplete="current-password" placeholder="Leave blank to get an email link instead">
      ${l.error ? `<div class="banner">${esc(l.error)}</div>` : ""}
      <button class="btn primary" type="submit" ${l.sending ? "disabled" : ""}>${l.sending ? "Signing in…" : "Sign in"}</button></form>`;
  }

  function render() {
    const openTA = state.openComposer ? document.getElementById("note-" + state.openComposer) : null;
    const keep = openTA ? { val: openTA.value, focused: document.activeElement === openTA, pos: openTA.selectionStart } : null;

    const view = currentView();
    renderTabs(view);
    renderWho();
    let html;
    if (state.error) html = `<div class="empty"><strong>Something went wrong</strong><span>${esc(state.error)}</span></div>`;
    else if (!state.me) html = renderLogin();
    else if (!state.loaded) html = `<div class="hero"><div class="eyebrow">Loading sessions</div><h2>Getting today's work ready…</h2></div><div class="skeleton"></div><div class="skeleton"></div>`;
    else if (view.kind === "notes") html = renderNotes();
    else if (view.kind === "session") html = renderSession(state.sessions.find((s) => s.id === view.id));
    else html = `<div class="empty"><strong>No sessions yet</strong><span>Add a session file to the sessions folder and it appears here.</span></div>`;
    app.innerHTML = html;

    if (keep) {
      const el = document.getElementById("note-" + state.openComposer);
      if (el) { el.value = keep.val; if (keep.focused) { el.focus(); try { el.setSelectionRange(keep.pos, keep.pos); } catch (e) {} } }
    }
  }

  let queued = false;
  function scheduleRender() { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; render(); }); }

  function flash(msg) {
    const b = document.createElement("div"); b.className = "banner"; b.textContent = msg;
    app.prepend(b); setTimeout(() => b.remove(), 6000);
  }
  function writeFailed(e) {
    console.warn(e);
    flash("That didn't save. Check your connection and try again.");
  }

  app.addEventListener("submit", async (ev) => {
    if (ev.target.id !== "login-form") return;
    ev.preventDefault();
    const email = $("#login-email").value.trim();
    const password = $("#login-password").value;
    if (!email) return;
    state.login = { email, sending: true, sent: false, error: null }; render();
    if (password) {
      try { await store.signInWithPassword(email, password); }
      catch (e) { state.login.error = "That email and password didn't match. Check them and try again, or leave the password blank to get an email link."; }
    } else {
      try { await store.signIn(email); state.login.sent = true; }
      catch (e) {
        state.login.error = /rate limit/i.test(e.message || "")
          ? "Too many sign-in emails in the last hour. Wait an hour, use the most recent link already in your inbox, or sign in with a password."
          : "Couldn't send the link: " + (e.message || "unknown error") + ". Check the address and try again.";
      }
    }
    state.login.sending = false; render();
  });

  document.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-act]"); if (!btn) return;
    const act = btn.dataset.act;
    if (act !== "del") state.confirmDelete = null;

    if (act === "tick") {
      const { sid, eid } = btn.dataset; const set = +btn.dataset.set; const id = tickId(sid, eid);
      const prev = state.ticks[id] || { sets: {} };
      const sets = Object.assign({}, prev.sets || {});
      if (sets[set]) delete sets[set]; else sets[set] = true;
      state.ticks[id] = { session: sid, ex: eid, sets, by: state.me, at: new Date().toISOString() };
      scheduleRender();
      try { await store.setTick(sid, eid, sets); } catch (e) { state.ticks[id] = prev; scheduleRender(); writeFailed(e); }
    } else if (act === "open-note") {
      state.openComposer = btn.dataset.key; render();
      const el = document.getElementById("note-" + state.openComposer); if (el) el.focus();
    } else if (act === "cancel-note") {
      state.openComposer = null; render();
    } else if (act === "save-note") {
      const key = btn.dataset.key; const el = document.getElementById("note-" + key);
      const text = ((el && el.value) || "").trim(); if (!text) return;
      const [sid, eid] = key.split("|");
      const s = state.sessions.find((x) => x.id === sid); let exName = null;
      if (eid && s) for (const b of s.blocks) for (const ex of b.exercises) if (ex.id === eid) exName = ex.name;
      btn.disabled = true;
      try {
        const note = await store.addNote({ session: sid, ex: eid || null, exName, text });
        if (!state.notes.find((n) => n.id === note.id)) state.notes.push(note);
        state.openComposer = null; render();
      } catch (e) { btn.disabled = false; writeFailed(e); }
    } else if (act === "review") {
      const n = state.notes.find((x) => x.id === btn.dataset.id); if (!n) return;
      const before = { reviewed: n.reviewed, reviewedBy: n.reviewedBy };
      n.reviewed = !n.reviewed; n.reviewedBy = n.reviewed ? state.me : null; scheduleRender();
      try { await store.setReviewed(n.id, n.reviewed); } catch (e) { Object.assign(n, before); scheduleRender(); writeFailed(e); }
    } else if (act === "del") {
      const id = btn.dataset.id;
      if (state.confirmDelete !== id) { state.confirmDelete = id; render(); return; }
      state.confirmDelete = null;
      const keep = state.notes; state.notes = state.notes.filter((x) => x.id !== id); scheduleRender();
      try { await store.deleteNote(id); } catch (e) { state.notes = keep; scheduleRender(); writeFailed(e); }
    } else if (act === "filter") {
      state.reviewFilter = btn.dataset.f; render();
    } else if (act === "signout") {
      await store.signOut(); state.me = null; state.loaded = false; render();
    } else if (act === "login-again") {
      state.login = { sent: false }; render();
    }
  });

  window.addEventListener("hashchange", () => { state.openComposer = null; render(); window.scrollTo(0, 0); });

  async function loadSessions() {
    const idx = await fetch("sessions/index.json", { cache: "no-cache" }).then((r) => r.json());
    const list = await Promise.all(idx.sessions.map((f) => fetch("sessions/" + f, { cache: "no-cache" }).then((r) => r.json())));
    return list.sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  async function enter(email) {
    state.me = email; state.loaded = false; render();
    try {
      await store.start((data) => {
        state.ticks = data.ticks; state.notes = data.notes;
        if (state.sessions.length) state.loaded = true;
        scheduleRender();
      });
      if (state.sessions.length) state.loaded = true;
      render();
    } catch (e) {
      console.warn(e);
      state.error = e.code === "not_allowed" || /row-level|permission|policy/i.test(e.message || "")
        ? "This email isn't on the list for Trae's log. Ask John to add it."
        : "Couldn't reach the shared log: " + (e.message || "unknown error");
      render();
    }
  }

  async function boot() {
    if (store.mode === "demo") $("#demo").hidden = false;
    try { state.sessions = await loadSessions(); }
    catch (e) { state.error = "Couldn't load the session files."; render(); return; }
    const email = await store.currentUser();
    store.onAuthChange((next) => { state.error = null; if (next) enter(next); else { state.me = null; render(); } });
    if (email) await enter(email); else render();
  }
  boot();
})();
