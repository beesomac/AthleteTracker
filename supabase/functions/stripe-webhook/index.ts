// "stripe-webhook" edge function: Stripe tells us when a subscription starts, renews, changes,
// fails to pay or is cancelled, and we copy it into public.subscriptions.
//
// Deploy with JWT verification off (Stripe calls it, not a signed-in user); the Stripe
// signature is checked instead:
//   supabase functions deploy stripe-webhook --no-verify-jwt --project-ref zaftplbijgkhnbmwegwt
//
// In Stripe: Developers → Webhooks → Add endpoint, URL
//   https://zaftplbijgkhnbmwegwt.supabase.co/functions/v1/stripe-webhook
// with events checkout.session.completed and customer.subscription.created / updated / deleted.
// Put its signing secret in STRIPE_WEBHOOK_SECRET.

import { saveSubscription, stripe, syncCustomer } from "../_shared/stripe.ts";

const SECRET = (Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "").trim();
const TOLERANCE_SECONDS = 300;

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Stripe-Signature: t=<unix time>,v1=<hex HMAC-SHA256 of "t.payload">[,v1=…]
async function verified(payload: string, header: string | null): Promise<boolean> {
  if (!SECRET || !header) return false;
  const parts = header.split(",").map((p) => p.split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > TOLERANCE_SECONDS) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return sigs.some((s) => sameText(s, expected));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const payload = await req.text();
  if (!(await verified(payload, req.headers.get("stripe-signature")))) {
    console.warn("Webhook signature didn't match (is STRIPE_WEBHOOK_SECRET the one for this endpoint?)");
    return new Response("Bad signature", { status: 400 });
  }
  const event = JSON.parse(payload);
  try {
    const obj = event.data?.object ?? {};
    switch (event.type) {
      case "checkout.session.completed":
        if (obj.mode === "subscription" && obj.subscription) {
          await saveSubscription(await stripe("GET", `subscriptions/${obj.subscription}`));
        }
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        await saveSubscription(obj);
        break;
      case "invoice.paid":
      case "invoice.payment_failed":
        if (obj.customer) await syncCustomer(typeof obj.customer === "string" ? obj.customer : obj.customer.id);
        break;
      default:
        break;
    }
    console.log(`Handled ${event.type} ${event.id}`);
    return Response.json({ received: true });
  } catch (e) {
    // A 500 makes Stripe retry later, which is what we want if the database was briefly away.
    console.error(`Webhook ${event.type} ${event.id} failed: ${(e as Error).message}`);
    return new Response("Failed", { status: 500 });
  }
});
