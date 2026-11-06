/* ميزان — browser-side data layer for the standalone server.
   Exposes the same small API the app was written against (window.claude.use('db' | 'user')),
   backed by /api/sync (incremental, cached in IndexedDB) and /api/write (batched). */
(function () {
  'use strict';
  const H = { 'Content-Type': 'application/json', 'X-Mizan': '1' };
  const B = (window.__BASE__ || '');
  async function api(path, opts) {
    const r = await fetch((path && path.charAt(0) === '/' ? B + path : path), Object.assign({ credentials: 'same-origin' }, opts || {}));
    try { const sd = r.headers.get('date'); if (sd) { const t = new Date(sd).getTime(); if (t) window.MZ.skew = t - Date.now(); } } catch (e) {}
    if (r.status === 401) { location.href = B + '/login'; throw Object.assign(new Error('login'), { code: 'unauthenticated' }); }
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw Object.assign(new Error((j && j.error) || ('HTTP ' + r.status)), { code: r.status === 403 ? 'permission_denied' : 'server', status: r.status });
    return j;
  }
  window.MZ = {
    api,
    post: (p, b) => api(p, { method: 'POST', headers: H, body: JSON.stringify(b || {}) }),
    patch: (p, b) => api(p, { method: 'PATCH', headers: H, body: JSON.stringify(b || {}) }),
    me: null, users: [],
    async loadUsers() { try { this.users = await api('/api/users'); } catch (e) {} return this.users; },
    async logout() { try { await this.post('/api/logout'); } catch (e) {} try { await IDB.set(CK, null); } catch (e) {} location.href = B + '/login'; },
  };

  /* ---------- local cache ---------- */
  const IDB = {
    d: null,
    async open() { if (this.d) return this.d; this.d = await new Promise((res, rej) => { const r = indexedDB.open('mizan-server', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); return this.d; },
    async get(k) { try { const d = await this.open(); return await new Promise(res => { const t = d.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result || null); t.onerror = () => res(null); }); } catch (e) { return null; } },
    async set(k, v) { try { const d = await this.open(); await new Promise(res => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; t.onabort = res; }); } catch (e) {} },
  };
  const CK = 'store-v1';
  const store = {};           // col -> { id -> data }
  let seq = 0, ready = false, loading = null, saveT = null;
  const subs = [];
  const col = c => store[c] || (store[c] = {});

  function apply(docs) {
    const touched = new Set();
    for (const r of docs) {
      const m = col(r.c);
      if (r.x) delete m[r.i]; else m[r.i] = r.d;
      touched.add(r.c);
    }
    return touched;
  }
  function persist(userId) {
    clearTimeout(saveT);
    saveT = setTimeout(() => IDB.set(CK, { user: userId, seq, store }), 3000);
  }
  function match(q, d) {
    return q.w.every(([f, op, v]) => { const x = d && d[f]; if (x === undefined) return false; return op === '>' ? x > v : op === '>=' ? x >= v : op === '<' ? x < v : op === '==' ? x === v : true; });
  }
  function deliver(s) {
    const m = col(s.c), changes = [], ids = Object.keys(m).filter(id => match(s.q, m[id]));
    const live = new Set(ids);
    for (const id of ids) { const d = m[id]; if (s.seen[id] !== d) { changes.push({ type: s.seen[id] ? 'modified' : 'added', doc: { id, exists: true, data: () => d } }); s.seen[id] = d; } }
    for (const id of Object.keys(s.seen)) if (!live.has(id)) { changes.push({ type: 'removed', doc: { id, exists: false, data: () => undefined } }); delete s.seen[id]; }
    if (!changes.length && s.first) return;
    s.first = true;
    try {
      s.cb({ docs: ids.map(id => ({ id, exists: true, data: () => m[id] })), size: ids.length, empty: !ids.length,
        metadata: { fromCache: false, hasPendingWrites: false }, docChanges: () => changes });
    } catch (e) { console.error(e); }
  }
  function notify(cols) { for (const s of subs) if (!cols || cols.has(s.c)) deliver(s); }

  async function initialLoad() {
    const me = await api('/api/me'); MZ.me = me;
    const cached = await IDB.get(CK);
    if (cached && cached.user === me.id && cached.store) { Object.assign(store, cached.store); seq = cached.seq || 0; }
    const t0 = performance.now();
    const r = await api('/api/sync?since=' + seq);
    if (r.full) { for (const k of Object.keys(store)) delete store[k]; }
    apply(r.docs); seq = r.seq; ready = true;
    MZ.syncMs = Math.round(performance.now() - t0); MZ.synced = r.docs.length; MZ.fromCache = !r.full;
    if (r.docs.length) persist(me.id);
    MZ.loadUsers();
    poll();
  }
  let pollT = null, polling = false;
  async function pullNow() {
    if (polling || !ready) return; polling = true;
    try {
      const r = await api('/api/sync?since=' + seq);
      if (r.full) { for (const k of Object.keys(store)) delete store[k]; }
      if (r.docs.length) { const t = apply(r.docs); seq = Math.max(seq, r.seq); notify(t); persist(MZ.me.id); }
      else seq = Math.max(seq, r.seq);
      MZ.online = true;
    } catch (e) { MZ.online = false; }
    polling = false;
  }
  function poll() {
    clearTimeout(pollT);
    pollT = setTimeout(async () => { if (document.visibilityState !== 'hidden') await pullNow(); poll(); }, 4000);
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pullNow(); });

  /* ---------- writes (batched) ---------- */
  let q = [], qT = null, qW = [];
  function enqueue(op) {
    return new Promise((res, rej) => { q.push(op); qW.push([res, rej]); if (!qT) qT = setTimeout(flush, 25); });
  }
  async function flush() {
    const ops = q, w = qW; q = []; qW = []; qT = null;
    for (let k = 0; k < ops.length; k += 400) {
      const part = ops.slice(k, k + 400), pw = w.slice(k, k + 400);
      try {
        const r = await api('/api/write', { method: 'POST', headers: H, body: JSON.stringify({ ops: part }) });
        const t = apply(r.docs || []); notify(t); persist(MZ.me && MZ.me.id);
        pw.forEach(x => x[0]());
      } catch (e) { pw.forEach(x => x[1](e)); }
    }
  }

  function query(c, qq) {
    qq = qq || { w: [] };
    const Q = {
      where: (f, op, v) => query(c, { w: qq.w.concat([[f, op, v]]) }),
      orderBy: () => Q, limit: () => Q,
      onSnapshot(cb, err) {
        const s = { c, q: qq, cb, err, seen: {}, first: false };
        subs.push(s);
        (loading || (loading = initialLoad())).then(() => deliver(s)).catch(e => { if (e.code !== 'unauthenticated' && err) err(e); });
        return () => { const i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1); };
      },
      doc: id => ({
        set: d => enqueue({ op: 'set', c, i: id, d }),
        update: d => enqueue({ op: 'update', c, i: id, d }),
        delete: () => enqueue({ op: 'delete', c, i: id }),
        get: async () => { await (loading || (loading = initialLoad())); const d = col(c)[id]; return { exists: d !== undefined, data: () => d }; },
      }),
    };
    return Q;
  }
  const db = { collection: c => query(c) };

  const user = {
    async me() { await (loading || (loading = initialLoad())); return { id: MZ.me.id, name: MZ.me.name }; },
    async isOwner() { await (loading || (loading = initialLoad())); return !!MZ.me.owner; },
    async canEdit() { await (loading || (loading = initialLoad())); return !!MZ.me.owner; },
    async can() { return true; },
    async id() { await (loading || (loading = initialLoad())); return MZ.me.id; },
    async profiles(ids) { const us = MZ.users.length ? MZ.users : await MZ.loadUsers(); const o = {}; for (const id of ids) { const u = us.find(x => x.id === id); if (u) o[id] = { name: u.name }; } return o; },
  };
  window.claude = { use: async n => n === 'db' ? db : n === 'user' ? user : null };
  window.MZ_STANDALONE = true;
})();
