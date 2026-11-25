// Profile page: your details, your membership, and paying for a plan with Stripe.
// Needs supabase/015_profile_billing.sql and the "billing" edge function.
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const app = $("#app"), whoEl = $("#who");
  const B = window.Billing;
  const sb = window.TrainingStore.createClient();
  const params = new URLSearchParams(location.search);
  const fromApp = params.get("app") === "1";
  const state = { me: null, profile: null, plans: [], status: null, error: null, needsMigration: false, busy: null, notice: null };

  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function fmtDay(iso) { try { return new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }); } catch (e) { return ""; } }
  function flash(msg, kind) { state.notice = { msg, kind }; render(); }
  const here = () => location.origin + location.pathname + (fromApp ? "?app=1" : "");

  async function load() {
    const { data: { session } } = await sb.auth.getSession();
    state.me = session && session.user ? session.user.email.toLowerCase() : null;
    if (!state.me) return render();
    const [p, plans] = await Promise.all([
      sb.rpc("my_profile"),
      sb.from("plans").select("*").eq("active", true).order("sort").order("amount_cents"),
    ]);
    if (p.error) { state.needsMigration = /my_profile|function/i.test(p.error.message); state.error = state.needsMigration ? null : p.error.message; return render(); }
    state.profile = p.data;
    state.plans = plans.data || [];
    render();
    if (!state.status) B.call(sb, "status").then((s) => { state.status = s; render(); }).catch(() => {});
  }

  function membershipHTML() {
    const p = state.profile, s = p.subscription;
    const testing = state.status && state.status.test_mode
      ? `<div class="banner warn">Stripe test mode: no real money moves. Pay with card <strong>4242 4242 4242 4242</strong>, any future date and any 3 numbers.</div>` : "";
    if (s && B.isLive(s.status)) {
      const [label, kind] = B.status(s.status);
      const when = s.current_period_end ? (s.cancel_at_period_end ? "Ends " : "Renews ") + fmtDay(s.current_period_end) : "";
      return `<div class="card"><div class="card-head"><h3>${esc(s.plan_name || "Membership")}</h3><span class="pill ${kind}">${esc(label)}</span></div>
        <div>${s.amount_cents ? esc(B.price(s)) : ""}${when ? ` · ${esc(when)}` : ""}</div>
        ${s.status === "past_due" || s.status === "unpaid" ? `<div class="banner">Your last payment didn't go through. Update your card in Manage billing.</div>` : ""}
        ${testing}
        <div class="row"><button class="btn primary" data-act="portal" ${state.busy ? "disabled" : ""}>${state.busy === "portal" ? "Opening…" : "Manage billing"}</button></div>
        <div class="extra">Change plan, update your card, see invoices or cancel. Billing is handled by Stripe.</div></div>`;
    }
    const plans = state.plans.filter((x) => x.stripe_price_id);
    let h = `<div class="card"><div class="card-head"><h3>Choose a plan</h3>${s ? `<span class="pill off">${esc(B.status(s.status)[0])}</span>` : ""}</div>${testing}`;
    if (!plans.length) h += `<div class="extra">There are no plans to choose from yet. Ask your trainer.</div>`;
    for (const x of plans) {
      h += `<div class="plan-row"><div><strong>${esc(x.name)}</strong><div>${esc(B.price(x))}</div>${x.description ? `<div class="extra">${esc(x.description)}</div>` : ""}</div>
        <button class="btn primary" data-act="checkout" data-id="${esc(x.id)}" ${state.busy ? "disabled" : ""}>${state.busy === x.id ? "Opening…" : "Choose"}</button></div>`;
    }
    if (p.has_billing) h += `<div class="row"><button class="btn" data-act="portal" ${state.busy ? "disabled" : ""}>Past invoices</button></div>`;
    h += `<div class="extra">You pay on Stripe's secure page. Card details go to Stripe and are never stored here.</div></div>`;
    return h;
  }

  function detailsHTML() {
    const p = state.profile;
    return `<div class="card"><h3>Your details</h3><form class="inline-form" id="profile-form">
      <label>Name<input name="name" value="${esc(p.display_name || "")}" maxlength="80" autocomplete="name"></label>
      <label>Email<input value="${esc(p.email)}" disabled></label>
      <label>Phone<input name="phone" type="tel" value="${esc(p.phone || "")}" maxlength="30" autocomplete="tel"></label>
      <label>Emergency contact<input name="emergency_name" value="${esc(p.emergency_name || "")}" maxlength="80"></label>
      <label>Their phone<input name="emergency_phone" type="tel" value="${esc(p.emergency_phone || "")}" maxlength="30"></label>
      <div class="row"><button class="btn primary">Save</button></div></form></div>`;
  }

  function render() {
    let h;
    whoEl.innerHTML = state.me ? `<span class="me-name"></span><button class="signout" data-act="signout">Sign out</button>` : "";
    if (state.me) whoEl.querySelector(".me-name").textContent = (state.profile && state.profile.display_name) || state.me;
    if (!sb) h = `<div class="empty"><strong>No database connected</strong><span>Fill in config.js first.</span></div>`;
    else if (state.error) h = `<div class="empty"><strong>Something went wrong</strong><span>${esc(state.error)}</span></div>`;
    else if (!state.me) h = `<div class="empty"><strong>Sign in first</strong><span>Sign in on the <a href="index.html">training log</a>, then come back here.</span></div>`;
    else if (state.needsMigration) h = `<div class="empty"><strong>One database step first</strong><span>Run <code>supabase/015_profile_billing.sql</code> in Supabase → SQL Editor, then reload this page.</span></div>`;
    else if (!state.profile) h = `<div class="empty"><strong>Not on the list</strong><span>${esc(state.me)} isn't set up as a member yet.</span></div>`;
    else {
      h = `<section class="hero"><div class="eyebrow">Membership and details</div><h2>${esc(state.profile.display_name || "Profile")}</h2></section>`;
      if (state.notice) h += `<div class="banner ${state.notice.kind || ""}">${esc(state.notice.msg)}</div>`;
      h += membershipHTML() + detailsHTML();
    }
    app.innerHTML = h;
  }

  async function go(action, body, busy) {
    state.busy = busy; state.notice = null; render();
    try {
      const r = await B.call(sb, action, Object.assign({ return_url: here() }, body));
      location.href = r.url;
    } catch (e) {
      state.busy = null;
      flash(e.message);
    }
  }

  document.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-act]"); if (!btn) return;
    const act = btn.dataset.act;
    if (act === "signout") { await sb.auth.signOut(); location.href = "index.html"; }
    else if (act === "checkout") go("checkout", { plan_id: btn.dataset.id }, btn.dataset.id);
    else if (act === "portal") go("portal", {}, "portal");
  });

  app.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target; if (f.id !== "profile-form") return;
    const v = (n) => f.elements[n].value.trim();
    const { error } = await sb.rpc("update_my_profile", { p_display_name: v("name"), p_phone: v("phone"), p_emergency_name: v("emergency_name"), p_emergency_phone: v("emergency_phone") });
    if (error) return flash("That didn't save: " + error.message + ".");
    await load();
    flash("Saved.", "ok");
  });

  (async function start() {
    if (!sb) return render();
    try {
      await load();
      // Back from Stripe: read the result straight away rather than waiting for the webhook.
      const back = params.get("billing");
      if (back && state.profile) {
        history.replaceState(null, "", here());
        if (back === "done" || back === "portal") { try { await B.call(sb, "sync"); } catch (e) {} await load(); }
        const done = fromApp ? " You can go back to the app now." : "";
        if (back === "done") flash("Payment done, your membership is set up." + done, "ok");
        else if (back === "cancelled") flash("No payment was taken." + done);
        else if (fromApp) flash("All saved. You can go back to the app now.", "ok");
      }
    } catch (e) { state.error = e.message; render(); }
  })();
})();
