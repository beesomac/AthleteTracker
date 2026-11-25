// "billing" edge function: everything the Profile screens and the console's Plans tab ask Stripe for.
// Called by a signed-in member (web or iPhone) with their Supabase token, so deploy it with JWT
// verification on (the default):
//   supabase functions deploy billing --project-ref zaftplbijgkhnbmwegwt
//
// POST {"action": …}
//   status                                  → {test_mode, ready}  (is a Stripe key set)
//   checkout   {plan_id, return_url?}       → {url}  Stripe Checkout page for that plan
//   portal     {return_url?}                → {url}  Stripe customer portal (change plan, card, cancel, invoices)
//   sync       {email?}                     → {}     re-read subscriptions from Stripe (trainers may pass email)
//   save_plan  {plan}                       → {plan} trainers only: create or change a plan and its Stripe price
//
// Secrets: see ../_shared/stripe.ts.

import { db, isTestMode, stripe, syncCustomer } from "../_shared/stripe.ts";

const SITE_URL = (Deno.env.get("SITE_URL") ?? "").trim().replace(/\/+$/, "");
const LIVE = ["active", "trialing", "past_due", "unpaid", "paused"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });
class Problem extends Error {
  constructor(message: string, public status = 400, public code?: string) { super(message); }
}

// Only send people back to our own site (or a local copy while testing), never anywhere else.
// The iPhone app passes app: true and gets the profile page that says "go back to the app".
function returnUrl(asked: unknown, app = false): string {
  if (!SITE_URL) throw new Problem("SITE_URL isn't set in the edge function secrets", 500);
  const fallback = SITE_URL + "/profile.html" + (app ? "?app=1" : "");
  if (typeof asked !== "string" || !asked) return fallback;
  try {
    const u = new URL(asked), site = new URL(SITE_URL);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    return u.origin === site.origin || local ? u.toString() : fallback;
  } catch {
    return fallback;
  }
}
function withParam(url: string, key: string, value: string): string {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

async function member(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data, error } = await db.auth.getUser(token);
  const email = data?.user?.email?.toLowerCase();
  if (error || !email) throw new Problem("Sign in first", 401);
  const { data: m } = await db.from("members").select("email, display_name, role, active").eq("email", email).maybeSingle();
  if (!m || !m.active) throw new Problem("You're not set up as a member yet", 403);
  return m as { email: string; display_name: string | null; role: string; active: boolean };
}

async function customerFor(m: { email: string }, create: boolean): Promise<string | null> {
  const { data } = await db.from("billing_customers").select("stripe_customer_id").eq("email", m.email).maybeSingle();
  if (data) return data.stripe_customer_id;
  if (!create) return null;
  // Only what Stripe needs for receipts: the email. No names, phone numbers or health details.
  const c = await stripe("POST", "customers", { email: m.email, metadata: { member_email: m.email } });
  const { error } = await db.from("billing_customers").insert({ email: m.email, stripe_customer_id: c.id });
  if (error) {
    // Two taps at once: keep whichever got saved first.
    const again = await db.from("billing_customers").select("stripe_customer_id").eq("email", m.email).maybeSingle();
    if (again.data) return again.data.stripe_customer_id;
    throw new Error(error.message);
  }
  return c.id;
}

async function checkout(m: Awaited<ReturnType<typeof member>>, body: any) {
  const { data: plan } = await db.from("plans").select("*").eq("id", body.plan_id ?? "").maybeSingle();
  if (!plan || !plan.active || !plan.stripe_price_id) throw new Problem("That plan isn't available");
  const { data: subs } = await db.from("subscriptions").select("status").eq("email", m.email);
  if ((subs ?? []).some((s) => LIVE.includes(s.status))) {
    throw new Problem("You already have a membership. Use Manage billing to change or cancel it.", 409, "has_subscription");
  }
  const customer = await customerFor(m, true);
  const back = returnUrl(body.return_url, !!body.app);
  const meta = { member_email: m.email, plan_id: plan.id };
  const session = await stripe("POST", "checkout/sessions", {
    mode: "subscription",
    customer,
    client_reference_id: m.email,
    line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
    success_url: withParam(back, "billing", "done"),
    cancel_url: withParam(back, "billing", "cancelled"),
    allow_promotion_codes: true,
    metadata: meta,
    subscription_data: { metadata: meta },
  });
  return { url: session.url };
}

async function portal(m: Awaited<ReturnType<typeof member>>, body: any) {
  const customer = await customerFor(m, false);
  if (!customer) throw new Problem("There's no billing set up for you yet. Choose a plan first.", 404, "no_customer");
  try {
    const s = await stripe("POST", "billing_portal/sessions", { customer, return_url: withParam(returnUrl(body.return_url, !!body.app), "billing", "portal") });
    return { url: s.url };
  } catch (e) {
    const msg = (e as Error).message;
    if (/configuration/i.test(msg)) throw new Problem("The Stripe customer portal hasn't been set up yet (Stripe → Settings → Billing → Customer portal → Save).", 500, "no_portal");
    throw e;
  }
}

async function sync(m: Awaited<ReturnType<typeof member>>, body: any) {
  let email = m.email;
  if (body.email && m.role === "trainer") email = String(body.email).toLowerCase();
  const { data } = await db.from("billing_customers").select("stripe_customer_id").eq("email", email).maybeSingle();
  if (data) await syncCustomer(data.stripe_customer_id);
  return {};
}

const INTERVALS = ["week", "month", "year"];

async function savePlan(m: Awaited<ReturnType<typeof member>>, body: any) {
  if (m.role !== "trainer") throw new Problem("Only trainers can change plans", 403);
  const p = body.plan ?? {};
  const name = String(p.name ?? "").trim();
  const amount = Math.round(Number(p.amount_cents));
  const interval = String(p.billing_interval ?? "week");
  const count = Math.round(Number(p.interval_count ?? 1));
  if (!name) throw new Problem("Give the plan a name");
  if (!Number.isFinite(amount) || amount < 50) throw new Problem("The price should be at least $0.50");
  if (!INTERVALS.includes(interval)) throw new Problem("Billing should be weekly, monthly or yearly");
  if (!(count >= 1 && count <= 52)) throw new Problem("Bill every 1 to 52 weeks, months or years");
  const spw = p.sessions_per_week == null || p.sessions_per_week === "" ? null : Math.round(Number(p.sessions_per_week));
  const fields = {
    name,
    description: String(p.description ?? "").trim() || null,
    category: String(p.category ?? "").trim() || null,
    amount_cents: amount,
    currency: "aud",
    billing_interval: interval,
    interval_count: count,
    sessions_per_week: spw && spw > 0 ? spw : null,
    active: p.active !== false,
    sort: Math.round(Number(p.sort ?? 0)) || 0,
    updated_at: new Date().toISOString(),
  };

  let row: any = null;
  if (p.id) {
    const { data } = await db.from("plans").select("*").eq("id", p.id).maybeSingle();
    if (!data) throw new Problem("That plan doesn't exist any more", 404);
    row = data;
  } else {
    const { data, error } = await db.from("plans").insert(fields).select().single();
    if (error) throw new Error(error.message);
    row = data;
  }

  try {
    let product = row.stripe_product_id;
    const productFields = { name, description: fields.description ?? "", active: fields.active, metadata: { plan_id: row.id } };
    if (!product) product = (await stripe("POST", "products", productFields)).id;
    else await stripe("POST", `products/${product}`, productFields);

    // Stripe prices can't be edited: a new price replaces the old one for new sign-ups.
    // People already on the plan keep paying the old price until they change plan.
    let price = row.stripe_price_id;
    const priceChanged = !price || row.amount_cents !== amount || row.billing_interval !== interval || row.interval_count !== count || row.currency !== "aud";
    if (priceChanged) {
      const old = price;
      price = (await stripe("POST", "prices", {
        product,
        unit_amount: amount,
        currency: "aud",
        recurring: { interval, interval_count: count },
        metadata: { plan_id: row.id },
      })).id;
      await stripe("POST", `products/${product}`, { default_price: price });
      if (old) await stripe("POST", `prices/${old}`, { active: false });
    }
    const { data, error } = await db.from("plans").update({ ...fields, stripe_product_id: product, stripe_price_id: price }).eq("id", row.id).select().single();
    if (error) throw new Error(error.message);
    return { plan: data, price_changed: priceChanged && !!row.stripe_price_id };
  } catch (e) {
    if (!p.id) await db.from("plans").delete().eq("id", row.id);
    throw e;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const m = await member(req);
    switch (body.action) {
      case "status": return reply({ test_mode: isTestMode(), ready: !!Deno.env.get("STRIPE_SECRET_KEY"), site: !!SITE_URL });
      case "checkout": return reply(await checkout(m, body));
      case "portal": return reply(await portal(m, body));
      case "sync": return reply(await sync(m, body));
      case "save_plan": return reply(await savePlan(m, body));
      default: return reply({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    const p = e instanceof Problem ? e : null;
    if (!p) console.error((e as Error).message);
    return reply({ error: (e as Error).message, code: p?.code }, p?.status ?? 500);
  }
});
