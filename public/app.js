(function () {
  "use strict";
  const STATUS = {
    new: { label: "جديد", action: "ready", actionLabel: "جاهز للتوصيل" },
    ready: { label: "جاهز", action: "out", actionLabel: "خرج مع الطيار" },
    out: { label: "مع الطيار", action: "done", actionLabel: "اتسلم للعميل" },
    done: { label: "اتسلم" },
    cancel: { label: "اتلغى" },
  };
  const METHODS = ["نقدي", "فيزا", "انستاباي", "محفظة", "مدفوع مسبقًا"];
  const normPhone = p => { let d = String(p || "").replace(/[٠-٩]/g, c => "٠١٢٣٤٥٦٧٨٩".indexOf(c)).replace(/\D/g, "");
    if (d.startsWith("0020")) d = d.slice(4); else if (d.startsWith("20") && d.length === 12) d = d.slice(2);
    if (d.length === 10 && d.startsWith("1")) d = "0" + d; return d; };
  const money = n => (Number(n) || 0).toLocaleString("ar-EG", { maximumFractionDigits: 2 }) + " ج";
  const REASONS = ["تأخير", "العميل لغى", "صنف ناقص", "عنوان غلط / مش بيرد", "سبب تاني"];
  const FILTERS = [["active", "الشغال"], ["late", "المتأخر"], ["new", "جديد"], ["ready", "جاهز"], ["out", "مع الطيار"], ["done", "اتسلم"], ["cancel", "اتلغى"], ["all", "الكل"]];
  const TABS = {
    admin: [["orders", "الأوردرات"], ["map", "الخريطة"], ["clients", "العملاء"], ["report", "التقارير"], ["users", "الفريق"]],
    staff: [["orders", "الأوردرات"], ["map", "الخريطة"], ["clients", "العملاء"], ["report", "التقارير"]],
    driver: [["driver", "أوردراتي"]],
  };

  const S = { live: [], token: null, user: null, today: null, orders: [], drivers: [], users: [], tab: null, filter: "active", skew: 0, pollT: null, lastMine: null };
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const now = () => Date.now() + S.skew;
  const ts = v => (v ? Date.parse(v) : null);
  const mins = ms => Math.max(0, Math.round(ms / 60000));
  const fmtMin = m => (m == null || isNaN(m) ? "—" : m < 60 ? m + " د" : Math.floor(m / 60) + " س" + (m % 60 ? " " + (m % 60) + " د" : ""));
  const clock = v => (v ? new Date(v).toLocaleTimeString("ar-EG", { hour: "numeric", minute: "2-digit" }) : "—");

  /* ---------- API ---------- */
  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: Object.assign({ "Content-Type": "application/json" }, S.token ? { Authorization: "Bearer " + S.token } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (res.status === 401 && S.token) { logoutLocal(); throw new Error(data.error || "سجّل دخول تاني"); }
    if (!res.ok) throw new Error(data.error || "حصلت مشكلة، جرّب تاني");
    return data;
  }

  /* ---------- pharmacy name & location ---------- */
  S.shop = { name: "توصيل الصيدلية", lat: null, lng: null };
  function applyShop() {
    document.querySelectorAll(".js-shop").forEach(el => (el.textContent = S.shop.name));
    document.title = S.shop.name;
  }
  async function loadShop() { try { S.shop = await api("/api/public/settings"); applyShop(); } catch (e) {} }
  function renderShopForm() {
    $("s-name").value = S.shop.name;
    $("s-loc").value = "";
    $("s-loc").placeholder = S.shop.lat != null ? `محفوظ: ${S.shop.lat.toFixed(5)}, ${S.shop.lng.toFixed(5)} · الصق لينك جديد للتغيير` : "الصق لينك جوجل ماب للصيدلية";
    $("s-status").textContent = S.shop.lat != null ? "موقع الصيدلية محفوظ وبيظهر على الخريطة." : "موقع الصيدلية لسه مش متحدد.";
  }
  async function saveShop(body, msg) {
    try { S.shop = await api("/api/settings", { method: "PUT", body }); applyShop(); renderShopForm(); toast(msg); if (MAP) refreshMap(); }
    catch (err) { toast(err.message); }
  }
  $("shopForm").addEventListener("submit", e => {
    e.preventDefault();
    const body = { name: $("s-name").value };
    if ($("s-loc").value.trim()) body.location = $("s-loc").value;
    saveShop(body, "بيانات الصيدلية اتحفظت");
  });
  $("s-here").addEventListener("click", () => {
    if (!navigator.geolocation) { toast("الجهاز ده مش بيدعم تحديد الموقع"); return; }
    $("s-status").textContent = "بيحدد موقعك…";
    navigator.geolocation.getCurrentPosition(
      p => saveShop({ lat: p.coords.latitude, lng: p.coords.longitude }, "موقع الصيدلية اتحفظ"),
      () => { $("s-status").textContent = "مش قادر يحدد موقعك. اسمح للمتصفح بالموقع، أو الصق لينك جوجل ماب."; },
      { enableHighAccuracy: true, timeout: 20000 });
  });

  /* ---------- login ---------- */
  async function showLogin(msg) {
    $("app").hidden = true; $("login").hidden = false;
    $("loginErr").hidden = !msg; $("loginErr").textContent = msg || "";
    try {
      const names = await api("/api/login-names");
      const roleName = { admin: "مدير", staff: "صيدلية", driver: "طيار" };
      let last = ""; try { last = localStorage.getItem("lastUser") || ""; } catch (e) {}
      $("l-user").innerHTML = `<option value="">اختار اسمك…</option>` +
        names.map(u => `<option value="${u.id}" ${String(u.id) === last ? "selected" : ""}>${esc(u.name)} (${roleName[u.role]})</option>`).join("");
    } catch (e) { $("loginErr").hidden = false; $("loginErr").textContent = "مش قادر أوصل للسيرفر. اتأكد من النت وجرّب تاني."; }
  }
  $("loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    const btn = e.target.querySelector("button"); btn.disabled = true;
    try {
      const r = await api("/api/login", { method: "POST", body: { userId: $("l-user").value, pin: $("l-pin").value } });
      S.token = r.token;
      try { localStorage.setItem("token", r.token); localStorage.setItem("lastUser", $("l-user").value); } catch (err) {}
      $("l-pin").value = "";
      await start();
    } catch (err) { $("loginErr").hidden = false; $("loginErr").textContent = err.message; }
    btn.disabled = false;
  });
  function logoutLocal() {
    S.token = null; S.user = null; clearInterval(S.pollT);
    try { localStorage.removeItem("token"); } catch (e) {}
    showLogin();
  }
  $("logout").addEventListener("click", async () => { try { await api("/api/logout", { method: "POST" }); } catch (e) {} logoutLocal(); });

  /* ---------- start ---------- */
  async function start() {
    const me = await api("/api/me");
    S.user = me.user; S.today = me.today;
    $("login").hidden = true; $("app").hidden = false;
    const roleName = { admin: "مدير", staff: "صيدلية", driver: "طيار" };
    $("whoami").textContent = `${S.user.name} (${roleName[S.user.role]})`;
    const tabs = TABS[S.user.role];
    $("tabs").hidden = tabs.length < 2;
    $("tabs").innerHTML = tabs.map(([k, l]) => `<button role="tab" data-tab="${k}">${l}</button>`).join("");
    $("r-from").value = $("r-to").value = S.today;
    setTab(tabs[0][0]);
    await refresh();
    clearInterval(S.pollT);
    S.pollT = setInterval(() => { if (!document.hidden) refresh(); }, 10000);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && S.user) { refresh(); if (TR.watch !== null) keepAwake(); if (S.tab === "map") refreshMap(); }
  });

  function setTab(t) {
    S.tab = t;
    document.querySelectorAll("[data-tab]").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === t));
    ["orders", "driver", "report", "users", "clients", "map"].forEach(k => ($("tab-" + k).hidden = k !== t));
    $("summary").hidden = t === "report" || t === "users" || t === "clients" || t === "map";
    if (t === "map") openMap().catch(err => ($("mapStatus").textContent = err.message));
    if (t === "report") loadReport();
    if (t === "clients") { $("importPanel").hidden = S.user.role !== "admin"; loadClients(); }
    if (t === "users") { loadUsers(); renderShopForm(); }
    render();
  }

  async function refresh() {
    try {
      const r = await api("/api/orders");
      S.skew = Date.parse(r.now) - Date.now();
      const hadLoc = new Set(S.orders.filter(o => o.lat != null).map(o => o.id));
      const firstLoad = !S.orders.length;
      S.orders = r.orders; S.today = r.day; S.live = r.drivers_live || [];
      if (!firstLoad && S.user.role !== "driver") {
        const arrived = S.orders.find(o => o.lat != null && o.loc_source === "customer" && !hadLoc.has(o.id));
        if (arrived) toast(`لوكيشن أوردر #${arrived.no} وصل من العميل`);
      }
      if (S.user.role !== "driver") S.drivers = (await api("/api/users")).filter(u => u.role === "driver" && u.active);
      $("sync").textContent = "آخر تحديث " + clock(new Date());
      notifyDriver();
      syncTracking();
      render();
    } catch (e) { $("sync").textContent = "مفيش اتصال — بيحاول تاني"; }
  }

  // Buzz the driver's phone when a new order is assigned to them
  function notifyDriver() {
    if (!S.user || S.user.role !== "driver") return;
    const mine = S.orders.filter(o => o.driver_id === S.user.id && o.status === "ready").map(o => o.id);
    if (S.lastMine && mine.some(id => !S.lastMine.includes(id))) {
      try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {}
      toast("فيه أوردر جديد ليك");
    }
    S.lastMine = mine;
  }

  /* ---------- location helpers ---------- */
  function mapHref(o) {
    if (o.lat != null && o.lng != null) return `https://www.google.com/maps/dir/?api=1&destination=${o.lat},${o.lng}`;
    if (o.location_url) return o.location_url;
    if (o.address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.address)}`;
    return "";
  }
  const waLink = (phone, text) => {
    const d = String(phone || "").replace(/\D/g, ""); const intl = d.startsWith("0") ? "2" + d : d;
    return `https://wa.me/${intl}?text=${encodeURIComponent(text)}`;
  };

  function distKm(aLat, aLng, bLat, bLng) {
    const r = x => x * Math.PI / 180;
    const d = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(d));
  }
  const fmtKm = k => (k < 1 ? Math.round(k * 1000 / 50) * 50 + " م" : (Math.round(k * 10) / 10) + " كم");
  const ago = v => { const s = Math.max(0, Math.round((now() - ts(v)) / 1000)); return s < 60 ? `${s} ث` : s < 3600 ? `${Math.round(s / 60)} د` : `${Math.round(s / 3600)} س`; };

  /* ---------- driver: share location while delivering ---------- */
  const TR = { watch: null, hb: null, last: null, sentAt: 0, okAt: 0, sentPos: null, lock: null, err: "" };
  const myOut = () => S.orders.filter(o => o.driver_id === S.user.id && o.status === "out").length;
  function syncTracking() {
    if (!S.user || S.user.role !== "driver") return;
    if (myOut() > 0) startTracking(); else stopTracking();
    renderTrackBar();
  }
  function startTracking() {
    if (TR.watch !== null) return;
    if (!navigator.geolocation) { TR.err = "الموبايل ده مش بيدعم تحديد الموقع"; return; }
    TR.watch = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
    TR.hb = setInterval(() => { if (TR.last && Date.now() - TR.sentAt > 45000) sendPos(TR.last); }, 15000);
    keepAwake();
  }
  function stopTracking() {
    if (TR.watch !== null) { try { navigator.geolocation.clearWatch(TR.watch); } catch (e) {} }
    TR.watch = null; clearInterval(TR.hb); TR.hb = null;
    try { TR.lock && TR.lock.release(); } catch (e) {} TR.lock = null;
  }
  function onPos(p) {
    TR.err = ""; TR.last = p.coords;
    const moved = TR.sentPos ? distKm(TR.sentPos.lat, TR.sentPos.lng, p.coords.latitude, p.coords.longitude) * 1000 : Infinity;
    if (Date.now() - TR.sentAt > 15000 || moved > 40) sendPos(p.coords);
    renderTrackBar();
  }
  function onPosErr(e) {
    TR.err = e.code === 1 ? "الموبايل رافض مشاركة الموقع. من إعدادات المتصفح اسمح للبرنامج بالموقع، وبعدين افتحه تاني."
      : "مش لاقي إشارة GPS. اتأكد إن الموقع (Location) شغال في الموبايل.";
    renderTrackBar();
  }
  async function sendPos(c) {
    TR.sentAt = Date.now(); TR.sentPos = { lat: c.latitude, lng: c.longitude };
    let battery = null;
    try { if (navigator.getBattery) battery = Math.round((await navigator.getBattery()).level * 100); } catch (e) {}
    try {
      await api("/api/driver/location", { method: "POST", body: { lat: c.latitude, lng: c.longitude, acc: c.accuracy, speed: c.speed, battery } });
      TR.okAt = Date.now(); TR.err = "";
    } catch (e) { TR.err = "موقعك مش بيوصل للصيدلية. اتأكد من النت."; }
    renderTrackBar();
  }
  async function keepAwake() {
    try {
      if ("wakeLock" in navigator && !TR.lock && document.visibilityState === "visible") {
        TR.lock = await navigator.wakeLock.request("screen");
        TR.lock.addEventListener("release", () => { TR.lock = null; renderTrackBar(); });
      }
    } catch (e) {}
    renderTrackBar();
  }
  function renderTrackBar() {
    const bar = $("trackBar"); if (!bar || !S.user || S.user.role !== "driver") return;
    bar.hidden = false;
    if (TR.watch === null) { bar.className = "trackbar idle"; bar.innerHTML = `مشاركة موقعك هتشتغل لوحدها أول ما تدوس "استلمته وخرجت".`; return; }
    if (TR.err) { bar.className = "trackbar bad"; bar.innerHTML = `<b>موقعك مش ظاهر للصيدلية</b><span>${esc(TR.err)}</span>`; return; }
    bar.className = "trackbar on";
    bar.innerHTML = `<b><i class="dot"></i>موقعك ظاهر للصيدلية</b><span>${TR.okAt ? "آخر إرسال من " + ago(new Date(TR.okAt).toISOString()) : "بيحدد موقعك…"}${TR.last && TR.last.accuracy ? ` · دقة ${Math.round(TR.last.accuracy)} م` : ""}</span>
      <span class="hint">خلي البرنامج مفتوح طول التوصيل${TR.lock ? "، والشاشة هتفضل منورة لوحدها" : ""}. لو قفلته أو قفلت الشاشة، الموقع بيقف لحد ما تفتحه تاني.</span>`;
  }

  /* ---------- logic ---------- */
  const isFinal = o => o.status === "done" || o.status === "cancel";
  function elapsed(o) {
    const end = o.status === "done" ? ts(o.delivered_at) : o.status === "cancel" ? ts(o.cancelled_at) : now();
    return mins(end - ts(o.created_at));
  }
  function lateness(o) {
    const e = elapsed(o), p = o.promise_min || 60;
    if (e > p) return "late";
    if (!isFinal(o) && e > p * 0.75) return "warn";
    if (o.status === "new" && e > 15) return "warn";
    return "";
  }
  const load = id => S.orders.filter(o => o.driver_id === id && o.status === "out").length;
  function suggestDriver() {
    if (!S.drivers.length) return null;
    return S.drivers.slice().sort((a, b) => load(a.id) - load(b.id))[0];
  }
  function matchFilter(o, k) {
    if (k === "all") return true;
    if (k === "active") return !isFinal(o);
    if (k === "late") return !isFinal(o) && lateness(o) === "late";
    return o.status === k;
  }
  function sortOrders(list) {
    const rank = { late: 0, warn: 1, "": 2 };
    return list.slice().sort((a, b) => {
      if (isFinal(a) !== isFinal(b)) return isFinal(a) ? 1 : -1;
      if (!isFinal(a)) return (rank[lateness(a)] - rank[lateness(b)]) || (ts(a.created_at) - ts(b.created_at));
      return (ts(b.delivered_at || b.cancelled_at) || 0) - (ts(a.delivered_at || a.cancelled_at) || 0);
    });
  }

  /* ---------- render ---------- */
  function render() {
    if (!S.user) return;
    renderSummary();
    if (S.tab === "orders") renderOrders();
    if (S.tab === "driver") renderDriver();
  }

  function renderSummary() {
    const os = S.user.role === "driver" ? S.orders.filter(o => o.driver_id === S.user.id) : S.orders;
    const active = os.filter(o => !isFinal(o));
    const late = active.filter(o => lateness(o) === "late");
    const done = os.filter(o => o.status === "done");
    const avg = done.length ? Math.round(done.reduce((a, o) => a + mins(ts(o.delivered_at) - ts(o.created_at)), 0) / done.length) : null;
    const canc = os.filter(o => o.status === "cancel").length;
    $("summary").innerHTML = S.user.role === "driver"
      ? `<div class="tile"><b>${active.length}</b><span>معاك دلوقتي</span></div><div class="tile ${late.length ? "late" : ""}"><b>${late.length}</b><span>متأخر</span></div><div class="tile"><b>${done.length}</b><span>وصّلت النهارده</span></div><div class="tile"><b>${fmtMin(avg)}</b><span>متوسط التوصيل</span></div>`
      : `<div class="tile"><b>${active.length}</b><span>شغال دلوقتي</span></div><div class="tile ${late.length ? "late" : ""}"><b>${late.length}</b><span>متأخر عن الوعد</span></div><div class="tile"><b>${fmtMin(avg)}</b><span>متوسط التوصيل</span></div><div class="tile ${canc ? "late" : ""}"><b>${canc}<small class="hint"> / ${os.length}</small></b><span>اتلغى من الإجمالي</span></div>`;
    if (S.user.role !== "driver") {
      const sd = suggestDriver();
      $("suggest").textContent = sd ? `الأقرب للخروج: ${sd.name} (معاه ${load(sd.id)})` : (S.user.role === "admin" ? "ضيف الطيارين من تبويب الفريق" : "مفيش طيارين متسجلين");
    }
  }

  function orderCard(o, driverMode) {
    const lt = lateness(o), e = elapsed(o), p = o.promise_min || 60, st = STATUS[o.status];
    const left = p - e;
    const clockTxt = isFinal(o) ? `${fmtMin(e)}<small>${o.status === "done" ? "وصل في" : "اتلغى بعد"}</small>`
      : left >= 0 ? `${fmtMin(left)}<small>فاضل على الوعد</small>` : `+${fmtMin(-left)}<small>متأخر</small>`;
    let actions = "";
    if (!isFinal(o)) {
      if (!driverMode && (o.status === "new" || o.status === "ready")) {
        const opts = S.drivers.map(d => `<option value="${d.id}" ${o.driver_id === d.id ? "selected" : ""}>${esc(d.name)} (${load(d.id)})</option>`).join("");
        actions += `<select data-act="assign" data-id="${o.id}" style="flex:1;min-width:140px" aria-label="الطيار"><option value="">${o.driver_id ? "شيل الطيار" : "اختار الطيار…"}</option>${opts}</select>`;
      }
      if (st.action && !(driverMode && o.status === "new")) {
        const label = driverMode && o.status === "ready" ? "استلمته وخرجت" : st.actionLabel;
        actions += `<button class="btn primary small" data-act="advance" data-id="${o.id}" data-to="${st.action}">${label}</button>`;
      }
      if (!driverMode) actions += `<button class="btn danger small" data-act="cancel" data-id="${o.id}">إلغاء</button>`;
    }
    const digits = String(o.phone || "").replace(/\D/g, "");
    const intl = digits.startsWith("0") ? "2" + digits : digits;
    const contact = digits ? `<a class="btn small" href="https://wa.me/${intl}" target="_blank" rel="noopener">واتساب</a><a class="btn small" href="tel:${digits}">اتصال</a>` : "";
    const hasLoc = o.lat != null || !!o.location_url;
    const href = mapHref(o);
    const maps = (driverMode || hasLoc) && href ? `<a class="btn small ${driverMode && hasLoc ? "primary" : ""}" href="${esc(href)}" target="_blank" rel="noopener">${hasLoc ? "افتح اللوكيشن" : "دوّر على العنوان"}</a>` : "";
    if (!driverMode && !isFinal(o)) {
      actions += hasLoc
        ? `<button class="btn small" data-act="addloc" data-id="${o.id}">تغيير اللوكيشن</button>`
        : `<button class="btn small loc" data-act="reqloc" data-id="${o.id}">اطلب اللوكيشن</button><button class="btn small" data-act="addloc" data-id="${o.id}">الصق لوكيشن</button>`;
    }
    const locSrc = { customer: "العميل بعته", staff: "اتسجل", saved: "محفوظ من قبل" }[o.loc_source] || "";
    const locPill = hasLoc ? `<span class="pill okp">لوكيشن ✓ ${locSrc}</span>` : (!isFinal(o) ? `<span class="pill warnp">مفيش لوكيشن</span>` : "");
    const copy = !driverMode ? `<button class="btn small ${o.status === "out" ? "loc" : ""}" data-act="copy" data-id="${o.id}">${o.status === "out" ? "ابعت لينك التتبع للعميل" : "نسخ"}</button>` : "";
    return `<article class="card st-${o.status} ${lt === "late" && !isFinal(o) ? "is-late" : lt === "warn" && !isFinal(o) ? "is-warn" : ""}">
      <div class="top">
        <div style="min-width:0">
          <div class="who">#${o.no} · ${esc(o.customer)} <span class="pill ${o.status === "cancel" ? "late" : ""}">${st.label}</span></div>
          <div class="addr">${esc(o.address)}</div>
        </div>
        <div class="clock ${lt}">${clockTxt}</div>
      </div>
      ${o.items ? `<div class="items">${esc(o.items)}</div>` : ""}
      <div class="meta num">
        ${o.area ? `<span class="pill area">${esc(o.area)}</span>` : ""}
        <span>${esc(o.source)}</span>·<span>${Number(o.amount) ? money(o.amount) : "—"}${Number(o.delivery_fee) ? ` + توصيل ${money(o.delivery_fee)}` : ""}</span>·<span class="pill pay">${esc(o.collected_method || o.payment)}${o.status === "done" && o.collected_amount != null ? " " + money(o.collected_amount) : ""}</span>·<span>اتسجل ${clock(o.created_at)}</span>
        ${o.driver_name ? `·<span>الطيار: ${esc(o.driver_name)}</span>` : ""}
        ${o.cancel_reason ? `·<span style="color:var(--late)">السبب: ${esc(o.cancel_reason)}</span>` : ""}
        ${locPill}
        ${(() => { if (driverMode || o.status !== "out" || o.lat == null) return "";
          const d = S.live.find(x => x.id === o.driver_id); if (!d || d.lat == null) return "";
          return `<span class="pill drvp">الطيار على بعد ${fmtKm(distKm(d.lat, d.lng, o.lat, o.lng) * 1.3)} · من ${ago(d.at)}</span>`; })()}
      </div>
      <div class="row">${actions}${contact}${maps}${copy}</div>
    </article>`;
  }

  function renderOrders() {
    const os = S.orders;
    $("filters").innerHTML = FILTERS.map(([k, l]) => `<button class="chip" data-filter="${k}" aria-pressed="${S.filter === k}">${l} <span class="num">${os.filter(o => matchFilter(o, k)).length}</span></button>`).join("");
    const list = sortOrders(os.filter(o => matchFilter(o, S.filter)));
    $("orderList").innerHTML = list.length ? list.map(o => orderCard(o, false)).join("")
      : `<div class="empty">${os.length ? "مفيش أوردرات في الفلتر ده" : "لسه مفيش أوردرات النهارده. دوس \"+ أوردر جديد\" أول ما ييجي طلب."}</div>`;
  }

  function renderDriver() {
    const me = S.user.id;
    const out = sortOrders(S.orders.filter(o => o.driver_id === me && o.status === "out"));
    const ready = sortOrders(S.orders.filter(o => o.status === "ready" && (o.driver_id === me || !o.driver_id)));
    api("/api/custody").then(rows => {
      const c = rows[0];
      $("driverStats").innerHTML = c && c.cash ? `<div class="custody">معاك نقدي <b class="num">${money(c.cash)}</b> من ${c.n} أوردر، لسه متسلمش للصيدلية</div>` : "";
    }).catch(() => {});
    $("driverList").innerHTML =
      `<h2>معاك في الطريق</h2>` + (out.length ? out.map(o => orderCard(o, true)).join("") : `<div class="empty">مفيش أوردرات معاك دلوقتي</div>`) +
      `<h2>جاهز للاستلام من الصيدلية</h2>` + (ready.length ? ready.map(o => orderCard(o, true)).join("") : `<div class="empty">مفيش أوردرات جاهزة</div>`);
  }

  /* ---------- report ---------- */
  async function loadReport() {
    $("reportBody").innerHTML = `<div class="empty">بيحمّل التقرير…</div>`;
    try {
      const r = await api(`/api/report?from=${$("r-from").value}&to=${$("r-to").value}`);
      renderReport(r);
      const cu = await api("/api/custody");
      $("custodyPanel").innerHTML = `<h2>عهدة الطيارين (نقدي لسه متسلمش)</h2>` + (cu.length ? cu.map(c => `<div class="user">
        <div><b>${esc(c.name)}</b><div class="hint">${c.n} أوردر من ${new Date(c.since).toLocaleDateString("ar-EG", { day: "numeric", month: "short" })}</div></div>
        <div class="row"><b class="num">${money(c.cash)}</b><button class="btn small" data-act="settle" data-driver="${c.driver_id}">استلمت العهدة</button></div></div>`).join("")
        : `<p class="hint" style="margin:0">مفيش فلوس نقدي مع أي طيار.</p>`);
    } catch (e) { $("reportBody").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  $("r-from").addEventListener("change", loadReport);
  $("r-to").addEventListener("change", loadReport);

  function renderReport(r) {
    const s = r.summary;
    const stages = [["التجهيز في الصيدلية", s.avg_prep, "var(--muted)"], ["مستني طيار", s.avg_wait, "var(--warn)"], ["في الطريق", s.avg_road, "var(--out)"]];
    const total = stages.reduce((a, x) => a + (x[2] && x[1] || 0), 0);
    const worst = total ? stages.slice().sort((a, b) => (b[1] || 0) - (a[1] || 0))[0] : null;
    const advice = !worst ? "" : worst[0] === "مستني طيار"
      ? "محتاج طيار زيادة في ساعات الذروة، أو تجمّع أوردرات المنطقة الواحدة في خروجة واحدة."
      : worst[0] === "التجهيز في الصيدلية"
        ? "خلي حد مسؤول يجهز أول ما الأوردر يتسجل، وجهّز الأصناف الأكتر طلبًا مسبقًا."
        : "راجع توزيع المناطق، وابعت الأوردرات القريبة من بعض مع نفس الطيار.";
    const pctOn = s.done ? Math.round(s.on_time * 100 / s.done) : null;
    const pctC = s.total ? Math.round(s.cancelled * 100 / s.total) : 0;
    const maxH = Math.max(1, ...r.hours.map(h => h.n));
    const hoursMap = Object.fromEntries(r.hours.map(h => [h.h, h]));
    const hs = r.hours.map(h => h.h); const hrs = []; for (let h = Math.min(8, ...hs); h <= Math.max(23, ...hs); h++) hrs.push(h);
    $("reportBody").innerHTML = `
      <div class="summary">
        <div class="tile"><b>${s.total}</b><span>إجمالي الأوردرات</span></div>
        <div class="tile"><b>${s.done}</b><span>اتسلم</span></div>
        <div class="tile"><b>${pctOn == null ? "—" : pctOn + "%"}</b><span>في الميعاد</span></div>
        <div class="tile ${s.cancelled ? "late" : ""}"><b>${pctC}%</b><span>نسبة الإلغاء</span></div>
      </div>
      <div class="panel">
        <h2>الأوردر بيتأخر فين؟</h2>
        <p class="hint" style="margin:0">متوسط الدقايق في كل مرحلة. متوسط الأوردر كله: ${fmtMin(s.avg_total)}</p>
        ${total ? `<div class="bar" role="img" aria-label="توزيع وقت التوصيل">${stages.map(x => x[1] ? `<i style="width:${(x[1] / total * 100).toFixed(1)}%;background:${x[2]}"></i>` : "").join("")}</div>` : ""}
        <div class="stage">${stages.map(x => `<i class="swatch" style="background:${x[2]}"></i><span>${x[0]}</span><b class="num">${fmtMin(x[1])}</b>`).join("")}</div>
        ${worst && worst[1] ? `<p style="margin:0"><b>أكبر مرحلة: ${worst[0]}.</b> ${advice}</p>` : `<p class="hint" style="margin:0">التحليل هيظهر أول ما الأوردرات تعدي بالمراحل.</p>`}
      </div>
      <div class="panel">
        <h2>الأوردرات حسب الساعة</h2>
        <div class="hours" role="img" aria-label="عدد الأوردرات في كل ساعة">${hrs.map(h => { const x = hoursMap[h] || { n: 0, cancelled: 0 }; const hn = x.n / maxH * 70, hc = x.cancelled / maxH * 70;
          return `<div title="${h}:00 — ${x.n} أوردر، ${x.cancelled} اتلغى"><span class="num">${x.n || ""}</span>${hc ? `<i class="c" style="height:${hc}px"></i>` : ""}<i style="height:${Math.max(hn - hc, x.n ? 2 : 0)}px"></i><span class="num">${h % 12 || 12}</span></div>`; }).join("")}</div>
        <p class="hint" style="margin:0">الأحمر = اتلغى. الساعات اللي فيها أحمر كتير محتاجة طيار زيادة.</p>
      </div>
      <div class="panel">
        <h2>التحصيلات</h2>
        ${r.collections.length ? `<table><tbody>${r.collections.map(c => `<tr><td>${esc(c.method)}</td><td class="n">${c.n} أوردر</td><td class="n"><b>${money(c.total)}</b></td></tr>`).join("")}
          <tr><td><b>الإجمالي</b></td><td></td><td class="n"><b>${money(r.collections.reduce((a, c) => a + c.total, 0))}</b></td></tr></tbody></table>` : `<p class="hint" style="margin:0">مفيش تحصيلات في الفترة دي.</p>`}
        ${(() => { const names = [...new Set(r.collections_by_driver.map(x => x.name))]; const ms = METHODS.filter(m => r.collections_by_driver.some(x => x.method === m));
          return names.length ? `<div class="tablewrap"><table><thead><tr><th>الطيار</th>${ms.map(m => `<th>${m}</th>`).join("")}</tr></thead><tbody>${names.map(n => `<tr><td>${esc(n)}</td>${ms.map(m => { const x = r.collections_by_driver.find(y => y.name === n && y.method === m); return `<td class="n">${x ? money(x.total) : "—"}</td>`; }).join("")}</tr>`).join("")}</tbody></table></div>` : ""; })()}
      </div>
      <div class="panel" id="custodyPanel"><h2>عهدة الطيارين (نقدي لسه متسلمش)</h2><p class="hint" style="margin:0">بيحمّل…</p></div>
      <div class="panel">
        <h2>أسباب الإلغاء</h2>
        ${r.reasons.length ? `<table><tbody>${r.reasons.map(x => `<tr><td>${esc(x.reason)}</td><td class="n">${x.n}</td></tr>`).join("")}</tbody></table>` : `<p class="hint" style="margin:0">مفيش إلغاءات في الفترة دي.</p>`}
      </div>
      <div class="panel">
        <h2>الطيارين</h2>
        ${r.drivers.length ? `<div class="tablewrap"><table><thead><tr><th>الطيار</th><th>وصّل</th><th>متوسط الطريق</th><th>متأخر</th></tr></thead><tbody>${r.drivers.map(d => `<tr><td>${esc(d.name)}</td><td class="n">${d.n}</td><td class="n">${fmtMin(d.avg_road)}</td><td class="n">${d.late}</td></tr>`).join("")}</tbody></table></div>` : `<p class="hint" style="margin:0">لسه مفيش توصيلات مكتملة.</p>`}
      </div>`;
  }

  /* ---------- clients ---------- */
  let clientSearchT, openClient = null;
  async function loadClients() {
    try {
      const r = await api("/api/clients?q=" + encodeURIComponent($("c-search").value.trim()));
      $("c-total").textContent = `${r.total.toLocaleString("ar-EG")} عميل متسجل` + ($("c-search").value.trim() ? ` · ${r.clients.length} نتيجة` : " · آخر اللي اتعاملوا");
      $("clientList").innerHTML = r.clients.length ? r.clients.map(c => `<button class="card client-row" data-act="openClient" data-id="${c.id}">
          <div class="top"><b>${esc(c.name || "بدون اسم")}</b>${c.code ? `<span class="hint num">كود ${esc(c.code)}</span>` : ""}</div>
          <div class="hint num">${(c.phones || []).map(esc).join(" / ") || "مفيش رقم"}</div>
          <div class="meta">${c.area ? `<span class="pill area">${esc(c.area)}</span>` : ""}${c.status ? `<span class="pill ${statusClass(c.status)}">${esc(c.status)}</span>` : ""}
            <span>${c.n_addresses} عنوان</span>${c.n_addresses ? `·<span>${c.n_located} بلوكيشن</span>` : ""}${c.last_purchase ? `·<span>آخر شراء ${fmtDate(c.last_purchase)}</span>` : ""}</div></button>`).join("")
        : `<div class="empty">${$("c-search").value.trim() ? "مفيش عميل بالبحث ده" : "لسه مفيش عملاء. هيتسجلوا لوحدهم مع الأوردرات، أو استورد الليستة من تحت."}</div>`;
    } catch (e) { toast(e.message); }
  }
  $("c-search").addEventListener("input", () => { clearTimeout(clientSearchT); clientSearchT = setTimeout(loadClients, 300); });
  $("c-new").addEventListener("click", () => sheet(`<h2>عميل جديد</h2>
    <label>الاسم<input id="nc-name"></label><label>الموبايل (لو أكتر من رقم افصل بينهم بـ /)<input id="nc-phone" inputmode="tel"></label>
    <div class="row"><button class="btn primary" data-act="createClient">حفظ</button><button class="btn" data-act="closeSheet">رجوع</button></div>`));

  function clientSheet(c) {
    openClient = c;
    const isAdmin = S.user.role === "admin";
    sheet(`<div class="row spread"><h2>${esc(c.name || "عميل")}</h2><button class="btn small" data-act="closeSheet">قفل</button></div>
      <div class="sheet-scroll list">
        ${clientFacts(c)}
        <div class="grid2"><label>الاسم<input id="ec-name" value="${esc(c.name)}"></label><label>ملاحظات<input id="ec-notes" value="${esc(c.notes)}" placeholder="مثلاً: بيدفع فيزا دايمًا"></label>
          <label>المنطقة<input id="ec-area" value="${esc(c.area || "")}"></label><label>رسوم التوصيل (جنيه)<input id="ec-fee" type="number" inputmode="decimal" min="0" value="${c.delivery_fee ?? ""}"></label></div>
        <button class="btn small" data-act="saveClient">حفظ البيانات</button>
        <h3>الأرقام</h3>
        ${c.phones.map(p => `<div class="user"><span class="num">${esc(p)}</span><button class="btn small danger" data-act="delPhone" data-p="${esc(p)}">شيل</button></div>`).join("") || `<p class="hint" style="margin:0">مفيش أرقام</p>`}
        <div class="row"><input id="ec-phone" inputmode="tel" placeholder="رقم تاني" style="flex:1;min-width:0"><button class="btn small" data-act="addPhone">إضافة</button></div>
        <h3>العناوين واللوكيشن</h3>
        ${c.addresses.map(a => `<div class="addr-card">
          <div class="grid2"><label>اسم العنوان<input data-f="label" data-aid="${a.id}" value="${esc(a.label)}" placeholder="البيت / الشغل / بيت الوالدة"></label>
          <label>العنوان<input data-f="address" data-aid="${a.id}" value="${esc(a.address)}"></label></div>
          <label>اللوكيشن ${a.lat != null || a.location_url ? `<span class="pill okp">محفوظ</span>` : `<span class="pill warnp">مفيش</span>`}<input data-f="location" data-aid="${a.id}" value="${esc(a.location_url || (a.lat != null ? a.lat + "," + a.lng : ""))}" placeholder="الصق لينك جوجل ماب أو اللوكيشن"></label>
          <div class="row"><button class="btn small primary" data-act="saveAddr" data-aid="${a.id}">حفظ</button>
          ${a.lat != null || a.location_url ? `<a class="btn small" href="${esc(a.lat != null ? `https://www.google.com/maps/search/?api=1&query=${a.lat},${a.lng}` : a.location_url)}" target="_blank" rel="noopener">افتح على الخريطة</a>` : ""}
          <button class="btn small" data-act="orderAt" data-aid="${a.id}">أوردر على العنوان ده</button>
          <button class="btn small danger" data-act="delAddr" data-aid="${a.id}">حذف</button></div></div>`).join("") || `<p class="hint" style="margin:0">مفيش عناوين</p>`}
        <div class="addr-card"><b>عنوان جديد</b>
          <div class="grid2"><label>اسم العنوان<input id="na-label" placeholder="البيت / الشغل"></label><label>العنوان<input id="na-address"></label></div>
          <label>اللوكيشن<input id="na-location" placeholder="الصق لينك جوجل ماب أو اللوكيشن"></label>
          <button class="btn small" data-act="addAddr">إضافة العنوان</button></div>
        <div class="row"><button class="btn primary" data-act="orderAt" data-aid="">+ أوردر للعميل ده</button>
        ${isAdmin ? `<button class="btn danger small" data-act="delClient">حذف العميل</button>` : ""}</div>
      </div>`);
  }
  async function clientCall(path, method, body, msg) {
    try { const c = await api(path, { method, body }); if (msg) toast(msg); if (c && c.id) clientSheet(c); loadClients(); return c; }
    catch (err) { toast(err.message); }
  }

  /* ---------- import ---------- */
  const ROLE_LABELS = { skip: "تجاهل", code: "كود العميل", name: "الاسم", phone: "تليفون", address: "عنوان", area: "المنطقة", location: "لوكيشن",
    label: "اسم العنوان", fee: "رسوم التوصيل", branch: "الفرع", invoices: "عدد الفواتير", first_purchase: "أول شراء", last_purchase: "آخر شراء",
    spend: "مشتريات السنة", status: "حالة العميل", notes: "ملاحظات" };
  function guessRole(h) {
    const t = String(h || "").toLowerCase().trim();
    if (!t) return "skip";
    if (/(كما في البرنامج|مدموج|الشبكة|network|carrier)/.test(t)) return "skip";
    if (/(كود التوصيل|رسوم التوصيل|مصاريف التوصيل|سعر التوصيل|delivery)/.test(t)) return "fee";
    if (/(كود|code|^id$|رقم العميل)/.test(t)) return "code";
    if (/(فواتير|فاتورة|invoices)/.test(t)) return "invoices";
    if (/(أول شراء|اول شراء|first)/.test(t)) return "first_purchase";
    if (/(آخر شراء|اخر شراء|last)/.test(t)) return "last_purchase";
    if (/(مشتريات|spend|sales)/.test(t)) return "spend";
    if (/(الحالة|حالة|status)/.test(t)) return "status";
    if (/(الفرع|فرع|branch)/.test(t)) return "branch";
    if (/(منطقة|المنطقة|area|zone|district)/.test(t)) return "area";
    if (/(تليفون|تلفون|موبايل|محمول|هاتف|رقم|أرقام|ارقام|phone|mobile|tel|whats|واتس)/.test(t)) return "phone";
    if (/(لوكيشن|لوكشن|موقع|خريطة|location|map|gps|link|لينك)/.test(t)) return "location";
    if (/(عنوان|عناوين|العنوان|address|addr|شارع)/.test(t)) return "address";
    if (/(اسم|الاسم|name|عميل|العميل|customer|client)/.test(t)) return "name";
    if (/(ملاحظ|note)/.test(t)) return "notes";
    return "skip";
  }
  let importData = null, importBook = null;
  function loadXLSX() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((ok, bad) => { const sc = document.createElement("script"); sc.src = "/vendor/xlsx/xlsx.full.min.js"; sc.onload = ok; sc.onerror = () => bad(new Error("مش قادر أحمّل قارئ Excel، اتأكد من النت")); document.head.appendChild(sc); });
  }
  const cellText = v => (v instanceof Date ? v.toISOString() : v == null ? "" : String(v).trim());
  function readSheet(name) {
    let rows = XLSX.utils.sheet_to_json(importBook.Sheets[name], { header: 1, defval: "", raw: true }).filter(r => r.some(v => cellText(v)));
    if (!rows.length) throw new Error("الشيت ده فاضي");
    // the header is the first row (within the first 10) that names at least 3 known columns
    let hi = rows.slice(0, 10).findIndex(r => r.filter(v => guessRole(v) !== "skip").length >= 3);
    const width = Math.max(...rows.slice(0, 60).map(r => r.length));
    let headers, roles;
    if (hi >= 0) {
      headers = Array.from({ length: width }, (_, i) => cellText(rows[hi][i]) || "عمود " + (i + 1));
      roles = headers.map(guessRole); rows = rows.slice(hi + 1);
    } else {
      headers = Array.from({ length: width }, (_, i) => "عمود " + (i + 1));
      roles = headers.map((_, i) => { const col = rows.slice(0, 30).map(r => cellText(r[i])); return col.filter(v => v.replace(/\D/g, "").length >= 10 && !/http/.test(v)).length > col.length / 2 ? "phone" : col.some(v => /http|maps/.test(v)) ? "location" : i === 0 ? "name" : "address"; });
    }
    importData = { sheet: name, headers, rows, roles };
    renderImportMap();
  }
  $("importFile").addEventListener("change", async e => {
    const f = e.target.files[0]; if (!f) return;
    $("importMap").innerHTML = `<p class="hint">بيقرا الملف…</p>`;
    try {
      await loadXLSX();
      importBook = XLSX.read(await f.arrayBuffer(), { type: "array", cellDates: true });
      // pick the sheet with the most rows (the customer list, not the summary)
      const best = importBook.SheetNames.map(n => [n, XLSX.utils.sheet_to_json(importBook.Sheets[n], { header: 1 }).length]).sort((a, b) => b[1] - a[1])[0][0];
      readSheet(best);
    } catch (err) { $("importMap").innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  });
  function buildImportRows() {
    const { rows, roles } = importData;
    return rows.map(r => {
      const pick = role => roles.map((x, i) => (x === role ? r[i] : null)).filter(v => cellText(v));
      const txt = role => pick(role).map(cellText);
      const addrs = txt("address"), locs = txt("location"), labels = txt("label");
      const n = Math.max(addrs.length, locs.length);
      const one = role => { const v = pick(role)[0]; return v instanceof Date ? v.toISOString() : v ?? null; };
      return { code: txt("code")[0] || null, name: txt("name").join(" "), phones: txt("phone"), area: txt("area")[0] || "",
        addresses: Array.from({ length: n }, (_, i) => ({ address: addrs[i] || "", location: locs[i] || "", label: labels[i] || "" })),
        delivery_fee: one("fee"), branch: txt("branch")[0] || "", invoices: one("invoices"), first_purchase: one("first_purchase"),
        last_purchase: one("last_purchase"), spend_12m: one("spend"), status: txt("status")[0] || "", notes: txt("notes").join(" - ") };
    });
  }
  function renderImportMap() {
    const { headers, rows, roles, sheet: sh } = importData;
    const built = buildImportRows();
    const usable = built.filter(r => r.code || r.phones.some(p => p.replace(/\D/g, "").length >= 8)).length;
    const sheets = importBook ? importBook.SheetNames : [];
    $("importMap").innerHTML = `${sheets.length > 1 ? `<label>الشيت<select id="importSheet">${sheets.map(n => `<option ${n === sh ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>` : ""}
      <p style="margin:0"><b class="num">${rows.length.toLocaleString("ar-EG")}</b> صف. اتأكد إن كل عمود متحدد صح:</p>
      <div class="tablewrap"><table><thead><tr>${headers.map((h, i) => `<th><select data-col="${i}" class="colrole">${Object.entries(ROLE_LABELS).map(([k, l]) => `<option value="${k}" ${roles[i] === k ? "selected" : ""}>${l}</option>`).join("")}</select><div class="hint">${esc(h)}</div></th>`).join("")}</tr></thead>
      <tbody>${rows.slice(0, 4).map(r => `<tr>${headers.map((_, i) => `<td>${esc(r[i] instanceof Date ? fmtDate(r[i]) : r[i])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      <p class="hint" style="margin:0">${usable.toLocaleString("ar-EG")} عميل هيتستورد. اللي من غير كود ولا رقم هيتجاهل. لو العميل موجود قبل كده (نفس الكود أو نفس الرقم) بياناته بتتحدث ومش بيتكرر، فتقدر تعيد الاستيراد بأمان كل ما تطلع ليستة جديدة.</p>
      <button class="btn primary" data-act="runImport" ${usable ? "" : "disabled"}>استيراد ${usable.toLocaleString("ar-EG")} عميل</button>`;
  }
  $("importMap").addEventListener("change", e => {
    if (e.target.classList.contains("colrole")) { importData.roles[Number(e.target.dataset.col)] = e.target.value; renderImportMap(); }
    if (e.target.id === "importSheet") { try { readSheet(e.target.value); } catch (err) { toast(err.message); } }
  });
  async function runImport(btn) {
    const all = buildImportRows().filter(r => r.code || r.phones.length);
    btn.disabled = true;
    const tot = { created: 0, merged: 0, phones: 0, addresses: 0, skipped: 0 };
    const B = 1000;
    try {
      for (let i = 0; i < all.length; i += B) {
        btn.textContent = `بيستورد… ${Math.min(i + B, all.length).toLocaleString("ar-EG")} من ${all.length.toLocaleString("ar-EG")}`;
        const r = await api("/api/clients/import", { method: "POST", body: { rows: all.slice(i, i + B) } });
        Object.keys(tot).forEach(k => (tot[k] += r[k] || 0));
      }
      const f = n => n.toLocaleString("ar-EG");
      $("importMap").innerHTML = `<div class="known"><b>الاستيراد خلص</b><span>${f(tot.created)} عميل جديد، و${f(tot.merged)} اتحدثت بياناتهم أو اتضموا لعميل موجود.</span><span>${f(tot.phones)} رقم و${f(tot.addresses)} عنوان اتضافوا${tot.skipped ? `، و${f(tot.skipped)} صف اتجاهل` : ""}.</span></div>`;
      $("importFile").value = ""; importData = null; importBook = null; loadClients();
    } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = "كمّل الاستيراد"; }
  }

  /* ---------- live map ---------- */
  let MAP = null, mapLayer = null, mapTimer = null, mapFitted = false, mapData = null;
  const driverMarkers = {};
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    return new Promise((ok, bad) => { const sc = document.createElement("script"); sc.src = "/vendor/leaflet/leaflet.js"; sc.onload = ok; sc.onerror = () => bad(new Error("مش قادر أحمّل الخريطة، اتأكد من النت")); document.head.appendChild(sc); });
  }
  async function openMap() {
    await loadLeaflet();
    if (!MAP) {
      MAP = L.map("map", { zoomControl: true, attributionControl: true }).setView([30.13, 31.33], 13);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(MAP);
      mapLayer = L.layerGroup().addTo(MAP);
    }
    setTimeout(() => MAP.invalidateSize(), 60);
    await refreshMap();
    clearInterval(mapTimer);
    mapTimer = setInterval(() => { if (S.tab === "map" && !document.hidden) refreshMap(); }, 10000);
  }
  const fresh = at => at && now() - ts(at) < 3 * 60000;
  async function refreshMap() {
    if (!MAP) return;
    let r;
    try { r = await api("/api/live"); } catch (e) { $("mapStatus").textContent = "مش قادر يجيب المواقع، بيحاول تاني"; return; }
    S.skew = Date.parse(r.now) - Date.now(); mapData = r;
    mapLayer.clearLayers();
    const pts = [];
    const colorOf = d => (fresh(d.at) ? "drv" : "drv stale");
    r.drivers.forEach(d => {
      const t = r.trails[d.id];
      if (t && t.length > 1) L.polyline(t, { color: "#3A6FB0", weight: 3, opacity: .35 }).addTo(mapLayer);
    });
    r.orders.forEach(o => {
      if (o.lat == null) return;
      pts.push([o.lat, o.lng]);
      const icon = L.divIcon({ className: "", html: `<div class="pin ${o.status === "out" ? "out" : "wait"}"><b>${o.no}</b></div>`, iconSize: [30, 30], iconAnchor: [15, 30] });
      L.marker([o.lat, o.lng], { icon }).bindPopup(`<b>#${o.no} · ${esc(o.customer)}</b><br>${esc(o.address)}${o.area ? "<br>" + esc(o.area) : ""}`).addTo(mapLayer);
      const d = o.status === "out" && r.drivers.find(x => x.id === o.driver_id);
      if (d && d.lat != null) L.polyline([[d.lat, d.lng], [o.lat, o.lng]], { color: "#3A6FB0", weight: 2, dashArray: "6 6", opacity: .8 }).addTo(mapLayer);
    });
    r.drivers.forEach(d => {
      if (d.lat == null) return;
      pts.push([d.lat, d.lng]);
      const icon = L.divIcon({ className: "", html: `<div class="drvpin ${colorOf(d)}"><span>${esc((d.name || "?").trim().charAt(0))}</span><em>${esc(d.name)}</em></div>`, iconSize: [36, 36], iconAnchor: [18, 18] });
      driverMarkers[d.id] = L.marker([d.lat, d.lng], { icon, zIndexOffset: 1000 }).bindPopup(`<b>${esc(d.name)}</b><br>آخر تحديث من ${ago(d.at)}${d.battery != null ? `<br>البطارية ${Math.round(d.battery)}%` : ""}`).addTo(mapLayer);
    });
    if (r.pharmacy) {
      pts.push([r.pharmacy.lat, r.pharmacy.lng]);
      L.marker([r.pharmacy.lat, r.pharmacy.lng], { zIndexOffset: 500, icon: L.divIcon({ className: "", html: `<div class="shoppin">+</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }) })
        .bindPopup(`<b>${esc(r.pharmacy.name)}</b>`).addTo(mapLayer);
    }
    if (!mapFitted && pts.length) { MAP.fitBounds(pts, { padding: [40, 40], maxZoom: 15 }); mapFitted = true; }
    $("mapStatus").textContent = `بيتحدث كل 10 ثواني · آخر تحديث ${clock(new Date())}`;
    renderDriverCards(r);
  }
  function renderDriverCards(r) {
    $("driverCards").innerHTML = r.drivers.map(d => {
      const mine = r.orders.filter(o => o.driver_id === d.id && o.status === "out");
      const waiting = r.orders.filter(o => o.driver_id === d.id && o.status !== "out").length;
      const state = d.at == null ? `<span class="pill">لسه مبعتش موقعه</span>` : fresh(d.at) ? `<span class="pill okp"><i class="dot"></i>متصل · من ${ago(d.at)}</span>` : `<span class="pill warnp">آخر ظهور من ${ago(d.at)}</span>`;
      const orders = mine.map(o => `<li>#${o.no} · ${esc(o.customer)}${o.lat != null && d.lat != null ? ` · <b class="num">${fmtKm(distKm(d.lat, d.lng, o.lat, o.lng) * 1.3)}</b>` : o.lat == null ? ` · <span class="hint">مفيش لوكيشن</span>` : ""}
        <span class="hint">خرج من ${ago(o.out_at)}</span></li>`).join("");
      return `<div class="card drvcard">
        <div class="top"><b>${esc(d.name)}</b>${state}</div>
        ${mine.length ? `<ul class="drvorders">${orders}</ul>` : `<div class="hint">مفيش أوردرات معاه في الطريق${waiting ? ` · ${waiting} مستنيين يخرج بيهم` : ""}</div>`}
        <div class="row">${d.lat != null ? `<button class="btn small" data-act="focusDriver" data-id="${d.id}">اظهر على الخريطة</button>` : ""}
        ${d.phone ? `<a class="btn small" href="tel:${esc(d.phone)}">اتصال</a>` : ""}${d.battery != null ? `<span class="hint">البطارية ${Math.round(d.battery)}%</span>` : ""}</div></div>`;
    }).join("") || `<div class="empty">مفيش طيارين متسجلين. ضيفهم من تبويب الفريق.</div>`;
  }
  function focusDriver(id) {
    const m = driverMarkers[id]; if (!m || !MAP) return;
    MAP.flyTo(m.getLatLng(), 16, { duration: .6 }); m.openPopup();
    $("map").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* ---------- users ---------- */
  async function loadUsers() {
    try { S.users = await api("/api/users"); renderUsers(); } catch (e) { toast(e.message); }
  }
  function renderUsers() {
    const roleName = { admin: "مدير", staff: "صيدلية", driver: "طيار" };
    $("userList").innerHTML = `<div class="panel"><h2>المستخدمين</h2>${S.users.map(u => `<div class="user">
      <div style="min-width:0"><b>${esc(u.name)}</b> <span class="pill">${roleName[u.role]}</span> ${u.active ? "" : '<span class="pill late">موقوف</span>'}<div class="hint num">${esc(u.phone)}</div></div>
      <div class="row"><button class="btn small" data-act="pin" data-id="${u.id}">تغيير الرقم السري</button>
      ${u.id === S.user.id ? "" : `<button class="btn small ${u.active ? "danger" : ""}" data-act="toggleUser" data-id="${u.id}">${u.active ? "إيقاف" : "تفعيل"}</button>`}</div></div>`).join("")}</div>`;
  }
  $("userForm").addEventListener("submit", async e => {
    e.preventDefault();
    try {
      await api("/api/users", { method: "POST", body: { name: $("u-name").value, phone: $("u-phone").value, role: $("u-role").value, pin: $("u-pin").value } });
      e.target.reset(); toast("اتضاف"); loadUsers(); refresh();
    } catch (err) { toast(err.message); }
  });

  /* ---------- sheets & toast ---------- */
  let toastT;
  function toast(t) { $("toastHost").innerHTML = `<div class="toast" role="status">${esc(t)}</div>`; clearTimeout(toastT); toastT = setTimeout(() => ($("toastHost").innerHTML = ""), 2600); }
  const closeSheet = () => ($("sheetHost").innerHTML = "");
  function sheet(inner) { $("sheetHost").innerHTML = `<div class="sheet" data-act="closeSheet"><div class="panel" data-stop="1">${inner}</div></div>`; }
  function copyText(text) {
    const fallback = () => { sheet(`<h2>انسخ النص</h2><textarea id="copyArea" rows="6">${esc(text)}</textarea><button class="btn" data-act="closeSheet">تمام</button>`); const a = $("copyArea"); a.focus(); a.select(); };
    try { navigator.clipboard.writeText(text).then(() => toast("اتنسخ"), fallback); } catch (e) { fallback(); }
  }

  function collectSheet(o) {
    const def = METHODS.includes(o.payment) ? o.payment : "نقدي";
    sheet(`<h2>تسليم أوردر #${o.no}</h2>
      <p class="hint" style="margin:0">اتحصّل إزاي؟</p>
      <div class="methods">${METHODS.map(m => `<button class="chip" data-act="pickMethod" data-id="${o.id}" data-m="${m}" aria-pressed="${m === def}">${m}</button>`).join("")}</div>
      <label>المبلغ اللي اتحصّل (جنيه)<input id="collAmount" type="number" inputmode="decimal" min="0" value="${def === "مدفوع مسبقًا" ? 0 : ((Number(o.amount) + Number(o.delivery_fee || 0)) || "")}"></label>
      <div class="row"><button class="btn primary big" style="flex:1" data-act="confirmDone" data-id="${o.id}">اتسلم واتحصّل</button><button class="btn" data-act="closeSheet">رجوع</button></div>`);
  }

  async function act(id, body) {
    try { await api("/api/orders/" + id, { method: "PATCH", body }); await refresh(); return true; }
    catch (e) { toast(e.message); return false; }
  }

  /* ---------- events ---------- */
  document.addEventListener("click", async e => {
    const t = e.target.closest("[data-tab]"); if (t) { setTab(t.dataset.tab); return; }
    const f = e.target.closest("[data-filter]"); if (f) { S.filter = f.dataset.filter; renderOrders(); return; }
    const a = e.target.closest("[data-act]"); if (!a) return;
    if (a.dataset.act === "closeSheet" && e.target.closest("[data-stop]") && !e.target.closest("button")) return;
    const id = Number(a.dataset.id), o = S.orders.find(x => x.id === id);
    switch (a.dataset.act) {
      case "advance":
        if (a.dataset.to === "done" && o) { collectSheet(o); break; }
        a.disabled = true;
        if (await act(id, { action: a.dataset.to })) toast(STATUS[a.dataset.to].label);
        a.disabled = false; break;
      case "cancel":
        sheet(`<h2>إلغاء أوردر #${o ? o.no : ""}</h2><p class="hint" style="margin:0">السبب بيتسجل عشان التقرير يوضح الإلغاء بييجي منين.</p>
          <div class="list">${REASONS.map(r => `<button class="btn" data-act="doCancel" data-id="${id}" data-reason="${esc(r)}">${esc(r)}</button>`).join("")}</div>
          <button class="btn" data-act="closeSheet">رجوع</button>`); break;
      case "doCancel": closeSheet(); if (await act(id, { action: "cancel", reason: a.dataset.reason })) toast("اتلغى"); break;
      case "closeSheet": closeSheet(); break;
      case "pickMethod":
        document.querySelectorAll("[data-act=pickMethod]").forEach(b => b.setAttribute("aria-pressed", b === a));
        if (a.dataset.m === "مدفوع مسبقًا") $("collAmount").value = "0";
        else if ($("collAmount").value === "0" && o) $("collAmount").value = (Number(o.amount) + Number(o.delivery_fee || 0)) || "";
        break;
      case "confirmDone": {
        const m = document.querySelector("[data-act=pickMethod][aria-pressed=true]");
        a.disabled = true;
        if (await act(id, { action: "done", collected_method: m ? m.dataset.m : "نقدي", collected_amount: $("collAmount").value })) { closeSheet(); toast("اتسلم"); }
        else a.disabled = false;
        break;
      }
      case "settle": {
        if (a.dataset.confirm !== "1") { a.dataset.confirm = "1"; a.textContent = "اتأكدت إن المبلغ وصلك؟ دوس تاني"; break; }
        try { const r = await api(`/api/custody/${a.dataset.driver}/settle`, { method: "POST" }); toast(`اتسجل استلام ${money(r.cash)}`); loadReport(); } catch (err) { toast(err.message); }
        break;
      }
      case "copy": {
        if (!o) return;
        const total = Number(o.amount) + Number(o.delivery_fee || 0);
        if (o.status === "out") {
          a.disabled = true;
          let link = "";
          try { link = (await api(`/api/orders/${id}/track-link`, { method: "POST" })).url; } catch (err) {}
          a.disabled = false;
          const msg = `أهلاً ${o.customer}، أوردرك من الصيدلية خرج دلوقتي مع ${o.driver_name || "الطيار"}.` +
            (total ? ` المطلوب ${total} جنيه (${o.payment}).` : "") + (link ? `\nتقدر تتابع الطيار وهو جاي على الخريطة من هنا:\n${link}` : "");
          sheet(`<h2>رسالة خروج أوردر #${o.no}</h2>
            ${o.phone ? `<a class="btn primary big" href="${esc(waLink(o.phone, msg))}" target="_blank" rel="noopener" data-act="closeSheet">ابعتها على واتساب</a>` : ""}
            <textarea id="copyArea" rows="5" readonly>${esc(msg)}</textarea>
            <div class="row"><button class="btn" data-act="copyMsg">نسخ الرسالة</button><button class="btn" data-act="closeSheet">رجوع</button></div>`);
          break;
        }
        copyText(`أوردر #${o.no}\n${o.customer} - ${o.phone}\n${o.address}${o.area ? " (" + o.area + ")" : ""}\n${o.items || ""}\n${total ? total + " ج - " : ""}${o.payment || ""}`);
        break;
      }
      case "toggleUser": {
        const u = S.users.find(x => x.id === id); if (!u) return;
        if (u.active && a.dataset.confirm !== "1") { a.dataset.confirm = "1"; a.textContent = "متأكد؟"; return; }
        try { await api("/api/users/" + id, { method: "PATCH", body: { active: !u.active } }); loadUsers(); refresh(); } catch (err) { toast(err.message); }
        break;
      }
      case "pin": {
        const u = S.users.find(x => x.id === id); if (!u) return;
        sheet(`<h2>رقم سري جديد لـ ${esc(u.name)}</h2><input id="newPin" inputmode="numeric" maxlength="8" placeholder="4 لـ 8 أرقام"><div class="row"><button class="btn primary" data-act="savePin" data-id="${id}">حفظ</button><button class="btn" data-act="closeSheet">رجوع</button></div>`);
        $("newPin").focus(); break;
      }
      case "reqloc": {
        if (!o) return;
        a.disabled = true;
        try {
          const r = await api(`/api/orders/${id}/loc-link`, { method: "POST" });
          const msg = `أهلاً ${o.customer}، عشان أوردرك من الصيدلية يوصلك أسرع، دوس على اللينك ده وابعت موقعك بضغطة واحدة:\n${r.url}`;
          sheet(`<h2>اطلب لوكيشن أوردر #${o.no}</h2>
            <p class="hint" style="margin:0">العميل هيفتح اللينك ويدوس "ابعت موقعي"، واللوكيشن هيظهر هنا لوحده.</p>
            ${o.phone ? `<a class="btn primary big" href="${esc(waLink(o.phone, msg))}" target="_blank" rel="noopener" data-act="closeSheet">ابعته على واتساب</a>` : ""}
            <textarea id="copyArea" rows="4" readonly>${esc(msg)}</textarea>
            <div class="row"><button class="btn" data-act="copyMsg">نسخ الرسالة</button><button class="btn" data-act="closeSheet">رجوع</button></div>`);
        } catch (err) { toast(err.message); }
        a.disabled = false; break;
      }
      case "copyMsg": {
        const ta = $("copyArea"); const text = ta.value;
        try { navigator.clipboard.writeText(text).then(() => toast("اتنسخ"), () => { ta.focus(); ta.select(); }); } catch (err) { ta.focus(); ta.select(); }
        break;
      }
      case "addloc": {
        if (!o) return;
        sheet(`<h2>لوكيشن أوردر #${o.no}</h2>
          <p class="hint" style="margin:0">من الواتساب: دوس على اللوكيشن اللي العميل بعته، ثم شارك أو انسخ اللينك، والصقه هنا. ينفع كمان لينك جوجل ماب أو إحداثيات.</p>
          <textarea id="locInput" rows="3" placeholder="https://maps.app.goo.gl/..."></textarea>
          <div class="row"><button class="btn primary" data-act="saveLoc" data-id="${id}">حفظ اللوكيشن</button><button class="btn" data-act="closeSheet">رجوع</button></div>`);
        $("locInput").focus(); break;
      }
      case "saveLoc": {
        a.disabled = true;
        try {
          const r = await api(`/api/orders/${id}/location`, { method: "POST", body: { location: $("locInput").value } });
          closeSheet(); toast(r.found_coords ? "اللوكيشن اتحفظ" : "اللينك اتحفظ، والطيار هيفتحه على الخريطة"); await refresh();
        } catch (err) { toast(err.message); a.disabled = false; }
        break;
      }
      case "openClient": try { clientSheet(await api("/api/clients/" + id)); } catch (err) { toast(err.message); } break;
      case "createClient": {
        const c = await clientCall("/api/clients", "POST", { name: $("nc-name").value, phone: $("nc-phone").value }, "العميل اتضاف"); break;
      }
      case "saveClient": await clientCall(`/api/clients/${openClient.id}`, "PATCH", { name: $("ec-name").value, notes: $("ec-notes").value, area: $("ec-area").value, delivery_fee: $("ec-fee").value }, "اتحفظ"); break;
      case "addPhone": await clientCall(`/api/clients/${openClient.id}/phones`, "POST", { phone: $("ec-phone").value }, "الرقم اتضاف"); break;
      case "delPhone":
        if (a.dataset.confirm !== "1") { a.dataset.confirm = "1"; a.textContent = "متأكد؟"; break; }
        await clientCall(`/api/clients/${openClient.id}/phones/${encodeURIComponent(a.dataset.p)}`, "DELETE", null, "الرقم اتشال"); break;
      case "saveAddr": {
        const aid = a.dataset.aid, val = f => document.querySelector(`[data-aid="${aid}"][data-f="${f}"]`).value;
        await clientCall(`/api/addresses/${aid}`, "PATCH", { label: val("label"), address: val("address"), location: val("location") }, "العنوان اتحفظ"); break;
      }
      case "delAddr":
        if (a.dataset.confirm !== "1") { a.dataset.confirm = "1"; a.textContent = "متأكد؟"; break; }
        await clientCall(`/api/addresses/${a.dataset.aid}`, "DELETE", null, "العنوان اتحذف"); break;
      case "addAddr": await clientCall(`/api/clients/${openClient.id}/addresses`, "POST", { label: $("na-label").value, address: $("na-address").value, location: $("na-location").value }, "العنوان اتضاف"); break;
      case "orderAt": { const c = openClient; closeSheet(); openOrderFor(c, Number(a.dataset.aid) || null); break; }
      case "delClient":
        if (a.dataset.confirm !== "1") { a.dataset.confirm = "1"; a.textContent = "هيتمسح العميل بكل عناوينه. دوس تاني"; break; }
        try { await api(`/api/clients/${openClient.id}`, { method: "DELETE" }); closeSheet(); toast("العميل اتحذف"); loadClients(); } catch (err) { toast(err.message); }
        break;
      case "runImport": await runImport(a); break;
      case "pickClient": {
        try {
          const c = await api("/api/clients/" + id);
          $("f-results").hidden = true; $("f-search").value = "";
          if (!c.phones.includes(normPhone($("f-phone").value))) $("f-phone").value = c.phones[0] || "";
          $("f-customer").value = c.name || "";
          resetKnown(); useClient(c); $("f-items").focus();
        } catch (err) { toast(err.message); }
        break;
      }
      case "focusDriver": focusDriver(Number(a.dataset.id)); break;
      case "savePin":
        try { await api("/api/users/" + id, { method: "PATCH", body: { pin: $("newPin").value } }); closeSheet(); toast("الرقم السري اتغيّر"); } catch (err) { toast(err.message); }
        break;
    }
  });
  document.addEventListener("change", async e => {
    const t = e.target;
    if (t.dataset && t.dataset.act === "assign") {
      if (await act(Number(t.dataset.id), { action: "assign", driver_id: t.value ? Number(t.value) : null })) toast(t.value ? "اتوزع" : "اتشال الطيار");
    }
  });
  $("toggleForm").addEventListener("click", () => { const f = $("orderForm"); f.hidden = !f.hidden; if (!f.hidden) $("f-search").focus(); });
  $("cancelForm").addEventListener("click", () => { $("orderForm").hidden = true; $("orderForm").reset(); resetKnown(); });
  let knownCustomer = null, pickedAddress = null;
  function resetKnown() {
    knownCustomer = null; pickedAddress = null; $("known").hidden = true; $("known").innerHTML = ""; $("f-location-wrap").hidden = false;
    if ($("f-fee").dataset.auto === "1") { $("f-fee").value = ""; $("f-fee").dataset.auto = ""; }
    updateTotal();
  }
  function updateTotal() {
    const a = Number($("f-amount").value) || 0, f = Number($("f-fee").value) || 0;
    $("f-total").hidden = !(a || f);
    $("f-total").innerHTML = `الإجمالي على العميل: <b class="num">${money(a + f)}</b>`;
  }
  $("f-amount").addEventListener("input", updateTotal);
  $("f-fee").addEventListener("input", () => { $("f-fee").dataset.auto = ""; updateTotal(); });
  const fmtDate = v => (v ? new Date(v).toLocaleDateString("ar-EG", { day: "numeric", month: "short", year: "numeric" }) : "—");
  function statusClass(st) { return /نشط/.test(st) ? "okp" : /خامل|لم يشتر/.test(st) ? "warnp" : ""; }
  function clientFacts(c) {
    const bits = [];
    if (c.code) bits.push(`كود <b class="num">${esc(c.code)}</b>`);
    if (c.status) bits.push(`<span class="pill ${statusClass(c.status)}">${esc(c.status)}</span>`);
    if (c.last_purchase) bits.push(`آخر شراء ${fmtDate(c.last_purchase)}`);
    if (c.invoices) bits.push(`${c.invoices} فاتورة`);
    if (Number(c.spend_12m)) bits.push(`مشتريات السنة ${money(c.spend_12m)}`);
    if (c.delivery_fee != null) bits.push(`التوصيل ${money(c.delivery_fee)}`);
    return bits.length ? `<div class="facts">${bits.join("<span class='sep'>·</span>")}</div>` : "";
  }
  let searchT;
  $("f-search").addEventListener("input", () => {
    clearTimeout(searchT);
    const t = $("f-search").value.trim();
    if (t.length < 2) { $("f-results").hidden = true; return; }
    searchT = setTimeout(async () => {
      try {
        const r = await api("/api/clients?q=" + encodeURIComponent(t));
        if ($("f-search").value.trim() !== t) return;
        $("f-results").innerHTML = r.clients.length ? r.clients.slice(0, 8).map(c => `<button type="button" class="res" data-act="pickClient" data-id="${c.id}">
            <span class="res-top"><b>${esc(c.name || "بدون اسم")}</b>${c.code ? `<span class="hint num">كود ${esc(c.code)}</span>` : ""}</span>
            <span class="hint num">${(c.phones || []).map(esc).join(" / ")}</span>
            ${c.area ? `<span class="hint">${esc(c.area)}</span>` : ""}</button>`).join("")
          : `<div class="hint" style="padding:10px">مفيش عميل بالبحث ده. اكتب بياناته تحت وهيتسجل عميل جديد.</div>`;
        $("f-results").hidden = false;
      } catch (e) {}
    }, 250);
  });
  $("f-search").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); const b = $("f-results").querySelector(".res"); if (b) b.click(); }
    if (e.key === "Escape") $("f-results").hidden = true;
  });
  function renderKnown() {
    const c = knownCustomer; if (!c) return;
    const addrs = c.addresses.map(a => `<label class="addr-opt"><input type="radio" name="addrPick" value="${a.id}" ${pickedAddress === a.id ? "checked" : ""}>
        <span>${a.label ? `<b>${esc(a.label)}</b> · ` : ""}${esc(a.address || "لوكيشن بس")}${a.area ? ` <span class="pill area">${esc(a.area)}</span>` : ""} ${a.lat != null || a.location_url ? `<span class="pill okp">لوكيشن ✓</span>` : ""}</span></label>`).join("");
    $("known").innerHTML = `<div><b>${esc(c.name || "عميل")}</b> · ${c.orders_count} أوردر قبل كده${c.phones.length > 1 ? ` · <span class="num">${c.phones.map(esc).join(" / ")}</span>` : ""}</div>
      ${clientFacts(c)}
      ${c.shared && c.shared.length ? `<div class="shared">الرقم ده متسجل كمان لـ: ${c.shared.map(x => `<button type="button" class="btn small" data-act="pickClient" data-id="${x.id}">${esc(x.name || "بدون اسم")}${x.code ? " · كود " + esc(x.code) : ""}</button>`).join("")}</div>` : ""}
      ${c.notes ? `<div class="hint">${esc(c.notes)}</div>` : ""}
      ${c.addresses.length ? `<div class="addr-list">${addrs}<label class="addr-opt"><input type="radio" name="addrPick" value="" ${pickedAddress ? "" : "checked"}><span>عنوان جديد</span></label></div>` : `<span class="hint">مفيش عناوين محفوظة</span>`}`;
    $("known").hidden = false;
  }
  function pickAddress(id) {
    pickedAddress = id || null;
    const a = knownCustomer && knownCustomer.addresses.find(x => x.id === pickedAddress);
    if (a) { $("f-address").value = a.address; }
    else if (knownCustomer && knownCustomer.addresses.some(x => x.address === $("f-address").value)) $("f-address").value = "";
    $("f-location-wrap").hidden = !!(a && (a.lat != null || a.location_url));
  }
  async function lookupCustomer() {
    const phone = $("f-phone").value.trim();
    if (knownCustomer && knownCustomer.phones.includes(normPhone(phone))) return;
    resetKnown();
    if (phone.replace(/\D/g, "").length < 8) return;
    try {
      const c = await api("/api/clients/by-phone/" + encodeURIComponent(phone));
      if (!c || $("f-phone").value.trim() !== phone) return;
      useClient(c);
    } catch (e) {}
  }
  function useClient(c, addressId) {
    knownCustomer = c;
    if (!$("f-customer").value.trim() && c.name) $("f-customer").value = c.name;
    if (c.delivery_fee != null && (!$("f-fee").value || $("f-fee").dataset.auto === "1")) { $("f-fee").value = c.delivery_fee; $("f-fee").dataset.auto = "1"; }
    updateTotal();
    renderKnown();
    pickAddress(addressId || (c.addresses[0] && c.addresses[0].id));
    renderKnown();
  }
  $("known").addEventListener("change", e => { if (e.target.name === "addrPick") pickAddress(Number(e.target.value)); });
  $("f-phone").addEventListener("change", lookupCustomer);
  $("f-phone").addEventListener("blur", lookupCustomer);
  $("f-address").addEventListener("input", () => {
    const a = knownCustomer && knownCustomer.addresses.find(x => x.id === pickedAddress);
    if (a && a.address !== $("f-address").value && !$("f-address").value.trim()) { pickedAddress = null; renderKnown(); $("f-location-wrap").hidden = false; }
  });
  function openOrderFor(c, addressId) {
    setTab("orders"); $("orderForm").reset(); $("f-promise").value = "60"; resetKnown();
    $("orderForm").hidden = false; $("f-phone").value = c.phones[0] || ""; $("f-customer").value = c.name || "";
    useClient(c, addressId); $("f-items").focus();
  }

  $("orderForm").addEventListener("submit", async e => {
    e.preventDefault();
    const btn = e.target.querySelector("[type=submit]"); btn.disabled = true;
    try {
      const o = await api("/api/orders", { method: "POST", body: {
        customer: $("f-customer").value, phone: $("f-phone").value, address: $("f-address").value, items: $("f-items").value,
        amount: $("f-amount").value, delivery_fee: $("f-fee").value, source: $("f-source").value, payment: $("f-payment").value, promise_min: Number($("f-promise").value),
        location: $("f-location-wrap").hidden ? "" : $("f-location").value,
        client_id: knownCustomer ? knownCustomer.id : null, address_id: pickedAddress } });
      e.target.reset(); resetKnown(); $("f-results").hidden = true; $("f-promise").value = "60"; e.target.hidden = true; S.filter = "active";
      toast("الأوردر اتسجل #" + o.no + (o.lat != null || o.location_url ? " باللوكيشن" : "")); await refresh();
    } catch (err) { toast(err.message); }
    btn.disabled = false;
  });

  setInterval(() => { if (S.user && !document.hidden) render(); }, 30000);

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  loadShop();
  try { S.token = localStorage.getItem("token"); } catch (e) {}
  if (S.token) start().catch(() => showLogin()); else showLogin();
})();
