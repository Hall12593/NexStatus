/* ═══════════════════════════════════════════
   GLOBALS
═══════════════════════════════════════════ */
let dataTimezone = -6;
let _allStatusData = null;
let tooltipEl = null;

/* ═══════════════════════════════════════════
   SEGURIDAD — Sanitización anti-XSS
═══════════════════════════════════════════ */
function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (className) e.className = className;
  return e;
}

function pad(n) { return String(n).padStart(2, "0"); }

/* ═══════════════════════════════════════════
   TIMEZONE
═══════════════════════════════════════════ */
function getServerNow() {
  const now = new Date();
  const utcTime = now.getTime() + now.getTimezoneOffset() * 60_000;
  return new Date(utcTime + dataTimezone * 3_600_000);
}

function getServerTodayKey() {
  const s = getServerNow();
  return `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`;
}

/* ═══════════════════════════════════════════
   FORMATTERS
═══════════════════════════════════════════ */
function formatDate(date) {
  try {
    return new Date(date).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
  } catch { return "—"; }
}

function formatDateOnly(dateStr) {
  try {
    return new Date(dateStr + "T12:00:00").toLocaleDateString("es-MX", {
      day: "numeric", month: "short", year: "numeric",
    });
  } catch { return "—"; }
}

function formatRelative(isoStr) {
  const diff = Date.now() - new Date(isoStr);
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `hace ${d}d`;
  if (h > 0) return `hace ${h}h`;
  if (m > 0) return `hace ${m}m`;
  return "justo ahora";
}

function truncate3(v) { return Math.trunc(v * 1000) / 1000; }

function formatPercent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  let v = value;
  if (v >= 0 && v <= 1) v *= 100;
  return truncate3(v).toFixed(3) + "%";
}

function formatShortPercent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  let v = value;
  if (v >= 0 && v <= 1) v *= 100;
  return v.toFixed(3) + "%";
}

function getUptimeClass(percent) {
  if (typeof percent !== "number") return "";
  if (percent >= 95) return "excellent";
  if (percent >= 89) return "good";
  return "poor";
}

function formatDuration(fromIso, toIso) {
  const ms = new Date(toIso) - new Date(fromIso);
  const m  = Math.floor(ms / 60_000);
  const h  = Math.floor(m / 60);
  const d  = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

/* ═══════════════════════════════════════════
   INCIDENT BADGE
═══════════════════════════════════════════ */
const BADGE_MAP = {
  investigating: { cls: "badge-investigating", label: "Investigando" },
  identified:    { cls: "badge-identified",    label: "Identificado" },
  monitoring:    { cls: "badge-monitoring",    label: "Monitoreando" },
  resolved:      { cls: "badge-resolved",      label: "Resuelto" },
  maintenance:   { cls: "badge-maintenance",   label: "Mantenimiento" },
};

function incidentBadgeEl(status) {
  const b = BADGE_MAP[status] ?? { cls: "badge-investigating", label: esc(status) };
  const span = document.createElement("span");
  span.className = `incident-badge ${b.cls}`;
  span.textContent = b.label;
  return span;
}

/* ═══════════════════════════════════════════
   TOOLTIP
═══════════════════════════════════════════ */
function showTooltip(e, dot) {
  const ts          = dot.dataset.time    || "";
  const percent     = dot.dataset.percent || "—";
  const isMonitored = dot.dataset.monitored === "true";
  const isToday     = dot.dataset.isToday  === "true";

  tooltipEl = document.createElement("div");
  tooltipEl.className = "tooltip";

  if (!isMonitored) {
    tooltipEl.textContent = `No monitoreado • ${ts ? formatDateOnly(ts) : "—"}`;
  } else if (isToday) {
    const now = new Date().toLocaleString("es-MX", {
      day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
    tooltipEl.textContent = `${percent} uptime • ${now}`;
  } else {
    tooltipEl.textContent = `${percent} uptime • ${ts ? formatDateOnly(ts) : "—"}`;
  }

  document.body.appendChild(tooltipEl);
  moveTooltip(e);
}

function moveTooltip(e) {
  if (!tooltipEl) return;
  const padding = 12;
  const rect = tooltipEl.getBoundingClientRect();
  let x = e.clientX + 12;
  let y = e.clientY + 12;
  if (x + rect.width  > window.innerWidth)  x = e.clientX - rect.width  - padding;
  if (y + rect.height > window.innerHeight) y = e.clientY - rect.height - padding;
  tooltipEl.style.left = x + "px";
  tooltipEl.style.top  = y + "px";
}

function hideTooltip() { tooltipEl?.remove(); tooltipEl = null; }

function showSimpleTooltip(e, text) {
  tooltipEl = document.createElement("div");
  tooltipEl.className = "tooltip";
  text.split("\n").forEach((line, i) => {
    if (i > 0) tooltipEl.appendChild(document.createElement("br"));
    tooltipEl.appendChild(document.createTextNode(line));
  });
  document.body.appendChild(tooltipEl);
  moveTooltip(e);
}