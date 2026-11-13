'use strict';
/* صيدلية الجزار — ERP mounted as a sub-app under /erp of the delivery server.
   Shares the same Postgres database but lives entirely in its own schema (default "saydaliya"),
   so the delivery app's tables and data are never touched. Any failure here is contained and
   must NOT bring down the parent (delivery) service. */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const SCHEMA = (process.env.ERP_SCHEMA || 'saydaliya').replace(/[^a-zA-Z0-9_]/g, '') || 'saydaliya';

/* توحيد عربي موسّع للبحث: يشيل التشكيل، ويوحّد الألف/الياء/التاء المربوطة/الهمزات،
   والكاف والياء الفارسية، والأرقام العربية↔اللاتينية (٥٠٠ = 500). */
const NORM_FROM = 'أإآىئؤةکی٠١٢٣٤٥٦٧٨٩';
const NORM_TO = 'اااييوهكي0123456789';
// يشيل التشكيل والهمزة، ثم علامات الترقيم (شرطة/نقطة/قوس/شرطة سفلية…) لتوحيد مثل URI-VIN = URIVIN، ثم يوحّد الحروف/الأرقام
function normSql(expr) { return `lower(translate(regexp_replace(regexp_replace(${expr}, '[ًٌٍَُِّْـء]', '', 'g'), '[-./()+_'',*&]', '', 'g'), '${NORM_FROM}', '${NORM_TO}'))`; }
const SEARCH_VER = '4'; // ابعته كل ما يتغيّر تعبير normSql عشان الأعمدة المخزّنة تتبني من جديد
let SCOLS = false; // هل أعمدة البحث المخزّنة (sname/sall) متاحة؟ بتتحدد في migrate

const app = express();
app.set('trust proxy', 1);

// If there is no database, mount a friendly notice instead of crashing the parent.
if (!DATABASE_URL) {
  app.use((_req, res) => res.status(503).send('صيدلية: قاعدة البيانات غير مهيأة (DATABASE_URL).'));
  module.exports = app;
  return;
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1|\/tmp|host=\//.test(DATABASE_URL) || process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
  max: 6,
});
pool.on('error', e => console.error('[erp] pool error', e.message));
pool.on('connect', c => { c.query(`SET search_path TO "${SCHEMA}"`).catch(() => {}); });

const SESSION_DAYS = 30;
const COOKIE = 'sd_s';
const now = () => Date.now();
const uidGen = (p = 'u_') => p + crypto.randomBytes(16).toString('base64url').slice(0, 22);

function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('base64') + '$' + h.toString('base64');
}
function checkPw(pw, stored) {
  try {
    const [, s, h] = String(stored).split('$');
    const want = Buffer.from(h, 'base64');
    const got = crypto.scryptSync(String(pw), Buffer.from(s, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(want, got);
  } catch (e) { return false; }
}
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function mergeDoc(cur, patch) {
  const out = isObj(cur) ? { ...cur } : {};
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (isObj(v) && isObj(out[k])) out[k] = { ...out[k], ...v };
    else out[k] = v;
  }
  return out;
}
function cookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}

let ready = false, migrateErr = null;
async function migrate() {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS doc_seq;
    CREATE TABLE IF NOT EXISTS docs (
      col text NOT NULL, id text NOT NULL, data jsonb, deleted boolean NOT NULL DEFAULT false,
      seq bigint NOT NULL DEFAULT nextval('doc_seq'), updated_at bigint NOT NULL DEFAULT 0, updated_by text,
      PRIMARY KEY (col, id));
    CREATE INDEX IF NOT EXISTS docs_seq_idx ON docs (seq);
    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY, username text UNIQUE NOT NULL, name text NOT NULL, pass text NOT NULL,
      role text NOT NULL DEFAULT 'cashier', owner boolean NOT NULL DEFAULT false,
      disabled boolean NOT NULL DEFAULT false, created_at bigint NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions (
      token text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at bigint NOT NULL, last_seen bigint NOT NULL);
  `);
  // أعمدة بحث مطبّعة مخزّنة (Postgres يحافظ عليها تلقائيًا) — بدل حساب التطبيع لكل صنف في كل استعلام
  // sname = الاسم مطبّع، sall = اسم+باركود+مسلسل مطبّع. تتبني مرة واحدة، وتتعاد لو اتغيّر تعبير التطبيع (SEARCH_VER).
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS erp_meta(k text PRIMARY KEY, v text)`);
    const cur = (await pool.query(`SELECT v FROM erp_meta WHERE k='search_cols_ver'`)).rows[0];
    if (!cur || cur.v !== SEARCH_VER) {
      await pool.query(`ALTER TABLE docs DROP COLUMN IF EXISTS sname`);
      await pool.query(`ALTER TABLE docs DROP COLUMN IF EXISTS sall`);
      await pool.query(`ALTER TABLE docs ADD COLUMN sname text GENERATED ALWAYS AS (${normSql("COALESCE(data->>'name','')")}) STORED`);
      await pool.query(`ALTER TABLE docs ADD COLUMN sall text GENERATED ALWAYS AS (${normSql("COALESCE(data->>'name','')||' '||COALESCE(data->>'name_ar','')||' '||COALESCE(data->>'barcode','')||' '||COALESCE(data->>'serial','')")}) STORED`);
      await pool.query(`INSERT INTO erp_meta(k,v) VALUES('search_cols_ver',$1) ON CONFLICT(k) DO UPDATE SET v=$1`, [SEARCH_VER]);
      console.log('[erp] search columns rebuilt to ver', SEARCH_VER);
    }
    SCOLS = true; console.log('[erp] search columns ready');
  } catch (e) { SCOLS = false; console.warn('[erp] search columns unavailable (fallback to expressions):', (e.message || '').split('\n')[0]); }
  // فهارس الأداء (best-effort — أي فشل ما يوقفش الإقلاع) — تسرّع البحث والتجميعات مع كبر البيانات
  const perfIdx = [
    `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
    // فهارس قديمة (تعابير) — تتشال، البحث بقى على الأعمدة المخزّنة
    `DROP INDEX IF EXISTS docs_items_trgm`, `DROP INDEX IF EXISTS docs_cust_trgm`,
    `DROP INDEX IF EXISTS docs_items_nall`, `DROP INDEX IF EXISTS docs_items_nname`,
    // بحث الأصناف على الأعمدة المخزّنة: btree للبادئة (سريع جدًا للحروف الأولى) + trigram للـ«أي مكان» والتقارب
    `CREATE INDEX IF NOT EXISTS docs_sname_pat ON docs (sname text_pattern_ops) WHERE col='items' AND NOT deleted`,
    `CREATE INDEX IF NOT EXISTS docs_sall_pat ON docs (sall text_pattern_ops) WHERE col='items' AND NOT deleted`,
    `CREATE INDEX IF NOT EXISTS docs_sname_trgm ON docs USING gin (sname gin_trgm_ops) WHERE col='items' AND NOT deleted`,
    `CREATE INDEX IF NOT EXISTS docs_sall_trgm ON docs USING gin (sall gin_trgm_ops) WHERE col='items' AND NOT deleted`,
    // بحث العملاء (اسم/هاتف)
    `CREATE INDEX IF NOT EXISTS docs_cust_n ON docs USING gin ((${normSql("COALESCE(data->>'name','')||' '||COALESCE(data->>'phone','')")}) gin_trgm_ops) WHERE col='customers' AND NOT deleted`,
    // الفواتير/المبيعات بالتاريخ (ملخّص لوحة التحكم + شاشة الفواتير)
    `CREATE INDEX IF NOT EXISTS docs_sales_date ON docs ((data->>'date')) WHERE col='sales' AND NOT deleted`,
    `CREATE INDEX IF NOT EXISTS docs_sales_ts ON docs (((data->>'ts')::bigint)) WHERE col='sales' AND NOT deleted`,
  ];
  // بناء الفهارس في الخلفية — ما يأخّرش إقلاع السيرفر ولا يفشّله
  (async () => { for (const sql of perfIdx) { try { await pool.query(sql); } catch (e) { console.warn('[erp] idx skip:', (e.message || '').split('\n')[0]); } } console.log('[erp] perf indexes ready'); })();
  const { rows } = await pool.query('SELECT count(*)::int n FROM users');
  if (rows[0].n === 0) {
    const u = (process.env.ERP_ADMIN_USER || 'owner').trim().toLowerCase();
    const p = process.env.ERP_ADMIN_PASSWORD;
    if (p && p.length >= 6) {
      await pool.query('INSERT INTO users(id,username,name,pass,role,owner,created_at) VALUES($1,$2,$3,$4,$5,true,$6)',
        [uidGen(), u, process.env.ERP_ADMIN_NAME || 'المالك', hashPw(p), 'owner', now()]);
      console.log('[erp] owner account created:', u);
    } else {
      console.warn('[erp] no ERP_ADMIN_PASSWORD set — owner not created yet');
    }
  }
  // إعادة تعيين كلمة مرور المالك عند الحاجة (متغيّر بيئة لمرة واحدة — يُحذف بعد الاستخدام)
  const rp = process.env.ERP_RESET_PW;
  if (rp && rp.length >= 6) {
    const ru = (process.env.ERP_ADMIN_USER || 'owner').trim().toLowerCase();
    const r = await pool.query('UPDATE users SET pass=$1, disabled=false WHERE lower(username)=$2',
      [hashPw(rp), ru]);
    console.log('[erp] owner password reset:', ru, 'rows:', r.rowCount);
  }
  ready = true;
}
const migrating = migrate().catch(e => { migrateErr = e; console.error('[erp] migrate failed (ERP disabled, delivery unaffected):', e.message); });

app.use(express.json({ limit: '2mb' }));

async function userByToken(tok) {
  if (!tok) return null;
  const { rows } = await pool.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND u.disabled=false`, [tok]);
  if (!rows[0]) return null;
  pool.query('UPDATE sessions SET last_seen=$1 WHERE token=$2', [now(), tok]).catch(() => {});
  return rows[0];
}
async function auth(req, res, next) {
  try {
    const u = await userByToken(cookies(req)[COOKIE]);
    if (!u) return res.status(401).json({ error: 'unauthenticated' });
    req.user = u; next();
  } catch (e) { res.status(503).json({ error: 'db' }); }
}
const base = req => req.baseUrl || '/erp';

app.get('/healthz', (_req, res) => res.type('text').send(ready ? 'ok' : (migrateErr ? 'db-error' : 'starting')));

app.post('/api/login', async (req, res) => {
  try {
    const u = String(req.body.username || '').trim().toLowerCase();
    const p = String(req.body.password || '');
    const { rows } = await pool.query('SELECT * FROM users WHERE username=$1 AND disabled=false', [u]);
    if (!rows[0] || !checkPw(p, rows[0].pass)) return res.status(401).json({ error: 'بيانات الدخول غلط' });
    const tok = crypto.randomBytes(32).toString('base64url');
    await pool.query('INSERT INTO sessions(token,user_id,created_at,last_seen) VALUES($1,$2,$3,$3)', [tok, rows[0].id, now()]);
    res.setHeader('Set-Cookie', `${COOKIE}=${tok}; Path=${base(req)}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${req.secure ? '; Secure' : ''}`);
    res.json({ ok: true });
  } catch (e) { res.status(503).json({ error: 'server' }); }
});
app.post('/api/logout', async (req, res) => {
  const tok = cookies(req)[COOKIE];
  if (tok) await pool.query('DELETE FROM sessions WHERE token=$1', [tok]).catch(() => {});
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=${base(req)}; HttpOnly; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) =>
  res.json({ id: req.user.id, name: req.user.name, username: req.user.username, role: req.user.role, owner: req.user.owner }));

app.get('/api/users', auth, async (_req, res) => {
  const { rows } = await pool.query('SELECT id,name,username,role,owner,disabled FROM users ORDER BY created_at');
  res.json(rows);
});

app.get('/api/sync', auth, async (req, res) => {
  const since = parseInt(req.query.since, 10) || 0;
  // الفواتير والأصناف مش بتتزامن للعميل (كتير جدًا) — بتتقرى من endpoints مخصصة عشان الأداء
  const { rows } = await pool.query(
    "SELECT col,id,data,deleted,seq FROM docs WHERE seq>$1 AND col NOT IN ('sales','items','customers') ORDER BY seq LIMIT 20000", [since]);
  let seq = since;
  const docs = rows.map(r => { if (r.seq > seq) seq = Number(r.seq); return r.deleted ? { c: r.col, i: r.id, x: true } : { c: r.col, i: r.id, d: r.data }; });
  // تقديم المؤشر لتخطّي مستندات الفواتير المستبعَدة (طالما مفيش صفحة ممتلئة)
  if (rows.length < 20000) {
    const mx = await pool.query('SELECT COALESCE(MAX(seq),$1) m FROM docs WHERE seq>$1', [since]);
    const m = Number(mx.rows[0].m); if (m > seq) seq = m;
  }
  res.json({ full: since === 0, docs, seq });
});

/* كاش بسيط للملخّصات — يخفّف المسح المتكرر على السيرفر المجاني (يتصفّر عند أي كتابة) */
const _sum = new Map();
async function memo(key, ttl, fn) { const c = _sum.get(key); if (c && Date.now() - c.t < ttl) return c.v; const v = await fn(); _sum.set(key, { t: Date.now(), v }); return v; }
function bustSummaries() { _sum.clear(); }

// ملخّص المبيعات للوحة التحكم (محسوب في السيرفر — رد صغير وسريع، بكاش ٦٠ث)
app.get('/api/sales-summary', auth, async (_req, res) => {
  try {
    const out = await memo('sales', 60000, async () => {
    const daily = await pool.query(
      `SELECT d.data->>'date' AS day,
              SUM((d.data->>'total')::numeric) AS sales,
              SUM(COALESCE(li.p,0)) - SUM(COALESCE((d.data->>'discount')::numeric,0)) AS profit,
              count(*) AS n
       FROM docs d
       LEFT JOIN LATERAL (
         SELECT SUM(((l->>'price')::numeric - COALESCE((l->>'cost')::numeric,0)) * (l->>'qty')::numeric) AS p
         FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.data->'lines')='array' THEN d.data->'lines' ELSE '[]'::jsonb END) l
       ) li ON true
       WHERE d.col='sales' AND NOT d.deleted
         AND d.data->>'date' >= to_char((now() AT TIME ZONE 'Africa/Cairo')::date - 34, 'YYYY-MM-DD')
       GROUP BY day`);
    const top = await pool.query(
      `SELECT l->>'name' AS name,
              SUM((l->>'qty')::numeric) AS qty,
              SUM((l->>'price')::numeric*(l->>'qty')::numeric) AS val
       FROM docs d, jsonb_array_elements(CASE WHEN jsonb_typeof(d.data->'lines')='array' THEN d.data->'lines' ELSE '[]'::jsonb END) l
       WHERE d.col='sales' AND NOT d.deleted
         AND d.data->>'date' >= to_char((now() AT TIME ZONE 'Africa/Cairo')::date - 30, 'YYYY-MM-DD')
       GROUP BY name ORDER BY val DESC NULLS LAST LIMIT 6`);
    return { daily: daily.rows, top: top.rows };
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'summary', detail: e.message }); }
});

// الفواتير عند الطلب (صفحة بصفحة) — بدل مزامنتها كلها
app.get('/api/invoices', auth, async (req, res) => {
  try {
    const days = Math.min(400, Math.max(1, parseInt(req.query.days, 10) || 30));
    const lim = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 300));
    const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const qraw = String(req.query.q || '').trim();
    const qlike = '%' + qraw.replace(/[%_]/g, '') + '%';
    const { rows } = await pool.query(
      `SELECT id, data FROM docs
       WHERE col='sales' AND NOT deleted
         AND data->>'date' >= to_char((now() AT TIME ZONE 'Africa/Cairo')::date - $1::int, 'YYYY-MM-DD')
         AND ($2='' OR data->>'customer' ILIKE $3 OR data->>'no' ILIKE $3)
       ORDER BY (data->>'ts')::bigint DESC NULLS LAST
       LIMIT $4 OFFSET $5`, [days, qraw, qlike, lim, off]);
    res.json(rows.map(r => Object.assign({ id: r.id }, r.data)));
  } catch (e) { res.status(500).json({ error: 'invoices', detail: e.message }); }
});

app.post('/api/write', auth, async (req, res) => {
  const ops = Array.isArray(req.body.ops) ? req.body.ops : [];
  if (!ops.length) return res.json({ docs: [] });
  const client = await pool.connect();
  const out = [];
  try {
    await client.query(`SET search_path TO "${SCHEMA}"`);
    await client.query('BEGIN');
    for (const op of ops) {
      const c = String(op.c || ''), i = String(op.i || '');
      if (!c || !i) continue;
      if (op.op === 'delete') {
        await client.query(`UPDATE docs SET deleted=true, seq=nextval('doc_seq'), updated_at=$3, updated_by=$4 WHERE col=$1 AND id=$2`,
          [c, i, now(), req.user.id]);
        out.push({ c, i, x: true });
      } else {
        let data = op.d || {};
        if (op.op === 'update') {
          const cur = await client.query('SELECT data FROM docs WHERE col=$1 AND id=$2', [c, i]);
          data = mergeDoc(cur.rows[0] ? cur.rows[0].data : {}, data);
        }
        await client.query(
          `INSERT INTO docs(col,id,data,deleted,seq,updated_at,updated_by) VALUES($1,$2,$3,false,nextval('doc_seq'),$4,$5)
           ON CONFLICT (col,id) DO UPDATE SET data=EXCLUDED.data, deleted=false, seq=nextval('doc_seq'), updated_at=$4, updated_by=$5`,
          [c, i, data, now(), req.user.id]);
        out.push({ c, i, d: data });
      }
    }
    await client.query('COMMIT');
    bustSummaries();
    res.json({ docs: out });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.status(500).json({ error: 'write' }); }
  finally { client.release(); }
});

app.post('/api/users', auth, async (req, res) => {
  if (!req.user.owner) return res.status(403).json({ error: 'للمالك فقط' });
  const { username, name, password, role } = req.body || {};
  const u = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]{2,32}$/.test(u)) return res.status(400).json({ error: 'اسم مستخدم غير صالح' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'كلمة المرور 6 أحرف على الأقل' });
  try {
    await pool.query('INSERT INTO users(id,username,name,pass,role,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [uidGen(), u, String(name || u), hashPw(password), role === 'owner' ? 'owner' : (role || 'cashier'), now()]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: 'الاسم مستخدم بالفعل' }); }
});

/* ---- Genius mirror ingest (token-protected bulk upsert; no DB exposure) ---- */
app.post('/api/ingest', async (req, res) => {
  const tok = process.env.ERP_SYNC_TOKEN;
  if (!tok || req.get('X-Sync-Token') !== tok) return res.status(403).json({ error: 'forbidden' });
  const col = String((req.body && req.body.collection) || '');
  if (!col) return res.status(400).json({ error: 'collection required' });
  const docs = Array.isArray(req.body.docs) ? req.body.docs : [];
  const client = await pool.connect();
  let changed = 0, deleted = 0;
  try {
    await client.query(`SET search_path TO "${SCHEMA}"`);
    await client.query('BEGIN');
    for (const d of docs) {
      const id = String((d && d.id) || '');
      if (!id) continue;
      const r = await client.query(
        `INSERT INTO docs(col,id,data,deleted,seq,updated_at,updated_by)
           VALUES($1,$2,$3,false,nextval('doc_seq'),$4,'genius')
         ON CONFLICT (col,id) DO UPDATE SET data=EXCLUDED.data, deleted=false,
           seq=nextval('doc_seq'), updated_at=$4, updated_by='genius'
         WHERE docs.data IS DISTINCT FROM EXCLUDED.data OR docs.deleted`,
        [col, id, d.data || {}, now()]);
      if (r.rowCount > 0) changed++;
    }
    // optional: soft-delete Genius-sourced docs in this collection that are no longer present
    if (req.body.purge && Array.isArray(req.body.keepIds)) {
      const keep = req.body.keepIds.map(String);
      const r = await client.query(
        `UPDATE docs SET deleted=true, seq=nextval('doc_seq'), updated_at=$2, updated_by='genius'
         WHERE col=$1 AND updated_by='genius' AND NOT deleted AND id <> ALL($3::text[])`,
        [col, now(), keep]);
      deleted = r.rowCount;
    }
    await client.query('COMMIT');
    if (changed || deleted) bustSummaries();
    res.json({ ok: true, collection: col, received: docs.length, changed, deleted });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'ingest', detail: e.message });
  } finally { client.release(); }
});

/* ---- تكامل: قراءة عملاء التوصيل (نفس القاعدة، سكيمة public) ---- */
app.get('/api/delivery-clients', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.area, c.orders_count,
         COALESCE(array_agg(DISTINCT p.phone) FILTER (WHERE p.phone IS NOT NULL), '{}') AS phones
       FROM public.clients c LEFT JOIN public.client_phones p ON p.client_id = c.id
       GROUP BY c.id ORDER BY c.orders_count DESC NULLS LAST LIMIT 5000`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'clients', detail: e.message }); }
});

/* ---- تكامل: قراءة طلبات التوصيل من قاعدة الدليفري (نفس القاعدة، سكيمة public) ---- */
app.get('/api/delivery-orders', auth, async (req, res) => {
  try {
    const date = String(req.query.date || '').trim();
    let where, params = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) { where = 'o.day = $1'; params = [date]; }
    else { const days = Math.min(120, Math.max(1, parseInt(req.query.days, 10) || 3)); where = 'o.day >= (CURRENT_DATE - $1::int)'; params = [days]; }
    const { rows } = await pool.query(
      `SELECT o.id, o.no, o.day, o.customer, o.phone, o.address, o.area, o.items, o.amount, o.payment,
              o.status, o.source, o.promise_min, o.created_at, o.out_at, o.delivered_at, o.driver_id, d.name AS driver
       FROM public.orders o LEFT JOIN public.users d ON d.id = o.driver_id
       WHERE ${where} ORDER BY o.created_at DESC LIMIT 800`, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'delivery', detail: e.message }); }
});

// تغيير حالة طلب توصيل من الصيدلية (جاهز للتوصيل / تم / إلغاء) — متوافق مع منطق الدليفري
app.post('/api/delivery-status', auth, async (req, res) => {
  try {
    const orderId = parseInt(req.body && req.body.orderId, 10);
    const status = String(req.body && req.body.status || '');
    const driverId = (req.body && req.body.driverId) ? parseInt(req.body.driverId, 10) : null;
    if (!orderId) return res.status(400).json({ error: 'طلب غير صحيح' });
    const cur = await pool.query(`SELECT driver_id, status FROM public.orders WHERE id=$1`, [orderId]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'الأوردر مش موجود' });
    let sql, params, note;
    if (status === 'out') {
      const drv = driverId || cur.rows[0].driver_id;
      if (!drv) return res.status(400).json({ error: 'اختار المندوب الأول' });
      const d = await pool.query(`SELECT id FROM public.users WHERE id=$1 AND role='driver' AND active`, [drv]);
      if (!d.rows[0]) return res.status(400).json({ error: 'الطيار مش موجود' });
      sql = `UPDATE public.orders SET driver_id=$2, status='out', out_at=COALESCE(out_at,now()), updated_at=now() WHERE id=$1`; params = [orderId, drv]; note = 'خروج للتوصيل من الصيدلية';
    } else if (status === 'ready') { sql = `UPDATE public.orders SET status='ready', ready_at=now(), updated_at=now() WHERE id=$1`; params = [orderId]; note = 'تجهيز من الصيدلية';
    } else if (status === 'done') { sql = `UPDATE public.orders SET status='done', delivered_at=now(), updated_at=now() WHERE id=$1`; params = [orderId]; note = 'تم التوصيل من الصيدلية';
    } else if (status === 'cancel') { sql = `UPDATE public.orders SET status='cancel', updated_at=now() WHERE id=$1`; params = [orderId]; note = 'إلغاء من الصيدلية';
    } else return res.status(400).json({ error: 'حالة غير معروفة' });
    await pool.query(sql, params);
    await pool.query(`INSERT INTO public.order_changes(order_id,user_id,kind,fields,note) VALUES ($1,NULL,'status',$2,$3)`,
      [orderId, JSON.stringify({ status: [cur.rows[0].status, status === 'out' ? 'out' : status] }), note]).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'status', detail: e.message }); }
});

// قائمة المندوبين (من قاعدة الدليفري)
app.get('/api/drivers', auth, async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, name FROM public.users WHERE role='driver' AND active ORDER BY name`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'drivers', detail: e.message }); }
});

// تعيين مندوب لطلب توصيل (متوافق مع منطق الدليفري + تسجيل في order_changes)
app.post('/api/delivery-assign', auth, async (req, res) => {
  try {
    const orderId = parseInt(req.body && req.body.orderId, 10);
    const driverId = (req.body && req.body.driverId) ? parseInt(req.body.driverId, 10) : null;
    if (!orderId) return res.status(400).json({ error: 'طلب غير صحيح' });
    if (driverId) {
      const d = await pool.query(`SELECT id FROM public.users WHERE id=$1 AND role='driver' AND active`, [driverId]);
      if (!d.rows[0]) return res.status(400).json({ error: 'الطيار مش موجود' });
    }
    const cur = await pool.query(`SELECT driver_id, status FROM public.orders WHERE id=$1`, [orderId]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'الأوردر مش موجود' });
    if (['done', 'cancel'].includes(cur.rows[0].status)) return res.status(400).json({ error: 'الأوردر خلص' });
    await pool.query(`UPDATE public.orders SET driver_id=$2, updated_at=now() WHERE id=$1`, [orderId, driverId]);
    await pool.query(
      `INSERT INTO public.order_changes(order_id,user_id,kind,fields,note) VALUES ($1,NULL,'edit',$2,'تعيين مندوب من الصيدلية')`,
      [orderId, JSON.stringify({ driver_id: [cur.rows[0].driver_id, driverId] })]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'assign', detail: e.message }); }
});

/* ---- بحث الأصناف الذكي (خادمي، على كل الأصناف) + قائمة + ملخّص مخزون ---- */
// توحيد عربي: إزالة التشكيل والهمزات وتوحيد الألف/الياء/التاء المربوطة — في SQL وفي Node بنفس الطريقة
const AR_NORM_SQL = normSql("COALESCE(data->>'name','')||' '||COALESCE(data->>'name_ar','')||' '||COALESCE(data->>'barcode','')||' '||COALESCE(data->>'serial','')");
const NAME_NORM_SQL = normSql("COALESCE(data->>'name','')");
function arNorm(s){ return String(s||'').toLowerCase().replace(/[ًٌٍَُِّْـء]/g,'').replace(/[-./()+_'*&,]/g,'').replace(/[أإآ]/g,'ا').replace(/[ىئی]/g,'ي').replace(/ؤ/g,'و').replace(/ة/g,'ه').replace(/ک/g,'ك').replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).trim(); }

/* بحث الأصناف الموحّد (نقطة البيع + المخزون) — دقيق ومتوقّع:
   الأساس: كل كلمة لازم تكون *جزء فعلي (substring)* من النص (اسم+باركود+مسلسل) — مفيش تقارب يجيب حاجة غلط.
   الترتيب: يبدأ بالبحث ← الاسم فيه البحث كبداية كلمة ← كل الكلمات بداية كلمات ← الاسم.
   التقارب (أخطاء الكتابة) بيشتغل *بس* لو كلمة واحدة ومفيش ولا نتيجة substring — كملاذ أخير زي «هل تقصد؟». */
async function searchItems(raw, o) {
  const lim = o.lim, off = o.off || 0;
  const SN = SCOLS ? 'sname' : NAME_NORM_SQL, SA = SCOLS ? 'sall' : AR_NORM_SQL;
  const toks = String(raw || '').trim().split(/\s+/).filter(Boolean).slice(0, 6).map(arNorm).filter(Boolean);
  const qf = arNorm(raw || '');
  const base = ["col='items'", 'NOT deleted'];
  if (o.low) base.push(`(data->>'min')::numeric>0 AND (data->>'stock')::numeric<=(data->>'min')::numeric`);
  if (o.instock) base.push(`COALESCE(NULLIF(data->>'stock','')::numeric,0) > 0`);
  const B = base.join(' AND ');
  if (!toks.length) {
    return (await pool.query(`SELECT id,data FROM docs WHERE ${B} ORDER BY ${SN} LIMIT $1 OFFSET $2`, [lim, off])).rows;
  }
  // الأساس: كل كلمة substring (في الاسم/الباركود/المسلسل)
  const P = []; const p = v => { P.push(v); return '$' + P.length; };
  const conds = toks.map(t => `${SA} LIKE ${p('%' + t + '%')}`);
  const wstart = toks.map(t => `(${SN} LIKE ${p(t + '%')} OR ${SN} LIKE ${p('% ' + t + '%')})`).join(' AND ');
  const rank = `CASE WHEN ${SN} LIKE ${p(qf + '%')} THEN 0 WHEN ${SN} LIKE ${p('% ' + qf + '%')} THEN 1 WHEN ${wstart} THEN 2 ELSE 3 END`;
  const rows = (await pool.query(
    `SELECT id,data FROM docs WHERE ${B} AND ${conds.join(' AND ')} ORDER BY ${rank}, ${SN} LIMIT ${p(lim)} OFFSET ${p(off)}`, P)).rows;
  return rows;
}

app.get('/api/items-search', auth, async (req, res) => {
  try {
    const lim = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 40));
    if (!String(req.query.q || '').trim()) return res.json([]);
    const rows = await searchItems(req.query.q, { lim });
    res.json(rows.map(r => Object.assign({ id: r.id }, r.data)));
  } catch (e) { res.status(500).json({ error: 'search', detail: e.message }); }
});

app.get('/api/items', auth, async (req, res) => {
  try {
    const lim = Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const off = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const rows = await searchItems(req.query.q, { lim, off, low: req.query.low === '1', instock: req.query.instock === '1' });
    res.json(rows.map(r => Object.assign({ id: r.id }, r.data)));
  } catch (e) { res.status(500).json({ error: 'items', detail: e.message }); }
});

// النواقص وأمر الشراء — يجمع المخزون الحالي مع معدلات البيع (istats) ويقترح كميات الطلب
app.get('/api/purchase-suggest', auth, async (req, res) => {
  try {
    const cover = Math.min(120, Math.max(1, parseInt(req.query.cover, 10) || 14)); // أيام التغطية المستهدفة
    const lim = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 300));
    const toks = String(req.query.q || '').trim().split(/\s+/).filter(Boolean).slice(0, 6).map(arNorm).filter(Boolean);
    const SA = SCOLS ? 'i.sall' : AR_NORM_SQL.replace(/data->>/g, "i.data->>");
    const P = [cover]; const p = v => { P.push(v); return '$' + P.length; };
    let where = `i.col='items' AND NOT i.deleted AND COALESCE(NULLIF(s.data->>'q90','')::numeric,0) > 0`;
    toks.forEach(t => { where += ` AND ${SA} LIKE ${p('%' + t + '%')}`; });
    const onlyShort = req.query.all !== '1';
    const stockE = `COALESCE(NULLIF(i.data->>'stock','')::numeric,0)`;
    const avgE = `(COALESCE(NULLIF(s.data->>'q90','')::numeric,0)/90.0)`;
    const needE = `($1::numeric*${avgE} - ${stockE})`;
    if (onlyShort) where += ` AND ${needE} > 0`;
    P.push(lim);
    const sql = `SELECT i.data->>'name' AS name, i.data->>'name_ar' AS name_ar, i.data->>'barcode' AS barcode,
        i.id, ${stockE} AS stock,
        COALESCE(NULLIF(s.data->>'q30','')::numeric,0) AS q30,
        COALESCE(NULLIF(s.data->>'q90','')::numeric,0) AS q90,
        s.data->>'last_sold' AS last_sold,
        ROUND(${avgE},2) AS avg_daily,
        CASE WHEN ${avgE} > 0 THEN ROUND(${stockE}/${avgE},0) ELSE NULL END AS days_cover,
        GREATEST(0, CEIL(${needE})) AS suggest
      FROM docs i LEFT JOIN docs s ON s.col='istats' AND s.id=i.id
      WHERE ${where}
      ORDER BY CASE WHEN ${avgE}>0 THEN ${stockE}/${avgE} ELSE 999999 END ASC, q90 DESC
      LIMIT $${P.length}`;
    const rows = (await pool.query(sql, P)).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'purchase', detail: e.message }); }
});

app.get('/api/stock-summary', auth, async (_req, res) => {
  try {
    const out = await memo('stock', 60000, async () => {
    const s = await pool.query(
      `SELECT count(*)::int AS items,
        COALESCE(SUM((data->>'stock')::numeric * COALESCE(NULLIF(data->>'buy','')::numeric,0)),0) AS stock_value,
        COUNT(*) FILTER (WHERE (data->>'min')::numeric>0 AND (data->>'stock')::numeric<=(data->>'min')::numeric)::int AS low_count
       FROM docs WHERE col='items' AND NOT deleted`);
    const low = await pool.query(
      `SELECT id,data FROM docs WHERE col='items' AND NOT deleted
        AND (data->>'min')::numeric>0 AND (data->>'stock')::numeric<=(data->>'min')::numeric
       ORDER BY (data->>'stock')::numeric ASC LIMIT 12`);
    return Object.assign({}, s.rows[0], { low: low.rows.map(r => Object.assign({ id: r.id }, r.data)) });
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'stock', detail: e.message }); }
});

/* ---- العملاء (خادمي، على كل العملاء) — عشان الأداء مش بيتزامنوا للموبايل ---- */
// توحيد عربي للاسم + الهاتف (نفس منطق الأصناف)
const CUST_NORM_SQL = normSql("COALESCE(data->>'name','')||' '||COALESCE(data->>'phone','')");

// ملخّص الحسابات للوحة التحكم (عدد العملاء + إجمالي ديونهم) بدون تحميل الكل
app.get('/api/parties-summary', auth, async (_req, res) => {
  try {
    const out = await memo('parties', 60000, async () => {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS cust_count,
                COALESCE(SUM(GREATEST(COALESCE(NULLIF(data->>'balance','')::numeric,0),0)),0) AS cust_debt
         FROM docs WHERE col='customers' AND NOT deleted`);
      return rows[0];
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'parties', detail: e.message }); }
});

// بحث/قائمة العملاء — بحث عربي ذكي بالاسم أو الهاتف، الأعلى ديونًا أولًا
app.get('/api/customers', auth, async (req, res) => {
  try {
    const toks = String(req.query.q || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
    const lim = Math.min(400, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const params = []; let where = "col='customers' AND NOT deleted";
    toks.forEach(t => { params.push('%' + arNorm(t) + '%'); where += ` AND ${CUST_NORM_SQL} LIKE $${params.length}`; });
    params.push(lim);
    const { rows } = await pool.query(
      `SELECT id,data FROM docs WHERE ${where}
       ORDER BY GREATEST(COALESCE(NULLIF(data->>'balance','')::numeric,0),0) DESC, data->>'name' ASC
       LIMIT $${params.length}`, params);
    res.json(rows.map(r => Object.assign({ id: r.id }, r.data)));
  } catch (e) { res.status(500).json({ error: 'customers', detail: e.message }); }
});

// بيع آجل: زوّد رصيد عميل بالاسم (أو أنشئه) — ذرّي، بصيغة docs + seq
app.post('/api/customer-credit', auth, async (req, res) => {
  const name = String(req.body && req.body.name || '').trim();
  const amount = +(req.body && req.body.amount) || 0;
  if (!name || amount <= 0) return res.status(400).json({ error: 'بيانات غير صحيحة' });
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${SCHEMA}"`);
    await client.query('BEGIN');
    const ex = await client.query(
      `SELECT id,data FROM docs WHERE col='customers' AND NOT deleted
         AND ${NAME_NORM_SQL} = $1
       ORDER BY seq LIMIT 1`, [arNorm(name)]);
    let out;
    if (ex.rows[0]) {
      const d = Object.assign({}, ex.rows[0].data); d.balance = (+d.balance || 0) + amount;
      await client.query(`UPDATE docs SET data=$2, deleted=false, seq=nextval('doc_seq'), updated_at=$3, updated_by=$4 WHERE col='customers' AND id=$1`,
        [ex.rows[0].id, d, now(), req.user.id]);
      out = Object.assign({ id: ex.rows[0].id }, d);
    } else {
      const id = 'cu_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const d = { name, phone: '', balance: amount, note: '' };
      await client.query(`INSERT INTO docs(col,id,data,deleted,seq,updated_at,updated_by) VALUES('customers',$1,$2,false,nextval('doc_seq'),$3,$4)`,
        [id, d, now(), req.user.id]);
      out = Object.assign({ id }, d);
    }
    await client.query('COMMIT');
    bustSummaries();
    res.json({ ok: true, customer: out });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.status(500).json({ error: 'credit', detail: e.message }); }
  finally { client.release(); }
});

/* static + pages (served under the mount, e.g. /erp/...) */
const pub = path.join(__dirname, 'public');
app.use(express.static(pub, { index: false, maxAge: '1h' }));
app.get('/login', (_req, res) => res.sendFile(path.join(pub, 'login.html')));
app.get('*', async (req, res) => {
  try {
    const u = await userByToken(cookies(req)[COOKIE]);
    if (!u) return res.redirect(base(req) + '/login');
    res.set('Cache-Control', 'no-cache'); // دايمًا يتأكد من آخر نسخة عشان التحديثات توصل فورًا
    res.sendFile(path.join(pub, 'app.html'));
  } catch (e) { res.redirect(base(req) + '/login'); }
});

module.exports = app;
