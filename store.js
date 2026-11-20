// Data layer: Supabase when configured, otherwise this device's localStorage (demo mode).
// Both expose the same shape so app.js doesn't care which one it's talking to.
(function () {
  const cfg = window.TRAINING_CONFIG || {};

  function tickKey(sid, eid) { return sid + "__" + eid; }

  function fromTickRow(r) {
    return {
      session: r.session_id, ex: r.exercise_id, sets: r.sets || {}, skipped: !!r.skipped, skipReason: r.skip_reason || "",
      by: r.updated_by_email, at: r.updated_at,
    };
  }
  function fromFinishRow(r) {
    return { session: r.session_id, by: r.finished_by_email, at: r.finished_at, summary: r.summary, details: r.details || {} };
  }
  function fromNoteRow(r) {
    return {
      id: r.id, session: r.session_id, ex: r.exercise_id, exName: r.exercise_name, text: r.body,
      by: r.author_email, at: r.created_at, reviewed: !!r.reviewed, reviewedBy: r.reviewed_by_email,
    };
  }

  function supabaseStore() {
    const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    let email = null;
    let listener = null;
    let channel = null;
    let reloadTimer = null;
    // v2 = the database has had supabase/004_trainer_console.sql run: members, roles, programs, WODs.
    // Before that the site works as it always has (one athlete, sessions from the sessions/ files).
    const info = { v2: false, role: null, name: null, athlete: null, athletes: [], names: {} };
    const ATHLETE_KEY = "training-log-athlete";
    // Rows in v2 belong to an athlete: the signed-in athlete, or whoever the trainer picked.
    const scoped = (q) => (info.v2 && info.athlete ? q.eq("athlete_email", info.athlete) : q);
    const mine = (row) => (info.v2 && info.athlete ? Object.assign({ athlete_email: info.athlete }, row) : row);

    async function loadRoles() {
      const w = await sb.rpc("whoami");
      info.v2 = !w.error;
      if (!info.v2) return;
      const meRow = (w.data || [])[0] || {};
      info.role = meRow.role || null;
      info.name = meRow.display_name || null;
      info.legacyFiles = !!meRow.legacy_files;
      const n = await sb.rpc("member_names");
      info.names = {};
      if (!n.error) for (const r of n.data || []) if (r.email) info.names[r.email.toLowerCase()] = r.name;
      if (info.role === "trainer") {
        const m = await sb.from("members").select("*").eq("active", true).order("display_name");
        // Athletes, plus any trainer who also trains (members.also_athlete, from 006).
        info.athletes = (m.data || []).filter((r) => r.role === "athlete" || r.also_athlete).map((r) => ({ email: r.email, name: r.display_name || r.email.split("@")[0], legacyFiles: !!r.legacy_files }));
        let saved = null;
        try { saved = localStorage.getItem(ATHLETE_KEY); } catch (e) {}
        const pick = info.athletes.find((a) => a.email === saved) || info.athletes[0];
        info.athlete = pick ? pick.email : null;
      } else {
        info.athletes = [];
        info.athlete = (email || "").toLowerCase();
      }
    }

    // The athlete's WOD scores, with round detail when 011 has run (older databases: without).
    async function myResultsQuery() {
      const cols = "id, wod_id, athlete_email, score, rx, performed_on, note, hidden, created_at";
      const r = await scoped(sb.from("wod_results").select(cols + ", detail"));
      if (!r.error || !/detail/.test(r.error.message || "")) return r;
      return scoped(sb.from("wod_results").select(cols));
    }

    async function loadAll() {
      const [t, n, f, m, p, w, b, nt, mr] = await Promise.all([
        scoped(sb.from("ticks").select("*")),
        scoped(sb.from("notes").select("*")).order("created_at", { ascending: true }),
        scoped(sb.from("session_finishes").select("*")),
        scoped(sb.from("lift_maxes").select("*")),
        info.v2 ? sb.from("programs").select("*").eq("published", true).order("date") : null,
        info.v2 ? sb.from("wods").select("*").order("created_at", { ascending: false }) : null,
        info.v2 ? sb.rpc("wod_board") : null,
        // 007: your own notifications (the signed-in person's, whichever athlete a trainer is viewing).
        info.v2 ? sb.from("notifications").select("*").eq("recipient_email", (email || "").toLowerCase()).order("created_at", { ascending: false }).limit(60) : null,
        // Every WOD score of the athlete being viewed, for "you've done this before".
        info.v2 ? myResultsQuery() : null,
      ]);
      if (t.error) throw t.error;
      if (n.error) throw n.error;
      const ticks = {};
      for (const r of t.data) ticks[tickKey(r.session_id, r.exercise_id)] = fromTickRow(r);
      const finishes = {};
      // Older databases without the finish table still work; finishing just won't save.
      if (!f.error) for (const r of f.data) finishes[r.session_id] = fromFinishRow(r);
      const maxes = {};
      if (!m.error) for (const r of m.data) maxes[r.lift_key] = { lift: r.lift_key, name: r.lift_name, kg: r.kg, on: r.tested_on, by: r.updated_by_email };
      // Programs for this athlete (their own, or for everyone). null = use the sessions/ files.
      let programs = null;
      if (p && !p.error) {
        programs = p.data
          .filter((r) => !r.athlete_email || r.athlete_email === info.athlete)
          .map((r) => Object.assign({}, r.body || {}, { id: r.id, date: r.date, title: r.title }));
      }
      return {
        ticks, notes: n.data.map(fromNoteRow), finishes, maxes, programs,
        wods: w && !w.error ? w.data : [], board: b && !b.error ? b.data : [],
        notifications: nt && !nt.error ? nt.data : null,   // null = 007 not run
        myResults: mr && !mr.error ? mr.data.filter((r) => !r.hidden) : [],
      };
    }
    function scheduleReload() {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(async () => {
        try { listener && listener(await loadAll()); } catch (e) { console.warn(e); }
      }, 250);
    }

    return {
      mode: "shared",
      info,
      async setAthlete(addr) {
        info.athlete = addr;
        try { localStorage.setItem(ATHLETE_KEY, addr); } catch (e) {}
        if (listener) listener(await loadAll());
      },
      async currentUser() {
        const { data } = await sb.auth.getSession();
        email = data.session ? data.session.user.email : null;
        return email;
      },
      onAuthChange(cb) {
        sb.auth.onAuthStateChange((_evt, session) => {
          const next = session ? session.user.email : null;
          if (next !== email) { email = next; cb(email); }
        });
      },
      async signIn(addr) {
        const { error } = await sb.auth.signInWithOtp({
          email: addr,
          options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true },
        });
        if (error) throw error;
      },
      async signInWithPassword(addr, password) {
        const { error } = await sb.auth.signInWithPassword({ email: addr, password });
        if (error) throw error;
      },
      async signOut() { await sb.auth.signOut(); },
      async start(onData) {
        const allowed = await sb.rpc("am_i_allowed");
        if (allowed.error) throw allowed.error;
        if (!allowed.data) { const e = new Error("Email not on the allowed list"); e.code = "not_allowed"; throw e; }
        await loadRoles();
        listener = onData;
        onData(await loadAll());
        if (channel) sb.removeChannel(channel);
        channel = sb.channel("training-log")
          .on("postgres_changes", { event: "*", schema: "public", table: "ticks" }, scheduleReload)
          .on("postgres_changes", { event: "*", schema: "public", table: "notes" }, scheduleReload)
          .on("postgres_changes", { event: "*", schema: "public", table: "session_finishes" }, scheduleReload)
          .on("postgres_changes", { event: "*", schema: "public", table: "lift_maxes" }, scheduleReload);
        if (info.v2) {
          for (const table of ["programs", "wods", "wod_results", "notifications"]) channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, scheduleReload);
        }
        channel = channel.subscribe();
        // Catch up when the phone wakes the tab back up.
        document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleReload(); });
      },
      async saveTick(sid, eid, t) {
        const { error } = await sb.from("ticks").upsert(mine({
          session_id: sid, exercise_id: eid, sets: t.sets || {}, skipped: !!t.skipped, skip_reason: t.skipReason || null,
          updated_by_email: email, updated_at: new Date().toISOString(),
        }), info.v2 ? { onConflict: "athlete_email,session_id,exercise_id" } : undefined);
        if (error) throw error;
      },
      async finishSession(sid, summary, details) {
        const { error } = await sb.from("session_finishes").upsert(mine({
          session_id: sid, summary, details, finished_by_email: email, finished_at: new Date().toISOString(),
        }), info.v2 ? { onConflict: "athlete_email,session_id" } : undefined);
        if (error) throw error;
      },
      async reopenSession(sid) {
        const { error } = await scoped(sb.from("session_finishes").delete().eq("session_id", sid));
        if (error) throw error;
      },
      async saveMax(key, name, kg, on) {
        const { error } = await sb.from("lift_maxes").upsert(mine({
          lift_key: key, lift_name: name, kg, tested_on: on, updated_by_email: email, updated_at: new Date().toISOString(),
        }), info.v2 ? { onConflict: "athlete_email,lift_key" } : undefined);
        if (error) throw error;
      },
      async deleteMax(key) {
        const { error } = await scoped(sb.from("lift_maxes").delete().eq("lift_key", key));
        if (error) throw error;
      },
      async addNote(n) {
        const { data, error } = await sb.from("notes").insert(mine({
          session_id: n.session, exercise_id: n.ex, exercise_name: n.exName, body: n.text, author_email: email,
        })).select().single();
        if (error) throw error;
        return fromNoteRow(data);
      },
      async setReviewed(id, reviewed) {
        const { error } = await sb.from("notes").update({ reviewed, reviewed_by_email: reviewed ? email : null }).eq("id", id);
        if (error) throw error;
      },
      async deleteNote(id) {
        const { error } = await sb.from("notes").delete().eq("id", id);
        if (error) throw error;
      },
      async markNotificationsRead(ids) {
        if (!ids.length) return;
        const { error } = await sb.from("notifications").update({ read_at: new Date().toISOString() }).in("id", ids);
        if (error) console.warn(error);
      },
      async clearNotifications() {
        const { error } = await sb.from("notifications").delete().eq("recipient_email", (email || "").toLowerCase());
        if (error) throw error;
        if (listener) listener(await loadAll());
      },
      // An athlete logging their own WOD score.
      // r.detail (optional): rounds and timer splits (supabase/011). Before 011 has run, the
      // round times go into the note instead so they aren't lost.
      async addResult(r) {
        const row = {
          wod_id: r.wod, athlete_email: (email || "").toLowerCase(), score: r.score, rx: !!r.rx,
          performed_on: r.on || undefined, note: r.note || null, entered_by_email: email,
        };
        let { error } = await sb.from("wod_results").insert(r.detail ? Object.assign({ detail: r.detail }, row) : row);
        if (error && r.detail && /detail/.test(error.message || "")) {
          const extra = r.detailText ? (row.note ? row.note + " · " : "") + r.detailText : row.note;
          ({ error } = await sb.from("wod_results").insert(Object.assign({}, row, { note: extra ? extra.slice(0, 500) : null })));
        }
        if (error) throw error;
        // The board is ranked in the database, so fetch it again rather than waiting for the live update.
        if (listener) listener(await loadAll());
      },
    };
  }

  function localStore() {
    const KEY = "trae-training-log-demo";
    const me = "demo@this-device";
    function read() {
      let d = null;
      try { d = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
      d = d || {};
      return { ticks: d.ticks || {}, notes: d.notes || [], finishes: d.finishes || {}, maxes: d.maxes || {} };
    }
    function write(d) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) {} }
    let listener = null;
    const emit = () => listener && listener(read());
    return {
      mode: "demo",
      info: { v2: false, role: null, athletes: [], names: {} },
      async setAthlete() {},
      async addResult() {},
      async currentUser() { return me; },
      onAuthChange() {},
      async signIn() {},
      async signInWithPassword() {},
      async signOut() {},
      async start(onData) { listener = onData; emit(); },
      async saveTick(sid, eid, t) {
        const d = read();
        d.ticks[tickKey(sid, eid)] = { session: sid, ex: eid, sets: t.sets || {}, skipped: !!t.skipped, skipReason: t.skipReason || "", by: me, at: new Date().toISOString() };
        write(d);
      },
      async finishSession(sid, summary, details) {
        const d = read();
        d.finishes[sid] = { session: sid, by: me, at: new Date().toISOString(), summary, details };
        write(d);
      },
      async reopenSession(sid) {
        const d = read(); delete d.finishes[sid]; write(d);
      },
      async saveMax(key, name, kg, on) {
        const d = read(); d.maxes[key] = { lift: key, name, kg, on, by: me }; write(d);
      },
      async deleteMax(key) {
        const d = read(); delete d.maxes[key]; write(d);
      },
      async addNote(n) {
        const d = read();
        const note = Object.assign({ id: String(Date.now()) + Math.random().toString(36).slice(2, 6), by: me, at: new Date().toISOString(), reviewed: false }, n);
        d.notes.push(note); write(d); return note;
      },
      async setReviewed(id, reviewed) {
        const d = read();
        const n = d.notes.find((x) => x.id === id);
        if (n) { n.reviewed = reviewed; n.reviewedBy = reviewed ? me : null; }
        write(d);
      },
      async deleteNote(id) {
        const d = read(); d.notes = d.notes.filter((x) => x.id !== id); write(d);
      },
    };
  }

  const configured = cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase;
  window.TrainingStore = { create: () => (configured ? supabaseStore() : localStore()), tickKey };
  // A tab left open across a deploy keeps running the old code. When the tab comes back into view
  // (and every 10 minutes), compare the scripts' ETags with the ones it loaded, and if any changed
  // show a bar that reloads the page.
  window.TrainingStore.watchForUpdates = (files) => {
    const tags = {};
    const etag = (f) => fetch(f, { method: "HEAD", cache: "no-cache" }).then((r) => (r.ok && r.headers.get("etag")) || null).catch(() => null);
    let shown = false;
    async function check() {
      if (shown || document.hidden) return;
      for (const f of files) {
        const t = await etag(f);
        if (!t) continue;
        if (!(f in tags)) { tags[f] = t; continue; }
        if (tags[f] !== t) { shown = true; show(); return; }
      }
    }
    function show() {
      const bar = document.createElement("div");
      bar.className = "update-bar";
      bar.innerHTML = `<span>A new version is ready.</span><button type="button">Reload</button>`;
      bar.querySelector("button").addEventListener("click", () => location.reload());
      document.body.appendChild(bar);
    }
    check();
    document.addEventListener("visibilitychange", check);
    setInterval(check, 10 * 60 * 1000);
  };
  window.TrainingStore.createClient = () => (configured ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  }) : null);
})();
