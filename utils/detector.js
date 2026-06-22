/**
 * Uptime Monitor – Nexora v5.1
 * ─────────────────────────────────────────
 *  • Intervalos por servicio (checkInterval)
 *  • Tipos: http, tcp, udp, ping, dns, keyword
 *  • Cloudflare bypass detection
 *  • Uptime 100% para servicios nuevos
 *  • Limpia stats de servicios eliminados
 *  • Notificación por bot de Discord
 *  • Zona horaria: UTC-6 fija
 *  • Si caen cloudflare-dns y google-dns → no internet → ignorar caídas
 *  • Delay entre embeds cuando caen múltiples servicios a la vez
 *  • Embeds actualizados cuando admin añade comentario
 */

import fs from "fs/promises";
import path from "path";
import { setTimeout as sleep } from "timers/promises";
import { pingService, tcpPing } from "./checkers.js";

/* ═══════════════════════════════════════════
   CONFIG BASE
═══════════════════════════════════════════ */

const BASE_INTERVAL_MS  = 60_000;
const TIMEZONE_OFFSET   = -6;
const FORCE_CHECK_FILE  = path.resolve(process.cwd(), "data", "force_check");
const FORCE_CONFIG_RELOAD_FILE = path.resolve(process.cwd(), "data", "force_config_reload");
const EMBED_DELAY_MS    = 1_500; // delay entre embeds cuando caen múltiples servicios

const DATA_DIR      = path.resolve(process.cwd(), "data");
const STATUS_FILE   = path.join(DATA_DIR, "status.json");
const SERVICES_FILE = path.join(DATA_DIR, "services.json");

// DNS de referencia para detectar pérdida de internet del servidor
const INTERNET_CHECK_HOSTS = [
  { host: "1.1.1.1",   port: 53, name: "Cloudflare DNS" },
  { host: "8.8.8.8",   port: 53, name: "Google DNS" },
];

/* ═══════════════════════════════════════════
   ENV (.env cargado manualmente si existe)
═══════════════════════════════════════════ */

async function loadEnv() {
  try {
    const raw = await fs.readFile(path.resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    // .env no existe, se usan process.env del sistema
  }
}

/* ═══════════════════════════════════════════
   SERVICES CONFIG
═══════════════════════════════════════════ */

const DEFAULT_SECTIONS = [
  {
    id: "nexora", name: "Nexora",
    services: [
      { id: "bot",   name: "Nexora Bot",    url: "https://mbot.nexorabot.xyz",  icon: "fa-brands fa-discord" },
      { id: "main",  name: "Web Principal", url: "https://nexorabot.xyz",       icon: "fa-solid fa-globe" },
      { id: "panel", name: "Panel Admin",   url: "https://panel.nexorabot.xyz", icon: "fa-solid fa-user-shield" },
      { id: "dash",  name: "Dashboard",     url: "https://dash.nexorabot.xyz",  icon: "fa-solid fa-gauge" },
      { id: "api",   name: "API",           url: "https://api.nexorabot.xyz/",  icon: "fa-solid fa-code" },
    ],
  },
];

async function loadSections() {
  try {
    const raw = await fs.readFile(SERVICES_FILE, "utf8");
    const { sections } = JSON.parse(raw);
    return sections ?? [];
  } catch {
    return [];
  }
}

/* ═══════════════════════════════════════════
   DISCORD BOT
═══════════════════════════════════════════ */

async function discordRequest(method, dpath, body) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return null;

  try {
    const res = await fetch(`https://discord.com/api/v10${dpath}`, {
      method,
      headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return true;
    if (!res.ok) {
      const err = await res.text();
      console.warn(`[discord] ${method} ${dpath} → ${res.status}: ${err}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn("[discord] Error de red:", e.message);
    return null;
  }
}

async function sendDiscordMessage(embeds) {
  const channelId = process.env.DISCORD_CHANNEL_ID;
  if (!channelId) return null;
  const data = await discordRequest("POST", `/channels/${channelId}/messages`, { embeds });
  return data?.id ?? null;
}

async function editDiscordMessage(messageId, embeds) {
  const channelId = process.env.DISCORD_CHANNEL_ID;
  if (!channelId || !messageId) return false;
  const result = await discordRequest("PATCH", `/channels/${channelId}/messages/${messageId}`, { embeds });
  return result !== null;
}

/** Verifica conexión al bot enviando una petición a /users/@me */
async function verifyBotConnection() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn("[discord] ⚠ DISCORD_BOT_TOKEN no configurado — notificaciones desactivadas");
    return false;
  }
  const data = await discordRequest("GET", "/users/@me", null);
  if (data && data.username) {
    console.log(`[discord] ✅ Bot conectado: ${data.username}#${data.discriminator ?? "0"} (ID: ${data.id})`);
    return true;
  }
  console.warn("[discord] ⚠ No se pudo verificar conexión al bot (token inválido o sin permisos)");
  return false;
}

/* ═══════════════════════════════════════════
   DETECCIÓN DE INTERNET DEL SERVIDOR
═══════════════════════════════════════════ */

async function checkInternet() {
  const results = await Promise.all(
    INTERNET_CHECK_HOSTS.map(({ host, port }) =>
      tcpPing(host, port).then(r => r.status === "up")
    )
  );
  // Si TODOS caen → sin internet
  const hasInternet = results.some(ok => ok);
  if (!hasInternet) {
    console.warn("[internet] ⚠ Todos los DNS de referencia no responden — asumiendo pérdida de internet del servidor. No se marcarán servicios como down.");
  }
  return hasInternet;
}

/* ═══════════════════════════════════════════
   GESTIÓN DE INCIDENTES
═══════════════════════════════════════════ */

// Número de checks estables requeridos para confirmar resolución
const STABLE_CHECKS_REQUIRED = 5;
// Checks confirmatorios en el mismo ciclo antes de abrir incidente
// Flujo: fallo inicial → espera 5s → check 1 → espera 5s → check 2 → si ambos DOWN → caída confirmada
const DOWN_CONFIRM_CHECKS  = 2;
const DOWN_CONFIRM_DELAY   = 5_000; // ms entre cada check confirmatorio

// Cola de embeds pendientes para evitar flood (delay entre cada uno)
let _embedSendQueue = Promise.resolve();

function queueEmbed(fn) {
  _embedSendQueue = _embedSendQueue.then(async () => {
    await fn();
    await sleep(EMBED_DELAY_MS);
  });
  return _embedSendQueue;
}

function buildDownEmbed(service, incidentId, now) {
  return {
    title: `🔴 Caída detectada — ${service.name}`,
    description: `El servicio **${service.name}** no responde.\nInvestigando el problema.`,
    color: 0xef4444,
    timestamp: now,
    footer: { text: `Nexora Status • ID: ${incidentId}` },
    fields: [
      { name: "Servicio", value: service.name,      inline: true },
      { name: "Estado",   value: "🔍 Investigando", inline: true },
    ],
  };
}

function buildMonitoringEmbed(service, incident, now, extraFields = []) {
  return {
    title: `🟡 Monitoreando — ${service.name}`,
    description: `El servicio **${service.name}** volvió a responder.\nVerificando estabilidad antes de marcar como resuelto.`,
    color: 0xf59e0b,
    timestamp: now,
    footer: { text: `Nexora Status • ID: ${incident.id}` },
    fields: [
      { name: "Servicio", value: service.name,      inline: true },
      { name: "Estado",   value: "🟡 Monitoreando", inline: true },
      { name: "Duración", value: formatDuration(incident.createdAt, now), inline: false },
      ...extraFields,
    ],
  };
}

function buildResolvedEmbed(service, incident, now) {
  return {
    title: `🟢 Resuelto — ${service.name}`,
    description: `El servicio **${service.name}** ha sido confirmado como estable y operativo.`,
    color: 0x22c55e,
    timestamp: now,
    footer: { text: `Nexora Status • ID: ${incident.id}` },
    fields: [
      { name: "Servicio",        value: service.name,                          inline: true },
      { name: "Estado",          value: "✅ Operativo",                        inline: true },
      { name: "Tiempo afectado", value: formatDuration(incident.createdAt, now), inline: false },
    ],
  };
}

function buildUpdateEmbed(service, incident, update) {
  const statusLabels = {
    investigating: "🔍 Investigando",
    identified:    "🔎 Identificado",
    monitoring:    "🟡 Monitoreando",
    resolved:      "✅ Resuelto",
    maintenance:   "🔧 Mantenimiento",
  };
  const colors = {
    investigating: 0xef4444,
    identified:    0xf97316,
    monitoring:    0xf59e0b,
    resolved:      0x22c55e,
    maintenance:   0x3b82f6,
  };

  const fields = [
    { name: "Servicio", value: service?.name ?? incident.serviceName ?? "—", inline: true },
    { name: "Estado",   value: statusLabels[update.status] ?? update.status,  inline: true },
  ];

  if (incident.updates?.length > 1) {
    fields.push({ name: "Duración", value: formatDuration(incident.createdAt, update.at), inline: false });
  }

  return {
    title: `📋 Actualización — ${incident.title}`,
    description: update.message || "Sin mensaje.",
    color: colors[update.status] ?? 0x6b7280,
    timestamp: update.at,
    footer: { text: `Nexora Status • ID: ${incident.id}` },
    fields,
  };
}

/**
 * Realiza DOWN_CONFIRM_CHECKS checks adicionales con DOWN_CONFIRM_DELAY ms de separación
 * para confirmar que el servicio realmente está caído antes de abrir un incidente.
 * Retorna true si todos los checks confirmatorios también son DOWN.
 */
async function confirmDown(service) {
  for (let i = 1; i <= DOWN_CONFIRM_CHECKS; i++) {
    await sleep(DOWN_CONFIRM_DELAY);
    const result = await pingService(service);
    console.log(`[incidentes] 🔎 ${service.id} — Check confirmatorio ${i}/${DOWN_CONFIRM_CHECKS}: ${result.status}`);
    if (result.status === "up") {
      console.log(`[incidentes] ✅ ${service.id} — Falso positivo descartado en check confirmatorio ${i}`);
      return false;
    }
  }
  return true;
}

async function handleServiceDown(store, service) {
  store.incidents    ??= [];
  store.announcements ??= [];

  if (store.incidents.find(i => i.serviceId === service.id && !i.resolvedAt)) return;

  // ── Checks confirmatorios: 2 pings adicionales con 5s de separación ──────
  // Si alguno responde UP → falso positivo, no abrir incidente.
  console.log(`[incidentes] ⚠ ${service.id} — Caída detectada. Ejecutando ${DOWN_CONFIRM_CHECKS} checks confirmatorios (cada ${DOWN_CONFIRM_DELAY / 1000}s)…`);
  const confirmed = await confirmDown(service);
  if (!confirmed) return false; // falso positivo — servicio volvió en los confirmatorios
  console.log(`[incidentes] 🔴 ${service.id} — Caída confirmada tras ${DOWN_CONFIRM_CHECKS} checks. Abriendo incidente.`);

  const now        = new Date().toISOString();
  const incidentId = `inc-${Date.now()}`;

  const incident = {
    id: incidentId, serviceId: service.id, serviceName: service.name,
    title: `Interrupción — ${service.name}`, status: "investigating",
    automatic: true, createdAt: now, resolvedAt: null, discordMessageId: null,
    updates: [{ at: now, status: "investigating", message: "Caída detectada automáticamente. Investigando." }],
  };

  store.incidents.push(incident);
  store.announcements.push({
    id: `ann-${incidentId}`, type: "incident", title: incident.title,
    body: "Estamos investigando el problema. Se publicarán actualizaciones en breve.",
    incidentId, createdAt: now, endsAt: null,
  });

  const embed = buildDownEmbed(service, incidentId, now);

  queueEmbed(async () => {
    const msgId = await sendDiscordMessage([embed]);
    if (msgId) {
      incident.discordMessageId = msgId;
      // Persistir el messageId en el JSON inmediatamente
      try {
        const fresh = JSON.parse(await fs.readFile(STATUS_FILE, "utf8"));
        const inc = fresh.incidents?.find(i => i.id === incidentId);
        if (inc) { inc.discordMessageId = msgId; await saveStatus(fresh); }
      } catch {}
      console.log(`[discord] 📨 Embed enviado para ${service.id} (msg: ${msgId})`);
    } else {
      console.warn(`[discord] ⚠ No se pudo enviar embed para ${service.id}`);
    }
  });

  console.log(`[incidentes] 🔴 ${service.id} — Incidente creado: ${incidentId}`);
}

async function handleServiceMonitoring(store, service) {
  store.incidents ??= [];
  const incident = store.incidents.find(i => i.serviceId === service.id && !i.resolvedAt);
  if (!incident) return;
  if (incident.status === "monitoring") return;

  const now = new Date().toISOString();
  incident.status = "monitoring";
  incident.updates.push({
    at: now, status: "monitoring",
    message: `Servicio respondiendo de nuevo. Monitoreando estabilidad (${STABLE_CHECKS_REQUIRED} checks confirmatorios).`,
  });

  const embed = buildMonitoringEmbed(service, incident, now);
  queueEmbed(async () => {
    await editDiscordMessage(incident.discordMessageId, [embed]);
  });

  console.log(`[incidentes] 🟡 ${service.id} — Monitoreando estabilidad: ${incident.id}`);
}

async function handleStableCheck(store, service) {
  store.incidents ??= [];
  const incident = store.incidents.find(i => i.serviceId === service.id && !i.resolvedAt && i.status === "monitoring");
  if (!incident) return;

  incident.stableCount = (incident.stableCount ?? 0) + 1;
  const count = incident.stableCount;
  console.log(`[incidentes] 🟡 ${service.id} — Check estable ${count}/${STABLE_CHECKS_REQUIRED}`);

  if (count >= STABLE_CHECKS_REQUIRED) {
    const now = new Date().toISOString();
    incident.resolvedAt = now;
    incident.status     = "resolved";
    incident.updates.push({ at: now, status: "resolved", message: "Estabilidad confirmada. Incidente resuelto automáticamente." });

    store.announcements = (store.announcements ?? []).filter(a => a.incidentId !== incident.id);

    const embed = buildResolvedEmbed(service, incident, now);
    queueEmbed(async () => {
      await editDiscordMessage(incident.discordMessageId, [embed]);
    });

    console.log(`[incidentes] 🟢 ${service.id} — Resuelto tras ${STABLE_CHECKS_REQUIRED} checks estables: ${incident.id}`);
  }
}

async function handleServiceRecovered(store, service) {
  store.incidents ??= [];
  const incident = store.incidents.find(i => i.serviceId === service.id && !i.resolvedAt);
  if (!incident) return;
  incident.stableCount = 0;
  await handleServiceMonitoring(store, service);
}

/**
 * Llamado por server.js cuando un admin añade un comentario a un incidente.
 * Edita el embed de Discord existente.
 */
export async function notifyIncidentUpdate(incident, update, serviceName) {
  if (!incident.discordMessageId) return;
  const embed = buildUpdateEmbed({ name: serviceName ?? incident.serviceName }, incident, update);
  const ok = await editDiscordMessage(incident.discordMessageId, [embed]);
  if (ok) {
    console.log(`[discord] ✏ Embed editado por comentario admin — incidente: ${incident.id}`);
  } else {
    console.warn(`[discord] ⚠ No se pudo editar embed para incidente: ${incident.id}`);
  }
}

function formatDuration(fromIso, toIso) {
  const ms = new Date(toIso) - new Date(fromIso);
  const m  = Math.floor(ms / 60_000);
  const h  = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

/* ═══════════════════════════════════════════
   TIEMPO (UTC-6)
═══════════════════════════════════════════ */

function getLocalDate() {
  const now = new Date();
  return new Date(now.getTime() + now.getTimezoneOffset() * 60_000 + TIMEZONE_OFFSET * 3_600_000);
}

function getCurrentHourKey() {
  const d = getLocalDate();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00:00`;
}

function getTodayKey() {
  const d = getLocalDate();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getDateFromHourKey(hourKey) { return hourKey.split("T")[0]; }
function pad(n) { return String(n).padStart(2, "0"); }

/* ═══════════════════════════════════════════
   UPTIME — sin redondeo, 3 decimales exactos
═══════════════════════════════════════════ */

function precise(value) {
  // Devuelve número con exactamente 3 decimales, sin redondeo adicional
  return Math.trunc(value * 1000) / 1000;
}

/* ═══════════════════════════════════════════
   STORAGE
═══════════════════════════════════════════ */

async function ensureStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(STATUS_FILE, "utf8");
    if (!raw.trim()) throw new Error("Empty");
    JSON.parse(raw);
  } catch {
    await fs.writeFile(STATUS_FILE, JSON.stringify({
      updatedAt: null, timezone: TIMEZONE_OFFSET, totalonline: 0,
      services: {}, announcements: [], incidents: [], sections: [],
    }, null, 2));
  }
}

async function loadStatus() {
  return JSON.parse(await fs.readFile(STATUS_FILE, "utf8"));
}

async function saveStatus(data) {
  const tmp = STATUS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, STATUS_FILE);
}

/* ═══════════════════════════════════════════
   PING – ver checkers.js (http, tcp, udp, ping, dns, keyword)
═══════════════════════════════════════════ */

/* ═══════════════════════════════════════════
   CICLO PRINCIPAL
═══════════════════════════════════════════ */

const nextCheckAt = {};
let lastConfigReloadAt = 0;
const CONFIG_RELOAD_INTERVAL_MS = 30_000;

async function runCheck(sections, forceAll = false) {
  // Antes de chequear servicios, verificar conectividad a internet
  const hasInternet = await checkInternet();
  if (!hasInternet) {
    // Sin internet → no hacer nada, esperar próximo ciclo
    return;
  }

  const store = await loadStatus();

  const SERVICES = sections.flatMap(s =>
    s.services.map(svc => ({ ...svc, sectionId: s.id }))
  );

  const activeIds = new Set(SERVICES.map(s => s.id));

  store.totalonline    ??= 0;
  store.services       ??= {};
  store.incidents      ??= [];
  store.announcements  ??= [];
  store.timezone         = TIMEZONE_OFFSET;

  for (const existingId of Object.keys(store.services)) {
    if (!activeIds.has(existingId)) {
      delete store.services[existingId];
      console.log(`[uptime] 🗑 Servicio eliminado de stats: ${existingId}`);
    }
  }

  const cutoff = new Date(Date.now() - 90 * 24 * 3600_000).toISOString();
  store.incidents = store.incidents.filter(i => !i.resolvedAt || i.resolvedAt > cutoff);

  const timestamp      = new Date().toISOString();
  const currentHourKey = getCurrentHourKey();
  const todayKey       = getTodayKey();
  const now            = Date.now();

  for (const service of SERVICES) {
    const intervalMs = (service.checkInterval ?? 60) * 1_000;
    const due        = nextCheckAt[service.id] ?? 0;

    if (!forceAll && now < due) {
      continue;
    }

    nextCheckAt[service.id] = now + intervalMs;

    /* ── Mantenimiento: si el servicio está en mantenimiento, omitir ping y registro ── */
    const nowIso = new Date().toISOString();
    const isUnderMaintenance = service.maintenance === true ||
      // Incidente con status "maintenance" abierto para este servicio
      (store.incidents ?? []).some(i =>
        i.serviceId === service.id &&
        i.status === "maintenance" &&
        !i.resolvedAt
      ) ||
      // Announcement de mantenimiento con serviceId directo o vía incidente vinculado
      (store.announcements ?? []).some(a => {
        if (a.type !== "maintenance") return false;
        if (a.endsAt && a.endsAt <= nowIso) return false;
        if (a.serviceId === service.id) return true;
        if (a.incidentId) {
          const inc = (store.incidents ?? []).find(i => i.id === a.incidentId && !i.resolvedAt);
          return inc?.serviceId === service.id;
        }
        return false;
      });

    if (isUnderMaintenance) {
      // Actualizar solo metadata del servicio, sin registrar checks ni abrir incidentes
      store.services[service.id] ??= {
        id: service.id, name: service.name, sectionId: service.sectionId,
        icon: service.icon ?? null, status: "maintenance",
        currentHour: null, hourlyHistory: [], dailyHistory: [],
      };
      const msvc = store.services[service.id];
      msvc.sectionId = service.sectionId;
      msvc.name      = service.name;
      msvc.status    = "maintenance";
      if (service.icon) msvc.icon = service.icon;
      console.log(`[uptime] 🔧 ${service.id} — En mantenimiento, omitiendo registro de check`);
      continue;
    }

    const result = await pingService(service);

    const isNew = !store.services[service.id];
    store.services[service.id] ??= {
      id:            service.id,
      name:          service.name,
      sectionId:     service.sectionId,
      icon:          service.icon ?? null,
      status:        "up",
      currentHour:   null,
      hourlyHistory: [],
      dailyHistory:  [{ date: todayKey, onlineper: 100 }],
    };

    const svc = store.services[service.id];

    svc.sectionId  = service.sectionId;
    svc.name       = service.name;
    svc.checkType  = service.checkType ?? "http";
    svc.keyword    = service.keyword ?? null;
    svc.keywordMode = service.keywordMode ?? "contains";
    svc.timeout    = service.timeout ?? null;
    if (service.icon) svc.icon = service.icon;

    // Modo debug por servicio: guarda la razón detallada del último check
    if (service.debug) {
      svc.lastDebug = {
        at: new Date().toISOString(),
        status: result.status,
        code: result.code,
        latency: result.latency,
        error: result.error ?? null,
        ...(result.debug ? { detail: result.debug } : {}),
      };
    } else if (svc.lastDebug) {
      delete svc.lastDebug;
    }

    if (service.debug) {
      console.log(`[debug] ${service.id} — status=${result.status} code=${result.code} error=${result.error ?? "-"} detail=${JSON.stringify(result.debug ?? {})}`);
    }

    /* ── Hora actual ── */
    if (!svc.currentHour || svc.currentHour.hour !== currentHourKey) {
      if (svc.currentHour) {
        const old     = svc.currentHour;
        const upCount = old.checks.filter(c => c.status === "up").length;
        const raw     = old.checks.length > 0 ? (upCount / old.checks.length) * 100 : 0;
        const onlineper = precise(raw);

        const lats = old.checks.map(c => c.latency).filter(l => l != null);
        const avgLatency = lats.length > 0
          ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length)
          : null;

        svc.hourlyHistory ??= [];
        svc.hourlyHistory.push({ hour: old.hour, onlineper, checks: old.checks.length, avgLatency });
        console.log(`[${service.id}] Hora ${old.hour} → ${onlineper}% uptime, ${avgLatency ?? "—"} ms`);
      }
      svc.currentHour = { hour: currentHourKey, startedAt: timestamp, checks: [] };
    }

    svc.currentHour.checks.push({ status: result.status, latency: result.latency, code: result.code, at: timestamp });
    svc.currentHour.checks  = svc.currentHour.checks.slice(-60);
    svc.hourlyHistory        = (svc.hourlyHistory ?? []).slice(-48);

    /* ── Historial diario ── */
    svc.dailyHistory ??= [];
    const hoursByDate = {};
    for (const h of svc.hourlyHistory) {
      const date = getDateFromHourKey(h.hour);
      (hoursByDate[date] ??= []).push(h);
    }

    for (const [date, hours] of Object.entries(hoursByDate)) {
      let dayEntry = svc.dailyHistory.find(d => d.date === date);
      if (!dayEntry) { dayEntry = { date, onlineper: 0 }; svc.dailyHistory.push(dayEntry); }
      const totalChecks = hours.reduce((s, h) => s + (h.checks || 0), 0);
      const weightedSum = hours.reduce((s, h) => s + h.onlineper * (h.checks || 0), 0);
      dayEntry.onlineper = totalChecks > 0 ? precise(weightedSum / totalChecks) : 0;
    }

    let todayEntry = svc.dailyHistory.find(d => d.date === todayKey);
    if (!todayEntry) {
      todayEntry = { date: todayKey, onlineper: isNew ? 100 : 0 };
      svc.dailyHistory.push(todayEntry);
    }

    if (!isNew) {
      const todayHours       = (svc.hourlyHistory ?? []).filter(h => getDateFromHourKey(h.hour) === todayKey);
      const curUpCount       = svc.currentHour.checks.filter(c => c.status === "up").length;
      const curTotal         = svc.currentHour.checks.length;
      const curPercent       = curTotal > 0 ? (curUpCount / curTotal) * 100 : 0;
      const todayTotalChecks = todayHours.reduce((s, h) => s + (h.checks || 0), 0) + curTotal;
      const todayWeightedSum = todayHours.reduce((s, h) => s + h.onlineper * (h.checks || 0), 0) + curPercent * curTotal;
      todayEntry.onlineper   = todayTotalChecks > 0 ? precise(todayWeightedSum / todayTotalChecks) : 0;
    }

    svc.dailyHistory = svc.dailyHistory
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(-30);

    /* ── Estado actual ── */
    const prevStatus = svc.status;
    const recent     = svc.currentHour.checks.slice(-10);
    const ups        = recent.filter(c => c.status === "up").length;
    const newStatus  = isNew ? "up" : (ups > recent.length / 2 ? "up" : "down");

    const latencies  = recent.filter(c => c.latency != null).map(c => c.latency);
    const avgLatency = latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : result.latency;

    svc.status    = newStatus;
    svc.latency   = avgLatency;
    svc.code      = result.code;
    svc.checkedAt = timestamp;
    svc.onlineper = todayEntry.onlineper;
    svc.history   = svc.dailyHistory.map(d => ({ date: d.date, onlineper: d.onlineper }));

    svc.latencySparkline = svc.hourlyHistory.slice(-24).map(h => ({
      hour: h.hour, avgLatency: h.avgLatency ?? null,
    }));

    const hasOpenIncident  = store.incidents?.find(i => i.serviceId === service.id && !i.resolvedAt);
    const inMonitoring     = hasOpenIncident?.status === "monitoring";
    const inMaintenance    = hasOpenIncident?.status === "maintenance";

    if (!isNew && prevStatus) {
      if (result.status === "down") {
        if (!hasOpenIncident) {
          // handleServiceDown hace checks confirmatorios internamente (2 × 5s)
          const opened = await handleServiceDown(store, service);
          if (opened === false) {
            // Falso positivo — corregir el check ya registrado a "up"
            const last = svc.currentHour.checks[svc.currentHour.checks.length - 1];
            if (last && last.status === "down") last.status = "up";
          }
        } else if (inMonitoring) {
          const inc = store.incidents.find(i => i.serviceId === service.id && !i.resolvedAt);
          if (inc && (inc.stableCount ?? 0) > 0) {
            inc.stableCount = 0;
            console.log(`[incidentes] 🔴 ${service.id} — Volvió a caer en monitoring, reiniciando conteo`);
          }
        }
        // Si inMaintenance: ignorar caída, el mantenimiento ya cubre el estado
      } else {
        if (hasOpenIncident && !inMonitoring && !inMaintenance) {
          await handleServiceRecovered(store, service);
        } else if (inMonitoring) {
          await handleStableCheck(store, service);
        }
        // Si inMaintenance: ignorar recuperación, el incidente lo cierra el admin manualmente
      }
    }
  }

  store.updatedAt = timestamp;
  let totalSum = 0, totalCount = 0;
  for (const svc of Object.values(store.services)) {
    if (activeIds.has(svc.id)) {
      totalSum += svc.onlineper ?? 100;
      totalCount++;
    }
  }
  store.totalonline = totalCount > 0 ? precise(totalSum / totalCount) : 0;
  store.sections    = sections.map(s => ({ id: s.id, name: s.name }));

  await saveStatus(store);
  console.log(`[uptime] ✓ Check completado — Total online: ${store.totalonline}%`);
}

/* ═══════════════════════════════════════════
   BOOT
═══════════════════════════════════════════ */

(async function start() {
  await loadEnv();

  const sections = await loadSections();
  const now      = getLocalDate();
  const tzStr    = TIMEZONE_OFFSET >= 0 ? `UTC+${TIMEZONE_OFFSET}` : `UTC${TIMEZONE_OFFSET}`;

  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║      NEXORA UPTIME MONITOR v5.2 – CONFIRM CHECKS + INTERVALS    ║");
  console.log("╠══════════════════════════════════════════════════════════════════╣");
  console.log(`║  • Base interval:   cada 1 minuto (por servicio configurable)   ║`);
  console.log(`║  • Confirm checks:  2 pings × 5s antes de abrir incidente       ║`);
  console.log(`║  • Zona horaria:    ${tzStr.padEnd(47)}║`);
  console.log(`║  • Hora local:      ${now.toISOString().replace("T"," ").substring(0,19).padEnd(47)}║`);
  console.log(`║  • Config:          data/services.json                          ║`);
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  await ensureStorage();

  // Verificar conexión al bot de Discord al inicio
  await verifyBotConnection();

  let lastCheckAt = 0;
  let currentSections = await loadSections();

  while (true) {
    await sleep(5_000);

    let forceAll = false;

    try {
      await fs.access(FORCE_CHECK_FILE);
      await fs.unlink(FORCE_CHECK_FILE);
      forceAll = true;
      console.log("[uptime] ⚡ Force check solicitado — ejecutando ahora");
    } catch {
      // archivo no existe, normal
    }

    let forceConfigReload = false;
    try {
      await fs.access(FORCE_CONFIG_RELOAD_FILE);
      await fs.unlink(FORCE_CONFIG_RELOAD_FILE);
      forceConfigReload = true;
      console.log("[uptime] ⚙ Config reload solicitado — recargando servicios");
    } catch {}

    const nowMs = Date.now();
    if (forceConfigReload || (nowMs - lastConfigReloadAt) >= CONFIG_RELOAD_INTERVAL_MS) {
      const newSections = await loadSections();
      currentSections = newSections.length > 0 ? newSections : currentSections;
      lastConfigReloadAt = nowMs;
      if (forceConfigReload) console.log("[uptime] ✓ Config recargada correctamente");
    }

    const shouldRunNormal = (nowMs - lastCheckAt) >= BASE_INTERVAL_MS;

    if (!forceAll && !shouldRunNormal) continue;

    lastCheckAt = nowMs;

    try {
      await runCheck(currentSections, forceAll);
    } catch (err) {
      console.error("[uptime] ✗ Error en ciclo:", err);
    }
  }
})();

/* ═══════════════════════════════════════════
   MANEJO DE ERRORES GLOBALES
═══════════════════════════════════════════ */

process.on("uncaughtException", err => {
  console.error("[Detector] uncaughtException:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[Detector] unhandledRejection:", reason);
});