/* Emission & Noise Monitor — single-page frontend (vanilla JS, Chart.js, Leaflet) */
"use strict";

// ------------------------------------------------------------------ helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $("#view");
const nf = new Intl.NumberFormat("en-IN");
const n = (v, d = 0) => (v == null ? "—" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d }).format(v));
const rupee = (v) => (v == null ? "—" : "₹" + nf.format(Math.round(v)));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plate = (p, cls = "") => `<span class="plate ${cls}">${esc(p)}</span>`;
const badge = (t) => `<span class="badge b-${esc(t)}">${esc(t)}</span>`;
const when = (s) => {
  if (!s) return "—";
  const d = new Date(String(s).replace(" ", "T"));
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 3200);
}

function showBanner(msg) {
  const b = $("#banner");
  if (!msg) { b.hidden = true; return; }
  b.textContent = msg;
  b.hidden = false;
}

// ------------------------------------------------------------------ timers / cleanup per page
let cleanups = [];
function onLeave(fn) { cleanups.push(fn); }
function every(ms, fn) { const id = setInterval(fn, ms); onLeave(() => clearInterval(id)); return id; }
const charts = [];
function chart(canvas, cfg) {
  if (!window.Chart) { canvas.parentElement.innerHTML = '<p class="muted">Charts need an internet connection to load Chart.js.</p>'; return null; }
  const c = new Chart(canvas, cfg);
  onLeave(() => c.destroy());
  return c;
}
if (window.Chart) {
  Chart.defaults.font.family = "Barlow, 'Segoe UI', sans-serif";
  Chart.defaults.color = "#5b6b73";
  Chart.defaults.plugins.legend.labels.boxWidth = 12;
}
const C = { teal: "#0e6e6b", crimson: "#b42335", amber: "#c9731d", blue: "#3b5b94", grey: "#9aa8ad" };

// ------------------------------------------------------------------ meters
function meter(label, value, limit, unit, big = false) {
  const max = Math.max(limit * 1.6, value * 1.05, 1);
  const over = value > limit;
  return `<div class="meter ${over ? "over" : ""} ${big ? "big" : ""}">
    <div class="meter-lbl"><span>${label}</span><span><b>${n(value, 1)}</b> / ${n(limit, 0)} ${unit}</span></div>
    <div class="track" role="img" aria-label="${label} ${n(value, 1)} ${unit}, limit ${n(limit, 0)}">
      <div class="fill" style="width:${Math.min(100, (value / max) * 100)}%"></div>
      <div class="limit" style="left:${(limit / max) * 100}%"></div>
    </div></div>`;
}

function feedItem(r, fresh = false) {
  return `<li class="${fresh ? "fresh" : ""}">
    <div class="feed-top">
      <button class="plate-btn" data-vehicle="${r.vehicle_id}" aria-label="Open vehicle ${esc(r.license_plate)}">${plate(r.license_plate, "small")}</button>
      <span class="eng">${esc(r.engine_type)}</span>
      ${badge(r.outcome)}${r.fine_amount ? `<span class="eng">${rupee(r.fine_amount)}</span>` : ""}
      <span class="when">${when(r.recorded_at)}</span>
    </div>
    <div class="feed-zone">${esc(r.zone_name || "Outside all zones")}${r.outcome === "Ignored" ? " · not penalised" : ""}</div>
    <div class="meters">
      ${meter("CO ppm", r.co_level, r.max_co_limit, "")}
      ${meter("NO₂ ppm", r.no2_level, r.max_no2_limit, "")}
      ${meter("Noise dB", r.noise_level, r.noise_limit, "")}
    </div>
  </li>`;
}

// Live feed widget used on Overview and Live monitor
function mountFeed(ul, { limit = 12, onNew } = {}) {
  let lastId = 0;
  let items = [];
  async function load(initial) {
    try {
      const rows = await api(`/api/feed?limit=${limit}&after=${initial ? 0 : lastId}`);
      if (!ul.isConnected || (!rows.length && !initial)) return;
      if (rows.length) lastId = Math.max(lastId, ...rows.map((r) => r.log_id));
      const freshIds = new Set(initial ? [] : rows.map((r) => r.log_id));
      items = [...rows, ...items].slice(0, limit);
      ul.innerHTML = items.length ? items.map((r) => feedItem(r, freshIds.has(r.log_id))).join("") : `<li class="feed-empty">No readings yet. Start the simulator on the Live monitor page.</li>`;
      if (!initial && rows.length && onNew) onNew(rows);
    } catch (e) { /* banner handled by health check */ }
  }
  load(true);
  every(3000, () => load(false));
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-vehicle]");
  if (b) openVehicle(Number(b.dataset.vehicle));
});

// ------------------------------------------------------------------ map
const ZONE_COLOURS = { Silence: "#b42335", Residential: "#c9731d", Commercial: "#3b5b94", Industrial: "#5b6b73" };
function makeMap(el, zones) {
  if (!window.L) { el.innerHTML = '<div class="map-fallback">The map needs an internet connection to load map tiles.</div>'; return null; }
  const map = L.map(el, { scrollWheelZoom: false }).setView([12.975, 77.61], 11);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  }).addTo(map);
  zones.forEach((z) => {
    L.rectangle([[z.min_lat, z.min_lng], [z.max_lat, z.max_lng]], {
      color: ZONE_COLOURS[z.zone_type], weight: 1.5, fillOpacity: 0.12,
    }).bindTooltip(`<b>${esc(z.zone_name)}</b><br>${esc(z.zone_type)} zone · noise limit ${n(z.max_noise_limit, 0)} dB`).addTo(map);
  });
  onLeave(() => map.remove());
  return map;
}
function addHotspots(map, rows) {
  if (!map) return null;
  const layer = L.layerGroup().addTo(map);
  const maxV = Math.max(1, ...rows.map((r) => r.total_violations));
  rows.forEach((r, i) => {
    L.circleMarker([r.grid_lat, r.grid_lng], {
      radius: 8 + 22 * (r.total_violations / maxV), color: C.crimson, weight: 1.5, fillColor: C.crimson, fillOpacity: 0.28,
    }).bindTooltip(`<b>#${i + 1} ${esc(r.place || "")} · ${n(r.total_violations)} violations</b><br>${n(r.distinct_vehicles)} different vehicles<br>${n(r.emission_count)} emission · ${n(r.noise_count)} noise<br>Avg noise ${n(r.avg_noise_db, 1)} dB`).addTo(layer);
  });
  return layer;
}
const legend = () => `<div class="legend">
  <span><i style="background:#b42335;opacity:.5"></i>Silence zone</span>
  <span><i style="background:#c9731d;opacity:.5"></i>Residential</span>
  <span><i style="background:#3b5b94;opacity:.5"></i>Commercial</span>
  <span><i style="background:#5b6b73;opacity:.5"></i>Industrial</span>
  <span><i style="background:#b42335;border-radius:50%"></i>Hotspot (size = violations)</span></div>`;

// ================================================================== PAGES
const pages = {};

// ------------------------------------------------------------------ Overview
pages.overview = async () => {
  view.innerHTML = `
    <div class="page-head"><div><h1>Overview</h1><p>Compliance across all monitored vehicles, updated as new readings arrive.</p></div></div>
    <div class="strip" id="strip">${"<div><div class='fig'>…</div><div class='lbl'>&nbsp;</div></div>".repeat(6)}</div>
    <div class="grid g-main">
      <section class="panel"><div class="panel-head"><h2>Where violations happen</h2><span class="sub">Zones and top 10 hotspots, last 7 days</span></div>
        <div class="map" id="ovMap"></div>${legend()}</section>
      <section class="panel"><div class="panel-head"><h2>Latest readings</h2><a href="#/live" class="sub">Open live monitor</a></div>
        <p class="sub">Bars show each reading against its limit. The black tick is the limit.</p>
        <ul class="feed" id="ovFeed"></ul></section>
    </div>
    <div class="grid g-3 mt">
      <section class="panel"><h2>Violations per day</h2><p class="sub">Last 30 complete days</p><div class="chart-box"><canvas id="cDaily"></canvas></div></section>
      <section class="panel"><h2>Violation rate by zone</h2><p class="sub">Share of readings that broke a limit</p><div class="chart-box"><canvas id="cZone"></canvas></div></section>
      <section class="panel"><h2>Violation types</h2><p class="sub">“Both” means emission and noise in one reading</p><div class="chart-box"><canvas id="cType"></canvas></div></section>
    </div>`;

  async function loadStrip() {
    const s = await api("/api/summary").catch(() => null);
    if (!s || !$("#strip")) return;
    $("#strip").innerHTML = [
      [nf.format(s.readings), "Readings stored"],
      [nf.format(s.violations), "Violations recorded"],
      [n(s.violation_rate, 1) + "%", "Of readings broke a limit"],
      [nf.format(s.violations_24h), "Violations in last 24 h"],
      [rupee(s.pending_fines), "Fines pending", "warn"],
      [`${s.active_sensors}<span class="muted" style="font-size:18px"> / ${s.active_sensors + s.faulty_sensors}</span>`, "Sensors active"],
    ].map(([f, l, c]) => `<div><div class="fig ${c || ""}">${f}</div><div class="lbl">${l}</div></div>`).join("");
  }
  loadStrip();
  every(6000, loadStrip);

  mountFeed($("#ovFeed"), { limit: 6 });

  const [zones, hot, daily, types] = await Promise.all([
    api("/api/zones?rates=1"), api("/api/hotspots?days=7&limit=10"), api("/api/violations/daily?days=30"), api("/api/violations/by-type"),
  ]);
  const map = makeMap($("#ovMap"), zones.zones);
  addHotspots(map, hot);

  chart($("#cDaily"), {
    type: "line",
    data: { labels: daily.map((d) => new Date(d.day).toLocaleDateString("en-IN", { day: "numeric", month: "short" })),
      datasets: [
        { label: "Emission", data: daily.map((d) => d.emission), borderColor: C.amber, backgroundColor: C.amber, tension: .3, pointRadius: 0, borderWidth: 2 },
        { label: "Noise", data: daily.map((d) => d.noise), borderColor: C.blue, backgroundColor: C.blue, tension: .3, pointRadius: 0, borderWidth: 2 },
      ] },
    options: { maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, scales: { x: { ticks: { maxTicksLimit: 6 }, grid: { display: false } }, y: { beginAtZero: true } } },
  });

  const zr = zones.rates;
  chart($("#cZone"), {
    type: "bar",
    data: { labels: zr.map((z) => `${z.zone_type === "-" ? "Outside zones" : z.zone_type} (${n(z.noise_limit)} dB)`),
      datasets: [
        { label: "Any violation", data: zr.map((z) => z.violation_rate), backgroundColor: C.crimson },
        { label: "Noise violation", data: zr.map((z) => z.noise_rate), backgroundColor: C.blue },
      ] },
    options: { maintainAspectRatio: false, indexAxis: "y",
      plugins: { tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${n(ctx.raw, 1)}% of ${nf.format(zr[ctx.dataIndex].readings)} readings` } } },
      scales: { x: { ticks: { callback: (v) => v + "%" }, grid: { display: false } }, y: { grid: { display: false } } } },
  });

  chart($("#cType"), {
    type: "bar",
    data: { labels: types.map((t) => t.violation_type), datasets: [{ label: "Violations", data: types.map((t) => t.count), backgroundColor: [C.amber, C.blue, C.crimson] }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { afterLabel: (ctx) => "Fines: " + rupee(types[ctx.dataIndex].fines) } } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true } } },
  });
};

// ------------------------------------------------------------------ Live monitor
const PLACES = [
  ["Central Hospital silence zone (68 dB)", 12.9575, 77.5975],
  ["Lakeview residential (72 dB)", 12.9275, 77.585],
  ["Downtown commercial (80 dB)", 12.974, 77.6075],
  ["North industrial estate (85 dB)", 13.03, 77.515],
  ["City road, outside zones (80 dB)", 12.99, 77.55],
  ["Junction J1, outside zones", 12.9177, 77.6238],
];
let simTimer = null;

pages.live = async () => {
  view.innerHTML = `
    <div class="page-head"><div><h1>Live monitor</h1><p>Send a reading the way a vehicle sensor would, and see exactly how the database judged it.</p></div>
      <div class="controls"><button class="btn ${simTimer ? "live" : ""}" id="simBtn">${simTimer ? "Stop simulated traffic" : "Start simulated traffic"}</button></div></div>
    <div class="grid g-main">
      <div class="stack">
        <section class="panel">
          <h2>Send a reading</h2>
          <p class="sub">The reading is inserted into Telemetry_Logs. The trigger decides; this page only shows the result.</p>
          <div class="scenarios" id="scen">
            <button class="chip" data-s="both">Diesel in silence zone</button>
            <button class="chip" data-s="petrol">Same exhaust: Petrol</button>
            <button class="chip" data-s="diesel">Same exhaust: Diesel</button>
            <button class="chip" data-s="cng">Same exhaust: CNG</button>
            <button class="chip" data-s="ind">75 dB in industrial zone</button>
            <button class="chip" data-s="sil">75 dB in silence zone</button>
            <button class="chip" data-s="faulty">Faulty sensor</button>
            <button class="chip" data-s="bad">Impossible value</button>
          </div>
          <form class="form-grid" id="rForm" novalidate>
            <div class="field wide"><label for="fSensor">Vehicle sensor</label><select id="fSensor" required><option>Loading sensors…</option></select></div>
            <div class="field"><label for="fCo">CO (ppm)</label><input id="fCo" type="number" step="0.01" value="200"></div>
            <div class="field"><label for="fNo2">NO₂ (ppm)</label><input id="fNo2" type="number" step="0.01" value="40"></div>
            <div class="field"><label for="fNoise">Noise (dB)</label><input id="fNoise" type="number" step="0.1" value="60"></div>
            <div class="field wide"><label for="fPlace">Location</label><select id="fPlace">${PLACES.map((p, i) => `<option value="${i}">${p[0]}</option>`).join("")}<option value="custom">Custom coordinates…</option></select></div>
            <div class="field" id="latF" hidden><label for="fLat">Latitude</label><input id="fLat" type="number" step="0.000001" value="12.99"></div>
            <div class="field" id="lngF" hidden><label for="fLng">Longitude</label><input id="fLng" type="number" step="0.000001" value="77.55"></div>
            <div class="field wide"><button class="btn primary" type="submit" id="sendBtn">Send reading</button></div>
          </form>
        </section>
        <section class="panel" id="trace" aria-live="polite">
          <h2>Decision</h2><p class="sub">Send a reading to see how the trigger judged it.</p>
        </section>
      </div>
      <section class="panel"><div class="panel-head"><h2>Incoming readings</h2><span class="sub" id="simNote">${simTimer ? "Simulator running" : "Refreshes every 3 seconds"}</span></div>
        <ul class="feed" id="liveFeed"></ul></section>
    </div>`;

  const sensors = await api("/api/sensors");
  $("#fSensor").innerHTML = sensors.map((s) =>
    `<option value="${s.sensor_id}" data-engine="${s.engine_type}">${esc(s.license_plate)} · ${s.engine_type} · sensor ${s.sensor_id}${s.sensor_status === "Faulty" ? " (faulty)" : ""}</option>`).join("");

  const findSensor = (engine, status = "Active") => sensors.find((s) => s.engine_type === engine && s.sensor_status === status);
  const SC = {
    both: ["Diesel", 210, 160, 88, 0], petrol: ["Petrol", 200, 40, 60, 4], diesel: ["Diesel", 200, 40, 60, 4], cng: ["CNG", 200, 40, 60, 4],
    ind: ["Petrol", 100, 20, 75, 3], sil: ["Petrol", 100, 20, 75, 0], faulty: [null, 999, 999, 120, 0], bad: ["Petrol", 50, 10, 250, 4],
  };
  $("#scen").addEventListener("click", (e) => {
    const k = e.target.dataset.s; if (!k) return;
    const [eng, co, no2, noise, place] = SC[k];
    const s = eng ? findSensor(eng) : sensors.find((x) => x.sensor_status === "Faulty");
    if (s) $("#fSensor").value = s.sensor_id;
    $("#fCo").value = co; $("#fNo2").value = no2; $("#fNoise").value = noise; $("#fPlace").value = place;
    $("#fPlace").dispatchEvent(new Event("change"));
    $("#sendBtn").focus();
  });
  $("#fPlace").addEventListener("change", () => {
    const custom = $("#fPlace").value === "custom";
    $("#latF").hidden = !custom; $("#lngF").hidden = !custom;
  });

  $("#rForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const p = $("#fPlace").value;
    const [lat, lng] = p === "custom" ? [$("#fLat").value, $("#fLng").value] : [PLACES[p][1], PLACES[p][2]];
    const btn = $("#sendBtn"); btn.disabled = true;
    try {
      const r = await api("/api/readings", { method: "POST", body: {
        sensor_id: $("#fSensor").value, co_level: $("#fCo").value, no2_level: $("#fNo2").value, noise_level: $("#fNoise").value, latitude: lat, longitude: lng } });
      renderTrace(r);
    } catch (err) {
      $("#trace").innerHTML = `<h2>Decision</h2><div class="verdict"><span class="big bad">Rejected</span></div><p>${esc(err.message)}</p>
        <p class="trace-note">The reading never reached the trigger: a database constraint blocked it at insert time.</p>`;
    } finally { btn.disabled = false; }
  });

  mountFeed($("#liveFeed"), { limit: 12 });

  $("#simBtn").addEventListener("click", () => {
    if (simTimer) { clearInterval(simTimer); simTimer = null; }
    else { simTimer = setInterval(() => api("/api/simulate", { method: "POST", body: { count: 3 } }).catch((e) => toast(e.message, true)), 2000); }
    $("#simBtn").textContent = simTimer ? "Stop simulated traffic" : "Start simulated traffic";
    $("#simBtn").classList.toggle("live", !!simTimer);
    $("#simNote").textContent = simTimer ? "Simulator running" : "Refreshes every 3 seconds";
    toast(simTimer ? "Simulated traffic started: 3 readings every 2 seconds" : "Simulated traffic stopped");
  });
};

function renderTrace(r) {
  const verdicts = {
    Compliant: ["Compliant", "ok", "Every value was within its limit, so no violation was recorded."],
    Ignored: ["Ignored", "skip", "This sensor is marked Faulty. The reading was stored for diagnostics but not penalised."],
    Emission: ["Emission violation", "bad", "At least one gas exceeded the limit for this engine type."],
    Noise: ["Noise violation", "bad", "Noise exceeded the limit for this location."],
    Both: ["Emission and noise violation", "bad", "Gas and noise limits were both exceeded in the same reading."],
  };
  const [title, cls, note] = verdicts[r.outcome];
  $("#trace").innerHTML = `
    <h2>Decision</h2>
    <div class="verdict"><span class="big ${cls}">${title}</span>${r.fine_amount ? `<span class="badge b-Pending">Fine ${rupee(r.fine_amount)}</span>` : ""}</div>
    <div class="trace">
      ${meter("Carbon monoxide (ppm)", r.co_level, r.max_co_limit, "ppm", true)}
      ${meter("Nitrogen dioxide (ppm)", r.no2_level, r.max_no2_limit, "ppm", true)}
      ${meter("Noise (dB)", r.noise_level, r.noise_limit, "dB", true)}
    </div>
    <dl class="kv mt">
      <dt>Vehicle</dt><dd><button class="plate-btn" data-vehicle="${r.vehicle_id}">${plate(r.license_plate, "small")}</button> ${esc(r.engine_type)}</dd>
      <dt>Gas limits from</dt><dd>${esc(r.engine_type)} row of Compliance_Thresholds</dd>
      <dt>Noise limit from</dt><dd>${r.zone_name ? esc(r.zone_name) : "Default limit (outside all zones)"}</dd>
      <dt>Reading id</dt><dd>log_id ${r.log_id}${r.violation_id ? ` → violation_id ${r.violation_id}` : ""}</dd>
    </dl>
    <p class="trace-note">${note}</p>`;
}

// ------------------------------------------------------------------ Hotspot map
pages.map = async () => {
  view.innerHTML = `
    <div class="page-head"><div><h1>Hotspot map</h1><p>Violations grouped into grid cells of about 110 m. Many different vehicles in one cell points to a problem with the place, not the drivers.</p></div>
      <div class="controls">
        <div class="field"><label for="hDays">Period</label><select id="hDays"><option value="1">Last 24 hours</option><option value="7" selected>Last 7 days</option><option value="30">Last 30 days</option></select></div>
        <div class="field"><label for="hLimit">Show</label><select id="hLimit"><option>5</option><option selected>10</option><option>20</option></select></div>
      </div></div>
    <section class="panel"><div class="map tall" id="hMap"></div>${legend()}</section>
    <section class="panel mt"><h2>Ranked hotspots</h2><p class="sub">From the GetZoneHotspots stored procedure</p><div class="table-wrap" id="hTable"></div></section>`;
  const zones = await api("/api/zones");
  const map = makeMap($("#hMap"), zones.zones);
  let layer = null;
  async function load() {
    const rows = await api(`/api/hotspots?days=${$("#hDays").value}&limit=${$("#hLimit").value}`);
    if (layer) layer.remove();
    layer = addHotspots(map, rows);
    $("#hTable").innerHTML = rows.length ? `<table><thead><tr><th>Rank</th><th>Grid cell</th><th>Area</th><th class="num">Violations</th><th class="num">Emission</th><th class="num">Noise</th><th class="num">Different vehicles</th><th class="num">Avg noise (dB)</th><th class="num">Fines</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="clickable" data-lat="${r.grid_lat}" data-lng="${r.grid_lng}"><td>${i + 1}</td><td>${r.grid_lat}, ${r.grid_lng}</td><td>${esc(r.place)}</td><td class="num"><b>${nf.format(r.total_violations)}</b></td><td class="num">${n(r.emission_count)}</td><td class="num">${n(r.noise_count)}</td><td class="num">${n(r.distinct_vehicles)}</td><td class="num">${n(r.avg_noise_db, 1)}</td><td class="num">${rupee(r.total_fines)}</td></tr>`).join("")}
      </tbody></table>` : `<p class="muted">No violations in this period. Choose a longer period or start the simulator.</p>`;
  }
  $("#hDays").addEventListener("change", load);
  $("#hLimit").addEventListener("change", load);
  $("#hTable").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-lat]");
    if (tr && map) { map.setView([+tr.dataset.lat, +tr.dataset.lng], 16); window.scrollTo({ top: 0, behavior: "smooth" }); }
  });
  load();
};

// ------------------------------------------------------------------ Vehicles
const vState = { q: "", sort: "pending", engine: "", page: 1 };
pages.vehicles = async () => {
  view.innerHTML = `
    <div class="page-head"><div><h1>Vehicles &amp; fines</h1><p>Every registered vehicle with its compliance record. Open a vehicle to see its violations and record payments.</p></div></div>
    <section class="panel">
      <div class="controls">
        <div class="field" style="flex:1;min-width:200px"><label for="vq">Search plate or owner</label><input id="vq" type="search" placeholder="e.g. KA38 or Sharma" value="${esc(vState.q)}"></div>
        <div class="field"><label for="ve">Engine</label><select id="ve"><option value="">All</option><option>Petrol</option><option>Diesel</option><option>CNG</option></select></div>
        <div class="field"><label for="vs">Sort by</label><select id="vs"><option value="pending">Pending fines</option><option value="violations">Violations</option><option value="recent">Latest violation</option><option value="plate">Plate</option></select></div>
      </div>
      <div class="table-wrap mt" id="vTable"></div>
      <div class="pager" id="vPager"></div>
    </section>`;
  $("#ve").value = vState.engine; $("#vs").value = vState.sort;
  async function load() {
    const d = await api(`/api/vehicles?q=${encodeURIComponent(vState.q)}&sort=${vState.sort}&engine=${vState.engine}&page=${vState.page}&size=15`);
    $("#vTable").innerHTML = d.rows.length ? `<table><thead><tr><th>Plate</th><th>Owner</th><th>Engine</th><th class="num">Violations</th><th class="num">Emission</th><th class="num">Noise</th><th class="num">Pending fines</th><th>Latest violation</th></tr></thead><tbody>
      ${d.rows.map((r) => `<tr class="clickable" data-vehicle="${r.vehicle_id}" tabindex="0"><td>${plate(r.license_plate, "small")}</td><td>${esc(r.owner_name)}</td><td>${r.engine_type}</td><td class="num">${n(r.total_violations)}</td><td class="num">${n(r.emission_violations)}</td><td class="num">${n(r.noise_violations)}</td><td class="num"><b>${rupee(r.pending_fines)}</b></td><td>${when(r.last_violation)}</td></tr>`).join("")}
      </tbody></table>` : `<p class="muted">No vehicles match “${esc(vState.q)}”. Try part of a plate, such as KA38.</p>`;
    const pages_ = Math.max(1, Math.ceil(d.total / d.size));
    $("#vPager").innerHTML = `<span>${nf.format(d.total)} vehicles · page ${d.page} of ${pages_}</span>
      <span><button class="btn small" id="pPrev" ${d.page <= 1 ? "disabled" : ""}>Previous</button> <button class="btn small" id="pNext" ${d.page >= pages_ ? "disabled" : ""}>Next</button></span>`;
    $("#pPrev").onclick = () => { vState.page--; load(); };
    $("#pNext").onclick = () => { vState.page++; load(); };
  }
  let t;
  $("#vq").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { vState.q = e.target.value; vState.page = 1; load(); }, 250); });
  $("#ve").addEventListener("change", (e) => { vState.engine = e.target.value; vState.page = 1; load(); });
  $("#vs").addEventListener("change", (e) => { vState.sort = e.target.value; vState.page = 1; load(); });
  $("#vTable").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.dataset.vehicle) openVehicle(+e.target.dataset.vehicle); });
  onLeave(() => { pages.vehicles.reload = null; });
  pages.vehicles.reload = load;
  load();
};

// ------------------------------------------------------------------ Vehicle drawer
async function openVehicle(id) {
  const drawer = $("#drawer");
  $("#drawerBody").innerHTML = `<p class="muted">Loading vehicle…</p>`;
  drawer.classList.add("open"); drawer.setAttribute("aria-hidden", "false");
  $("#drawerClose").focus();
  try {
    const v = await api(`/api/vehicles/${id}`);
    renderVehicle(v);
  } catch (e) { $("#drawerBody").innerHTML = `<p>${esc(e.message)}</p>`; }
}
function closeDrawer() {
  const drawer = $("#drawer");
  drawer.classList.remove("open"); drawer.setAttribute("aria-hidden", "true");
  if (pages.vehicles.reload) pages.vehicles.reload();
}
$("#drawerClose").addEventListener("click", closeDrawer);
$("#drawer").addEventListener("click", (e) => { if (e.target.id === "drawer") closeDrawer(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#drawer").classList.contains("open")) closeDrawer(); });

function renderVehicle(v) {
  const c = v.compliance || {};
  const s = v.sensors[0];
  $("#drawerBody").innerHTML = `
    <h2 id="drawerTitle">${plate(v.license_plate)} <span style="font-size:18px">${esc(v.owner_name)}</span></h2>
    <dl class="kv"><dt>Engine</dt><dd>${v.engine_type}</dd><dt>Owner email</dt><dd>${esc(v.owner_email)}</dd><dt>Registered</dt><dd>${esc(v.registration_date)}</dd>
      ${v.sensors.map((x) => `<dt>Sensor ${x.sensor_id}</dt><dd>${esc(x.mac_address)} ${badge(x.sensor_status)}</dd>`).join("")}</dl>
    <div class="strip mt" style="grid-template-columns:repeat(3,1fr)">
      <div><div class="fig">${n(c.total_violations)}</div><div class="lbl">Violations</div></div>
      <div><div class="fig">${n(c.emission_violations)} / ${n(c.noise_violations)}</div><div class="lbl">Emission / noise</div></div>
      <div><div class="fig warn" id="dPending">${rupee(c.pending_fines)}</div><div class="lbl">Pending fines</div></div>
    </div>
    <h2>Violations</h2><p class="sub">Most recent 100. Recording a payment calls the PayFine stored procedure.</p>
    ${v.violations.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Type</th><th>Where</th><th class="num">Fine</th><th>Status</th></tr></thead><tbody>
      ${v.violations.map((x) => `<tr><td>${when(x.occurred_at)}</td><td>${badge(x.violation_type)}</td><td>${esc(x.zone_name || "Outside zones")}</td><td class="num">${rupee(x.fine_amount)}</td>
        <td>${x.status === "Paid" ? badge("Paid") : `<button class="btn small" data-pay="${x.violation_id}" data-fine="${x.fine_amount}">Record payment</button>`}</td></tr>`).join("")}
    </tbody></table></div>` : `<p class="muted">No violations recorded for this vehicle.</p>`}`;
  drawerVehicle = c;
}
let drawerVehicle = null;
$("#drawerBody").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-pay]"); if (!b) return;
  b.disabled = true;
  try {
    await api(`/api/violations/${b.dataset.pay}/pay`, { method: "POST" });
    b.outerHTML = badge("Paid");
    drawerVehicle.pending_fines -= Number(b.dataset.fine);
    $("#dPending").textContent = rupee(drawerVehicle.pending_fines);
    toast("Payment recorded");
  } catch (err) { toast(err.message, true); b.disabled = false; }
});

// ------------------------------------------------------------------ Offenders
pages.offenders = async () => {
  view.innerHTML = `
    <div class="page-head"><div><h1>Repeat offenders</h1><p>Vehicles that broke limits at least a set number of times. Raise the minimum until the list shows only the vehicles worth acting on.</p></div>
      <div class="controls">
        <div class="field"><label for="oDays">Within the last</label><select id="oDays"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></div>
        <div class="field"><label for="oMin">Minimum violations</label><input id="oMin" type="number" min="1" value="60" style="width:110px"></div>
        <button class="btn primary" id="oGo">Find offenders</button>
      </div></div>
    <section class="panel"><div id="oOut"></div></section>`;
  async function load() {
    try {
      const rows = await api(`/api/offenders?days=${$("#oDays").value}&min=${$("#oMin").value}`);
      $("#oOut").innerHTML = `<p class="sub">${rows.length} vehicles found · GetRepeatOffenders(${$("#oDays").value}, ${$("#oMin").value})</p>` + (rows.length ?
        `<div class="table-wrap"><table><thead><tr><th>Plate</th><th>Owner</th><th>Email</th><th>Engine</th><th class="num">Violations</th><th class="num">Unpaid</th><th class="num">Amount due</th><th>Latest</th></tr></thead><tbody>
        ${rows.map((r) => `<tr class="clickable" data-vehicle="${r.vehicle_id}"><td>${plate(r.license_plate, "small")}</td><td>${esc(r.owner_name)}</td><td>${esc(r.owner_email)}</td><td>${r.engine_type}</td><td class="num"><b>${n(r.violations)}</b></td><td class="num">${n(r.unpaid)}</td><td class="num">${rupee(r.pending_amount)}</td><td>${when(r.last_violation)}</td></tr>`).join("")}
        </tbody></table></div>` : `<p class="muted">No vehicle reached ${esc($("#oMin").value)} violations. Lower the minimum to widen the search.</p>`);
    } catch (e) { $("#oOut").innerHTML = `<p>${esc(e.message)}</p>`; }
  }
  $("#oGo").addEventListener("click", load);
  $("#oMin").addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });
  load();
};

// ------------------------------------------------------------------ Rules & sensors
pages.rules = async () => {
  view.innerHTML = `
    <div class="page-head"><div><h1>Rules &amp; sensors</h1><p>Limits and fines are stored as data. A change here applies to the very next reading, with no code changes.</p></div></div>
    <section class="panel"><h2>Emission limits and fines</h2><p class="sub">Compliance_Thresholds · noise limit here is used only outside all zones</p><div class="table-wrap" id="tTable"></div></section>
    <div class="grid g-2 mt">
      <section class="panel"><h2>Zone noise limits</h2><p class="sub">Zones · the strictest zone wins where zones overlap</p><div class="table-wrap" id="zTable"></div></section>
      <section class="panel"><div class="panel-head"><h2>Sensors</h2><input id="sFilter" type="search" placeholder="Filter by plate" aria-label="Filter sensors by plate" style="border:1px solid var(--line-strong);border-radius:6px;padding:5px 9px"></div>
        <p class="sub">Readings from faulty sensors are stored but never fined</p><div class="table-wrap" id="sTable" style="max-height:420px;overflow-y:auto"></div></section>
    </div>`;

  async function loadT() {
    const rows = await api("/api/thresholds");
    $("#tTable").innerHTML = `<table><thead><tr><th>Engine</th><th class="num">Max CO (ppm)</th><th class="num">Max NO₂ (ppm)</th><th class="num">Default noise (dB)</th><th class="num">Emission fine (₹)</th><th class="num">Noise fine (₹)</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr data-engine="${r.engine_type}"><td><b>${r.engine_type}</b></td>
        ${["max_co_limit", "max_no2_limit", "max_noise_limit", "emission_fine", "noise_fine"].map((k) => `<td class="num"><input name="${k}" type="number" step="0.01" value="${r[k]}" aria-label="${r.engine_type} ${k.replace(/_/g, " ")}"></td>`).join("")}
        <td class="right"><button class="btn small" data-save-t>Save</button></td></tr>`).join("")}</tbody></table>`;
  }
  async function loadZ() {
    const d = await api("/api/zones");
    $("#zTable").innerHTML = `<table><thead><tr><th>Zone</th><th>Type</th><th class="num">Noise limit (dB)</th><th></th></tr></thead><tbody>
      ${d.zones.map((z) => `<tr data-zone="${z.zone_id}"><td>${esc(z.zone_name)}</td><td>${z.zone_type}</td><td class="num"><input name="max_noise_limit" type="number" step="0.1" value="${z.max_noise_limit}" aria-label="${esc(z.zone_name)} noise limit"></td><td class="right"><button class="btn small" data-save-z>Save</button></td></tr>`).join("")}</tbody></table>`;
  }
  let sensors = [];
  function drawS() {
    const f = $("#sFilter").value.trim().toUpperCase();
    const rows = sensors.filter((s) => !f || s.license_plate.includes(f));
    $("#sTable").innerHTML = `<table><thead><tr><th>Sensor</th><th>Vehicle</th><th class="num">Readings</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((s) => `<tr><td>${s.sensor_id}</td><td>${plate(s.license_plate, "small")}</td><td class="num">${n(s.total_readings)}</td><td>${badge(s.sensor_status)}</td>
        <td class="right"><button class="btn small" data-sensor="${s.sensor_id}" data-to="${s.sensor_status === "Active" ? "Faulty" : "Active"}">Mark ${s.sensor_status === "Active" ? "faulty" : "active"}</button></td></tr>`).join("")}</tbody></table>`;
  }
  async function loadS() { sensors = await api("/api/sensors"); drawS(); }
  $("#sFilter").addEventListener("input", drawS);

  const onRulesClick = async (e) => {
    const t = e.target;
    try {
      if (t.matches("[data-save-t]")) {
        const tr = t.closest("tr"); const body = {};
        $$("input", tr).forEach((i) => (body[i.name] = i.value));
        await api(`/api/thresholds/${tr.dataset.engine}`, { method: "PUT", body });
        toast(`${tr.dataset.engine} limits saved`);
      } else if (t.matches("[data-save-z]")) {
        const tr = t.closest("tr");
        await api(`/api/zones/${tr.dataset.zone}`, { method: "PUT", body: { max_noise_limit: $("input", tr).value } });
        toast("Zone limit saved");
      } else if (t.matches("[data-sensor]")) {
        await api(`/api/sensors/${t.dataset.sensor}/status`, { method: "PUT", body: { sensor_status: t.dataset.to } });
        const s = sensors.find((x) => x.sensor_id === +t.dataset.sensor); s.sensor_status = t.dataset.to; drawS();
        toast(`Sensor ${t.dataset.sensor} marked ${t.dataset.to.toLowerCase()}`);
      }
    } catch (err) { toast(err.message, true); }
  };
  view.addEventListener("click", onRulesClick);
  onLeave(() => view.removeEventListener("click", onRulesClick));
  await Promise.all([loadT(), loadZ(), loadS()]);
};

// ------------------------------------------------------------------ Query lab
const labHistory = {}; // { q1: { without: {...}, with: {...} } }
pages.lab = async () => {
  view.innerHTML = `
    <div class="page-head"><div><h1>Query lab</h1><p>Run the same queries with and without indexes and compare how MySQL executes them. Plans come from EXPLAIN and EXPLAIN ANALYZE.</p></div></div>
    <section class="panel"><div class="panel-head"><h2>Indexes on Telemetry_Logs</h2><span class="sub" id="labRows"></span></div>
      <div class="idx-state mt" id="idxState"></div></section>
    <div class="stack mt" id="labQueries"></div>
    <section class="panel mt"><h2>Before and after</h2><p class="sub">Filled in as you run each query in both states</p><div class="table-wrap" id="labCompare"></div></section>`;
  const info = await api("/api/lab");
  $("#labRows").textContent = `${nf.format(info.rows)} rows in the table`;
  function drawIdx(ix) {
    const on = Object.values(ix).every(Boolean);
    $("#idxState").innerHTML = Object.entries(ix).map(([k, v]) => `<span class="badge ${v ? "b-Active" : "b-Faulty"}">${k}: ${v ? "present" : "absent"}</span>`).join("") +
      `<button class="btn ${on ? "danger" : "primary"}" id="idxBtn" style="margin-left:auto">${on ? "Drop indexes" : "Create indexes"}</button>`;
    $("#idxBtn").onclick = async () => {
      $("#idxBtn").disabled = true; $("#idxBtn").textContent = on ? "Dropping…" : "Creating…";
      try { const d = await api("/api/lab/indexes", { method: "POST", body: { action: on ? "drop" : "create" } }); drawIdx(d.indexes); toast(on ? "Indexes dropped" : "Indexes created"); }
      catch (e) { toast(e.message, true); drawIdx(ix); }
    };
  }
  drawIdx(info.indexes);

  $("#labQueries").innerHTML = Object.entries(info.queries).map(([id, q]) => `
    <section class="panel" id="lab-${id}"><div class="panel-head"><h2>${id.toUpperCase()}: ${esc(q.title)}</h2><button class="btn primary" data-run="${id}">Run with EXPLAIN</button></div>
      <div class="code">${esc(q.sql)}</div><div class="out"></div></section>`).join("");

  function drawCompare() {
    const rows = Object.entries(labHistory);
    $("#labCompare").innerHTML = rows.length ? `<table><thead><tr><th>Query</th><th>Without indexes</th><th class="num">Rows examined</th><th class="num">Time (ms)</th><th>With indexes</th><th class="num">Rows examined</th><th class="num">Time (ms)</th></tr></thead><tbody>
      ${rows.map(([id, h]) => { const a = h.without || {}, b = h.with || {}; return `<tr><td><b>${id.toUpperCase()}</b></td>
        <td>${a.type ? `<span class="scan-${a.type}">${a.type}</span> ${esc(a.key || "")}` : "<span class='muted'>not run</span>"}</td><td class="num">${n(a.rows)}</td><td class="num">${n(a.ms, 2)}</td>
        <td>${b.type ? `<span class="scan-${b.type}">${b.type}</span> ${esc(b.key || "")}` : "<span class='muted'>not run</span>"}</td><td class="num">${n(b.rows)}</td><td class="num">${n(b.ms, 2)}</td></tr>`; }).join("")}
      </tbody></table>` : `<p class="muted">Run a query, change the indexes, then run it again.</p>`;
  }
  drawCompare();

  $("#labQueries").addEventListener("click", async (e) => {
    const id = e.target.dataset.run; if (!id) return;
    const out = $(`#lab-${id} .out`); e.target.disabled = true; out.innerHTML = `<p class="muted">Running…</p>`;
    try {
      const d = await api(`/api/lab/${id}`);
      const p = d.plan[0];
      const indexed = Object.values(d.indexes).every(Boolean);
      (labHistory[id] = labHistory[id] || {})[indexed ? "with" : "without"] = { type: p.type, key: p.key, rows: d.rows_examined, ms: d.server_ms };
      out.innerHTML = `
        <div class="lab-figs">
          <div><b class="scan-${esc(p.type)}">${esc(p.type)}</b>Access type</div>
          <div><b>${esc(p.key || "none")}</b>Index used</div>
          <div><b>${n(d.rows_examined)}</b>Rows examined</div>
          <div><b>${n(d.rows_returned)}</b>Rows returned</div>
          <div><b>${n(d.server_ms, 2)} ms</b>Server time</div>
        </div>
        <div class="table-wrap"><table><thead><tr>${["select_type", "table", "type", "possible_keys", "key", "rows", "filtered", "Extra"].map((h) => `<th>${h}</th>`).join("")}</tr></thead>
          <tbody>${d.plan.map((r) => `<tr>${["select_type", "table", "type", "possible_keys", "key", "rows", "filtered", "Extra"].map((h) => `<td>${esc(r[h] ?? "NULL")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
        <div class="code">${esc(d.analyze)}</div>`;
      drawCompare();
    } catch (err) { out.innerHTML = `<p>${esc(err.message)}</p>`; }
    finally { e.target.disabled = false; }
  });
};

// ================================================================== router
async function route() {
  const dr = $("#drawer");
  if (dr.classList.contains("open")) { dr.classList.remove("open"); dr.setAttribute("aria-hidden", "true"); }
  cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  cleanups = [];
  const name = (location.hash.replace("#/", "") || "overview").split("?")[0];
  const page = pages[name] ? name : "overview";
  $$(".rail nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === page));
  view.innerHTML = "";
  try { await pages[page](); }
  catch (e) { view.innerHTML = `<div class="page-head"><div><h1>Couldn’t load this page</h1><p>${esc(e.message)}</p></div></div>`; }
  $("#main").focus({ preventScroll: true });
}
window.addEventListener("hashchange", route);

async function healthCheck() {
  try {
    const h = await api("/api/health");
    $("#dbDot").className = "db-dot ok";
    $("#dbStatus").textContent = `MySQL ${h.version.split("-")[0]} · ${h.db}`;
    showBanner(null);
  } catch (e) {
    $("#dbDot").className = "db-dot down";
    $("#dbStatus").textContent = "Database unreachable";
    showBanner(e.message || "Can't reach the server. Check that python app.py is still running.");
  }
}
healthCheck();
setInterval(healthCheck, 10000);
route();
