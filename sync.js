/* Khan Family Planner — sync layer.
   Gives the planner the same small document API it used inside Claude
   (collection/doc, onSnapshot, add/set/update/delete), backed by one Supabase table:
     docs(collection text, id text, data jsonb, updated_at timestamptz)
   - Everything is cached on the phone, so the planner opens and works offline.
   - Changes made offline wait in a queue and are sent when the connection is back.
   - Changes from the other phone arrive live (Supabase Realtime). */
(function () {
  const SB_URL = "https://onhzqbydulpsqtagfnri.supabase.co";
  const SB_KEY = "sb_publishable_ZlbF9qndF8A1CTvPGKdgHA_PRqURSsv";
  const CACHE_KEY = "kfp-cache-v1", OUT_KEY = "kfp-outbox-v1";

  const sb = window.supabase.createClient(SB_URL, SB_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "kfp-auth" }
  });

  const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || "null") ?? d; } catch (e) { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  let data = read(CACHE_KEY, {});      // { collection: { id: body } }
  let outbox = read(OUT_KEY, []);      // [{type:'set'|'delete', coll, id, data}]
  const listeners = new Set();
  const statusFns = new Set();
  let online = false, channel = null, flushing = false;

  /* ---------- status ---------- */
  function status() { return { online, pending: outbox.length }; }
  function emitStatus() { statusFns.forEach(f => { try { f(status()); } catch (e) {} }); }

  /* ---------- local view ---------- */
  function fire(l) {
    const c = data[l.coll] || {};
    if (l.docId) {
      const d = c[l.docId];
      l.cb({ id: l.docId, exists: !!d, data: () => clone(d), metadata: { fromCache: !online, hasPendingWrites: false } });
      return;
    }
    const docs = Object.keys(c).map(id => ({ id, exists: true, data: () => clone(c[id]), _d: c[id] }));
    if (l.orderBy) docs.sort((a, b) => { const x = a._d[l.orderBy], y = b._d[l.orderBy]; return x == null ? 1 : y == null ? -1 : x < y ? -1 : x > y ? 1 : 0; });
    else docs.sort((a, b) => (a.id < b.id ? -1 : 1));
    l.cb({ docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: !online, hasPendingWrites: outbox.length > 0 } });
  }
  function emit(coll) { listeners.forEach(l => { if (!coll || l.coll === coll) fire(l); }); }
  function applyLocal(op) {
    const c = data[op.coll] || (data[op.coll] = {});
    if (op.type === "delete") delete c[op.id]; else c[op.id] = clone(op.data);
    store(CACHE_KEY, data); emit(op.coll);
  }

  /* ---------- server ---------- */
  const isNetworkError = e => !e || e.name === "TypeError" || /fetch|network|Failed to|Load failed/i.test(e.message || "") || e.status === 0;
  const isDenied = e => e && (e.code === "42501" || e.status === 401 || e.status === 403 || /row-level security|permission denied|JWT/i.test(e.message || ""));

  async function push(op) {
    const q = op.type === "delete"
      ? sb.from("docs").delete().match({ collection: op.coll, id: op.id })
      : sb.from("docs").upsert({ collection: op.coll, id: op.id, data: op.data, updated_at: new Date().toISOString() });
    const { error, status: st } = await q;
    if (error) { error.status = error.status ?? st; throw error; }
  }

  async function flush() {
    if (flushing || !outbox.length) { emitStatus(); return; }
    flushing = true;
    try {
      while (outbox.length) {
        try { await push(outbox[0]); }
        catch (e) {
          if (isDenied(e)) { const bad = outbox.shift(); store(OUT_KEY, outbox); await refresh(true); throw Object.assign(new Error("Not allowed"), { code: "invalid_argument", op: bad }); }
          throw e;
        }
        outbox.shift(); store(OUT_KEY, outbox);
      }
      online = true;
    } catch (e) {
      if (e.code === "invalid_argument") throw e;
      online = false;
    } finally { flushing = false; emitStatus(); }
  }

  async function write(op) {
    applyLocal(op);
    outbox.push(clone(op)); store(OUT_KEY, outbox); emitStatus();
    await flush();               // resolves when saved, or when queued because the phone is offline
  }

  async function refresh(quiet) {
    const { data: rows, error } = await sb.from("docs").select("collection,id,data").range(0, 9999);
    if (error) { if (!quiet) { online = false; emitStatus(); } throw error; }
    const next = {};
    for (const r of rows || []) (next[r.collection] || (next[r.collection] = {}))[r.id] = r.data;
    for (const op of outbox) {                    // keep changes that have not reached the server yet
      const c = next[op.coll] || (next[op.coll] = {});
      if (op.type === "delete") delete c[op.id]; else c[op.id] = op.data;
    }
    data = next; store(CACHE_KEY, data); online = true; emit(); emitStatus();
  }

  function subscribe() {
    if (channel) return;
    channel = sb.channel("kfp-docs")
      .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, p => {
        const row = p.eventType === "DELETE" ? p.old : p.new;
        if (!row || !row.collection) return;
        if (outbox.some(o => o.coll === row.collection && o.id === row.id)) return; // our own unsent edit wins locally
        const c = data[row.collection] || (data[row.collection] = {});
        if (p.eventType === "DELETE") delete c[row.id]; else c[row.id] = row.data;
        store(CACHE_KEY, data); emit(row.collection);
      })
      .subscribe(s => {
        if (s === "SUBSCRIBED") { online = true; emitStatus(); refresh(true).catch(() => {}); }
        if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") { online = false; emitStatus(); }
      });
  }

  let started = false;
  async function start() {
    if (started) return; started = true;
    emit(); emitStatus();
    try { await flush(); } catch (e) {}
    try { await refresh(); } catch (e) {}
    subscribe();
    window.addEventListener("online", () => { flush().catch(() => {}); refresh(true).catch(() => {}); });
    window.addEventListener("offline", () => { online = false; emitStatus(); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { flush().catch(() => {}); refresh(true).catch(() => {}); } });
    setInterval(() => { if (outbox.length) flush().catch(() => {}); }, 20000);
  }

  /* ---------- the document API the planner uses ---------- */
  function docRef(coll, id) {
    return {
      id, path: coll + "/" + id,
      set: body => write({ type: "set", coll, id, data: clone(body) }),
      update: patch => {
        const cur = (data[coll] || {})[id];
        if (!cur) return Promise.reject(Object.assign(new Error("Item no longer exists"), { code: "not_found" }));
        return write({ type: "set", coll, id, data: { ...clone(cur), ...clone(patch) } });
      },
      delete: () => write({ type: "delete", coll, id }),
      onSnapshot(cb) { const l = { coll, docId: id, cb }; listeners.add(l); fire(l); return () => listeners.delete(l); }
    };
  }
  function collRef(coll, orderBy) {
    return {
      path: coll,
      orderBy: f => collRef(coll, f),
      doc: id => docRef(coll, id || newId()),
      add: async body => { const id = newId(); await write({ type: "set", coll, id, data: clone(body) }); return docRef(coll, id); },
      onSnapshot(cb) { const l = { coll, orderBy, cb }; listeners.add(l); fire(l); return () => listeners.delete(l); }
    };
  }
  const db = {
    collection: c => collRef(c),
    doc: path => { const [c, id] = path.split("/"); return docRef(c, id); }
  };

  /* ---------- auth ---------- */
  const auth = {
    async session() { const { data: d } = await sb.auth.getSession(); return d && d.session; },
    async signIn(email, password) {
      const { data: d, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return d.session;
    },
    async signOut() {
      try { await sb.auth.signOut(); } catch (e) {}
      try { localStorage.removeItem(CACHE_KEY); localStorage.removeItem(OUT_KEY); localStorage.removeItem("kfp-auth"); } catch (e) {}
    },
    onChange(fn) { sb.auth.onAuthStateChange((ev, s) => fn(ev, s)); }
  };

  window.KFP = { db, auth, start, onStatus: f => { statusFns.add(f); f(status()); }, hasCache: () => Object.keys(data).length > 0 };
})();
