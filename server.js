// Pharmacy delivery — API server
// Node + Express + Postgres. Serves the mobile web app from /public.
const express = require("express");
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
  `);
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

/* ---------------- app ---------------- */
const app = express();
app.disable("x-powered-by");
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
  res.json({ day, now: new Date().toISOString(), orders: rows });
}));

app.post("/api/orders", auth, allow("admin", "staff"), wrap(async (req, res) => {
  const b = req.body || {};
  if (!String(b.customer || "").trim()) return res.status(400).json({ error: "اكتب اسم العميل" });
  if (!String(b.address || "").trim()) return res.status(400).json({ error: "اكتب العنوان" });
  const day = todayCairo();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const c = await client.query(
      `INSERT INTO day_counter(day,n) VALUES ($1,1) ON CONFLICT(day) DO UPDATE SET n=day_counter.n+1 RETURNING n`, [day]);
    const { rows } = await client.query(
      `INSERT INTO orders(day,no,customer,phone,address,items,amount,source,payment,promise_min,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [day, c.rows[0].n, String(b.customer).trim(), String(b.phone || "").trim(), String(b.address).trim(),
       String(b.items || "").trim(), Number(b.amount) || 0, String(b.source || ""), String(b.payment || ""),
       Math.min(240, Math.max(10, Number(b.promise_min) || 60)), req.user.id]);
    await client.query("COMMIT");
    const o = await q(`SELECT ${ORDER_COLS} FROM orders o LEFT JOIN users d ON d.id=o.driver_id WHERE o.id=$1`, [rows[0].id]);
    res.json(o.rows[0]);
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}));

// One endpoint for every status change, with role rules
app.patch("/api/orders/:id", auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { action, driver_id, reason } = req.body || {};
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
      sql = `UPDATE orders SET status='done', delivered_at=now(), updated_at=now() WHERE id=$1`; params = [id];
      break;
    case "cancel":
      if (isDriver) return res.status(403).json({ error: "الإلغاء من الصيدلية بس" });
      if (final) return res.status(400).json({ error: "الأوردر خلص" });
      sql = `UPDATE orders SET status='cancel', cancel_reason=$2, cancelled_at=now(), updated_at=now() WHERE id=$1`;
      params = [id, String(reason || "سبب تاني").slice(0, 100)];
      break;
    default:
      return res.status(400).json({ error: "طلب غير معروف" });
  }
  await q(sql, params);
  const out = await q(`SELECT ${ORDER_COLS} FROM orders o LEFT JOIN users d ON d.id=o.driver_id WHERE o.id=$1`, [id]);
  res.json(out.rows[0]);
}));

/* ---- report ---- */
app.get("/api/report", auth, allow("admin", "staff"), wrap(async (req, res) => {
  const from = isDay(req.query.from) ? req.query.from : todayCairo();
  const to = isDay(req.query.to) ? req.query.to : from;
  const m = (a, b) => `EXTRACT(EPOCH FROM (${b} - ${a}))/60`;
  const sum = await q(`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status='done')::int AS done,
      count(*) FILTER (WHERE status='cancel')::int AS cancelled,
      count(*) FILTER (WHERE status='done' AND ${m("created_at", "delivered_at")} <= promise_min)::int AS on_time,
      round(avg(${m("created_at", "delivered_at")}) FILTER (WHERE status='done'))::int AS avg_total,
      round(avg(${m("created_at", "ready_at")}) FILTER (WHERE ready_at IS NOT NULL))::int AS avg_prep,
      round(avg(${m("ready_at", "out_at")}) FILTER (WHERE out_at IS NOT NULL AND ready_at IS NOT NULL))::int AS avg_wait,
      round(avg(${m("out_at", "delivered_at")}) FILTER (WHERE status='done' AND out_at IS NOT NULL))::int AS avg_road
    FROM orders WHERE day BETWEEN $1 AND $2`, [from, to]);
  const reasons = await q(`SELECT coalesce(cancel_reason,'غير محدد') AS reason, count(*)::int AS n FROM orders
    WHERE day BETWEEN $1 AND $2 AND status='cancel' GROUP BY 1 ORDER BY 2 DESC`, [from, to]);
  const drivers = await q(`SELECT u.name, count(*)::int AS n,
      round(avg(${m("o.out_at", "o.delivered_at")}))::int AS avg_road,
      count(*) FILTER (WHERE ${m("o.created_at", "o.delivered_at")} > o.promise_min)::int AS late
    FROM orders o JOIN users u ON u.id=o.driver_id
    WHERE o.day BETWEEN $1 AND $2 AND o.status='done' GROUP BY u.name ORDER BY n DESC`, [from, to]);
  const hours = await q(`SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE '${TZ}')::int AS h, count(*)::int AS n,
      count(*) FILTER (WHERE status='cancel')::int AS cancelled
    FROM orders WHERE day BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, [from, to]);
  res.json({ from, to, summary: sum.rows[0], reasons: reasons.rows, drivers: drivers.rows, hours: hours.rows });
}));

/* ---- static app ---- */
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
