// Pharmacy delivery — API server
// Node + Express + Postgres. Serves the mobile web app from /public.
const express = require("express");
const compression = require("compression");
const path = require("path");
const crypto = require("crypto");
const { Pool, types } = require("pg");
types.setTypeParser(1082, v => v); // keep DATE as "YYYY-MM-DD"

const PORT = process.env.PORT || 3000;
const TZ = "Africa/Cairo";
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
});
const q = (text, params) => pool.query(text, params);

/* ---------------- schema ---------------- */
async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      phone TEXT DEFAULT '',
      role TEXT NOT NULL CHECK (role IN ('admin','staff','driver')),
      pin_hash TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS day_counter (day DATE PRIMARY KEY, n INT NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      day DATE NOT NULL,
      no INT NOT NULL,
      customer TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      items TEXT NOT NULL DEFAULT '',
      amount NUMERIC(10,2) NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT '',
      payment TEXT NOT NULL DEFAULT '',
      promise_min INT NOT NULL DEFAULT 60,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','ready','out','done','cancel')),
      driver_id INT REFERENCES users(id) ON DELETE SET NULL,
      cancel_reason TEXT,
      created_by INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ready_at TIMESTAMPTZ,
      out_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS orders_day_idx ON orders(day);
    CREATE INDEX IF NOT EXISTS orders_updated_idx ON orders(updated_at);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS location_url TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS loc_token TEXT UNIQUE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS loc_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS loc_source TEXT;
    CREATE TABLE IF NOT EXISTS customers (
      phone TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      location_url TEXT,
      orders_count INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- One customer can have several phones and several addresses/locations
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      orders_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS client_phones (
      phone TEXT PRIMARY KEY,
      client_id INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS client_phones_client_idx ON client_phones(client_id);
    CREATE TABLE IF NOT EXISTS client_addresses (
      id SERIAL PRIMARY KEY,
      client_id INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      location_url TEXT,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS client_addresses_client_idx ON client_addresses(client_id);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_id INT REFERENCES clients(id) ON DELETE SET NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS address_id INT REFERENCES client_addresses(id) ON DELETE SET NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS collected_method TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS collected_amount NUMERIC(10,2);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS settled_by INT REFERENCES users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS orders_custody_idx ON orders(driver_id) WHERE settled_at IS NULL AND collected_method = 'نقدي';
    -- customer details from the pharmacy system (Genius)
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS code TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS clients_code_uidx ON clients(code);
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS area TEXT NOT NULL DEFAULT '';
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(8,2);
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS branch TEXT NOT NULL DEFAULT '';
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS invoices INT NOT NULL DEFAULT 0;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS first_purchase TIMESTAMPTZ;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_purchase TIMESTAMPTZ;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS spend_12m NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT '';
    -- a phone can belong to more than one customer (family members sharing a number)
    DO $$ BEGIN
      IF (SELECT count(*) FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = 'client_phones'::regclass AND i.indisprimary) = 1 THEN
        ALTER TABLE client_phones DROP CONSTRAINT client_phones_pkey;
        ALTER TABLE client_phones ADD PRIMARY KEY (phone, client_id);
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS client_phones_phone_idx ON client_phones(phone);
    CREATE INDEX IF NOT EXISTS clients_recent_idx ON clients(last_purchase DESC NULLS LAST);
    ALTER TABLE client_addresses ADD COLUMN IF NOT EXISTS area TEXT NOT NULL DEFAULT '';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(8,2) NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS area TEXT NOT NULL DEFAULT '';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS track_token TEXT UNIQUE;
    -- live driver location
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_lat DOUBLE PRECISION;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_lng DOUBLE PRECISION;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_acc REAL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_speed REAL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_battery REAL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS driver_positions (
      id BIGSERIAL PRIMARY KEY,
      driver_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      acc REAL,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS driver_positions_idx ON driver_positions(driver_id, at);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    -- Arabic-insensitive search: أ/إ/آ=ا, ى=ي, ة=ه, ؤ=و, ئ=ي, Arabic digits, no tashkeel or punctuation
    CREATE OR REPLACE FUNCTION norm_ar(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
      SELECT trim(regexp_replace(regexp_replace(
        translate(lower(coalesce(t, '')), 'أإآٱىةؤئ٠١٢٣٤٥٦٧٨٩ـًٌٍَُِّْ', 'اااايهوي0123456789'),
        '[^0-9a-zء-ي ]+', ' ', 'g'), ' +', ' ', 'g'))
    $f$;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS search TEXT;
    -- old codes that were merged into this customer in the pharmacy system, stored as " 8893 9676 "
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS alt_codes TEXT NOT NULL DEFAULT '';
    -- edits after an order is placed (items added/removed, price changes), with history
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS edits INT NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS order_changes (
      id SERIAL PRIMARY KEY,
      order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      kind TEXT NOT NULL DEFAULT 'edit',
      fields JSONB NOT NULL DEFAULT '{}',
      note TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS order_changes_order_idx ON order_changes(order_id);
    -- driver commission (from the delivery fee) and end-of-day settlements
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_share NUMERIC(8,2);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS share_manual BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS driver_settlements (
      id SERIAL PRIMARY KEY,
      driver_id INT REFERENCES users(id) ON DELETE SET NULL,
      by_user INT REFERENCES users(id) ON DELETE SET NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      n INT NOT NULL DEFAULT 0,
      fees NUMERIC(10,2) NOT NULL DEFAULT 0,
      share NUMERIC(10,2) NOT NULL DEFAULT 0,
      cash NUMERIC(12,2) NOT NULL DEFAULT 0,
      other NUMERIC(12,2) NOT NULL DEFAULT 0,
      net NUMERIC(12,2) NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT ''
    );
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS settlement_id INT REFERENCES driver_settlements(id) ON DELETE SET NULL;
    -- old payment labels → new ones
    UPDATE orders SET payment = 'نقدي' WHERE payment = 'كاش';
    UPDATE orders SET payment = 'محفظة' WHERE payment = 'فودافون كاش / انستاباي';
    UPDATE orders SET payment = 'مدفوع مسبقًا' WHERE payment = 'مدفوع';
  `);
  // Move the old one-phone customers into the new structure (runs once)
  const moved = await q(`SELECT count(*)::int AS n FROM clients`);
  if (moved.rows[0].n === 0) {
    const old = await q(`SELECT * FROM customers ORDER BY updated_at`);
    for (const c of old.rows) {
      const id = (await q(`INSERT INTO clients(name, orders_count) VALUES ($1,$2) RETURNING id`, [c.name, c.orders_count])).rows[0].id;
      await q(`INSERT INTO client_phones(phone, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [c.phone, id]);
      if (c.address || c.lat != null || c.location_url)
        await q(`INSERT INTO client_addresses(client_id, address, lat, lng, location_url, last_used_at) VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, c.address, c.lat, c.lng, c.location_url, c.updated_at]);
    }
    if (old.rows.length) {
      await q(`UPDATE orders o SET client_id = p.client_id FROM client_phones p WHERE o.client_id IS NULL AND o.phone = p.phone`);
      console.log(`Moved ${old.rows.length} customers to the new structure`);
    }
  }
  // fill the search text for customers that don't have it yet
  await q(`UPDATE clients c SET search = ${SEARCH_EXPR} WHERE c.search IS NULL`);
  // First run: create the admin account from ADMIN_PIN
  const { rows } = await q(`SELECT count(*)::int AS n FROM users`);
  if (rows[0].n === 0) {
    const pin = process.env.ADMIN_PIN || "1234";
    await q(`INSERT INTO users(name, role, pin_hash) VALUES ($1,'admin',$2)`,
      [process.env.ADMIN_NAME || "المدير", hashPin(pin)]);
    console.log("Created admin user");
  }
}

/* ---------------- auth ---------------- */
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(String(pin), salt, 32).toString("hex");
  return `${salt}:${h}`;
}
function checkPin(pin, stored) {
  const [salt, h] = String(stored).split(":");
  const t = crypto.scryptSync(String(pin), salt, 32);
  return crypto.timingSafeEqual(t, Buffer.from(h, "hex"));
}

const attempts = new Map(); // simple brute-force guard per user
async function auth(req, res, next) {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "سجّل دخول الأول" });
  const { rows } = await q(
    `SELECT u.id, u.name, u.role, u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1`, [token]);
  if (!rows[0] || !rows[0].active) return res.status(401).json({ error: "الجلسة انتهت، سجّل دخول تاني" });
  req.user = rows[0];
  next();
}
const allow = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: "مش مسموحلك تعمل ده" });

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------------- helpers ---------------- */
const ORDER_COLS = `o.*, d.name AS driver_name`;
const todayCairo = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");

// Egyptian numbers to one form: 01xxxxxxxxx
function normPhone(p) {
  let d = String(p || "").replace(/[٠-٩]/g, c => "٠١٢٣٤٥٦٧٨٩".indexOf(c)).replace(/\D/g, "");
  if (d.startsWith("0020")) d = d.slice(4); else if (d.startsWith("20") && d.length === 12) d = d.slice(2);
  if (d.length === 10 && d.startsWith("1")) d = "0" + d;
  return d;
}

/* ---- location parsing ---- */
function coordsFromText(t) {
  const s = decodeURIComponent(String(t || "")).replace(/[٠-٩]/g, c => "٠١٢٣٤٥٦٧٨٩".indexOf(c)).replace(/٫/g, ".");
  const pats = [
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,              // place data in long maps links
    /@(-?\d+\.\d+),\s*(-?\d+\.\d+)/,                // .../@30.05,31.49,17z
    /[?&](?:q|query|ll|destination|daddr|center)=(?:loc:)?(-?\d+\.\d+),\s*\+?(-?\d+\.\d+)/,
    /(-?\d{1,2}\.\d{2,})\s*[,، ]\s*(-?\d{1,3}\.\d{2,})/, // plain "30.0567, 31.4912"
  ];
  for (const re of pats) {
    const m = s.match(re);
    if (m) {
      const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
  }
  return null;
}
async function resolveShortLink(url) {
  // maps.app.goo.gl / goo.gl/maps → follow redirects to the full link that carries coordinates
  let cur = url;
  for (let i = 0; i < 4; i++) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(cur, { redirect: "manual", signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
      const loc = r.headers.get("location");
      if (!loc) return cur;
      cur = new URL(loc, cur).toString();
      if (coordsFromText(cur)) return cur;
    } catch (e) { return cur; } finally { clearTimeout(t); }
  }
  return cur;
}
// Takes whatever staff pasted (WhatsApp location link, Google Maps link, or coordinates)
async function parseLocation(input) {
  const raw = String(input || "").trim().slice(0, 1000);
  if (!raw) return null;
  const urlMatch = raw.match(/https?:\/\/\S+/);
  const url = urlMatch ? urlMatch[0] : null;
  let c = coordsFromText(raw);
  if (!c && url && /goo\.gl|maps\.app|g\.co|bit\.ly/i.test(url)) c = coordsFromText(await resolveShortLink(url));
  if (!c && !url) return { error: "مش لاقي لوكيشن في النص ده. الصق لينك جوجل ماب أو اللوكيشن من الواتساب." };
  return { lat: c ? c.lat : null, lng: c ? c.lng : null, location_url: url || null };
}
const METHODS = ["نقدي", "فيزا", "انستاباي", "محفظة", "مدفوع مسبقًا"];
const normAddr = a => String(a || "").replace(/[\s،,.\-]+/g, " ").trim().toLowerCase();

// Split a cell like "0100-123-4567 / 01234567890" into clean phone numbers
function splitPhones(v) {
  const s = String(v ?? "").replace(/[٠-٩]/g, c => "٠١٢٣٤٥٦٧٨٩".indexOf(c));
  const parts = s.split(/[\/\\,،;|\n]+|\s{2,}|\s+(?:و|or)\s+/);
  const out = [];
  for (const part of parts) {
    let p = normPhone(part);
    if (p.length === 9 && /^[2-9]/.test(p)) p = "0" + p; // landline without 0
    if (p.length >= 8 && p.length <= 13 && !out.includes(p)) out.push(p);
  }
  return out;
}

// what a customer can be found by: name, area, code and every address
const SEARCH_EXPR = `norm_ar(concat_ws(' ', c.name, c.area, c.code,
  (SELECT string_agg(concat_ws(' ', a.label, a.address, a.area), ' ') FROM client_addresses a WHERE a.client_id = c.id)))`;
async function refreshSearch(ids, cq = q) {
  ids = [...new Set((ids || []).filter(Boolean))];
  if (ids.length) await cq(`UPDATE clients c SET search = ${SEARCH_EXPR} WHERE c.id = ANY($1)`, [ids]);
}
// same rules as norm_ar() in the database
function normAr(t) {
  return String(t || "").toLowerCase()
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[\u0640\u064B-\u0652]/g, "")
    .replace(/[^0-9a-zء-ي ]+/g, " ").replace(/\s+/g, " ").trim();
}

const CLIENT_COLS = `id, name, notes, orders_count, code, trim(alt_codes) AS alt_codes, area, delivery_fee::float AS delivery_fee, branch, invoices,
  first_purchase, last_purchase, spend_12m::float AS spend_12m, status`;
async function clientById(id) {
  const c = (await q(`SELECT ${CLIENT_COLS} FROM clients WHERE id=$1`, [id])).rows[0];
  if (!c) return null;
  c.phones = (await q(`SELECT phone FROM client_phones WHERE client_id=$1 ORDER BY phone`, [id])).rows.map(r => r.phone);
  c.addresses = (await q(`SELECT id, label, address, area, lat, lng, location_url, last_used_at FROM client_addresses
    WHERE client_id=$1 ORDER BY last_used_at DESC NULLS LAST, id DESC`, [id])).rows;
  return c;
}
async function clientIdByPhone(phone) {
  const p = normPhone(phone);
  if (p.length < 8) return null;
  const r = (await q(`SELECT p.client_id FROM client_phones p JOIN clients c ON c.id=p.client_id WHERE p.phone=$1
    ORDER BY c.last_purchase DESC NULLS LAST, c.updated_at DESC LIMIT 1`, [p])).rows[0];
  return r ? r.client_id : null;
}
async function addPhone(clientId, phone) {
  const p = normPhone(phone);
  if (p.length < 8) return false;
  const r = await q(`INSERT INTO client_phones(phone, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [p, clientId]);
  return r.rowCount > 0;
}
// Find the same address text for this client, or add it. Location (if given) is stored on it.
async function upsertAddress(clientId, { address, label, lat, lng, location_url }) {
  const n = normAddr(address);
  const existing = (await q(`SELECT id, address, lat, location_url FROM client_addresses WHERE client_id=$1`, [clientId])).rows;
  let hit = n ? existing.find(a => normAddr(a.address) === n) : null;
  if (!hit && lat != null) hit = existing.find(a => !a.address && a.lat == null && !a.location_url);
  if (hit) {
    if (lat != null || location_url)
      await q(`UPDATE client_addresses SET lat=$2, lng=$3, location_url=$4 WHERE id=$1`, [hit.id, lat ?? null, lng ?? null, location_url ?? null]);
    if (label) await q(`UPDATE client_addresses SET label=$2 WHERE id=$1 AND label=''`, [hit.id, label]);
    return { id: hit.id, created: false };
  }
  if (!n && lat == null && !location_url) return { id: null, created: false };
  const id = (await q(`INSERT INTO client_addresses(client_id, label, address, lat, lng, location_url) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [clientId, label || "", String(address || "").trim(), lat ?? null, lng ?? null, location_url ?? null])).rows[0].id;
  await refreshSearch([clientId]);
  return { id, created: true };
}
// When a location arrives for an order, keep it on the customer's address too
async function locationToAddress(orderId, lat, lng, location_url) {
  const o = (await q(`SELECT client_id, address_id, address FROM orders WHERE id=$1`, [orderId])).rows[0];
  if (!o || !o.client_id) return;
  if (o.address_id) await q(`UPDATE client_addresses SET lat=$2, lng=$3, location_url=$4 WHERE id=$1`, [o.address_id, lat, lng, location_url]);
  else {
    const a = await upsertAddress(o.client_id, { address: o.address, lat, lng, location_url });
    if (a.id) await q(`UPDATE orders SET address_id=$2 WHERE id=$1`, [orderId, a.id]);
  }
}

// Straight-line distance in km
function km(aLat, aLng, bLat, bLng) {
  const R = 6371, r = x => x * Math.PI / 180;
  const d = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(d));
}
const num = (v, d = null) => (v === null || v === undefined || v === "" || !isFinite(Number(v)) ? d : Number(v));
const toDate = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };

/* ---- pharmacy settings (name, location) ---- */
async function getSettings() {
  const rows = (await q(`SELECT key, value FROM settings`)).rows;
  const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return { name: m.name || "توصيل الصيدلية", lat: num(m.lat), lng: num(m.lng) };
}
async function setSetting(key, value) {
  await q(`INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, value == null ? "" : String(value)]);
}

/* ---- driver commission rules: first tier whose "max" covers the delivery fee wins ---- */
const DEFAULT_RULES = [{ max: 20, mode: "pct", value: 50 }, { max: 25, mode: "pct", value: 50 }, { max: null, mode: "pct", value: 50 }];
function cleanRules(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const out = [];
  for (const r of list.slice(0, 10)) {
    const mode = r.mode === "fixed" ? "fixed" : "pct";
    const value = num(r.value); const max = r.max === null || r.max === "" || r.max === undefined ? null : num(r.max);
    if (value === null || value < 0 || (mode === "pct" && value > 100) || (mode === "fixed" && value > 1000)) return null;
    if (max !== null && (max <= 0 || max > 10000)) return null;
    out.push({ max, mode, value });
  }
  const fixed = out.filter(r => r.max !== null).sort((a, b) => a.max - b.max);
  const last = out.find(r => r.max === null) || { max: null, mode: "pct", value: 50 };
  return [...fixed, last];
}
async function getRules() {
  const r = (await q(`SELECT value FROM settings WHERE key='share_rules'`)).rows[0];
  try { return cleanRules(JSON.parse(r.value)) || DEFAULT_RULES; } catch (e) { return DEFAULT_RULES; }
}
function shareFor(fee, rules) {
  fee = Number(fee) || 0;
  if (fee <= 0) return 0;
  const t = rules.find(r => r.max === null || fee <= r.max) || rules[rules.length - 1];
  const v = t.mode === "fixed" ? Math.min(t.value, fee) : fee * t.value / 100;
  return Math.round(v * 100) / 100;
}

/* ---------------- app ---------------- */
const app = express();
app.disable("x-powered-by");
app.use(compression());
app.set("trust proxy", 1);
app.use("/api/clients/import", express.json({ limit: "8mb" }));
app.use(express.json({ limit: "100kb" }));
app.use((req, res, next) => { res.set("X-Content-Type-Options", "nosniff"); next(); });

app.get("/healthz", wrap(async (req, res) => { await q("SELECT 1"); res.json({ ok: true }); }));

// Names for the login picker (no phones, no roles beyond what's needed)
app.get("/api/login-names", wrap(async (req, res) => {
  const { rows } = await q(`SELECT id, name, role FROM users WHERE active ORDER BY role, name`);
  res.json(rows);
}));

app.post("/api/login", wrap(async (req, res) => {
  const { userId, pin } = req.body || {};
  const key = String(userId);
  const a = attempts.get(key) || { n: 0, until: 0 };
  if (a.until > Date.now()) return res.status(429).json({ error: "محاولات كتير، استنى 5 دقايق" });
  const { rows } = await q(`SELECT id, name, role, pin_hash, active FROM users WHERE id=$1`, [Number(userId) || 0]);
  const u = rows[0];
  if (!u || !u.active || !checkPin(pin || "", u.pin_hash)) {
    a.n += 1; if (a.n >= 5) { a.until = Date.now() + 5 * 60000; a.n = 0; }
    attempts.set(key, a);
    return res.status(401).json({ error: "الرقم السري غلط" });
  }
  attempts.delete(key);
  const token = crypto.randomBytes(32).toString("hex");
  await q(`INSERT INTO sessions(token, user_id) VALUES ($1,$2)`, [token, u.id]);
  res.json({ token, user: { id: u.id, name: u.name, role: u.role } });
}));

app.post("/api/logout", auth, wrap(async (req, res) => {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  await q(`DELETE FROM sessions WHERE token=$1`, [token]);
  res.json({ ok: true });
}));

app.get("/api/me", auth, (req, res) => res.json({ user: req.user, today: todayCairo() }));

app.get("/api/public/settings", wrap(async (req, res) => res.json(await getSettings())));
app.put("/api/settings", auth, allow("admin"), wrap(async (req, res) => {
  const b = req.body || {};
  if (b.name !== undefined) {
    const name = String(b.name).trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: "اكتب اسم الصيدلية" });
    await setSetting("name", name);
  }
  if (b.lat !== undefined && b.lng !== undefined) {
    const lat = num(b.lat), lng = num(b.lng);
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: "الموقع مش واضح" });
    await setSetting("lat", lat); await setSetting("lng", lng);
  } else if (b.location !== undefined) {
    if (!String(b.location).trim()) { await setSetting("lat", ""); await setSetting("lng", ""); }
    else {
      const loc = await parseLocation(b.location);
      if (loc.error) return res.status(400).json({ error: loc.error });
      if (loc.lat == null) return res.status(400).json({ error: "اللينك ده مفيهوش إحداثيات. افتحه على جوجل ماب وانسخ اللينك الطويل، أو استخدم موقعك الحالي وانت في الصيدلية." });
      await setSetting("lat", loc.lat); await setSetting("lng", loc.lng);
    }
  }
  res.json(await getSettings());
}));

/* ---- users (admin manages; staff can list drivers) ---- */
app.get("/api/users", auth, wrap(async (req, res) => {
  const where = req.user.role === "admin" ? "" : "WHERE role='driver'";
  const { rows } = await q(`SELECT id, name, phone, role, active FROM users ${where} ORDER BY role, name`);
  res.json(rows);
}));

app.post("/api/users", auth, allow("admin"), wrap(async (req, res) => {
  const { name, phone, role, pin } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "اكتب الاسم" });
  if (!["admin", "staff", "driver"].includes(role)) return res.status(400).json({ error: "اختار الدور" });
  if (!/^\d{4,8}$/.test(String(pin || ""))) return res.status(400).json({ error: "الرقم السري من 4 لـ 8 أرقام" });
  try {
    const { rows } = await q(`INSERT INTO users(name, phone, role, pin_hash) VALUES ($1,$2,$3,$4) RETURNING id, name, phone, role, active`,
      [String(name).trim(), String(phone || "").trim(), role, hashPin(pin)]);
    res.json(rows[0]);
  } catch (e) {
    if (e.code === "23505") return res.status(400).json({ error: "الاسم ده موجود قبل كده" });
    throw e;
  }
}));

app.patch("/api/users/:id", auth, allow("admin"), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { active, pin, phone } = req.body || {};
  if (id === req.user.id && active === false) return res.status(400).json({ error: "مينفعش توقف حسابك" });
  if (typeof active === "boolean") {
    await q(`UPDATE users SET active=$1 WHERE id=$2`, [active, id]);
    if (!active) await q(`DELETE FROM sessions WHERE user_id=$1`, [id]);
  }
  if (pin !== undefined) {
    if (!/^\d{4,8}$/.test(String(pin))) return res.status(400).json({ error: "الرقم السري من 4 لـ 8 أرقام" });
    await q(`UPDATE users SET pin_hash=$1 WHERE id=$2`, [hashPin(pin), id]);
  }
  if (phone !== undefined) await q(`UPDATE users SET phone=$1 WHERE id=$2`, [String(phone), id]);
  const { rows } = await q(`SELECT id, name, phone, role, active FROM users WHERE id=$1`, [id]);
  res.json(rows[0]);
}));

/* ---- orders ---- */
app.get("/api/orders", auth, wrap(async (req, res) => {
  const day = isDay(req.query.day) ? req.query.day : todayCairo();
  const params = [day];
  let extra = "";
  if (req.user.role === "driver") { extra = ` AND (o.driver_id=$2 OR (o.status='ready' AND o.driver_id IS NULL))`; params.push(req.user.id); }
  const { rows } = await q(
    `SELECT ${ORDER_COLS} FROM orders o LEFT JOIN users d ON d.id=o.driver_id WHERE o.day=$1${extra} ORDER BY o.no`, params);
  let drivers_live = [];
  if (req.user.role !== "driver") drivers_live = (await q(`SELECT id, last_lat AS lat, last_lng AS lng, last_at AS at FROM users
    WHERE role='driver' AND active AND last_at > now() - interval '12 hours'`)).rows;
  res.json({ day, now: new Date().toISOString(), orders: rows, drivers_live });
}));

app.post("/api/orders", auth, allow("admin", "staff"), wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.customer || "").trim(), addressText = String(b.address || "").trim();
  if (!name) return res.status(400).json({ error: "اكتب اسم العميل" });
  if (!addressText) return res.status(400).json({ error: "اكتب العنوان" });
  const payment = METHODS.includes(b.payment) ? b.payment : "نقدي";

  // 1) customer: chosen one, or found by phone, or new
  let clientId = Number(b.client_id) || null;
  if (clientId && !(await q(`SELECT 1 FROM clients WHERE id=$1`, [clientId])).rows[0]) clientId = null;
  if (!clientId) clientId = await clientIdByPhone(b.phone);
  if (!clientId) clientId = (await q(`INSERT INTO clients(name) VALUES ($1) RETURNING id`, [name])).rows[0].id;
  await addPhone(clientId, b.phone);

  // 2) location: pasted now, or from the saved address that was picked
  let loc = null, locSource = null;
  if (String(b.location || "").trim()) {
    loc = await parseLocation(b.location);
    if (loc && loc.error) return res.status(400).json({ error: loc.error });
    locSource = "staff";
  }
  let addressId = null;
  const picked = Number(b.address_id) ? (await q(`SELECT * FROM client_addresses WHERE id=$1 AND client_id=$2`, [Number(b.address_id), clientId])).rows[0] : null;
  if (picked) {
    addressId = picked.id;
    if (loc) await q(`UPDATE client_addresses SET lat=$2, lng=$3, location_url=$4 WHERE id=$1`, [picked.id, loc.lat, loc.lng, loc.location_url]);
    else if (picked.lat != null || picked.location_url) { loc = picked; locSource = "saved"; }
    if (addressText && normAddr(addressText) !== normAddr(picked.address)) await q(`UPDATE client_addresses SET address=$2 WHERE id=$1`, [picked.id, addressText]);
  } else {
    addressId = (await upsertAddress(clientId, { address: addressText, label: b.address_label, ...(loc || {}) })).id;
    if (!loc && addressId) {
      const a = (await q(`SELECT lat, lng, location_url FROM client_addresses WHERE id=$1`, [addressId])).rows[0];
      if (a && (a.lat != null || a.location_url)) { loc = a; locSource = "saved"; }
    }
  }
  if (addressId) await q(`UPDATE client_addresses SET last_used_at=now() WHERE id=$1`, [addressId]);
  const cl = (await q(`SELECT area, delivery_fee FROM clients WHERE id=$1`, [clientId])).rows[0] || {};
  const addrArea = addressId ? ((await q(`SELECT area FROM client_addresses WHERE id=$1`, [addressId])).rows[0] || {}).area : "";
  const area = String(b.area || addrArea || (picked || !cl.area ? "" : cl.area) || "").slice(0, 60);
  const fee = Math.max(0, Math.min(1000, num(b.delivery_fee, num(cl.delivery_fee, 0))));
  await q(`UPDATE clients SET name = CASE WHEN name='' THEN $2 ELSE name END, orders_count = orders_count + 1, updated_at=now() WHERE id=$1`, [clientId, name]);
  await refreshSearch([clientId]);

  const day = todayCairo();
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    const c = await conn.query(
      `INSERT INTO day_counter(day,n) VALUES ($1,1) ON CONFLICT(day) DO UPDATE SET n=day_counter.n+1 RETURNING n`, [day]);
    const { rows } = await conn.query(
      `INSERT INTO orders(day,no,customer,phone,address,items,amount,source,payment,promise_min,created_by,lat,lng,location_url,loc_at,loc_source,client_id,address_id,delivery_fee,area)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
      [day, c.rows[0].n, name, normPhone(b.phone) || String(b.phone || "").trim(), addressText,
       String(b.items || "").trim(), Number(b.amount) || 0, String(b.source || ""), payment,
       Math.min(240, Math.max(10, Number(b.promise_min) || 60)), req.user.id,
       loc ? loc.lat : null, loc ? loc.lng : null, loc ? loc.location_url : null, loc ? new Date() : null, locSource,
       clientId, addressId, fee, area]);
    await conn.query("COMMIT");
    const o = await q(`SELECT ${ORDER_COLS} FROM orders o LEFT JOIN users d ON d.id=o.driver_id WHERE o.id=$1`, [rows[0].id]);
    res.json(o.rows[0]);
  } catch (e) { await conn.query("ROLLBACK"); throw e; }
  finally { conn.release(); }
}));

// One endpoint for every status change, with role rules
app.patch("/api/orders/:id", auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { action, driver_id, reason, collected_method, collected_amount } = req.body || {};
  const { rows } = await q(`SELECT * FROM orders WHERE id=$1`, [id]);
  const o = rows[0];
  if (!o) return res.status(404).json({ error: "الأوردر مش موجود" });
  const isDriver = req.user.role === "driver";
  const final = o.status === "done" || o.status === "cancel";

  let sql, params;
  switch (action) {
    case "assign": {
      if (isDriver) return res.status(403).json({ error: "التوزيع من الصيدلية بس" });
      if (final) return res.status(400).json({ error: "الأوردر خلص" });
      const d = driver_id ? (await q(`SELECT id FROM users WHERE id=$1 AND role='driver' AND active`, [Number(driver_id)])).rows[0] : null;
      if (driver_id && !d) return res.status(400).json({ error: "الطيار مش موجود" });
      sql = `UPDATE orders SET driver_id=$2, updated_at=now() WHERE id=$1`; params = [id, d ? d.id : null];
      break;
    }
    case "ready":
      if (isDriver) return res.status(403).json({ error: "التجهيز من الصيدلية بس" });
      if (o.status !== "new") return res.status(400).json({ error: "الأوردر مش في مرحلة التجهيز" });
      sql = `UPDATE orders SET status='ready', ready_at=now(), updated_at=now() WHERE id=$1`; params = [id];
      break;
    case "out": {
      if (o.status !== "ready") return res.status(400).json({ error: "الأوردر لسه مش جاهز" });
      let drv = o.driver_id;
      if (isDriver) {
        if (drv && drv !== req.user.id) return res.status(403).json({ error: "الأوردر ده متوزع على طيار تاني" });
        drv = req.user.id;
      }
      if (!drv) return res.status(400).json({ error: "اختار الطيار الأول" });
      sql = `UPDATE orders SET status='out', driver_id=$2, out_at=now(), updated_at=now() WHERE id=$1`; params = [id, drv];
      break;
    }
    case "done":
      if (o.status !== "out") return res.status(400).json({ error: "الأوردر لسه ماخرجش" });
      if (isDriver && o.driver_id !== req.user.id) return res.status(403).json({ error: "الأوردر ده مش معاك" });
      {
        const method = METHODS.includes(collected_method) ? collected_method : (METHODS.includes(o.payment) ? o.payment : "نقدي");
        let amount = collected_amount === undefined || collected_amount === "" ? Number(o.amount) : Number(collected_amount);
        if (method === "مدفوع مسبقًا") amount = 0;
        if (!isFinite(amount) || amount < 0 || amount > 1000000) return res.status(400).json({ error: "المبلغ مش مظبوط" });
        sql = `UPDATE orders SET status='done', delivered_at=now(), collected_method=$2, collected_amount=$3,
          driver_share = CASE WHEN share_manual THEN driver_share ELSE $4 END, updated_at=now() WHERE id=$1`;
        params = [id, method, amount, shareFor(o.delivery_fee, await getRules())];
      }
      break;
    case "cancel":
      if (isDriver) return res.status(403).json({ error: "الإلغاء من الصيدلية بس" });
      if (final) return res.status(400).json({ error: "الأوردر خلص" });
      sql = `UPDATE orders SET status='cancel', cancel_reason=$2, cancelled_at=now(), updated_at=now() WHERE id=$1`;
      params = [id, String(reason || "سبب تاني").slice(0, 100)];
      await q(`INSERT INTO order_changes(order_id, user_id, kind, note) VALUES ($1,$2,'cancel',$3)`, [id, req.user.id, params[1] + (o.status === "out" ? " (كان مع الطيار)" : "")]);
      break;
    default:
      return res.status(400).json({ error: "طلب غير معروف" });
  }
  await q(sql, params);
  const out = await q(`SELECT ${ORDER_COLS} FROM orders o LEFT JOIN users d ON d.id=o.driver_id WHERE o.id=$1`, [id]);
  res.json(out.rows[0]);
}));

/* ---- edit an order after it was placed ---- */
const EDITABLE = {
  items: v => String(v ?? "").trim().slice(0, 2000),
  amount: v => Math.max(0, Math.min(1000000, num(v, 0))),
  delivery_fee: v => Math.max(0, Math.min(1000, num(v, 0))),
  payment: v => (METHODS.includes(v) ? v : null),
  promise_min: v => Math.min(240, Math.max(10, Math.round(num(v, 60)))),
  address: v => String(v ?? "").trim().slice(0, 300),
};
app.put("/api/orders/:id", auth, allow("admin", "staff"), wrap(async (req, res) => {
  const id = Number(req.params.id); const b = req.body || {};
  const o = (await q(`SELECT * FROM orders WHERE id=$1`, [id])).rows[0];
  if (!o) return res.status(404).json({ error: "الأوردر مش موجود" });
  if (o.status === "done") return res.status(400).json({ error: "الأوردر اتسلم خلاص، مينفعش يتعدل" });
  if (o.status === "cancel") return res.status(400).json({ error: "الأوردر ده ملغي" });
  const changes = {}, sets = [], params = [id];
  for (const [f, clean] of Object.entries(EDITABLE)) {
    if (b[f] === undefined) continue;
    const v = clean(b[f]);
    if (v === null || (f === "address" && !v)) continue;
    const old = ["amount", "delivery_fee"].includes(f) ? Number(o[f]) : o[f];
    if (String(old ?? "") === String(v)) continue;
    changes[f] = [old, v]; params.push(v); sets.push(`${f}=$${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: "مفيش حاجة اتغيرت" });
  const note = String(b.note || "").trim().slice(0, 200);
  await q(`UPDATE orders SET ${sets.join(", ")}, edits=edits+1, edited_at=now(), updated_at=now() WHERE id=$1`, params);
  await q(`INSERT INTO order_changes(order_id, user_id, kind, fields, note) VALUES ($1,$2,'edit',$3,$4)`, [id, req.user.id, JSON.stringify(changes), note]);
  const out = await q(`SELECT ${ORDER_COLS} FROM orders o LEFT JOIN users d ON d.id=o.driver_id WHERE o.id=$1`, [id]);
  res.json(out.rows[0]);
}));
app.get("/api/orders/:id/detail", auth, allow("admin", "staff"), wrap(async (req, res) => {
  const o = (await q(`SELECT o.items, o.address, o.location_url, o.lat, o.lng FROM orders o WHERE o.id=$1`, [Number(req.params.id)])).rows[0];
  if (!o) return res.status(404).json({ error: "الأوردر مش موجود" });
  res.json(o);
}));
app.get("/api/orders/:id/changes", auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (req.user.role === "driver") {
    const o = (await q(`SELECT driver_id FROM orders WHERE id=$1`, [id])).rows[0];
    if (!o || o.driver_id !== req.user.id) return res.status(403).json({ error: "الأوردر ده مش معاك" });
  }
  const { rows } = await q(`SELECT c.at, c.kind, c.fields, c.note, u.name AS by FROM order_changes c LEFT JOIN users u ON u.id=c.user_id
    WHERE c.order_id=$1 ORDER BY c.at`, [id]);
  res.json(rows);
}));

/* ---- clients (customers) ---- */
const staffOnly = allow("admin", "staff");
app.get("/api/clients", auth, staffOnly, wrap(async (req, res) => {
  const term = String(req.query.q || "").trim().slice(0, 80);
  const words = normAr(term).split(" ").filter(Boolean).slice(0, 6);
  const digits = term.replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/\D/g, "");
  const onlyDigits = !!digits && /^[\d٠-٩\s+()-]+$/.test(term);
  const params = []; const P = v => { params.push(v); return "$" + params.length; };
  const codeHit = d => { const a = P(d), b = P("% " + d + " %"); return `(c.code = ${a} OR c.alt_codes LIKE ${b})`; };
  let where = "", rank = "";
  if (term) {
    const conds = [];
    if (onlyDigits && digits.length <= 6) {
      // a short number: the customer code (current or an old merged one), or the last digits of a phone
      conds.push(codeHit(digits));
      if (digits.length >= 4) conds.push(`EXISTS (SELECT 1 FROM client_phones p WHERE p.client_id=c.id AND p.phone LIKE ${P("%" + digits)})`);
      rank = `(c.code = ${P(digits)}) DESC, (c.alt_codes LIKE ${P("% " + digits + " %")}) DESC,`;
    } else if (onlyDigits) {
      // a phone number, typed with or without the leading 0, spaces or dashes
      conds.push(`EXISTS (SELECT 1 FROM client_phones p WHERE p.client_id=c.id AND p.phone LIKE ${P("%" + normPhone(digits).replace(/^0/, "") + "%")})`);
    } else {
      // words: every word must appear somewhere (name, area, code or an address), in any order
      if (words.length) conds.push("(" + words.map(w => `c.search LIKE ${P("%" + w + "%")}`).join(" AND ") + ")");
      const nameAll = words.length ? words.map(w => `norm_ar(c.name) LIKE ${P("%" + w + "%")}`).join(" AND ") : "false";
      rank = `(${nameAll}) DESC, ${words.length ? `(norm_ar(c.name) LIKE ${P(words[0] + "%")}) DESC,` : ""}`;
    }
    if (!conds.length) return res.json({ total: (await q(`SELECT count(*)::int AS n FROM clients`)).rows[0].n, clients: [] });
    where = "WHERE " + conds.join(" OR ");
  }
  const { rows } = await q(`WITH hit AS (
      SELECT c.id FROM clients c ${where}
      ORDER BY ${rank} c.last_purchase DESC NULLS LAST, c.updated_at DESC LIMIT 40)
    SELECT c.id, c.name, c.code, trim(c.alt_codes) AS alt_codes, c.area, c.status, c.last_purchase, c.invoices, c.orders_count, c.delivery_fee::float AS delivery_fee,
      (SELECT array_agg(phone ORDER BY phone) FROM client_phones p WHERE p.client_id=c.id) AS phones,
      (SELECT count(*)::int FROM client_addresses a WHERE a.client_id=c.id) AS n_addresses,
      (SELECT count(*)::int FROM client_addresses a WHERE a.client_id=c.id AND (a.lat IS NOT NULL OR a.location_url IS NOT NULL)) AS n_located
    FROM (SELECT id, row_number() OVER () AS rn FROM hit) h JOIN clients c USING (id) ORDER BY h.rn`, params);
  const total = (await q(`SELECT count(*)::int AS n FROM clients`)).rows[0].n;
  res.json({ total, clients: rows });
}));
app.get("/api/clients/by-phone/:phone", auth, staffOnly, wrap(async (req, res) => {
  const id = await clientIdByPhone(req.params.phone);
  if (!id) return res.json(null);
  const c = await clientById(id);
  // other customers registered on the same number
  c.shared = (await q(`SELECT c.id, c.name, c.code, c.area FROM client_phones p JOIN clients c ON c.id=p.client_id
    WHERE p.phone=$1 AND c.id<>$2 ORDER BY c.last_purchase DESC NULLS LAST LIMIT 10`, [normPhone(req.params.phone), id])).rows;
  res.json(c);
}));
app.get("/api/clients/:id", auth, staffOnly, wrap(async (req, res) => {
  const c = await clientById(Number(req.params.id));
  if (!c) return res.status(404).json({ error: "العميل مش موجود" });
  res.json(c);
}));
app.post("/api/clients", auth, staffOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const phones = splitPhones(b.phone);
  if (!String(b.name || "").trim() && !phones.length) return res.status(400).json({ error: "اكتب الاسم أو الرقم" });
  const id = (await q(`INSERT INTO clients(name) VALUES ($1) RETURNING id`, [String(b.name || "").trim()])).rows[0].id;
  for (const p of phones) await addPhone(id, p);
  await refreshSearch([id]);
  res.json(await clientById(id));
}));
app.patch("/api/clients/:id", auth, staffOnly, wrap(async (req, res) => {
  const id = Number(req.params.id); const b = req.body || {};
  if (b.name !== undefined) await q(`UPDATE clients SET name=$2, updated_at=now() WHERE id=$1`, [id, String(b.name).trim()]);
  if (b.notes !== undefined) await q(`UPDATE clients SET notes=$2, updated_at=now() WHERE id=$1`, [id, String(b.notes).slice(0, 500)]);
  if (b.area !== undefined) await q(`UPDATE clients SET area=$2 WHERE id=$1`, [id, String(b.area).trim().slice(0, 60)]);
  if (b.delivery_fee !== undefined) await q(`UPDATE clients SET delivery_fee=$2 WHERE id=$1`, [id, num(b.delivery_fee)]);
  await refreshSearch([id]);
  res.json(await clientById(id));
}));
app.delete("/api/clients/:id", auth, allow("admin"), wrap(async (req, res) => {
  await q(`DELETE FROM clients WHERE id=$1`, [Number(req.params.id)]);
  res.json({ ok: true });
}));
app.post("/api/clients/:id/phones", auth, staffOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const phones = splitPhones(req.body && req.body.phone);
  if (!phones.length) return res.status(400).json({ error: "الرقم مش مظبوط" });
  for (const p of phones) {
    await addPhone(id, p);
  }
  res.json(await clientById(id));
}));
app.delete("/api/clients/:id/phones/:phone", auth, staffOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  await q(`DELETE FROM client_phones WHERE client_id=$1 AND phone=$2`, [id, normPhone(req.params.phone)]);
  res.json(await clientById(id));
}));
app.post("/api/clients/:id/addresses", auth, staffOnly, wrap(async (req, res) => {
  const id = Number(req.params.id); const b = req.body || {};
  let loc = null;
  if (String(b.location || "").trim()) { loc = await parseLocation(b.location); if (loc.error) return res.status(400).json({ error: loc.error }); }
  if (!String(b.address || "").trim() && !loc) return res.status(400).json({ error: "اكتب العنوان أو الصق اللوكيشن" });
  await q(`INSERT INTO client_addresses(client_id, label, address, lat, lng, location_url) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, String(b.label || "").trim(), String(b.address || "").trim(), loc ? loc.lat : null, loc ? loc.lng : null, loc ? loc.location_url : null]);
  await refreshSearch([id]);
  res.json(await clientById(id));
}));
app.patch("/api/addresses/:id", auth, staffOnly, wrap(async (req, res) => {
  const id = Number(req.params.id); const b = req.body || {};
  const a = (await q(`SELECT client_id FROM client_addresses WHERE id=$1`, [id])).rows[0];
  if (!a) return res.status(404).json({ error: "العنوان مش موجود" });
  if (b.label !== undefined) await q(`UPDATE client_addresses SET label=$2 WHERE id=$1`, [id, String(b.label).trim()]);
  if (b.address !== undefined) await q(`UPDATE client_addresses SET address=$2 WHERE id=$1`, [id, String(b.address).trim()]);
  if (b.location !== undefined) {
    const loc = String(b.location).trim() ? await parseLocation(b.location) : { lat: null, lng: null, location_url: null };
    if (loc.error) return res.status(400).json({ error: loc.error });
    await q(`UPDATE client_addresses SET lat=$2, lng=$3, location_url=$4 WHERE id=$1`, [id, loc.lat, loc.lng, loc.location_url]);
  }
  await refreshSearch([a.client_id]);
  res.json(await clientById(a.client_id));
}));
app.delete("/api/addresses/:id", auth, staffOnly, wrap(async (req, res) => {
  const a = (await q(`DELETE FROM client_addresses WHERE id=$1 RETURNING client_id`, [Number(req.params.id)])).rows[0];
  if (a) await refreshSearch([a.client_id]);
  res.json(a ? await clientById(a.client_id) : { ok: true });
}));

// Bulk import from the customer sheet (works for the Genius export and simple lists).
// A row matches an existing customer by code first, then by any of its phones. Re-importing updates, never duplicates.
app.post("/api/clients/import", auth, allow("admin"), wrap(async (req, res) => {
  const input = Array.isArray(req.body && req.body.rows) ? req.body.rows.slice(0, 2000) : [];
  const st = { created: 0, merged: 0, phones: 0, addresses: 0, skipped: 0 };
  // 1) clean rows
  const rows = [];
  for (const r of input) {
    const code = String(r.code ?? "").trim().replace(/\.0+$/, "").slice(0, 40) || null;
    const merged = String(r.merged_codes ?? "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).split(/[^0-9]+/).filter(x => x && x !== code).slice(0, 30);
    const phones = [...new Set((r.phones || []).flatMap(splitPhones))].slice(0, 10);
    const name = String(r.name || "").trim().slice(0, 120);
    if (!code && !phones.length) { st.skipped++; continue; }
    const area = String(r.area || "").trim().slice(0, 60);
    const addresses = (r.addresses || []).flatMap(a => String(a.address || "").split("|").map((t, j) => ({
        address: t.trim().slice(0, 300), label: j ? "" : String(a.label || "").trim().slice(0, 40), location: j ? "" : String(a.location || "").trim() })))
      .filter(a => a.address || a.location).slice(0, 10);
    rows.push({ code, merged, phones, name, area, addresses,
      fee: num(r.delivery_fee), branch: String(r.branch || "").trim().slice(0, 40), invoices: Math.round(num(r.invoices, 0)),
      first: toDate(r.first_purchase), last: toDate(r.last_purchase), spend: num(r.spend_12m, 0), status: String(r.status || "").trim().slice(0, 40),
      notes: String(r.notes || "").trim().slice(0, 500) });
  }
  if (!rows.length) return res.json(st);

  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    const cq = (t, p) => conn.query(t, p);
    // 2) who already exists
    const codes = rows.map(r => r.code).filter(Boolean), allPhones = rows.flatMap(r => r.phones);
    const byCode = new Map((await cq(`SELECT id, code FROM clients WHERE code = ANY($1)`, [codes])).rows.map(r => [r.code, r.id]));
    const phoneRows = (await cq(`SELECT p.phone, p.client_id, c.code FROM client_phones p JOIN clients c ON c.id=p.client_id WHERE p.phone = ANY($1)`, [allPhones])).rows;
    const byPhoneAny = new Map(), byPhoneNoCode = new Map();
    phoneRows.forEach(r => { if (!byPhoneAny.has(r.phone)) byPhoneAny.set(r.phone, r.client_id); if (!r.code && !byPhoneNoCode.has(r.phone)) byPhoneNoCode.set(r.phone, r.client_id); });
    // 3) group rows. A row with a code is its own customer (different codes = different people, even on a shared number);
    //    it can absorb a code-less customer that was created from orders with the same phone. Rows without a code group by phone.
    const groups = []; const gByKey = new Map(); const claimed = new Set();
    const groupFor = id => { let g = id && groups.find(x => x.id === id); if (!g) { g = { id, rows: [] }; groups.push(g); } return g; };
    for (const r of rows) {
      let g;
      if (r.code) {
        g = gByKey.get("c:" + r.code);
        if (!g) {
          let id = byCode.get(r.code) || null;
          if (!id) { id = r.phones.map(p => byPhoneNoCode.get(p)).find(x => x && !claimed.has(x)) || null; if (id) claimed.add(id); }
          g = groupFor(id); gByKey.set("c:" + r.code, g);
        }
      } else {
        g = r.phones.map(p => gByKey.get("p:" + p)).find(Boolean);
        if (!g) g = groupFor(r.phones.map(p => byPhoneAny.get(p)).find(Boolean) || null);
        r.phones.forEach(p => gByKey.set("p:" + p, g));
      }
      g.rows.push(r);
    }
    // 4) create the new customers (ids reserved first so they map back exactly)
    const fresh = groups.filter(g => !g.id);
    if (fresh.length) {
      const ids = (await cq(`SELECT nextval(pg_get_serial_sequence('clients','id'))::int AS id FROM generate_series(1,$1)`, [fresh.length])).rows.map(r => r.id);
      fresh.forEach((g, i) => (g.id = ids[i]));
    }
    st.created = fresh.length; st.merged = rows.length - fresh.length;
    const head = g => { // first non-empty value wins for each field
      const pick = f => { for (const r of g.rows) if (r[f] !== null && r[f] !== "" && r[f] !== undefined) return r[f]; return null; };
      return { name: pick("name") || "", code: pick("code"), area: pick("area") || "", fee: pick("fee"), branch: pick("branch") || "",
        invoices: Math.max(0, ...g.rows.map(r => r.invoices || 0)), first: pick("first"), last: pick("last"),
        spend: Math.max(0, ...g.rows.map(r => r.spend || 0)), status: pick("status") || "", notes: g.rows.map(r => r.notes).filter(Boolean).join(" - "),
        alt: (() => { const m = [...new Set(g.rows.flatMap(r => r.merged))]; return m.length ? " " + m.join(" ") + " " : ""; })() };
    };
    const H = groups.map(head);
    const col = f => H.map(h => h[f]);
    // codes already used by another customer stay where they are
    const takenCodes = new Map((await cq(`SELECT code, id FROM clients WHERE code = ANY($1)`, [H.map(h => h.code).filter(Boolean)])).rows.map(r => [r.code, r.id]));
    const codeFor = H.map((h, i) => (h.code && (!takenCodes.has(h.code) || takenCodes.get(h.code) === groups[i].id) ? h.code : null));
    if (fresh.length) {
      const idx = groups.map((g, i) => i).filter(i => fresh.includes(groups[i]));
      const sel = arr => idx.map(i => arr[i]);
      await cq(`INSERT INTO clients(id, name, code, area, delivery_fee, branch, invoices, first_purchase, last_purchase, spend_12m, status, notes, alt_codes)
        SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::text[], $7::int[], $8::timestamptz[], $9::timestamptz[], $10::numeric[], $11::text[], $12::text[], $13::text[])`,
        [sel(groups.map(g => g.id)), sel(col("name")), sel(codeFor), sel(col("area")), sel(col("fee")), sel(col("branch")), sel(col("invoices")),
         sel(col("first")), sel(col("last")), sel(col("spend")), sel(col("status")), sel(col("notes")), sel(col("alt"))]);
    }
    const old = groups.map((g, i) => i).filter(i => !fresh.includes(groups[i]));
    if (old.length) {
      const sel = arr => old.map(i => arr[i]);
      await cq(`UPDATE clients c SET
          name = CASE WHEN c.name = '' THEN v.name ELSE c.name END,
          code = COALESCE(c.code, v.code),
          area = COALESCE(NULLIF(v.area, ''), c.area),
          delivery_fee = COALESCE(v.fee, c.delivery_fee),
          branch = COALESCE(NULLIF(v.branch, ''), c.branch),
          invoices = GREATEST(c.invoices, v.invoices),
          first_purchase = COALESCE(v.first, c.first_purchase),
          last_purchase = GREATEST(c.last_purchase, v.last),
          spend_12m = v.spend,
          status = COALESCE(NULLIF(v.status, ''), c.status),
          notes = CASE WHEN c.notes = '' THEN v.notes ELSE c.notes END,
          alt_codes = CASE WHEN v.alt = '' THEN c.alt_codes ELSE v.alt END,
          updated_at = now()
        FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::text[], $7::int[], $8::timestamptz[], $9::timestamptz[], $10::numeric[], $11::text[], $12::text[], $13::text[])
          AS v(id, name, code, area, fee, branch, invoices, first, last, spend, status, notes, alt)
        WHERE c.id = v.id`,
        [sel(groups.map(g => g.id)), sel(col("name")), sel(codeFor), sel(col("area")), sel(col("fee")), sel(col("branch")), sel(col("invoices")),
         sel(col("first")), sel(col("last")), sel(col("spend")), sel(col("status")), sel(col("notes")), sel(col("alt"))]);
    }
    // 5) phones
    const pPhone = [], pId = [];
    groups.forEach(g => [...new Set(g.rows.flatMap(r => r.phones))].forEach(p => { pPhone.push(p); pId.push(g.id); }));
    if (pPhone.length) st.phones = (await cq(`INSERT INTO client_phones(phone, client_id) SELECT * FROM unnest($1::text[], $2::int[]) ON CONFLICT DO NOTHING`, [pPhone, pId])).rowCount;
    // 6) addresses (skip ones the customer already has); the first address of a row is its main one
    const gIds = groups.map(g => g.id);
    const have = new Map();
    (await cq(`SELECT client_id, address, location_url FROM client_addresses WHERE client_id = ANY($1)`, [gIds])).rows
      .forEach(a => { const k = a.client_id; if (!have.has(k)) have.set(k, []); have.get(k).push(a); });
    const A = { cid: [], label: [], address: [], area: [], lat: [], lng: [], url: [], used: [] };
    groups.forEach((g, gi) => {
      const list = have.get(g.id) || []; let n = 0;
      const base = Date.parse(H[gi].last || "2000-01-01T00:00:00Z");
      g.rows.forEach(r => r.addresses.forEach((a, j) => {
        const c = coordsFromText(a.location); const url = (a.location.match(/https?:\/\/\S+/) || [null])[0];
        if (list.some(e => (a.address && normAddr(e.address) === normAddr(a.address)) || (url && e.location_url === url))) return;
        list.push({ address: a.address, location_url: url });
        A.cid.push(g.id); A.label.push(a.label); A.address.push(a.address); A.area.push(j === 0 ? r.area : "");
        A.lat.push(c ? c.lat : null); A.lng.push(c ? c.lng : null); A.url.push(url);
        A.used.push(new Date(base - (n++) * 1000).toISOString());
      }));
      have.set(g.id, list);
    });
    if (A.cid.length) st.addresses = (await cq(`INSERT INTO client_addresses(client_id, label, address, area, lat, lng, location_url, last_used_at)
      SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::float8[], $6::float8[], $7::text[], $8::timestamptz[])`,
      [A.cid, A.label, A.address, A.area, A.lat, A.lng, A.url, A.used])).rowCount;
    await refreshSearch(gIds, cq);
    await conn.query("COMMIT");
  } catch (e) { await conn.query("ROLLBACK"); throw e; }
  finally { conn.release(); }
  res.json(st);
}));

// Staff pastes a location onto an existing order
app.post("/api/orders/:id/location", auth, staffOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const loc = await parseLocation(req.body && req.body.location);
  if (!loc) return res.status(400).json({ error: "الصق اللوكيشن الأول" });
  if (loc.error) return res.status(400).json({ error: loc.error });
  const r = await q(`UPDATE orders SET lat=$2, lng=$3, location_url=$4, loc_at=now(), loc_source='staff', updated_at=now() WHERE id=$1`,
    [id, loc.lat, loc.lng, loc.location_url]);
  if (!r.rowCount) return res.status(404).json({ error: "الأوردر مش موجود" });
  await locationToAddress(id, loc.lat, loc.lng, loc.location_url);
  res.json({ ok: true, found_coords: loc.lat != null });
}));

// Link the customer opens to share their own location
app.post("/api/orders/:id/loc-link", auth, allow("admin", "staff"), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await q(`SELECT loc_token, status FROM orders WHERE id=$1`, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: "الأوردر مش موجود" });
  let token = cur.loc_token;
  if (!token) {
    token = crypto.randomBytes(9).toString("base64url");
    await q(`UPDATE orders SET loc_token=$2 WHERE id=$1`, [id, token]);
  }
  const base = PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  res.json({ url: `${base}/l/${token}` });
}));

// Public (no login): the customer's page reads the order basics and posts their position
const publicHits = new Map();
function publicLimit(req, res, next) {
  const k = req.ip; const now = Date.now();
  const h = (publicHits.get(k) || []).filter(t => now - t < 60000); h.push(now); publicHits.set(k, h);
  if (h.length > 30) return res.status(429).json({ error: "استنى دقيقة وجرّب تاني" });
  next();
}
async function orderByToken(token) {
  const { rows } = await q(`SELECT id, no, customer, phone, address, status, lat, created_at FROM orders WHERE loc_token=$1`, [String(token || "")]);
  const o = rows[0];
  if (!o) return null;
  if (Date.now() - new Date(o.created_at).getTime() > 48 * 3600 * 1000) return { expired: true };
  return o;
}
app.get("/api/public/loc/:token", publicLimit, wrap(async (req, res) => {
  const o = await orderByToken(req.params.token);
  if (!o || o.expired) return res.status(404).json({ error: "اللينك ده انتهى. اطلب لينك جديد من الصيدلية." });
  res.json({ no: o.no, name: String(o.customer).split(" ")[0], done: o.status === "done" || o.status === "cancel", has: o.lat != null });
}));
app.post("/api/public/loc/:token", publicLimit, wrap(async (req, res) => {
  const o = await orderByToken(req.params.token);
  if (!o || o.expired) return res.status(404).json({ error: "اللينك ده انتهى. اطلب لينك جديد من الصيدلية." });
  if (o.status === "done" || o.status === "cancel") return res.status(400).json({ error: "الأوردر ده خلص" });
  const lat = Number(req.body && req.body.lat), lng = Number(req.body && req.body.lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: "الموقع مش واضح، جرّب تاني" });
  await q(`UPDATE orders SET lat=$2, lng=$3, location_url=NULL, loc_at=now(), loc_source='customer', updated_at=now() WHERE id=$1`, [o.id, lat, lng]);
  await locationToAddress(o.id, lat, lng, null);
  res.json({ ok: true });
}));
app.get("/l/:token", (req, res) => res.sendFile(path.join(__dirname, "public", "locate.html")));

/* ---- live driver location ---- */
const lastStored = new Map(); let lastPurge = 0;
app.post("/api/driver/location", auth, allow("driver"), wrap(async (req, res) => {
  const b = req.body || {};
  const lat = num(b.lat), lng = num(b.lng);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: "الموقع مش واضح" });
  const acc = num(b.acc), speed = num(b.speed), battery = num(b.battery);
  await q(`UPDATE users SET last_lat=$2, last_lng=$3, last_acc=$4, last_speed=$5, last_battery=$6, last_at=now() WHERE id=$1`,
    [req.user.id, lat, lng, acc, speed, battery]);
  // keep a trail point every ~15 s or 25 m, skipping very inaccurate fixes
  const prev = lastStored.get(req.user.id);
  if ((acc === null || acc < 150) && (!prev || Date.now() - prev.t > 15000 || km(prev.lat, prev.lng, lat, lng) > 0.025)) {
    await q(`INSERT INTO driver_positions(driver_id, lat, lng, acc) VALUES ($1,$2,$3,$4)`, [req.user.id, lat, lng, acc]);
    lastStored.set(req.user.id, { lat, lng, t: Date.now() });
  }
  if (Date.now() - lastPurge > 3600 * 1000) { lastPurge = Date.now(); q(`DELETE FROM driver_positions WHERE at < now() - interval '14 days'`).catch(() => {}); }
  res.json({ ok: true });
}));
app.get("/api/live", auth, staffOnly, wrap(async (req, res) => {
  const drivers = (await q(`SELECT id, name, phone, last_lat AS lat, last_lng AS lng, last_acc AS acc, last_speed AS speed, last_battery AS battery, last_at AS at
    FROM users WHERE role='driver' AND active ORDER BY name`)).rows;
  const orders = (await q(`SELECT id, no, customer, address, area, lat, lng, status, driver_id, created_at, out_at, promise_min
    FROM orders WHERE day=$1 AND status IN ('new','ready','out') ORDER BY no`, [todayCairo()])).rows;
  const trail = (await q(`SELECT driver_id, lat, lng, at FROM driver_positions WHERE at > now() - interval '3 hours' ORDER BY driver_id, at`)).rows;
  const trails = {};
  for (const p of trail) (trails[p.driver_id] = trails[p.driver_id] || []).push([p.lat, p.lng]);
  for (const k of Object.keys(trails)) { const t = trails[k]; if (t.length > 300) { const step = Math.ceil(t.length / 300); trails[k] = t.filter((_, i) => i % step === 0 || i === t.length - 1); } }
  const st = await getSettings();
  res.json({ now: new Date().toISOString(), drivers, orders, trails, pharmacy: st.lat != null ? { name: st.name, lat: st.lat, lng: st.lng } : null });
}));

// Tracking link the customer opens from the "your order is out" message
app.post("/api/orders/:id/track-link", auth, staffOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = (await q(`SELECT track_token FROM orders WHERE id=$1`, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: "الأوردر مش موجود" });
  let token = cur.track_token;
  if (!token) { token = crypto.randomBytes(9).toString("base64url"); await q(`UPDATE orders SET track_token=$2 WHERE id=$1`, [id, token]); }
  const base = PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  res.json({ url: `${base}/t/${token}` });
}));
app.get("/api/public/track/:token", publicLimit, wrap(async (req, res) => {
  const o = (await q(`SELECT o.no, o.customer, o.status, o.lat, o.lng, o.created_at, o.out_at, o.delivered_at, o.driver_id,
      u.name AS driver_name, u.last_lat, u.last_lng, u.last_at
    FROM orders o LEFT JOIN users u ON u.id=o.driver_id WHERE o.track_token=$1`, [String(req.params.token || "")])).rows[0];
  if (!o || Date.now() - new Date(o.created_at).getTime() > 24 * 3600 * 1000) return res.status(404).json({ error: "اللينك ده انتهى" });
  const st = await getSettings();
  const out = { pharmacy: st.name, shop: st.lat != null ? { lat: st.lat, lng: st.lng } : null, no: o.no, name: String(o.customer).split(" ")[0], status: o.status, out_at: o.out_at, delivered_at: o.delivered_at,
    dest: o.lat != null ? { lat: o.lat, lng: o.lng } : null, driver: null, now: new Date().toISOString() };
  // the driver's position is shared only while this order is on its way
  if (o.status === "out" && o.last_lat != null && o.last_at && Date.now() - new Date(o.last_at).getTime() < 15 * 60000) {
    out.driver = { name: String(o.driver_name || "").split(" ")[0], lat: o.last_lat, lng: o.last_lng, at: o.last_at };
    if (out.dest) out.km = Math.round(km(o.last_lat, o.last_lng, o.lat, o.lng) * 1.3 * 10) / 10;
  }
  res.json(out);
}));
app.get("/t/:token", (req, res) => res.sendFile(path.join(__dirname, "public", "track.html")));

/* ---- driver accounts: commission and cash, settled at the end of the day ---- */
const OPEN = `o.status='done' AND o.driver_id IS NOT NULL AND o.settlement_id IS NULL AND o.settled_at IS NULL`;
const share = `coalesce(o.driver_share, 0)`;
const TOTALS = `count(*)::int AS n, coalesce(sum(o.delivery_fee),0)::float AS fees, coalesce(sum(${share}),0)::float AS share,
  coalesce(sum(o.collected_amount) FILTER (WHERE o.collected_method='نقدي'),0)::float AS cash,
  coalesce(sum(o.collected_amount) FILTER (WHERE o.collected_method<>'نقدي'),0)::float AS other,
  min(o.delivered_at) AS since`;
// the driver's own banner (and the old "custody" name, kept for older app versions)
app.get(["/api/custody", "/api/my-account"], auth, wrap(async (req, res) => {
  const params = []; let where = "";
  if (req.user.role === "driver") { params.push(req.user.id); where = "AND o.driver_id=$1"; }
  const { rows } = await q(`SELECT u.id AS driver_id, u.name, ${TOTALS} FROM orders o JOIN users u ON u.id=o.driver_id
    WHERE ${OPEN} ${where} GROUP BY u.id, u.name ORDER BY u.name`, params);
  rows.forEach(r => (r.net = Math.round((r.cash - r.share) * 100) / 100));
  res.json(rows);
}));
app.get("/api/accounts", auth, staffOnly, wrap(async (req, res) => {
  const drivers = (await q(`SELECT id, name FROM users WHERE role='driver' ORDER BY active DESC, name`)).rows;
  const orders = (await q(`SELECT o.id, o.no, o.day, o.customer, o.area, o.amount::float AS amount, o.delivery_fee::float AS fee,
      o.driver_share::float AS share, o.share_manual, o.collected_method AS method, o.collected_amount::float AS collected, o.delivered_at, o.driver_id
    FROM orders o WHERE ${OPEN} ORDER BY o.delivered_at`)).rows;
  const history = (await q(`SELECT s.*, s.fees::float AS fees, s.share::float AS share, s.cash::float AS cash, s.other::float AS other, s.net::float AS net,
      d.name AS driver, b.name AS by FROM driver_settlements s LEFT JOIN users d ON d.id=s.driver_id LEFT JOIN users b ON b.id=s.by_user
    ORDER BY s.at DESC LIMIT 40`)).rows;
  res.json({ rules: await getRules(), drivers, orders, history });
}));
app.put("/api/share-rules", auth, allow("admin"), wrap(async (req, res) => {
  const rules = cleanRules(req.body && req.body.rules);
  if (!rules) return res.status(400).json({ error: "القواعد مش مظبوطة. النسبة من 0 لـ 100، والمبلغ الثابت رقم موجب." });
  await setSetting("share_rules", JSON.stringify(rules));
  // apply to delivered orders that aren't settled yet (unless someone set their share by hand)
  const open = (await q(`SELECT id, delivery_fee FROM orders o WHERE ${OPEN} AND NOT o.share_manual`)).rows;
  for (const o of open) await q(`UPDATE orders SET driver_share=$2 WHERE id=$1`, [o.id, shareFor(o.delivery_fee, rules)]);
  res.json({ rules, updated: open.length });
}));
app.patch("/api/orders/:id/share", auth, staffOnly, wrap(async (req, res) => {
  const id = Number(req.params.id); const b = req.body || {};
  const o = (await q(`SELECT * FROM orders o WHERE id=$1 AND ${OPEN}`, [id])).rows[0];
  if (!o) return res.status(400).json({ error: "الأوردر ده اتقفل حسابه أو لسه ماتسلمش" });
  if (b.reset) {
    await q(`UPDATE orders SET share_manual=false, driver_share=$2 WHERE id=$1`, [id, shareFor(o.delivery_fee, await getRules())]);
  } else {
    const v = num(b.share);
    if (v === null || v < 0 || v > 5000) return res.status(400).json({ error: "المبلغ مش مظبوط" });
    await q(`UPDATE orders SET share_manual=true, driver_share=$2 WHERE id=$1`, [id, v]);
  }
  res.json({ ok: true });
}));
app.post(["/api/accounts/:driverId/settle", "/api/custody/:driverId/settle"], auth, staffOnly, wrap(async (req, res) => {
  const driverId = Number(req.params.driverId);
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    const t = (await conn.query(`SELECT ${TOTALS} FROM orders o WHERE ${OPEN} AND o.driver_id=$1`, [driverId])).rows[0];
    if (!t.n) { await conn.query("ROLLBACK"); return res.status(400).json({ error: "مفيش أوردرات مفتوحة للطيار ده" }); }
    const net = Math.round((t.cash - t.share) * 100) / 100;
    const sid = (await conn.query(`INSERT INTO driver_settlements(driver_id, by_user, n, fees, share, cash, other, net, note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [driverId, req.user.id, t.n, t.fees, t.share, t.cash, t.other, net, String((req.body || {}).note || "").slice(0, 200)])).rows[0].id;
    await conn.query(`UPDATE orders o SET settlement_id=$2, settled_at=now(), settled_by=$3 WHERE ${OPEN} AND o.driver_id=$1`, [driverId, sid, req.user.id]);
    await conn.query("COMMIT");
    res.json({ id: sid, n: t.n, share: t.share, cash: t.cash, net });
  } catch (e) { await conn.query("ROLLBACK"); throw e; }
  finally { conn.release(); }
}));
app.get("/api/settlements/:id", auth, staffOnly, wrap(async (req, res) => {
  const { rows } = await q(`SELECT o.no, o.day, o.customer, o.amount::float AS amount, o.delivery_fee::float AS fee, o.driver_share::float AS share,
    o.collected_method AS method, o.collected_amount::float AS collected FROM orders o WHERE o.settlement_id=$1 ORDER BY o.delivered_at`, [Number(req.params.id)]);
  res.json(rows);
}));

/* ---- report: one period, any filters, every breakdown ---- */
function reportWhere(f, from, to) {
  const params = [from, to]; const P = v => { params.push(v); return "$" + params.length; };
  const w = [`o.day BETWEEN $1 AND $2`];
  if (f.driver) w.push(`o.driver_id = ${P(Number(f.driver))}`);
  if (f.staff) w.push(`o.created_by = ${P(Number(f.staff))}`);
  if (f.method) w.push(`coalesce(nullif(o.collected_method,''), nullif(o.payment,''), 'غير محدد') = ${P(String(f.method))}`);
  if (f.area) w.push(f.area === "غير محدد" ? `coalesce(o.area,'') = ''` : `o.area = ${P(String(f.area))}`);
  if (f.source) w.push(`o.source = ${P(String(f.source))}`);
  if (f.status === "late") w.push(`o.status='done' AND ${M("o.created_at", "o.delivered_at")} > o.promise_min`);
  else if (f.status === "active") w.push(`o.status IN ('new','ready','out')`);
  else if (["done", "cancel"].includes(f.status)) w.push(`o.status = ${P(f.status)}`);
  if (f.client) w.push(`o.client_id = ${P(Number(f.client))}`);
  return { where: "WHERE " + w.join(" AND "), params };
}
const M = (a, b) => `EXTRACT(EPOCH FROM (${b} - ${a}))/60`;
const SUMMARY = `count(*)::int AS total,
  count(*) FILTER (WHERE o.status='done')::int AS done,
  count(*) FILTER (WHERE o.status='cancel')::int AS cancelled,
  count(*) FILTER (WHERE o.status IN ('new','ready','out'))::int AS active,
  count(*) FILTER (WHERE o.status='done' AND ${M("o.created_at", "o.delivered_at")} <= o.promise_min)::int AS on_time,
  coalesce(sum(o.collected_amount) FILTER (WHERE o.status='done'),0)::float AS sales,
  coalesce(sum(o.amount) FILTER (WHERE o.status='cancel'),0)::float AS lost,
  coalesce(sum(o.delivery_fee) FILTER (WHERE o.status='done'),0)::float AS fees,
  coalesce(sum(o.driver_share) FILTER (WHERE o.status='done'),0)::float AS share,
  round(avg(o.collected_amount) FILTER (WHERE o.status='done'))::int AS avg_order,
  round(avg(${M("o.created_at", "o.delivered_at")}) FILTER (WHERE o.status='done'))::int AS avg_total,
  round(avg(${M("o.created_at", "o.ready_at")}) FILTER (WHERE o.ready_at IS NOT NULL))::int AS avg_prep,
  round(avg(${M("o.ready_at", "o.out_at")}) FILTER (WHERE o.out_at IS NOT NULL AND o.ready_at IS NOT NULL))::int AS avg_wait,
  round(avg(${M("o.out_at", "o.delivered_at")}) FILTER (WHERE o.status='done' AND o.out_at IS NOT NULL))::int AS avg_road,
  count(*) FILTER (WHERE o.edits > 0)::int AS edited,
  count(*) FILTER (WHERE o.lat IS NOT NULL OR o.location_url IS NOT NULL)::int AS located,
  count(DISTINCT o.client_id)::int AS customers`;
const GROUP_COLS = `count(*)::int AS n, count(*) FILTER (WHERE o.status='done')::int AS done,
  count(*) FILTER (WHERE o.status='cancel')::int AS cancelled,
  count(*) FILTER (WHERE o.status='done' AND ${M("o.created_at", "o.delivered_at")} > o.promise_min)::int AS late,
  coalesce(sum(o.collected_amount) FILTER (WHERE o.status='done'),0)::float AS sales,
  round(avg(${M("o.created_at", "o.delivered_at")}) FILTER (WHERE o.status='done'))::int AS avg_total`;
app.get("/api/report", auth, allow("admin", "staff"), wrap(async (req, res) => {
  const from = isDay(req.query.from) ? req.query.from : todayCairo();
  let to = isDay(req.query.to) ? req.query.to : from;
  if (to < from) to = from;
  const f = req.query;
  const { where, params } = reportWhere(f, from, to);
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const pTo = new Date(Date.parse(from) - 86400000).toISOString().slice(0, 10);
  const pFrom = new Date(Date.parse(from) - days * 86400000).toISOString().slice(0, 10);
  const prevW = reportWhere(f, pFrom, pTo);
  const run = (sql, p = params) => q(sql, p).then(r => r.rows);
  const FROM = `FROM orders o LEFT JOIN users d ON d.id=o.driver_id LEFT JOIN users s ON s.id=o.created_by LEFT JOIN clients c ON c.id=o.client_id ${where}`;
  const [summary, prev, daily, byDriver, byArea, byHour, byWeekday, byMethod, bySource, byStaff, reasons, topCustomers, orders, options] = await Promise.all([
    run(`SELECT ${SUMMARY} FROM orders o ${where}`).then(r => r[0]),
    run(`SELECT ${SUMMARY} FROM orders o ${prevW.where}`, prevW.params).then(r => r[0]),
    days <= 120 ? run(`SELECT to_char(g.d,'YYYY-MM-DD') AS day, coalesce(x.n,0) AS n, coalesce(x.done,0) AS done, coalesce(x.cancelled,0) AS cancelled, coalesce(x.sales,0) AS sales
      FROM generate_series($1::date, $2::date, '1 day') g(d) LEFT JOIN (SELECT o.day, ${GROUP_COLS} FROM orders o ${where} GROUP BY o.day) x ON x.day = g.d::date ORDER BY g.d`) : [],
    run(`SELECT d.id, d.name, ${GROUP_COLS},
        count(*) FILTER (WHERE o.status='cancel' AND o.out_at IS NOT NULL)::int AS cancelled_on_road,
        round(avg(${M("o.out_at", "o.delivered_at")}) FILTER (WHERE o.status='done'))::int AS avg_road,
        coalesce(sum(o.delivery_fee) FILTER (WHERE o.status='done'),0)::float AS fees,
        coalesce(sum(o.driver_share) FILTER (WHERE o.status='done'),0)::float AS share,
        coalesce(sum(o.collected_amount) FILTER (WHERE o.status='done' AND o.collected_method='نقدي'),0)::float AS cash
      FROM orders o JOIN users d ON d.id=o.driver_id ${where} GROUP BY d.id, d.name ORDER BY done DESC`),
    run(`SELECT coalesce(nullif(o.area,''),'غير محدد') AS area, ${GROUP_COLS} FROM orders o ${where} GROUP BY 1 ORDER BY n DESC LIMIT 40`),
    run(`SELECT EXTRACT(HOUR FROM o.created_at AT TIME ZONE '${TZ}')::int AS h, ${GROUP_COLS} FROM orders o ${where} GROUP BY 1 ORDER BY 1`),
    run(`SELECT EXTRACT(ISODOW FROM o.day)::int AS wd, ${GROUP_COLS} FROM orders o ${where} GROUP BY 1 ORDER BY 1`),
    run(`SELECT coalesce(nullif(o.collected_method,''), nullif(o.payment,''), 'غير محدد') AS method, ${GROUP_COLS} FROM orders o ${where} GROUP BY 1 ORDER BY sales DESC`),
    run(`SELECT coalesce(nullif(o.source,''),'غير محدد') AS source, ${GROUP_COLS} FROM orders o ${where} GROUP BY 1 ORDER BY n DESC`),
    run(`SELECT s.id, s.name, ${GROUP_COLS}, count(*) FILTER (WHERE o.edits>0)::int AS edited
      FROM orders o JOIN users s ON s.id=o.created_by ${where} GROUP BY s.id, s.name ORDER BY n DESC`),
    run(`SELECT coalesce(o.cancel_reason,'غير محدد') AS reason, count(*)::int AS n, coalesce(sum(o.amount),0)::float AS lost,
        count(*) FILTER (WHERE o.out_at IS NOT NULL)::int AS on_road FROM orders o ${where} AND o.status='cancel' GROUP BY 1 ORDER BY n DESC`),
    run(`SELECT c.id, coalesce(nullif(c.name,''), max(o.customer)) AS name, c.code, ${GROUP_COLS}
      FROM orders o JOIN clients c ON c.id=o.client_id ${where} GROUP BY c.id ORDER BY sales DESC, n DESC LIMIT 20`),
    run(`SELECT o.id, o.no, o.day, o.created_at, o.customer, o.phone, o.area, c.code, o.amount::float AS amount, o.delivery_fee::float AS fee,
        o.payment, o.collected_method AS method, o.collected_amount::float AS collected, o.driver_share::float AS share, o.status, o.source,
        d.name AS driver, s.name AS staff, o.cancel_reason, o.edits, o.promise_min,
        round(${M("o.created_at", "coalesce(o.delivered_at, o.cancelled_at)")})::int AS minutes
      ${FROM} ORDER BY o.created_at DESC LIMIT 4000`),
    run(`SELECT
        (SELECT json_agg(x ORDER BY x) FROM (SELECT DISTINCT coalesce(nullif(o.area,''),'غير محدد') AS x FROM orders o WHERE o.day BETWEEN $1 AND $2) a) AS areas,
        (SELECT json_agg(x ORDER BY x) FROM (SELECT DISTINCT coalesce(nullif(o.collected_method,''), nullif(o.payment,''), 'غير محدد') AS x FROM orders o WHERE o.day BETWEEN $1 AND $2) m) AS methods,
        (SELECT json_agg(x ORDER BY x) FROM (SELECT DISTINCT o.source AS x FROM orders o WHERE o.day BETWEEN $1 AND $2 AND o.source <> '') s) AS sources`, [from, to]).then(r => r[0]),
  ]);
  const people = (await q(`SELECT id, name, role FROM users ORDER BY name`)).rows;
  res.json({ from, to, days, prev_from: pFrom, prev_to: pTo, summary, prev, daily, by_driver: byDriver, by_area: byArea, by_hour: byHour,
    by_weekday: byWeekday, by_method: byMethod, by_source: bySource, by_staff: byStaff, reasons, top_customers: topCustomers, orders,
    options: { areas: options.areas || [], methods: options.methods || [], sources: options.sources || [],
      drivers: people.filter(u => u.role === "driver"), staff: people.filter(u => u.role !== "driver") } });
}));

/* ---- static app ---- */
app.use("/vendor/xlsx", express.static(path.join(__dirname, "node_modules", "xlsx", "dist"), { maxAge: "30d" }));
app.use("/vendor/leaflet", express.static(path.join(__dirname, "node_modules", "leaflet", "dist"), { maxAge: "30d" }));
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, p) { if (p.endsWith("sw.js") || p.endsWith(".html")) res.set("Cache-Control", "no-cache"); },
}));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "حصلت مشكلة في السيرفر، جرّب تاني" });
});

migrate().then(() => app.listen(PORT, () => console.log("Listening on " + PORT)))
  .catch(e => { console.error("Migration failed", e); process.exit(1); });
