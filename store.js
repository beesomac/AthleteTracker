// Data layer: Supabase when configured, otherwise this device's localStorage (demo mode).
// Both expose the same shape so app.js doesn't care which one it's talking to.
(function () {
  const cfg = window.TRAINING_CONFIG || {};

  function tickKey(sid, eid) { return sid + "__" + eid; }

  function fromTickRow(r) {
    return { session: r.session_id, ex: r.exercise_id, sets: r.sets || {}, by: r.updated_by_email, at: r.updated_at };
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

    async function loadAll() {
      const [t, n] = await Promise.all([
        sb.from("ticks").select("*"),
        sb.from("notes").select("*").order("created_at", { ascending: true }),
      ]);
      if (t.error) throw t.error;
      if (n.error) throw n.error;
      const ticks = {};
      for (const r of t.data) ticks[tickKey(r.session_id, r.exercise_id)] = fromTickRow(r);
      return { ticks, notes: n.data.map(fromNoteRow) };
    }
    function scheduleReload() {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(async () => {
        try { listener && listener(await loadAll()); } catch (e) { console.warn(e); }
      }, 250);
    }

    return {
      mode: "shared",
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
        listener = onData;
        onData(await loadAll());
        if (channel) sb.removeChannel(channel);
        channel = sb.channel("training-log")
          .on("postgres_changes", { event: "*", schema: "public", table: "ticks" }, scheduleReload)
          .on("postgres_changes", { event: "*", schema: "public", table: "notes" }, scheduleReload)
          .subscribe();
        // Catch up when the phone wakes the tab back up.
        document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleReload(); });
      },
      async setTick(sid, eid, sets) {
        const { error } = await sb.from("ticks").upsert({
          session_id: sid, exercise_id: eid, sets, updated_by_email: email, updated_at: new Date().toISOString(),
        });
        if (error) throw error;
      },
      async addNote(n) {
        const { data, error } = await sb.from("notes").insert({
          session_id: n.session, exercise_id: n.ex, exercise_name: n.exName, body: n.text, author_email: email,
        }).select().single();
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
    };
  }

  function localStore() {
    const KEY = "trae-training-log-demo";
    const me = "demo@this-device";
    function read() {
      try { return JSON.parse(localStorage.getItem(KEY)) || { ticks: {}, notes: [] }; }
      catch (e) { return { ticks: {}, notes: [] }; }
    }
    function write(d) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) {} }
    let listener = null;
    const emit = () => listener && listener(read());
    return {
      mode: "demo",
      async currentUser() { return me; },
      onAuthChange() {},
      async signIn() {},
      async signInWithPassword() {},
      async signOut() {},
      async start(onData) { listener = onData; emit(); },
      async setTick(sid, eid, sets) {
        const d = read();
        d.ticks[tickKey(sid, eid)] = { session: sid, ex: eid, sets, by: me, at: new Date().toISOString() };
        write(d);
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
})();
