// Rehab gym bookings for the trainer console (supabase/014_bookings.sql).
//   #bookings / #bookings-YYYY-MM-DD   week calendar of gym sessions, people shown in their colour
//   #booking-<id>                      one session: who's booked, book someone in, walk-ins, attendance
// Trainers create and change sessions and set group colours. Coaches (role "coach") see the same
// calendar and book people in, but can't change sessions or anything else in the console.
// console.js calls in through create(ctx); everything bookings-related lives here.
(function () {
  const KINDS = { rehab: "Rehab supervised", open_gym: "Open gym" };
  const STATUS = { booked: "Booked", attended: "Came", no_show: "No-show", cancelled: "Cancelled" };
  const LIVE = (b) => b.status === "booked" || b.status === "attended";
  const PALETTE = ["#2d5fa8", "#1f8a5b", "#d9481c", "#9a6400", "#7b3fa8", "#0f8a8a", "#c2306b", "#5b6876"];

  function create(ctx) {
    const { sb, state, esc } = ctx;
    const bk = state.bk = { ready: null, slots: [], bookings: [], colours: [], from: null, to: null, kind: "", newSlot: false, editing: false, adding: "" };
    const isTrainer = () => state.role === "trainer";

    // ─── dates (local time: the gym's clock) ──────────────────────────────────────────────
    const pad = (n) => String(n).padStart(2, "0");
    const isoDay = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    const atNoon = (iso) => new Date(iso + "T12:00:00");
    function addDays(iso, n) { const d = atNoon(iso); d.setDate(d.getDate() + n); return isoDay(d); }
    function mondayOf(iso) { const d = atNoon(iso); return addDays(iso, -((d.getDay() + 6) % 7)); }
    const today = () => isoDay(new Date());
    const dayOf = (ts) => isoDay(new Date(ts));
    const hm = (ts) => { const d = new Date(ts); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
    const timeLabel = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const dayLabel = (iso, opts) => atNoon(iso).toLocaleDateString(undefined, opts || { weekday: "short", day: "numeric", month: "short" });
    const local = (date, time) => new Date(date + "T" + time).toISOString();

    // ─── data ─────────────────────────────────────────────────────────────────────────────
    // Sessions from 8 weeks back to 26 weeks ahead, widened to take in whichever week is open.
    function range() {
      const v = view((location.hash || "").slice(1));
      const wk = v && v.kind === "bookings" && v.week ? mondayOf(v.week) : mondayOf(today());
      let from = addDays(mondayOf(today()), -56), to = addDays(mondayOf(today()), 182);
      if (wk < from) from = wk;
      if (addDays(wk, 7) > to) to = addDays(wk, 7);
      return [from, to];
    }
    async function load() {
      const [from, to] = range();
      const fromTs = local(from, "00:00"), toTs = local(to, "00:00");
      const [s, b, c] = await Promise.all([
        sb.from("gym_slots").select("*").gte("starts_at", fromTs).lt("starts_at", toTs).order("starts_at"),
        sb.from("bookings").select("*, gym_slots!inner(starts_at)").gte("gym_slots.starts_at", fromTs).lt("gym_slots.starts_at", toTs).order("created_at"),
        sb.from("group_colours").select("*").order("sort"),
      ]);
      if (s.error) { bk.ready = false; bk.slots = []; bk.bookings = []; bk.colours = []; return; }
      Object.assign(bk, { ready: true, from, to, slots: s.data, bookings: (b.data || []).map((r) => { delete r.gym_slots; return r; }), colours: c.data || [] });
    }
    function inRange(week) { return !bk.from || (week >= bk.from && addDays(week, 7) <= bk.to); }

    // ─── colours ──────────────────────────────────────────────────────────────────────────
    function memberOf(email) { return state.members.find((m) => m.email === email) || null; }
    function colourOf(email) {
      const m = memberOf(email); if (!m) return null;
      for (const g of m.groups || []) { const c = bk.colours.find((x) => x.name === g); if (c) return c; }
      return null;
    }
    function personName(b) { return b.member_email ? ctx.nameOf(b.member_email) : b.guest_name || "Guest"; }
    function personChip(b, { full = false } = {}) {
      const c = b.member_email ? colourOf(b.member_email) : null;
      const style = c ? ` style="--pc:${esc(c.colour)}"` : "";
      return `<span class="pc${c ? "" : b.member_email ? " none" : " guest"}${b.status === "attended" ? " came" : ""}"${style} title="${esc(personName(b))}${c ? " · " + esc(c.name) : b.member_email ? "" : " · walk-in guest"}${b.status === "attended" ? " · came" : ""}"><i></i>${esc(personName(b))}${full && c ? ` <span class="pc-g">${esc(c.name)}</span>` : ""}</span>`;
    }
    function legendHTML() {
      if (!bk.colours.length) return "";
      return `<div class="pc-legend">${bk.colours.map((c) => `<span class="pc" style="--pc:${esc(c.colour)}"><i></i>${esc(c.name)}</span>`).join("")}<span class="pc none"><i></i>No group colour</span><span class="pc guest"><i></i>Walk-in guest</span></div>`;
    }
    function coloursHTML() {
      const groups = [...new Set(ctx.allGroups().concat(bk.colours.map((c) => c.name)))].sort((a, b) => a.localeCompare(b));
      if (!groups.length) return `<section class="card"><h3>Colours</h3><div class="extra">Put people in groups (Athletes → Edit → Groups, e.g. "Knee rehab", "Shoulder rehab", "Morning crew"), then give each group a colour here.</div></section>`;
      return `<section class="card"><div class="card-head"><h3>Colours</h3><span class="extra">Each person shows in the colour of their first group that has one.</span></div>
        <form id="bk-colours" class="bk-colours">${groups.map((g, i) => {
          const c = bk.colours.find((x) => x.name === g);
          return `<label class="bk-colour"><input type="checkbox" name="use" value="${esc(g)}" ${c ? "checked" : ""}><input type="color" name="c:${esc(g)}" value="${esc(c ? c.colour : PALETTE[i % PALETTE.length])}" aria-label="Colour for ${esc(g)}"><span>${esc(g)}</span></label>`;
        }).join("")}<div class="row"><button class="btn primary">Save colours</button></div></form></section>`;
    }

    // ─── views ────────────────────────────────────────────────────────────────────────────
    function view(h) {
      if (h === "bookings") return { kind: "bookings", week: null };
      if (/^bookings-\d{4}-\d{2}-\d{2}$/.test(h)) return { kind: "bookings", week: h.slice(9) };
      if (/^booking-[0-9a-f-]{36}$/.test(h)) return { kind: "booking", id: h.slice(8) };
      return null;
    }
    const slotBookings = (id) => bk.bookings.filter((b) => b.slot_id === id);
    const taken = (id) => slotBookings(id).filter(LIVE).length;
    function spotsText(s) {
      if (s.cancelled) return "Cancelled";
      const n = taken(s.id), left = s.capacity - n;
      return `${n}/${s.capacity}` + (left > 0 ? ` · ${left} left` : left === 0 ? " · full" : ` · ${-left} over`);
    }
    const kindChip = (k) => `<span class="chip kind-${esc(k)}">${esc(KINDS[k] || k)}</span>`;
    function staffOptions(selected) {
      const staff = state.members.filter((m) => (m.role === "trainer" || m.role === "coach") && m.active);
      return `<option value="">Nobody set</option>` + staff.map((m) => `<option value="${esc(m.email)}" ${m.email === selected ? "selected" : ""}>${esc(m.display_name || m.email)}</option>`).join("");
    }

    function needsMigration() {
      return `<section class="hero"><div class="eyebrow">Rehab gym</div><h2>Bookings</h2></section>
        <div class="empty"><strong>One database step first</strong><span>Run <code>supabase/014_bookings.sql</code> in Supabase → SQL Editor, then reload this page.</span></div>`;
    }

    function slotFormHTML(s) {
      const d = s ? dayOf(s.starts_at) : (bk.newDate || today());
      return `<form class="inline-form" id="${s ? "bk-slot-edit" : "bk-slot-add"}" ${s ? `data-id="${esc(s.id)}"` : ""}>
        <label>Date<input type="date" name="date" value="${esc(d)}" required></label>
        <label>Starts<input type="time" name="start" value="${esc(s ? hm(s.starts_at) : "09:00")}" required step="300"></label>
        <label>Ends<input type="time" name="end" value="${esc(s ? hm(s.ends_at) : "10:00")}" required step="300"></label>
        <label>Type<select name="kind">${Object.entries(KINDS).map(([k, l]) => `<option value="${k}" ${(s ? s.kind : "rehab") === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>People limit<input type="number" name="capacity" min="1" max="200" value="${esc(s ? s.capacity : 8)}" required></label>
        <label>Supervised by<select name="coach">${staffOptions(s ? s.coach_email : "")}</select></label>
        <label class="wide">Name (optional)<input name="title" maxlength="120" value="${esc(s ? s.title || "" : "")}" placeholder="e.g. Knee rehab group"></label>
        ${s ? `<label class="check"><input type="checkbox" name="cancelled" ${s.cancelled ? "checked" : ""}> Session cancelled</label>`
            : `<label>Repeat weekly<select name="repeat">${[1, 2, 4, 6, 8, 10, 12, 26].map((n) => `<option value="${n}">${n === 1 ? "Just once" : n + " weeks"}</option>`).join("")}</select></label>`}
        <label class="full">Notes (optional)<input name="notes" maxlength="500" value="${esc(s ? s.notes || "" : "")}" placeholder="Shown to athletes when they book"></label>
        <div class="row"><button type="button" class="btn" data-act="${s ? "bk-edit" : "bk-new"}">Cancel</button><button class="btn primary">${s ? "Save" : "Add session"}</button></div></form>`;
    }

    function renderWeek(v) {
      if (bk.ready === false) return needsMigration();
      const wk = mondayOf(v.week || today()), days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(wk, i));
      if (!inRange(wk)) { ctx.reload(); }
      const slots = bk.slots.filter((s) => (!bk.kind || s.kind === bk.kind) && dayOf(s.starts_at) >= days[0] && dayOf(s.starts_at) <= days[6]);
      const week = bk.slots.filter((s) => dayOf(s.starts_at) >= days[0] && dayOf(s.starts_at) <= days[6] && !s.cancelled);
      const booked = week.reduce((n, s) => n + taken(s.id), 0), cap = week.reduce((n, s) => n + s.capacity, 0);
      let html = `<section class="hero"><div class="eyebrow">Rehab gym · week of ${esc(dayLabel(wk, { day: "numeric", month: "long" }))}</div><h2>Bookings</h2>
        <div class="toolbar">
          <a class="btn" href="#bookings-${addDays(wk, -7)}" aria-label="Previous week">‹ Prev</a>
          <a class="btn" href="#bookings">This week</a>
          <a class="btn" href="#bookings-${addDays(wk, 7)}" aria-label="Next week">Next ›</a>
          <span class="filter">${[["", "All"], ["rehab", KINDS.rehab], ["open_gym", KINDS.open_gym]].map(([k, l]) => `<button class="btn" data-act="bk-kind" data-k="${k}" aria-pressed="${bk.kind === k}">${l}</button>`).join(" ")}</span>
          <span class="spacer"></span>
          ${isTrainer() ? `<button class="btn primary" data-act="bk-new">New session</button>` : ""}
        </div>
        <div class="extra">${week.length ? `${week.length} session${week.length > 1 ? "s" : ""} · ${booked} of ${cap} spots booked` : "No sessions this week yet."}</div></section>`;
      if (bk.newSlot && isTrainer()) html += `<section class="card" id="bk-new-card"><h3>New session</h3>${slotFormHTML(null)}</section>`;
      html += legendHTML();
      html += `<div class="bk-week">${days.map((d) => {
        const list = slots.filter((s) => dayOf(s.starts_at) === d);
        return `<div class="bk-day${d === today() ? " today" : ""}${d < today() ? " past" : ""}"><div class="bk-day-h"><b>${esc(dayLabel(d, { weekday: "short" }))}</b> ${esc(dayLabel(d, { day: "numeric", month: "short" }))}
          ${isTrainer() ? `<button class="bk-add" data-act="bk-new" data-date="${d}" aria-label="Add a session on ${esc(dayLabel(d))}" title="Add a session">+</button>` : ""}</div>
          ${list.map(slotCard).join("") || `<div class="bk-none">–</div>`}</div>`;
      }).join("")}</div>`;
      if (isTrainer()) html += coloursHTML();
      return html;
    }
    function slotCard(s) {
      const people = slotBookings(s.id).filter(LIVE);
      const n = people.length, pct = Math.min(100, Math.round((n / s.capacity) * 100));
      return `<a class="bk-slot kind-${esc(s.kind)}${s.cancelled ? " cancelled" : ""}${n >= s.capacity ? " full" : ""}" href="#booking-${esc(s.id)}">
        <div class="bk-time">${esc(timeLabel(s.starts_at))}–${esc(timeLabel(s.ends_at))}</div>
        <div class="bk-kind">${esc(s.title || KINDS[s.kind])}</div>
        <div class="bk-spots"><span class="bk-meter"><i style="width:${pct}%"></i></span>${esc(spotsText(s))}</div>
        ${people.length ? `<div class="bk-people">${people.map((b) => personChip(b)).join("")}</div>` : ""}</a>`;
    }

    function renderSlot(v) {
      if (bk.ready === false) return needsMigration();
      const s = bk.slots.find((x) => x.id === v.id);
      if (!s) return `<div class="empty"><strong>Session not found</strong><span>It may have been deleted. <a href="#bookings">Back to bookings</a></span></div>`;
      const rows = slotBookings(s.id).slice().sort((a, b) => (LIVE(b) - LIVE(a)) || personName(a).localeCompare(personName(b)));
      const n = taken(s.id), d = dayOf(s.starts_at), past = new Date(s.ends_at) < new Date();
      const coach = s.coach_email ? ctx.nameOf(s.coach_email) : null;
      let html = `<section class="hero"><div class="eyebrow"><a href="#bookings-${mondayOf(d)}">Bookings</a> · ${esc(dayLabel(d, { weekday: "long", day: "numeric", month: "long" }))}</div>
        <h2>${esc(timeLabel(s.starts_at))}–${esc(timeLabel(s.ends_at))} ${esc(s.title || KINDS[s.kind])}</h2>
        <div class="toolbar">${kindChip(s.kind)} ${s.cancelled ? `<span class="chip hold">Cancelled</span>` : ""}<b>${esc(spotsText(s))}</b>${coach ? `<span class="extra">Supervised by ${esc(coach)}</span>` : ""}
          <span class="spacer"></span>${isTrainer() ? `<button class="btn" data-act="bk-edit">${bk.editing ? "Close" : "Edit session"}</button>
          <button class="btn danger" data-act="bk-del" data-id="${esc(s.id)}">${state.confirm === "bk-del-" + s.id ? "Really delete?" : "Delete"}</button>` : ""}</div>
        ${s.notes ? `<div class="extra">${esc(s.notes)}</div>` : ""}</section>`;
      if (bk.editing && isTrainer()) {
        html += `<section class="card"><h3>Edit session</h3>${slotFormHTML(s)}
          ${s.series_id && bk.slots.filter((x) => x.series_id === s.series_id && x.starts_at > s.starts_at).length ? `<div class="row"><button class="btn danger" data-act="bk-del-series" data-id="${esc(s.id)}">${state.confirm === "bk-del-series-" + s.id ? "Really delete this and every later one?" : "Delete this and later weekly repeats"}</button></div>` : ""}</section>`;
      }
      // Book someone in
      if (!s.cancelled) {
        const already = new Set(rows.filter((b) => b.member_email && b.status !== "cancelled").map((b) => b.member_email));
        const people = state.members.filter((m) => m.active && !already.has(m.email)).sort((a, b) => (a.display_name || a.email).localeCompare(b.display_name || b.email));
        const full = n >= s.capacity;
        html += `<section class="card"><div class="card-head"><h3>Book someone in</h3>${full ? `<span class="chip swap">Full: this goes over the limit of ${s.capacity}</span>` : ""}</div>
          <form class="inline-form" id="bk-book" data-id="${esc(s.id)}">
            <label class="wide">Member<select name="member"><option value="">Choose a person…</option>${people.map((m) => {
              const c = colourOf(m.email);
              return `<option value="${esc(m.email)}">${esc(m.display_name || m.email)}${c ? " · " + esc(c.name) : ""}${m.role !== "athlete" ? " (" + esc(m.role) + ")" : ""}</option>`;
            }).join("")}</select></label>
            <label class="wide">…or a walk-in who isn't a member<input name="guest" maxlength="80" placeholder="Their name"></label>
            <label class="check"><input type="checkbox" name="walkin" ${past || d === today() ? "checked" : ""}> They're here now (mark as came)</label>
            <div class="row"><button class="btn primary">Book in</button></div></form></section>`;
      }
      html += `<div class="card table-card"><h3>People (${n})</h3>${rows.length ? `<table class="grid"><thead><tr><th>Person</th><th>Status</th><th>Booked</th><th></th></tr></thead><tbody>${rows.map((b) => `
        <tr class="${b.status === "cancelled" ? "inactive" : ""}">
          <td data-l="Person">${personChip(b, { full: true })}${b.walk_in ? ` <span class="chip new">walk-in</span>` : ""}</td>
          <td data-l="Status"><span class="chip ${b.status === "attended" ? "back" : b.status === "no_show" ? "swap" : b.status === "cancelled" ? "hold" : "info"}">${STATUS[b.status]}</span></td>
          <td data-l="Booked" class="extra">${esc(new Date(b.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short" }))}${b.booked_by_email && b.booked_by_email !== b.member_email ? " by " + esc(ctx.nameOf(b.booked_by_email)) : ""}</td>
          <td class="actions">${b.status === "cancelled"
            ? `<button class="btn" data-act="bk-status" data-id="${esc(b.id)}" data-s="booked">Re-book</button>`
            : `${b.status !== "attended" ? `<button class="btn" data-act="bk-status" data-id="${esc(b.id)}" data-s="attended">Came</button>` : ""}
               ${b.status !== "no_show" ? `<button class="btn" data-act="bk-status" data-id="${esc(b.id)}" data-s="no_show">No-show</button>` : ""}
               ${b.status !== "booked" ? `<button class="btn" data-act="bk-status" data-id="${esc(b.id)}" data-s="booked">Booked</button>` : ""}
               <button class="btn danger" data-act="bk-status" data-id="${esc(b.id)}" data-s="cancelled">Cancel</button>`}</td></tr>`).join("")}</tbody></table>`
        : `<div class="extra" style="padding:0 16px 14px">Nobody booked yet.</div>`}</div>`;
      return html;
    }

    function render(v) { return v.kind === "booking" ? renderSlot(v) : renderWeek(v); }

    // ─── actions ──────────────────────────────────────────────────────────────────────────
    const val = (f, n) => (f.elements[n] ? f.elements[n].value.trim() : "");
    function slotRow(f) {
      const date = val(f, "date"), start = val(f, "start"), end = val(f, "end");
      if (!date || !start || !end) return null;
      if (end <= start) { ctx.flash("The session has to end after it starts."); return null; }
      return { date, start, end, row: { kind: val(f, "kind"), capacity: Number(val(f, "capacity")) || 8, coach_email: val(f, "coach") || null, title: val(f, "title") || null, notes: val(f, "notes") || null } };
    }

    async function submit(f) {
      if (f.id === "bk-slot-add") {
        const x = slotRow(f); if (!x) return true;
        const n = Math.max(1, Number(val(f, "repeat")) || 1), series = n > 1 ? (crypto.randomUUID ? crypto.randomUUID() : null) : null;
        const rows = [];
        for (let i = 0; i < n; i++) {
          const d = addDays(x.date, i * 7);
          rows.push(Object.assign({ starts_at: local(d, x.start), ends_at: local(d, x.end), series_id: series, created_by_email: state.me }, x.row));
        }
        if (await ctx.run(sb.from("gym_slots").insert(rows),n > 1 ? `Added ${n} weekly sessions.` : "Session added.")) {
          bk.newSlot = false; location.hash = "bookings-" + mondayOf(x.date);
        }
        return true;
      }
      if (f.id === "bk-slot-edit") {
        const x = slotRow(f); if (!x) return true;
        const upd = Object.assign({ starts_at: local(x.date, x.start), ends_at: local(x.date, x.end), cancelled: !!(f.elements.cancelled && f.elements.cancelled.checked), updated_at: new Date().toISOString() }, x.row);
        if (await ctx.run(sb.from("gym_slots").update(upd).eq("id", f.dataset.id), "Session saved.")) { bk.editing = false; ctx.render(); }
        return true;
      }
      if (f.id === "bk-book") {
        const member = val(f, "member"), guest = val(f, "guest"), here = !!(f.elements.walkin && f.elements.walkin.checked);
        if (!member && !guest) { ctx.flash("Choose a member or type a walk-in's name."); return true; }
        if (member && guest) { ctx.flash("Pick a member or type a walk-in's name, not both."); return true; }
        const row = { slot_id: f.dataset.id, member_email: member || null, guest_name: member ? null : guest, walk_in: !member || here, status: here ? "attended" : "booked", booked_by_email: state.me };
        // A cancelled booking for the same person comes back instead of adding a second row.
        const old = member && bk.bookings.find((b) => b.slot_id === f.dataset.id && b.member_email === member && b.status === "cancelled");
        const q = old ? sb.from("bookings").update({ status: row.status, walk_in: row.walk_in, booked_by_email: state.me }).eq("id", old.id) : sb.from("bookings").insert(row);
        await ctx.run(q, (member ? ctx.nameOf(member) : guest) + (here ? " is in." : " is booked in."));
        return true;
      }
      if (f.id === "bk-colours") {
        const use = [...f.querySelectorAll("input[name=use]")];
        const keep = use.filter((i) => i.checked).map((i, n) => ({ name: i.value, colour: f.elements["c:" + i.value].value, sort: n }));
        const drop = use.filter((i) => !i.checked && bk.colours.some((c) => c.name === i.value)).map((i) => i.value);
        if (drop.length) { const r = await sb.from("group_colours").delete().in("name", drop); if (r.error) { ctx.failed(r.error); return true; } }
        await ctx.run(keep.length ? sb.from("group_colours").upsert(keep, { onConflict: "name" }) : Promise.resolve({}), "Colours saved.");
        return true;
      }
      return false;
    }

    async function click(act, btn) {
      if (!act.startsWith("bk-")) return false;
      const id = btn.dataset.id;
      if (act === "bk-kind") { bk.kind = btn.dataset.k || ""; ctx.render(); }
      else if (act === "bk-new") {
        bk.newDate = btn.dataset.date || null; bk.newSlot = btn.dataset.date ? true : !bk.newSlot; ctx.render();
        const c = document.getElementById("bk-new-card"); if (c) c.scrollIntoView({ block: "start", behavior: "smooth" });
      }
      else if (act === "bk-edit") { bk.editing = !bk.editing; ctx.render(); }
      else if (act === "bk-status") {
        const b = bk.bookings.find((x) => x.id === id); if (!b) return true;
        await ctx.run(sb.from("bookings").update({ status: btn.dataset.s }).eq("id", id), `${personName(b)}: ${STATUS[btn.dataset.s].toLowerCase()}.`);
      }
      else if (act === "bk-del") {
        if (!ctx.armed("bk-del-" + id)) return true;
        const s = bk.slots.find((x) => x.id === id);
        if (await ctx.run(sb.from("gym_slots").delete().eq("id", id), "Session and its bookings deleted.")) location.hash = "bookings-" + mondayOf(s ? dayOf(s.starts_at) : today());
      }
      else if (act === "bk-del-series") {
        if (!ctx.armed("bk-del-series-" + id)) return true;
        const s = bk.slots.find((x) => x.id === id); if (!s) return true;
        if (await ctx.run(sb.from("gym_slots").delete().eq("series_id", s.series_id).gte("starts_at", s.starts_at), "Deleted this session and the later repeats.")) location.hash = "bookings-" + mondayOf(dayOf(s.starts_at));
      }
      return true;
    }

    function hashChanged() { bk.editing = false; bk.newSlot = false; }

    return { view, render, load, submit, click, hashChanged, tables: ["gym_slots", "bookings", "group_colours"] };
  }

  window.ConsoleBookings = { create };
})();
