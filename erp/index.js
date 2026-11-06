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
  const { rows } = await pool.query(
    'SELECT col,id,data,deleted,seq FROM docs WHERE seq>$1 ORDER BY seq LIMIT 20000', [since]);
  let seq = since;
  const docs = rows.map(r => { if (r.seq > seq) seq = Number(r.seq); return r.deleted ? { c: r.col, i: r.id, x: true } : { c: r.col, i: r.id, d: r.data }; });
  res.json({ full: since === 0, docs, seq });
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

/* static + pages (served under the mount, e.g. /erp/...) */
const pub = path.join(__dirname, 'public');
app.use(express.static(pub, { index: false, maxAge: '1h' }));
app.get('/login', (_req, res) => res.sendFile(path.join(pub, 'login.html')));
app.get('*', async (req, res) => {
  try {
    const u = await userByToken(cookies(req)[COOKIE]);
    if (!u) return res.redirect(base(req) + '/login');
    res.sendFile(path.join(pub, 'app.html'));
  } catch (e) { res.redirect(base(req) + '/login'); }
});

module.exports = app;
