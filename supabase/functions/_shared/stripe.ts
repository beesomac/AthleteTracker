// Small Stripe REST client shared by the "billing" and "stripe-webhook" edge functions.
// Plain fetch with form encoding, so there's no SDK to keep up to date.
//
// Secrets (Supabase dashboard → Edge Functions → Secrets):
//   STRIPE_SECRET_KEY       sk_test_… while testing, sk_live_… when taking real payments
//   STRIPE_WEBHOOK_SECRET   whsec_… from the webhook endpoint in the Stripe dashboard
//   SITE_URL                the website address, e.g. https://your-site.vercel.app (no trailing slash)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

import { createClient } from "npm:@supabase/supabase-js@2";

export const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const KEY = (Deno.env.get("STRIPE_SECRET_KEY") ?? "").trim();
const API_VERSION = "2025-03-31.basil";

type Params = Record<string, unknown>;

// Stripe's form encoding: nested objects as a[b]=…, arrays as a[0]=….
function encode(params: Params, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" ? encode(item as Params, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === "object") encode(v as Params, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe<T = any>(method: "GET" | "POST" | "DELETE", path: string, params: Params = {}): Promise<T> {
  if (!KEY) throw new Error("STRIPE_SECRET_KEY isn't set in the edge function secrets");
  const body = encode(params).toString();
  const url = `https://api.stripe.com/v1/${path}${method === "GET" && body ? "?" + body : ""}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Stripe-Version": API_VERSION,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method === "POST" ? body : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe: ${json?.error?.message ?? res.status}`);
  return json as T;
}

export const isTestMode = () => KEY.startsWith("sk_test_") || KEY.startsWith("rk_test_");

// Copies one Stripe subscription into public.subscriptions. The member comes from the
// subscription's metadata (set at checkout), else from billing_customers.
export async function saveSubscription(sub: any): Promise<void> {
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  let email: string | null = sub.metadata?.member_email?.toLowerCase() ?? null;
  if (!email) {
    const { data } = await db.from("billing_customers").select("email").eq("stripe_customer_id", customer).maybeSingle();
    email = data?.email ?? null;
  }
  if (!email) {
    console.warn(`Subscription ${sub.id}: no member for customer ${customer}; skipped`);
    return;
  }
  const item = sub.items?.data?.[0];
  const product = typeof item?.price?.product === "string" ? item.price.product : item?.price?.product?.id;
  let planId: string | null = sub.metadata?.plan_id ?? null;
  if (product) {
    const { data } = await db.from("plans").select("id").eq("stripe_product_id", product).maybeSingle();
    if (data) planId = data.id;
  }
  // Newer Stripe API versions keep the period end on the item rather than the subscription.
  const periodEnd = sub.current_period_end ?? item?.current_period_end ?? null;
  const { error } = await db.from("subscriptions").upsert({
    stripe_subscription_id: sub.id,
    email,
    stripe_customer_id: customer,
    plan_id: planId,
    status: sub.status,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Saving subscription ${sub.id}: ${error.message}`);
}

// Re-reads every subscription Stripe has for a customer (used after checkout and by "Refresh").
export async function syncCustomer(customerId: string): Promise<void> {
  const list = await stripe("GET", "subscriptions", { customer: customerId, status: "all", limit: 20 });
  for (const sub of list.data ?? []) await saveSubscription(sub);
}
