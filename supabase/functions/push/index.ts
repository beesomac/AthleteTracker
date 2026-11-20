// "push" edge function: sends one row of public.notifications to the recipient's iPhones
// through Apple Push Notification service (APNs), using token auth (.p8 key).
//
// Called by the notifications_push trigger (supabase/009_push.sql) with {"id": "<notification id>"}.
// Deploy with JWT verification off (the database calls it without a user):
//   supabase functions deploy push --no-verify-jwt --project-ref zaftplbijgkhnbmwegwt
//
// Secrets (Supabase dashboard → Edge Functions → Secrets):
//   APNS_KEY_ID       10-character Key ID of the APNs key
//   APNS_TEAM_ID      10-character Team ID of the paid developer team
//   APNS_PRIVATE_KEY  the whole contents of the AuthKey_XXXXXXXXXX.p8 file
//   APNS_BUNDLE_ID    optional, defaults to com.blackstumpsoftware.TrainingLog
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

import { createClient } from "npm:@supabase/supabase-js@2";

const KEY_ID = Deno.env.get("APNS_KEY_ID") ?? "";
const TEAM_ID = Deno.env.get("APNS_TEAM_ID") ?? "";
const PRIVATE_KEY = Deno.env.get("APNS_PRIVATE_KEY") ?? "";
const BUNDLE_ID = Deno.env.get("APNS_BUNDLE_ID") ?? "com.blackstumpsoftware.TrainingLog";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
} as const;
type Env = keyof typeof HOSTS;

// --- APNs auth token (ES256 JWT). Apple wants it reused for 20–60 minutes. ---

let cached: { jwt: string; at: number } | null = null;

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Accepts the .p8 pasted with or without its BEGIN/END lines, with real or escaped (\\n) line
// breaks, quotes or stray spaces. Never logs the key itself.
function p8Bytes(raw: string): Uint8Array {
  const body = raw
    .replace(/\\[nr]/g, "\n")
    .replace(/-----(BEGIN|END)[^-]*-----/g, "")
    .replace(/(BEGIN|END) (EC )?PRIVATE KEY/g, "")
    .replace(/[^A-Za-z0-9+/=]/g, "")
    .replace(/=+$/, "");
  const padded = body + "=".repeat((4 - (body.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    throw new Error(`APNS_PRIVATE_KEY isn't a readable .p8 key (${body.length} base64 characters after cleaning; a .p8 has about 200)`);
  }
}

async function apnsJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && now - cached.at < 40 * 60) return cached.jwt;
  const key = await crypto.subtle.importKey("pkcs8", p8Bytes(PRIVATE_KEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const input = b64url(JSON.stringify({ alg: "ES256", kid: KEY_ID })) + "." + b64url(JSON.stringify({ iss: TEAM_ID, iat: now }));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input)));
  cached = { jwt: input + "." + b64url(sig), at: now };
  return cached.jwt;
}

async function send(token: string, env: Env, payload: unknown): Promise<{ status: number; reason?: string }> {
  const res = await fetch(`${HOSTS[env]}/3/device/${token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${await apnsJwt()}`,
      "apns-topic": BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (res.ok) return { status: res.status };
  const text = await res.text();
  let reason = text;
  try { reason = JSON.parse(text).reason ?? text; } catch { /* keep text */ }
  return { status: res.status, reason };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!KEY_ID || !TEAM_ID || !PRIVATE_KEY) return json({ error: "APNs secrets not set" }, 500);

  let id: unknown;
  try { ({ id } = await req.json()); } catch { /* fall through */ }
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "bad id" }, 400);

  // Claim the row: only a fresh, not-yet-pushed notification goes out, and only once.
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: rows, error } = await db.from("notifications")
    .update({ pushed_at: new Date().toISOString() })
    .eq("id", id).is("pushed_at", null).gte("created_at", since)
    .select("id, recipient_email, kind, title, body, wod_id, session_id");
  if (error) return json({ error: error.message }, 500);
  const n = rows?.[0];
  if (!n) return json({ sent: 0, note: "already pushed, too old, or unknown" });

  const { data: tokens, error: tokErr } = await db.from("device_tokens")
    .select("token, environment").eq("email", n.recipient_email);
  if (tokErr) return json({ error: tokErr.message }, 500);

  const payload = {
    aps: { alert: { title: n.title, ...(n.body ? { body: n.body } : {}) }, sound: "default" },
    id: n.id,
    kind: n.kind,
    ...(n.wod_id ? { wod_id: n.wod_id } : {}),
    ...(n.session_id ? { session_id: n.session_id } : {}),
  };

  try {
    await apnsJwt();
  } catch (e) {
    await db.from("notifications").update({ pushed_at: null }).eq("id", n.id);
    console.error(String(e));
    return json({ error: String(e) }, 500);
  }

  const results = [];
  for (const t of tokens ?? []) {
    const env = (t.environment === "sandbox" ? "sandbox" : "production") as Env;
    let r = await send(t.token, env, payload);
    // A Debug build from Xcode uses the sandbox, TestFlight/App Store use production.
    // If the phone guessed wrong, try the other one and remember it.
    if (r.status === 400 && r.reason === "BadDeviceToken") {
      const other: Env = env === "sandbox" ? "production" : "sandbox";
      const r2 = await send(t.token, other, payload);
      if (r2.status === 200) {
        await db.from("device_tokens").update({ environment: other }).eq("token", t.token);
      }
      r = r2;
    }
    // Gone: the app was deleted or notifications were turned off for good.
    if (r.status === 410 || (r.status === 400 && r.reason === "BadDeviceToken")) {
      await db.from("device_tokens").delete().eq("token", t.token);
    }
    results.push({ token: t.token.slice(0, 8) + "…", ...r });
  }
  console.log(JSON.stringify({ notification: n.id, results }));
  return json({ sent: results.filter((r) => r.status === 200).length, results });
});
