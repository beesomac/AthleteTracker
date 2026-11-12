(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const app = $("#app"), tabs = $("#tabs"), whoEl = $("#who");
  const cfg = window.TRAINING_CONFIG || {};
  const store = window.TrainingStore.create();
  const tickId = window.TrainingStore.tickKey;

  const state = {
    me: null, sessions: [], ticks: {}, notes: [], finishes: {}, openSkip: null, finishing: null, openLog: null, maxes: {}, openMax: null, guide: null,
    loaded: false, error: null, login: { sent: false, sending: false, error: null },
    openComposer: null, reviewFilter: "open", confirmDelete: null,
  };

  const ytIcon = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12a31 31 0 0 0 .5 4.8 3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .5-4.8 31 31 0 0 0-.5-4.8zM9.7 15.1V8.9l5.8 3.1-5.8 3.1z"/></svg>';
  const skipIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 5l9 7-9 7zM18 5v14"/></svg>';
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

  function exState(s, ex) {
    const t = state.ticks[tickId(s.id, ex.id)] || {};
    const n = ex.sets || 1;
    let done = 0;
    for (let i = 1; i <= n; i++) if (t.sets && t.sets[i]) done++;
    return { t, n, done, skipped: !!t.skipped, reason: t.skipReason || "" };
  }
  // Skipped exercises drop out of the total, so a session with skips can still reach 100%.
  function sessionStats(s) {
    let total = 0, done = 0, skipped = 0;
    for (const b of s.blocks || []) for (const ex of b.exercises || []) {
      if (ex.status === "hold") continue;
      const e = exState(s, ex);
      if (e.skipped) { skipped++; continue; }
      total += e.n; done += e.done;
    }
    return { total, done, skipped };
  }
  // A set is stored as an ISO time (old) or {at, reps, kg}.
  function setInfo(v) {
    if (!v) return null;
    if (typeof v === "string") return { at: v };
    if (v === true) return { at: null };
    return v;
  }
  function targetReps(ex) { const m = /^(\d+)/.exec(ex.target || ""); return m ? +m[1] : ""; }
  const liftKey = (name) => String(name).toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  // Epley estimate. Only trusted up to 12 reps; above that it's too rough to call a 1RM.
  function est1RM(kg, reps) { if (!kg || !reps || reps > 12) return null; return reps === 1 ? kg : kg * (1 + reps / 30); }
  const round1 = (x) => Math.round(x * 10) / 10;
  // Every logged set across all sessions, grouped by lift name.
  function liftHistory() {
    const lifts = {};
    for (const s of state.sessions) for (const b of s.blocks || []) for (const ex of b.exercises || []) {
      const t = state.ticks[tickId(s.id, ex.id)];
      if (!t || !t.sets) continue;
      for (const r in t.sets) {
        const v = setInfo(t.sets[r]);
        if (!v || !v.kg) continue;
        const k = liftKey(ex.name);
        const L = lifts[k] || (lifts[k] = { name: ex.name, sets: [] });
        L.sets.push({ session: s, ex, round: +r, kg: +v.kg, reps: +v.reps || 0, at: v.at || t.at, e1rm: est1RM(+v.kg, +v.reps) });
      }
    }
    for (const k in lifts) {
      const L = lifts[k];
      L.sets.sort((a, b) => ((a.at || "") < (b.at || "") ? -1 : 1));
      let best = null, heaviest = null;
      for (const x of L.sets) {
        x.pr = !!(x.e1rm && best && x.e1rm > best.e1rm + 0.01);
        if (x.e1rm && (!best || x.e1rm > best.e1rm)) best = x;
        if (!heaviest || x.kg > heaviest.kg) heaviest = x;
      }
      L.best = best; L.heaviest = heaviest; L.last = L.sets[L.sets.length - 1];
    }
    return lifts;
  }
  // Best so far for this lift, and a suggested weight when the session gives a % of 1RM.
  // The 1RM used for suggestions: an entered (known) 1RM wins over the estimate from logged sets.
  function oneRM(name) {
    const m = state.maxes[liftKey(name)];
    if (m && m.kg) return { kg: +m.kg, known: true, on: m.on };
    const L = liftHistory()[liftKey(name)];
    if (L && L.best) return { kg: L.best.e1rm, known: false };
    return null;
  }
  function liftLine(ex, sid) {
    const L = liftHistory()[liftKey(ex.name)];
    const m = state.maxes[liftKey(ex.name)];
    const key = liftKey(ex.name) + "@" + sid;
    const lines = [];
    if (m && m.kg) lines.push(`<span class="onerm"><span>1RM</span>${esc(m.kg)} kg</span>${m.on ? ` <span class="extra">tested ${esc(fmtDate(m.on))}</span>` : ""}`);
    else if (L && L.best) lines.push(`<span class="onerm est"><span>est. 1RM</span>${round1(L.best.e1rm)} kg</span>`);
    if (L && L.best) lines.push(`<span class="extra">Best set ${L.best.reps} × ${L.best.kg} kg${m && m.kg ? ` · est. ${round1(L.best.e1rm)} kg` : ""}</span>`);
    else if (L && L.heaviest) lines.push(`<span class="extra">Heaviest ${L.heaviest.kg} kg</span>`);
    const p = ex.pct || (Array.isArray(ex.pcts) ? ex.pcts[0] : null);
    const rm = oneRM(ex.name);
    if (p && rm) lines.push(`Suggested: <b>${to2_5(rm.kg * p)} kg</b> (${Math.round(p * 100)}% of ${rm.known ? "" : "est. "}1RM)`);
    else if (ex.suggestKg) lines.push(`Suggested: <b>${esc(ex.suggestKg)} kg</b>`);
    const btn = `<button class="link-btn" data-act="open-max" data-key="${esc(key)}">${m && m.kg ? "Edit 1RM" : "Enter 1RM"}</button>`;
    let html = `<div class="lift-line"><div class="lift-bits">${lines.length ? lines.map((l) => `<div>${l}</div>`).join("") : `<span class="extra">No 1RM yet</span>`}</div>${btn}</div>`;
    if (state.openMax === key) {
      html += `<form class="max-form" data-lift="${esc(liftKey(ex.name))}" data-name="${esc(ex.name)}">
        <label>1RM (kg)<input id="max-kg" type="number" inputmode="decimal" min="0" max="999" step="0.5" value="${m && m.kg ? esc(m.kg) : ""}"></label>
        <label>Tested on<input id="max-on" type="date" value="${esc((m && m.on) || localDay(new Date().toISOString()))}"></label>
        <div class="row">${m && m.kg ? `<button type="button" class="btn" data-act="clear-max" data-lift="${esc(liftKey(ex.name))}">Remove</button>` : ""}<button type="button" class="btn" data-act="cancel-max">Cancel</button><button type="submit" class="btn primary">Save 1RM</button></div>
      </form>`;
    }
    return html;
  }
  // Planned weight for a set. A weight typed earlier in this session carries forward:
  // the same kg each set, or scaled when the exercise has a % of 1RM per set (pcts).
  // Before anything is typed: % of est. 1RM if the session gives one, else the last weight used.
  function pctFor(ex, r) {
    if (Array.isArray(ex.pcts) && ex.pcts.length) return ex.pcts[Math.min(r, ex.pcts.length) - 1];
    return ex.pct || null;
  }
  const to2_5 = (x) => Math.round(x / 2.5) * 2.5;
  function plannedKg(s, ex, r) {
    const t = state.ticks[tickId(s.id, ex.id)];
    for (let r0 = r - 1; r0 >= 1; r0--) {
      const v = setInfo(t && t.sets && t.sets[r0]);
      if (v && v.kg) {
        const p0 = pctFor(ex, r0), p1 = pctFor(ex, r);
        return p0 && p1 && p0 !== p1 ? to2_5((v.kg * p1) / p0) : +v.kg;
      }
    }
    const L = liftHistory()[liftKey(ex.name)];
    const p = pctFor(ex, r);
    const rm = oneRM(ex.name);
    if (p && rm) return to2_5(rm.kg * p);
    if (ex.suggestKg) return +ex.suggestKg;
    return L && L.last ? L.last.kg : "";
  }
  function lastKg(ex) { const L = liftHistory()[liftKey(ex.name)]; return L && L.last ? L.last.kg : ""; }

  // The day most sets were ticked on (the viewer's local date), e.g. "2026-11-13".
  function localDay(iso) { const d = new Date(iso); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function doneDay(s) {
    const counts = {};
    for (const b of s.blocks || []) for (const ex of b.exercises || []) {
      const t = state.ticks[tickId(s.id, ex.id)];
      if (!t || !t.sets) continue;
      for (const k in t.sets) {
        const v = t.sets[k];
        const info = setInfo(v);
        const iso = info ? (info.at || t.at) : null;
        if (iso) { const d = localDay(iso); counts[d] = (counts[d] || 0) + 1; }
      }
    }
    let best = null;
    for (const d in counts) if (!best || counts[d] > counts[best]) best = d;
    return best;
  }
  function sessionReport(s) {
    const st = sessionStats(s);
    const skipped = [], missed = [], partial = [];
    for (const b of s.blocks || []) for (const ex of b.exercises || []) {
      if (ex.status === "hold") continue;
      const e = exState(s, ex);
      if (e.skipped) skipped.push({ name: ex.name, reason: e.reason });
      else if (e.done === 0) missed.push({ name: ex.name });
      else if (e.done < e.n) partial.push({ name: ex.name, done: e.done, of: e.n });
    }
    const who = nameOf(state.me) === "You" ? ((cfg.people || {})[state.me] || "Trae") : nameOf(state.me);
    const day = doneDay(s);
    const lines = [`${who} finished ${s.title} (${s.short || s.date})${day ? ", done " + fmtDate(day) : ""}: ${st.done}/${st.total} sets done.`];
    if (skipped.length) lines.push("Skipped: " + skipped.map((x) => x.name + (x.reason ? ` (${x.reason})` : "")).join("; ") + ".");
    if (partial.length) lines.push("Part done: " + partial.map((x) => `${x.name} ${x.done}/${x.of}`).join("; ") + ".");
    if (missed.length) lines.push("Not done: " + missed.map((x) => x.name).join("; ") + ".");
    if (!skipped.length && !partial.length && !missed.length) lines.push("Everything done.");
    return { stats: st, skipped, partial, missed, doneOn: day, text: lines.join("\n") };
  }
  function reportListHTML(r) {
    const li = (arr, f) => arr.map((x) => `<li>${f(x)}</li>`).join("");
    let h = "";
    if (r.skipped.length) h += `<div><b>Skipped</b><ul>${li(r.skipped, (x) => esc(x.name) + (x.reason ? ` <span class="extra">(${esc(x.reason)})</span>` : ""))}</ul></div>`;
    if (r.partial.length) h += `<div><b>Part done</b><ul>${li(r.partial, (x) => `${esc(x.name)} <span class="extra">${x.done}/${x.of} sets</span>`)}</ul></div>`;
    if (r.missed.length) h += `<div><b>Not done</b><ul>${li(r.missed, (x) => esc(x.name))}</ul></div>`;
    if (!h) h = `<div>Every set ticked. Nice work.</div>`;
    return h;
  }
  const openNotes = () => state.notes.filter((n) => !n.reviewed);

  function currentView() {
    const h = (location.hash || "").slice(1);
    if (h === "notes") return { kind: "notes" };
    if (h === "records") return { kind: "records" };
    if (h.startsWith("session-")) { const id = h.slice(8); if (state.sessions.find((s) => s.id === id)) return { kind: "session", id }; }
    const latest = state.sessions[state.sessions.length - 1];
    return latest ? { kind: "session", id: latest.id } : { kind: "none" };
  }

  function sessionDay(s) {
    const fin = state.finishes[s.id];
    return (fin && fin.details && fin.details.doneOn) || doneDay(s) || s.date;
  }
  function renderTabs(view) {
    if (!state.me || !state.loaded) { tabs.innerHTML = ""; return; }
    const parts = state.sessions.map((s, i) => {
      const st = sessionStats(s);
      const cur = view.kind === "session" && view.id === s.id;
      const finished = !!state.finishes[s.id] || (st.total && st.done === st.total);
      return `<a href="#session-${esc(s.id)}" ${cur ? 'aria-current="page"' : ""}>${esc(s.short || "Session " + (i + 1))} · ${esc(fmtDate(sessionDay(s)))}${finished ? " ✓" : ""}</a>`;
    });
    const n = openNotes().length;
 parts.push(`<a href="#records" ${view.kind === "records" ? 'aria-current="page"' : ""}>Records</a>`);
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

  // Guided mode: every set in the order it's done (block by block, round by round).
  function guideSteps(s) {
    const steps = [];
    for (const b of s.blocks || []) {
      const active = (b.exercises || []).filter((ex) => ex.status !== "hold" && !exState(s, ex).skipped);
      const circuit = (b.exercises || []).filter((ex) => ex.status !== "hold").length > 1;
      const rounds = Math.max(0, ...active.map((ex) => ex.sets || 1));
      for (let r = 1; r <= rounds; r++) active.forEach((ex) => {
        if (r <= (ex.sets || 1)) steps.push({ key: ex.id + "#" + r, b, ex, r, rounds, circuit });
      });
    }
    return steps;
  }
  function stepDone(s, st) { const t = state.ticks[tickId(s.id, st.ex.id)]; return !!(t && t.sets && t.sets[st.r]); }

  function renderGuide(s) {
    const steps = guideSteps(s);
    const g = state.guide;
    let i = steps.findIndex((x) => x.key === g.key);
    if (i < 0) { i = steps.findIndex((x) => !stepDone(s, x)); if (i < 0) i = steps.length; g.key = steps[i] ? steps[i].key : "end"; }
    const doneCount = steps.filter((x) => stepDone(s, x)).length;
    const pct = steps.length ? Math.round((doneCount / steps.length) * 100) : 0;
    const top = `<div class="guide-top"><button class="btn" data-act="guide-exit">✕ Exit</button>
      <div class="guide-count">${i < steps.length ? `Step ${i + 1} of ${steps.length}` : "All done"}</div></div>
      <div class="bar guide-bar"><i style="width:${pct}%"></i></div>`;
    if (i >= steps.length) {
      return `<section class="guide">${top}<div class="guide-end"><h2>That's the lot</h2>
        <p class="extra">${doneCount}/${steps.length} sets ticked. Finish the session to send ${esc(cfg.adminName || "John")} the summary.</p>
        <button class="btn primary big" data-act="guide-finish" data-sid="${esc(s.id)}">Finish session</button>
        ${steps.length ? `<button class="btn" data-act="guide-prev">‹ Back to last set</button>` : ""}</div></section>`;
    }
    const st = steps[i], ex = st.ex;
    const t = state.ticks[tickId(s.id, ex.id)] || {};
    const info = setInfo(t.sets && t.sets[st.r]);
    const reps = info && info.reps ? info.reps : targetReps(ex);
    const planned = plannedKg(s, ex, st.r);
    const kg = info && info.kg ? info.kg : planned;
    const p = pctFor(ex, st.r);
    const nxt = steps[i + 1];
    const key = s.id + "|" + ex.id;
    const exNotes = state.notes.filter((x) => x.session === s.id && x.ex === ex.id);
    const idx = (st.b.exercises || []).filter((x) => x.status !== "hold").indexOf(ex) + 1;
    return `<section class="guide">${top}
      <div class="guide-where"><span class="letter">${esc(st.b.key)}</span>${esc(st.b.name)} · ${st.circuit ? `Round ${st.r} of ${st.rounds}` : `Set ${st.r} of ${ex.sets || 1}`}</div>
      <div class="guide-card${info ? " is-done" : ""}">
        <div class="guide-head"><span class="step-num">${esc(st.b.key + (st.circuit ? idx : ""))}</span><h2>${esc(ex.name)}</h2></div>
        <div class="guide-target">${esc(ex.target || "")}${p ? ` · ${Math.round(p * 100)}% of 1RM` : ""}${info ? ` <span class="chip back">Done</span>` : ""}</div>
        ${ex.status && chipLabel[ex.status] ? `<div class="chips"><span class="chip ${esc(ex.status)}">${chipLabel[ex.status]}</span></div>` : ""}
        ${ex.cue ? `<div class="cue">${esc(ex.cue)}</div>` : ""}
        ${ex.extra ? `<div class="extra">${esc(ex.extra)}</div>` : ""}
        ${liftLine(ex, s.id)}
        <form class="guide-form" data-sid="${esc(s.id)}" data-eid="${esc(ex.id)}" data-set="${st.r}">
          <div class="stepper"><span class="stepper-label">Reps</span>
            <button type="button" class="step-btn" data-act="bump" data-field="guide-reps" data-delta="-1" aria-label="One less rep">−</button>
            <input id="guide-reps" type="number" inputmode="numeric" min="0" max="999" step="1" value="${esc(reps)}">
            <button type="button" class="step-btn" data-act="bump" data-field="guide-reps" data-delta="1" aria-label="One more rep">+</button></div>
          <div class="stepper"><span class="stepper-label">Weight kg</span>
            <button type="button" class="step-btn" data-act="bump" data-field="guide-kg" data-delta="-2.5" aria-label="2.5 kg less">−</button>
            <input id="guide-kg" type="number" inputmode="decimal" min="0" max="999" step="0.5" value="${esc(kg)}" placeholder="none">
            <button type="button" class="step-btn" data-act="bump" data-field="guide-kg" data-delta="2.5" aria-label="2.5 kg more">+</button></div>
          <button type="submit" class="btn primary big">${info ? "Save · next" : "Done · next"}</button>
          ${info ? `<button type="button" class="btn" data-act="guide-untick">Untick this set</button>` : ""}
        </form>
        <div class="tools guide-tools">
          <a class="btn" href="${esc(ytLink(ex))}" target="_blank" rel="noopener">${ytIcon}${ex.video ? "Video" : "Examples"}</a>
          <button class="btn" data-act="open-note" data-key="${esc(key)}">${noteIcon}Note</button>
          <button class="btn" data-act="open-skip" data-key="${esc(key)}">${skipIcon}Skip exercise</button>
        </div>
        ${state.openSkip === key ? `<div class="composer"><input id="skip-${esc(key)}" class="skip-input" type="text" maxlength="200" placeholder="Why skip? e.g. ankle sore, no box, ran out of time (optional)">
          <div class="row"><button class="btn" data-act="cancel-skip">Cancel</button><button class="btn primary" data-act="save-skip" data-sid="${esc(s.id)}" data-eid="${esc(ex.id)}">Skip all its sets</button></div></div>` : ""}
        ${exNotes.length ? `<div class="notes">${exNotes.map((x) => noteHTML(x, false)).join("")}</div>` : ""}
        ${state.openComposer === key ? composerHTML(key) : ""}
      </div>
      <div class="guide-nav"><button class="btn" data-act="guide-prev" ${i === 0 ? "disabled" : ""}>‹ Back</button>
        <div class="guide-next">${nxt ? `Next: <b>${esc(nxt.ex.name)}</b>${nxt.r !== st.r || nxt.b !== st.b ? ` <span class="extra">(${nxt.b !== st.b ? esc(nxt.b.name) + ", " : ""}${nxt.circuit ? "round" : "set"} ${nxt.r})</span>` : ""}` : "Last one"}</div>
        <button class="btn" data-act="guide-next" aria-label="Go to the next set without ticking this one">Next ›</button></div>
    </section>`;
  }

  function renderSession(s) {
    if (state.guide && state.guide.sid === s.id) return renderGuide(s);
    const st = sessionStats(s);
    const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
    let html = `<section class="hero">
      <div class="eyebrow">${s.short ? esc(s.short) + " · " : ""}${sessionDay(s) !== s.date ? "Done " + esc(fmtDate(sessionDay(s))) + " · planned " + esc(fmtDate(s.date)) : (doneDay(s) ? "Done " : "Planned ") + esc(fmtDate(s.date))}</div>
      <h2>${esc(s.title)}</h2>
      <div class="meter"><div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div><b>${st.done}/${st.total} sets</b></div>
      ${st.skipped ? `<div class="extra">${st.skipped} exercise${st.skipped > 1 ? "s" : ""} skipped</div>` : ""}
      ${s.summary ? `<div class="status"><strong>Ankle check:</strong> ${esc(s.summary)}</div>` : ""}
      <button class="btn primary big" data-act="guide-start" data-sid="${esc(s.id)}">${st.done ? "Continue guided workout" : "Start guided workout"}</button>
    </section>`;
    // The first unticked step, going block by block and round by round, is "up next".
    let nextKey = null;
    for (const b of s.blocks || []) {
      const act = (b.exercises || []).filter((ex) => ex.status !== "hold" && !exState(s, ex).skipped);
      const rounds = Math.max(0, ...act.map((ex) => ex.sets || 1));
      for (let r = 1; r <= rounds && !nextKey; r++) for (const ex of act) {
        if (r > (ex.sets || 1)) continue;
        if (!exState(s, ex).t.sets || !exState(s, ex).t.sets[r]) { nextKey = ex.id + "#" + r; break; }
      }
      if (nextKey) break;
    }
    for (const b of s.blocks || []) {
      const active = (b.exercises || []).filter((ex) => ex.status !== "hold");
      const circuit = active.length > 1;
      const roundsN = Math.max(0, ...active.map((ex) => ex.sets || 1));
      const lifts = liftHistory();
      html += `<section class="block"><div class="block-head"><span class="letter">${esc(b.key)}</span><h3>${esc(b.name)}</h3>${roundsN ? `<span class="rounds">${roundsN} ${circuit ? "round" : "set"}${roundsN > 1 ? "s" : ""}</span>` : ""}</div>`;
      let setsHtml = "";
      if (active.length) {
        setsHtml += circuit ? `<div class="how">Do one set of each exercise in order, then start the next round. Type the weight in the box to tick it off, or tap the circle. Tap an exercise to change reps.</div>` : `<div class="how">Type the weight in the box to tick off the set, or tap the circle. Tap a set to change reps.</div>`;
        setsHtml += `<div class="round-grid">`;
        for (let r = 1; r <= roundsN; r++) {
          let rows = "", doneInRound = 0, inRound = 0;
          active.forEach((ex, idx) => {
            if (r > (ex.sets || 1)) return;
            const e = exState(s, ex);
            const label = circuit ? b.key + (idx + 1) : String(r);
            if (e.skipped) { rows += `<li class="step skipped"><span class="step-num">${esc(label)}</span><span class="step-name">${esc(ex.name)}</span><span class="step-target">Skipped</span><span class="step-check" aria-hidden="true">–</span></li>`; return; }
            inRound++;
            const info = setInfo(e.t.sets && e.t.sets[r]);
            const on = !!info; if (on) doneInRound++;
            const isNext = nextKey === ex.id + "#" + r;
            const logKey = s.id + "|" + ex.id + "|" + r;
            const L = lifts[liftKey(ex.name)];
            const thisSet = L && L.sets.find((x) => x.session.id === s.id && x.ex.id === ex.id && x.round === r);
            const planned = plannedKg(s, ex, r);
            const logged = info && (info.reps || info.kg) ? `${info.reps ? esc(info.reps) + " reps" : ""}${info.reps && info.kg ? " × " : ""}${info.kg ? esc(info.kg) + " kg" : ""}` : "";
            rows += `<li class="step-row${on ? " on" : ""}${isNext ? " is-next" : ""}">
              <span class="step-num">${esc(label)}</span>
              <button class="step-main" data-act="open-log" data-key="${esc(logKey)}" aria-label="Log reps and weight for ${esc(ex.name)}, ${circuit ? "round" : "set"} ${r}">
                <span class="step-name">${circuit ? esc(ex.name) : "Set " + r}${isNext ? ` <span class="up-next">Up next</span>` : ""}</span>
                <span class="step-log">${info && info.reps ? esc(info.reps) + " reps" : `<span class="step-target-inline">${esc(ex.target || "")}</span>`}${pctFor(ex, r) ? ` · ${Math.round(pctFor(ex, r) * 100)}%` : ""}${thisSet && thisSet.pr ? ` <span class="pr">New best</span>` : ""}</span>
              </button>
              <label class="kg-box${info && info.kg ? " filled" : ""}"><input id="kg-${esc(s.id)}-${esc(ex.id)}-${r}" class="kg-input" type="number" inputmode="decimal" min="0" max="999" step="0.5" value="${info && info.kg ? esc(info.kg) : ""}" placeholder="${esc(planned)}" data-sid="${esc(s.id)}" data-eid="${esc(ex.id)}" data-set="${r}" aria-label="Weight in kg for ${esc(ex.name)}, ${circuit ? "round" : "set"} ${r}"><span>kg</span></label>
              <button class="step-check" data-act="tick" data-sid="${esc(s.id)}" data-eid="${esc(ex.id)}" data-set="${r}" data-planned="${esc(planned)}" aria-pressed="${on}" aria-label="Mark ${esc(ex.name)} ${circuit ? "round" : "set"} ${r} done">${on ? "✓" : ""}</button>
            </li>`;
            if (state.openLog === logKey) {
              const reps = info && info.reps ? info.reps : targetReps(ex);
              const kg = info && info.kg ? info.kg : lastKg(ex);
              rows += `<li class="log-row"><form class="log-form" data-sid="${esc(s.id)}" data-eid="${esc(ex.id)}" data-set="${r}">
                <label>Reps<input id="log-reps" type="number" inputmode="numeric" min="0" max="999" step="1" value="${esc(reps)}"></label>
                <label>Weight (kg)<input id="log-kg" type="number" inputmode="decimal" min="0" max="999" step="0.5" value="${esc(kg)}" placeholder="bodyweight"></label>
                <div class="row">${on ? `<button type="button" class="btn" data-act="clear-log" data-sid="${esc(s.id)}" data-eid="${esc(ex.id)}" data-set="${r}">Untick</button>` : ""}<button type="button" class="btn" data-act="cancel-log">Cancel</button><button type="submit" class="btn primary">Save${on ? "" : " & tick"}</button></div>
              </form></li>`;
            }
          });
          const roundDone = inRound && doneInRound === inRound;
          if (circuit) setsHtml += `<div class="round${roundDone ? " done" : ""}"><div class="round-label">Round ${r}<span>${roundDone ? "Done ✓" : `${doneInRound}/${inRound}`}</span></div><ol>${rows}</ol></div>`;
          else setsHtml += `<div class="round single${roundDone ? " done" : ""}"><ol>${rows}</ol></div>`;
        }
        setsHtml += `</div>`;
      }
      if (setsHtml) html += `<div class="how sub">Exercise details</div>`;
      html += `<div class="exlist">`;
      for (const ex of b.exercises || []) {
        const e = exState(s, ex);
        const t = e.t, n = e.n, doneN = e.done;
        const hold = ex.status === "hold";
        const skipped = !hold && e.skipped;
        const complete = !hold && !skipped && doneN === n;
        const exNotes = state.notes.filter((x) => x.session === s.id && x.ex === ex.id);
        const key = s.id + "|" + ex.id;
        html += `<article class="ex${complete ? " complete" : ""}${hold ? " hold" : ""}${skipped ? " skipped" : ""}">
          <div class="ex-top"><div class="ex-name">${esc(ex.name)}</div><div class="ex-target">${esc(ex.target || "")}</div></div>
          ${(ex.status && chipLabel[ex.status]) || skipped ? `<div class="chips">${ex.status && chipLabel[ex.status] ? `<span class="chip ${esc(ex.status)}">${chipLabel[ex.status]}</span>` : ""}${skipped ? `<span class="chip skip">Skipped</span>` : ""}</div>` : ""}
          ${skipped && e.reason ? `<div class="skip-reason">Why: ${esc(e.reason)}</div>` : ""}
          ${ex.cue ? `<div class="cue">${esc(ex.cue)}</div>` : ""}
          ${ex.extra ? `<div class="extra">${esc(ex.extra)}</div>` : ""}
          ${hold ? "" : liftLine(ex, s.id)}
          <div class="ex-row">
            ${hold ? `<span class="who-ticked">Not this session</span>` : skipped ? `<span class="who-ticked">Skipped by ${esc(nameOf(t.by))} · ${esc(fmtWhen(t.at))}</span>` : `<span class="who-ticked">${doneN}/${n} ${circuit ? "rounds" : "sets"} done</span>`}
            <div class="tools">
              <a class="btn" href="${esc(ytLink(ex))}" target="_blank" rel="noopener">${ytIcon}${ex.video ? "Video" : "Examples"}</a>
              <button class="btn" data-act="open-note" data-key="${esc(key)}">${noteIcon}Note</button>
              ${hold ? "" : skipped ? `<button class="btn" data-act="unskip" data-sid="${esc(s.id)}" data-eid="${esc(ex.id)}">Undo skip</button>` : `<button class="btn" data-act="open-skip" data-key="${esc(key)}">${skipIcon}Skip</button>`}
            </div>
          </div>
          ${state.openSkip === key ? `<div class="composer"><input id="skip-${esc(key)}" class="skip-input" type="text" maxlength="200" placeholder="Why skip? e.g. ankle sore, no box, ran out of time (optional)">
            <div class="row"><button class="btn" data-act="cancel-skip">Cancel</button><button class="btn primary" data-act="save-skip" data-sid="${esc(s.id)}" data-eid="${esc(ex.id)}">Skip exercise</button></div></div>` : ""}
          ${t.by && doneN && !skipped && !circuit ? `<div class="who-ticked">Last ticked by ${esc(nameOf(t.by))} · ${esc(fmtWhen(t.at))}</div>` : ""}
          ${exNotes.length ? `<div class="notes">${exNotes.map((x) => noteHTML(x, false)).join("")}</div>` : ""}
          ${state.openComposer === key ? composerHTML(key) : ""}
        </article>`;
      }
      html += `</div>${setsHtml ? `<div class="how sub">${circuit ? "Rounds" : "Sets"}</div>` + setsHtml : ""}</section>`;
    }
    const fin = state.finishes[s.id];
    const admin = cfg.adminName || "John";
    if (fin) {
      const r = { skipped: (fin.details && fin.details.skipped) || [], partial: (fin.details && fin.details.partial) || [], missed: (fin.details && fin.details.missed) || [] };
      html += `<section class="finish done"><h3>Session finished</h3>
        <div class="extra">${fin.details && fin.details.doneOn ? "Done " + esc(fmtDate(fin.details.doneOn)) + " · " : ""}finished by ${esc(nameOf(fin.by))} · ${esc(fmtWhen(fin.at))}</div>
        <div class="report">${reportListHTML(r)}</div>
        <div><button class="btn" data-act="reopen" data-sid="${esc(s.id)}">Reopen session</button></div></section>`;
    } else if (state.finishing === s.id) {
      const r = sessionReport(s);
      html += `<section class="finish"><h3>Finish this session?</h3>
        <div class="extra">${r.stats.done}/${r.stats.total} sets ticked. ${esc(admin)} gets a summary on his phone.</div>
        <div class="report">${reportListHTML(r)}</div>
        <div class="row"><button class="btn" data-act="cancel-finish">Keep going</button><button class="btn primary" data-act="confirm-finish" data-sid="${esc(s.id)}">Finish session</button></div></section>`;
    } else {
      html += `<section class="finish"><div><button class="btn primary big" data-act="start-finish" data-sid="${esc(s.id)}">Finish session</button></div>
        <div class="extra">Shows what was skipped or not done, then sends ${esc(admin)} a summary.</div></section>`;
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

  function renderRecords() {
    const hist = liftHistory();
    for (const k in state.maxes) if (!hist[k] && state.maxes[k].kg) hist[k] = { name: state.maxes[k].name || k, sets: [], best: null, heaviest: null };
    const lifts = Object.values(hist).sort((a, b) => a.name.localeCompare(b.name));
    let html = `<section class="hero"><div class="eyebrow">Across all sessions</div><h2>Records</h2>
      <div class="extra">Estimated 1RM uses the Epley formula (weight × (1 + reps ÷ 30)) on sets of 12 reps or fewer. It's a guide for choosing weights, not a tested max.</div></section>`;
    if (!lifts.length) return html + `<div class="empty"><strong>No weights logged yet</strong><span>Tap any set during a session to log reps and kg. Each lift's best shows up here.</span></div>`;
    html += `<div class="records">`;
    for (const L of lifts) {
      const recent = L.sets.slice().reverse().slice(0, 6);
      html += `<article class="record">
        <div class="record-top"><div class="ex-name">${esc(L.name)}</div>${(() => { const m = state.maxes[liftKey(L.name)]; return m && m.kg ? `<div class="record-1rm"><span>1RM</span>${esc(m.kg)} kg</div>` : L.best ? `<div class="record-1rm"><span>est. 1RM</span>${round1(L.best.e1rm)} kg</div>` : ""; })()}</div>
        <div class="extra">${L.best ? `Best set ${L.best.reps} × ${L.best.kg} kg on ${esc(fmtDate(localDay(L.best.at)))}` : ""}${L.best && L.heaviest ? " · " : ""}${L.heaviest ? `Heaviest ${L.heaviest.kg} kg` : ""}</div>
        <table class="hist"><thead><tr><th>Date</th><th>Set</th><th>Reps × kg</th><th>est. 1RM</th></tr></thead><tbody>
        ${recent.map((x) => `<tr${x.pr ? ' class="pr-row"' : ""}><td>${esc(x.at ? fmtDate(localDay(x.at)) : "")}</td><td>${esc(x.session.short || "")} #${x.round}</td><td>${x.reps || "–"} × ${x.kg}</td><td>${x.e1rm ? round1(x.e1rm) + (x.pr ? " ★" : "") : "–"}</td></tr>`).join("")}
        </tbody></table></article>`;
    }
    return html + `</div>`;
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
    const ae = document.activeElement;
    const keepInput = ae && ae.classList && ae.classList.contains("kg-input") ? { id: ae.id, val: ae.value } : null;

    const view = currentView();
    renderTabs(view);
    renderWho();
    let html;
    if (state.error) html = `<div class="empty"><strong>Something went wrong</strong><span>${esc(state.error)}</span></div>`;
    else if (!state.me) html = renderLogin();
    else if (!state.loaded) html = `<div class="hero"><div class="eyebrow">Loading sessions</div><h2>Getting today's work ready…</h2></div><div class="skeleton"></div><div class="skeleton"></div>`;
    else if (view.kind === "notes") html = renderNotes();
    else if (view.kind === "records") html = renderRecords();
    else if (view.kind === "session") html = renderSession(state.sessions.find((s) => s.id === view.id));
    else html = `<div class="empty"><strong>No sessions yet</strong><span>Add a session file to the sessions folder and it appears here.</span></div>`;
    app.innerHTML = html;

    if (keepInput) {
      const el = document.getElementById(keepInput.id);
      if (el) { el.value = keepInput.val; el.focus(); }
    }
    if (keep) {
      const el = document.getElementById("note-" + state.openComposer);
      if (el) { el.value = keep.val; if (keep.focused) { el.focus(); try { el.setSelectionRange(keep.pos, keep.pos); } catch (e) {} } }
    }
  }

  async function persistTick(sid, eid, patch) {
    const id = tickId(sid, eid);
    const prev = state.ticks[id] || { sets: {} };
    const next = Object.assign({ session: sid, ex: eid, sets: {}, skipped: false, skipReason: "" }, prev, patch, { by: state.me, at: new Date().toISOString() });
    state.ticks[id] = next; scheduleRender();
    try { await store.saveTick(sid, eid, next); } catch (e) { state.ticks[id] = prev; scheduleRender(); writeFailed(e); }
  }
  function findEx(sid, eid) {
    const s = state.sessions.find((x) => x.id === sid);
    if (s) for (const b of s.blocks) for (const ex of b.exercises) if (ex.id === eid) return ex;
    return null;
  }
  // Typing a weight saves it and ticks the set.
  app.addEventListener("change", async (ev) => {
    const el = ev.target;
    if (!el.classList || !el.classList.contains("kg-input")) return;
    const { sid, eid } = el.dataset; const set = +el.dataset.set;
    const kg = parseFloat(el.value);
    const prev = state.ticks[tickId(sid, eid)] || {};
    const sets = Object.assign({}, prev.sets || {});
    const old = setInfo(sets[set]) || {};
    if (kg > 0) {
      const ex = findEx(sid, eid);
      sets[set] = Object.assign({}, old, { at: old.at || new Date().toISOString(), kg });
      if (!sets[set].reps && ex && targetReps(ex)) sets[set].reps = targetReps(ex);
    } else if (sets[set]) {
      const copy = Object.assign({}, old); delete copy.kg; sets[set] = copy;
    } else return;
    await persistTick(sid, eid, { sets });
  });
  app.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && ev.target.classList && ev.target.classList.contains("kg-input")) ev.target.blur();
  });

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
    if (ev.target.classList.contains("guide-form")) {
      ev.preventDefault();
      const f = ev.target; const { sid, eid } = f.dataset; const set = +f.dataset.set;
      const reps = parseInt($("#guide-reps").value, 10); const kg = parseFloat($("#guide-kg").value);
      const prev = state.ticks[tickId(sid, eid)] || {};
      const old = setInfo((prev.sets || {})[set]);
      const sets = Object.assign({}, prev.sets || {});
      sets[set] = { at: (old && old.at) || new Date().toISOString() };
      if (reps > 0) sets[set].reps = reps;
      if (kg > 0) sets[set].kg = kg;
      // move on first so the next screen appears straight away
      const s = state.sessions.find((x) => x.id === sid); const steps = guideSteps(s);
      const i = steps.findIndex((x) => x.key === state.guide.key);
      state.guide.key = steps[i + 1] ? steps[i + 1].key : "end"; state.openComposer = null; state.openSkip = null; state.openMax = null;
      window.scrollTo(0, 0);
      await persistTick(sid, eid, { sets });
      return;
    }
    if (ev.target.classList.contains("max-form")) {
      ev.preventDefault();
      const f = ev.target; const k = f.dataset.lift;
      const kg = parseFloat($("#max-kg").value); const on = $("#max-on").value || null;
      if (!(kg > 0)) return;
      const keep = state.maxes[k];
      state.maxes[k] = { lift: k, name: f.dataset.name, kg, on, by: state.me };
      state.openMax = null; render();
      try { await store.saveMax(k, f.dataset.name, kg, on); } catch (e) { if (keep) state.maxes[k] = keep; else delete state.maxes[k]; render(); writeFailed(e); }
      return;
    }
    if (ev.target.classList.contains("log-form")) {
      ev.preventDefault();
      const f = ev.target; const { sid, eid } = f.dataset; const set = +f.dataset.set;
      const reps = parseInt($("#log-reps").value, 10);
      const kg = parseFloat($("#log-kg").value);
      const prev = state.ticks[tickId(sid, eid)] || {};
      const old = setInfo((prev.sets || {})[set]);
      const sets = Object.assign({}, prev.sets || {});
      sets[set] = { at: (old && old.at) || new Date().toISOString() };
      if (reps > 0) sets[set].reps = reps;
      if (kg > 0) sets[set].kg = kg;
      state.openLog = null;
      const id = tickId(sid, eid);
      const next = Object.assign({ session: sid, ex: eid, sets: {}, skipped: false, skipReason: "" }, prev, { sets, by: state.me, at: new Date().toISOString() });
      state.ticks[id] = next; scheduleRender();
      try { await store.saveTick(sid, eid, next); } catch (e) { state.ticks[id] = prev; scheduleRender(); writeFailed(e); }
      return;
    }
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

    const saveTick = persistTick;
    if (act === "tick") {
      const { sid, eid } = btn.dataset; const set = +btn.dataset.set;
      const prev = state.ticks[tickId(sid, eid)] || {};
      const sets = Object.assign({}, prev.sets || {});
      if (sets[set]) delete sets[set];
      else {
        sets[set] = { at: new Date().toISOString() };
        const ex = findEx(sid, eid);
        const planned = parseFloat(btn.dataset.planned);
        if (planned > 0) sets[set].kg = planned;
        if (ex && targetReps(ex)) sets[set].reps = targetReps(ex);
      }
      await saveTick(sid, eid, { sets });
    } else if (act === "open-max") {
      state.openMax = state.openMax === btn.dataset.key ? null : btn.dataset.key; render();
      const el = document.getElementById("max-kg"); if (el) el.focus();
    } else if (act === "cancel-max") {
      state.openMax = null; render();
    } else if (act === "clear-max") {
      const k = btn.dataset.lift; const keep = state.maxes[k];
      delete state.maxes[k]; state.openMax = null; render();
      try { await store.deleteMax(k); } catch (e) { state.maxes[k] = keep; render(); writeFailed(e); }
    } else if (act === "open-log") {
      state.openLog = state.openLog === btn.dataset.key ? null : btn.dataset.key; render();
      const el = document.getElementById("log-kg"); if (el && !el.value) el.focus();
    } else if (act === "cancel-log") {
      state.openLog = null; render();
    } else if (act === "clear-log") {
      const { sid, eid } = btn.dataset; const set = +btn.dataset.set;
      const prev = state.ticks[tickId(sid, eid)] || {};
      const sets = Object.assign({}, prev.sets || {}); delete sets[set];
      state.openLog = null;
      await saveTick(sid, eid, { sets });
    } else if (act === "guide-start") {
      const s = state.sessions.find((x) => x.id === btn.dataset.sid); if (!s) return;
      const steps = guideSteps(s); const first = steps.find((x) => !stepDone(s, x));
      state.guide = { sid: s.id, key: first ? first.key : "end" }; state.openComposer = null; state.openSkip = null;
      render(); window.scrollTo(0, 0);
    } else if (act === "guide-exit") {
      state.guide = null; render(); window.scrollTo(0, 0);
    } else if (act === "guide-prev" || act === "guide-next") {
      const s = state.sessions.find((x) => x.id === state.guide.sid); const steps = guideSteps(s);
      let i = steps.findIndex((x) => x.key === state.guide.key); if (i < 0) i = steps.length;
      i = act === "guide-prev" ? Math.max(0, i - 1) : i + 1;
      state.guide.key = steps[i] ? steps[i].key : "end"; state.openComposer = null; state.openSkip = null; state.openMax = null;
      render(); window.scrollTo(0, 0);
    } else if (act === "guide-finish") {
      state.guide = null; state.finishing = btn.dataset.sid; render();
      const f = document.querySelector(".finish"); if (f) f.scrollIntoView({ block: "center" });
    } else if (act === "guide-untick") {
      const f = btn.closest("form"); const { sid, eid } = f.dataset; const set = +f.dataset.set;
      const prev = state.ticks[tickId(sid, eid)] || {};
      const sets = Object.assign({}, prev.sets || {}); delete sets[set];
      await saveTick(sid, eid, { sets });
    } else if (act === "bump") {
      const el = document.getElementById(btn.dataset.field); if (!el) return;
      const v = (parseFloat(el.value) || 0) + parseFloat(btn.dataset.delta);
      el.value = Math.max(0, Math.round(v * 2) / 2);
    } else if (act === "open-skip") {
      state.openSkip = btn.dataset.key; render();
      const el = document.getElementById("skip-" + state.openSkip); if (el) el.focus();
    } else if (act === "cancel-skip") {
      state.openSkip = null; render();
    } else if (act === "save-skip") {
      const { sid, eid } = btn.dataset;
      const el = document.getElementById("skip-" + sid + "|" + eid);
      const reason = ((el && el.value) || "").trim();
      state.openSkip = null;
      await saveTick(sid, eid, { skipped: true, skipReason: reason });
    } else if (act === "unskip") {
      await saveTick(btn.dataset.sid, btn.dataset.eid, { skipped: false, skipReason: "" });
    } else if (act === "start-finish") {
      state.finishing = btn.dataset.sid; render();
      const f = document.querySelector(".finish"); if (f) f.scrollIntoView({ block: "center" });
    } else if (act === "cancel-finish") {
      state.finishing = null; render();
    } else if (act === "confirm-finish") {
      const sid = btn.dataset.sid; const s = state.sessions.find((x) => x.id === sid); if (!s) return;
      const r = sessionReport(s);
      const details = { done: r.stats.done, total: r.stats.total, doneOn: r.doneOn, skipped: r.skipped, partial: r.partial, missed: r.missed };
      btn.disabled = true;
      try {
        await store.finishSession(sid, r.text, details);
        state.finishes[sid] = { session: sid, by: state.me, at: new Date().toISOString(), summary: r.text, details };
        state.finishing = null; render();
      } catch (e) { btn.disabled = false; writeFailed(e); }
    } else if (act === "reopen") {
      const sid = btn.dataset.sid; const keep = state.finishes[sid];
      delete state.finishes[sid]; render();
      try { await store.reopenSession(sid); } catch (e) { state.finishes[sid] = keep; render(); writeFailed(e); }
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

  window.addEventListener("hashchange", () => { state.openComposer = null; state.openSkip = null; state.finishing = null; state.openLog = null; state.openMax = null; state.guide = null; render(); window.scrollTo(0, 0); });

  async function loadSessions() {
    const idx = await fetch("sessions/index.json", { cache: "no-cache" }).then((r) => r.json());
    const list = await Promise.all(idx.sessions.map((f) => fetch("sessions/" + f, { cache: "no-cache" }).then((r) => r.json())));
    return list.sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  async function enter(email) {
    state.me = email; state.loaded = false; render();
    try {
      await store.start((data) => {
        state.ticks = data.ticks; state.notes = data.notes; state.finishes = data.finishes || {}; state.maxes = data.maxes || {};
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
