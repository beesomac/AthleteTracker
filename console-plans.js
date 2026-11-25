// Console → Plans: the memberships people can buy, and who is on which plan.
// Plans are saved through the "billing" edge function so the Stripe product and price match.
// Needs supabase/015_profile_billing.sql; before that the tab says so and nothing else changes.
(function () {
  const B = window.Billing;
  const s = { loaded: false, loading: false, needsMigration: false, plans: [], subs: [], status: null, editing: null, busy: null };
  let ctx = null;

  async function load() {
    if (s.loading) return;
    s.loading = true;
    try {
      const [p, sub] = await Promise.all([
        ctx.sb.from("plans").select("*").order("sort").order("amount_cents"),
        ctx.sb.from("subscriptions").select("*").order("updated_at", { ascending: false }),
      ]);
      s.needsMigration = !!(p.error || sub.error);
      s.plans = p.data || []; s.subs = sub.data || [];
      s.loaded = true;
      if (!s.status && !s.needsMigration) B.call(ctx.sb, "status").then((x) => { s.status = x; ctx.rerender(); }).catch((e) => { s.status = { error: e.message }; ctx.rerender(); });
    } finally { s.loading = false; }
    ctx.rerender();
  }

  // Each member's current subscription: a live one first, else the newest.
  function currentSub(email) {
    const mine = s.subs.filter((x) => x.email === email);
    return mine.find((x) => B.isLive(x.status)) || mine[0] || null;
  }
  const planName = (id) => (s.plans.find((p) => p.id === id) || {}).name || "Unknown plan";

  function planForm(p) {
    const e = ctx.esc, isNew = !p.id;
    const opt = (v, label, cur) => `<option value="${v}" ${cur === v ? "selected" : ""}>${label}</option>`;
    return `<form class="inline-form" id="plan-form" data-id="${e(p.id || "")}">
      <label class="wide">Name<input name="name" required maxlength="60" value="${e(p.name || "")}" placeholder="e.g. Supervised rehab, 2 a week"></label>
      <label>Price (AUD)<input name="amount" required inputmode="decimal" value="${p.amount_cents ? (p.amount_cents / 100).toFixed(2).replace(/\.00$/, "") : ""}" placeholder="45"></label>
      <label>Every<input name="count" type="number" min="1" max="52" value="${e(p.interval_count || 1)}"></label>
      <label>Billing<select name="interval">${opt("week", "Week(s)", p.billing_interval || "week")}${opt("month", "Month(s)", p.billing_interval)}${opt("year", "Year(s)", p.billing_interval)}</select></label>
      <label>Type<select name="category">${opt("", "Any", p.category || "")}${opt("rehab", "Rehab (supervised)", p.category)}${opt("open_gym", "Open gym", p.category)}${opt("both", "Rehab + open gym", p.category)}</select></label>
      <label>Sessions a week<input name="spw" type="number" min="1" max="21" value="${e(p.sessions_per_week || "")}" placeholder="Unlimited"></label>
      <label>Order<input name="sort" type="number" value="${e(p.sort || 0)}"></label>
      <label class="full">Description<input name="description" maxlength="200" value="${e(p.description || "")}" placeholder="Shown to members when they choose a plan"></label>
      <label class="check"><input type="checkbox" name="active" ${p.active !== false ? "checked" : ""}> Members can choose it</label>
      <div class="extra full">Plan names and descriptions are sent to Stripe, so keep health details out of them ("Supervised rehab", not "ACL rehab").</div>
      ${isNew ? "" : `<div class="extra full">Changing the price makes a new Stripe price for new sign-ups. People already on this plan keep their current price until they change plan.</div>`}
      <div class="row"><button type="button" class="btn" data-act="plans-cancel">Cancel</button><button class="btn primary" ${s.busy ? "disabled" : ""}>${s.busy === "save" ? "Saving…" : isNew ? "Add plan" : "Save"}</button></div></form>`;
  }

  function render(c) {
    ctx = c;
    const e = ctx.esc;
    if (!s.loaded) { load(); return `<div class="hero"><div class="eyebrow">Loading</div><h2>Plans</h2></div><div class="skeleton"></div>`; }
    if (s.needsMigration) return `<div class="empty"><strong>One database step first</strong><span>Run <code>supabase/015_profile_billing.sql</code> in Supabase → SQL Editor, then reload this page.</span></div>`;
    let h = `<section class="hero"><div class="eyebrow">Memberships · paid with Stripe</div><h2>Plans</h2>
      <div class="extra">Members pick a plan on their Profile (website or iPhone) and pay on Stripe's page. Cards, receipts, plan changes and cancelling are handled by Stripe.</div></section>`;
    const st = s.status;
    if (st && st.error) h += `<div class="banner">Stripe isn't connected yet: ${e(st.error)}. See "Payments (Stripe)" in the README.</div>`;
    else if (st && !st.ready) h += `<div class="banner">Stripe isn't connected yet: add STRIPE_SECRET_KEY to the edge function secrets.</div>`;
    else if (st && st.test_mode) h += `<div class="banner warn">Stripe test mode: no real money moves. Test card 4242 4242 4242 4242.</div>`;

    h += `<div class="card table-card"><h3>Plans</h3><table class="grid"><thead><tr><th>Name</th><th>Price</th><th>Type</th><th>Sessions</th><th>Members</th><th></th></tr></thead><tbody>`;
    for (const p of s.plans) {
      if (s.editing === p.id) { h += `<tr class="editing"><td colspan="6">${planForm(p)}</td></tr>`; continue; }
      const n = ctx.members().filter((m) => { const x = currentSub(m.email); return x && x.plan_id === p.id && B.isLive(x.status); }).length;
      h += `<tr class="${p.active ? "" : "inactive"}"><td data-l="Name"><b>${e(p.name)}</b>${p.active ? "" : ` <span class="chip hold">hidden</span>`}${p.description ? `<div class="extra">${e(p.description)}</div>` : ""}</td>
        <td data-l="Price">${e(B.price(p))}</td><td data-l="Type">${e({ rehab: "Rehab", open_gym: "Open gym", both: "Rehab + open gym" }[p.category] || "Any")}</td>
        <td data-l="Sessions">${p.sessions_per_week ? e(p.sessions_per_week) + " a week" : "Unlimited"}</td><td data-l="Members">${n}</td>
        <td class="actions"><button class="btn" data-act="plans-edit" data-id="${e(p.id)}">Edit</button></td></tr>`;
    }
    if (!s.plans.length) h += `<tr><td colspan="6" class="extra">No plans yet. Add the first one below.</td></tr>`;
    h += `</tbody></table></div>`;
    h += s.editing === "new" ? `<section class="card"><h3>New plan</h3>${planForm({})}</section>`
      : `<div class="row" style="margin-top:12px"><button class="btn primary" data-act="plans-new">+ New plan</button></div>`;

    h += `<div class="card table-card"><h3>Members</h3><table class="grid"><thead><tr><th>Name</th><th>Plan</th><th>Status</th><th>Renews / ends</th><th></th></tr></thead><tbody>`;
    for (const m of ctx.members().filter((x) => x.active)) {
      const x = currentSub(m.email);
      const [label, kind] = x ? B.status(x.status) : ["No plan", "off"];
      const when = x && x.current_period_end && B.isLive(x.status) ? (x.cancel_at_period_end ? "Ends " : "Renews ") + ctx.fmtDate(x.current_period_end) : "";
      h += `<tr><td data-l="Name"><b>${e(m.display_name || m.email)}</b></td><td data-l="Plan">${x ? e(planName(x.plan_id)) : `<span class="extra">–</span>`}</td>
        <td data-l="Status"><span class="pill ${kind}">${e(label)}</span></td><td data-l="Renews / ends">${e(when) || `<span class="extra">–</span>`}</td>
        <td class="actions">${x ? `<button class="btn" data-act="plans-sync" data-email="${e(m.email)}" ${s.busy ? "disabled" : ""}>${s.busy === m.email ? "Checking…" : "Refresh"}</button>` : ""}</td></tr>`;
    }
    h += `</tbody></table></div>`;
    h += `<div class="extra" style="margin-top:10px">Refunds, pausing and one-off discounts are done in the Stripe dashboard; this list updates by itself when Stripe tells us.</div>`;
    return h;
  }

  document.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-act^='plans-']"); if (!btn || !ctx) return;
    const act = btn.dataset.act;
    if (act === "plans-new") { s.editing = "new"; ctx.rerender(); }
    else if (act === "plans-edit") { s.editing = btn.dataset.id; ctx.rerender(); }
    else if (act === "plans-cancel") { s.editing = null; ctx.rerender(); }
    else if (act === "plans-sync") {
      s.busy = btn.dataset.email; ctx.rerender();
      try { await B.call(ctx.sb, "sync", { email: btn.dataset.email }); } catch (e) { ctx.flash("Couldn't check Stripe: " + e.message); }
      s.busy = null; s.loaded = false; await load();
    }
  });

  document.addEventListener("submit", async (ev) => {
    const f = ev.target; if (f.id !== "plan-form" || !ctx) return;
    ev.preventDefault();
    const v = (n) => (f.elements[n] ? f.elements[n].value.trim() : "");
    const amount = Math.round(parseFloat(v("amount").replace(/[$,\s]/g, "")) * 100);
    if (!(amount >= 50)) return ctx.flash("Enter a price of at least $0.50, e.g. 45 or 45.50.");
    const plan = {
      id: f.dataset.id || undefined, name: v("name"), description: v("description"), category: v("category"),
      amount_cents: amount, billing_interval: v("interval"), interval_count: Number(v("count")) || 1,
      sessions_per_week: v("spw") ? Number(v("spw")) : null, sort: Number(v("sort")) || 0, active: f.elements.active.checked,
    };
    s.busy = "save"; ctx.rerender();
    try {
      const r = await B.call(ctx.sb, "save_plan", { plan });
      s.editing = null; s.busy = null; s.loaded = false; await load();
      ctx.flash(r.price_changed ? "Saved. New sign-ups get the new price; current members keep theirs." : "Plan saved.", "ok");
    } catch (e) { s.busy = null; ctx.rerender(); ctx.flash("That didn't save: " + e.message); }
  });

  window.ConsolePlans = { render };
})();
