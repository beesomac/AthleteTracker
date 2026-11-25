// Shared by profile.html and the console's Plans tab: price wording and calls to the
// "billing" edge function (supabase/functions/billing), which talks to Stripe.
(function () {
  const STATUS = {
    active: ["Active", "ok"],
    trialing: ["Trial", "ok"],
    past_due: ["Payment overdue", "warn"],
    unpaid: ["Unpaid", "warn"],
    paused: ["Paused", "warn"],
    incomplete: ["Payment not finished", "warn"],
    incomplete_expired: ["Payment not finished", "off"],
    canceled: ["Cancelled", "off"],
  };
  const LIVE = ["active", "trialing", "past_due", "unpaid", "paused"];

  function money(cents, currency = "aud") {
    const n = (Number(cents) || 0) / 100;
    try {
      return new Intl.NumberFormat("en-AU", { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: n % 1 ? 2 : 0 }).format(n);
    } catch (e) { return "$" + n.toFixed(2); }
  }
  // "every week", "every 2 weeks", "a month", …
  function every(interval, count) {
    const c = Number(count) || 1;
    const unit = { week: "week", month: "month", year: "year" }[interval] || interval;
    return c === 1 ? (unit === "week" ? "a week" : unit === "month" ? "a month" : "a year") : `every ${c} ${unit}s`;
  }
  const price = (p) => `${money(p.amount_cents, p.currency)} ${every(p.billing_interval, p.interval_count)}`;
  const status = (s) => STATUS[s] || [s || "None", "off"];
  const isLive = (s) => LIVE.includes(s);

  // Calls the edge function; throws an Error with the function's own message (and .code).
  async function call(sb, action, body = {}) {
    const { data, error } = await sb.functions.invoke("billing", { body: Object.assign({ action }, body) });
    if (!error) return data;
    let msg = error.message, code;
    try {
      const j = await error.context.json();
      if (j && j.error) { msg = j.error; code = j.code; }
    } catch (e) {}
    if (/Failed to send|NetworkError|Load failed/i.test(msg)) msg = "Billing isn't switched on yet (the billing edge function isn't deployed)";
    const err = new Error(msg); err.code = code; throw err;
  }

  window.Billing = { money, every, price, status, isLive, call };
})();
