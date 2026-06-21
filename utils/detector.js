/**
 * Uptime Monitor – Nexora v5.2
 * ─────────────────────────────────────────
 *  • Per-service check intervals (checkInterval)
 *  • Types: http, tcp, keyword
 *  • Cloudflare bypass detection
 *  • 100% uptime for new services
 *  • Cleans stats from removed services
 *  • Discord bot notification
 *  • Fixed timezone: UTC-6
 *  • If cloudflare-dns and google-dns fail → no internet → ignore downtime
 *  • Delay between embeds when multiple services go down at once
 *  • Embeds updated when admin adds comment
 *  • Config reload on demand via FORCE_CONFIG_RELOAD file
 */

import fs from "fs/promises";
import path from "path";
import net from "net";
import { setTimeout as sleep } from "timers/promises";
import { info, success, error, warn } from "./console.js";

/* ═══════════════════════════════════════════
   BASE CONFIG
═══════════════════════════════════════════ */

const BASE_INTERVAL_MS  = 60_000;
const TIMEOUT_MS        = 10_000;
const TIMEZONE_OFFSET   = -6;
const FORCE_CHECK_FILE  = path.resolve(process.cwd(), "data", "force_check");
const FORCE_CONFIG_RELOAD_FILE = path.resolve(process.cwd(), "data", "force_config_reload");
const EMBED_DELAY_MS    = 1_500; // delay between embeds when multiple services go down

const DATA_DIR      = path.resolve(process.cwd(), "data");
const STATUS_FILE   = path.join(DATA_DIR, "status.json");
const SERVICES_FILE = path.join(DATA_DIR, "services.json");

// DNS servers to check for internet connectivity
const INTERNET_CHECK_HOSTS = [
  { host: "1.1.1.1",   port: 53, name: "Cloudflare DNS" },
  { host: "8.8.8.8",   port: 53, name: "Google DNS" },
];

/* ═══════════════════════════════════════════
   ENV (.env loaded manually if exists)
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
    // .env does not exist, using system environment variables
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
      warn(`[discord] ${method} ${dpath} → ${res.status}: ${err}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    warn("[discord] Network error:", e.message);
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

/** Verify bot connection by sending a request to /users/@me */
async function verifyBotConnection() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    warn("[discord] ⚠ DISCORD_BOT_TOKEN not configured — notifications disabled");
    return false;
  }
  const data = await discordRequest("GET", "/users/@me", null);
  if (data && data.username) {
    success(`[discord] ✅ Bot connected: ${data.username}#${data.discriminator ?? "0"} (ID: ${data.id})`);
    return true;
  }
  warn("[discord] ⚠ Could not verify bot connection (invalid token or missing permissions)");
  return false;
}

/* ═══════════════════════════════════════════
   SERVER INTERNET CONNECTIVITY CHECK
═══════════════════════════════════════════ */

async function checkInternet() {
  const results = await Promise.all(
    INTERNET_CHECK_HOSTS.map(({ host, port }) =>
      tcpPing(host, port).then(r => r.status === "up")
    )
  );
  // If ALL DNS checks fail → no internet
  const hasInternet = results.some(ok => ok);
  if (!hasInternet) {
    warn("[internet] ⚠ All reference DNS servers not responding — assuming server internet loss. Services will not be marked as down.");
  }
  return hasInternet;
}

/* ═══════════════════════════════════════════
   INCIDENT MANAGEMENT
═══════════════════════════════════════════ */

// Number of stable checks required to confirm resolution
const STABLE_CHECKS_REQUIRED = 5;
// Confirmatory checks in same cycle before opening incident
// Flow: initial failure → wait 5s → check 1 → wait 5s → check 2 → if both DOWN → downtime confirmed
const DOWN_CONFIRM_CHECKS  = 2;
const DOWN_CONFIRM_DELAY   = 5_000; // ms between each confirmatory check

// Queue of pending embeds to avoid flood (delay between each one)
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
    title: `🔴 Downtime detected — ${service.name}`,
    description: `Service **${service.name}** is not responding.\nInvestigating the issue.`,
    color: 0xef4444,
    timestamp: now,
    footer: { text: `Nexora Status • ID: ${incidentId}` },
    fields: [
      { name: "Service", value: service.name,      inline: true },
      { name: "Status",   value: "🔍 Investigating", inline: true },
    ],
  };
}

function buildMonitoringEmbed(service, incident, now, extraFields = []) {
  return {
    title: `🟡 Monitoring — ${service.name}`,
    description: `Service **${service.name}** is responding again.\nVerifying stability before marking as resolved.`,
    color: 0xf59e0b,
    timestamp: now,
    footer: { text: `Nexora Status • ID: ${incident.id}` },
    fields: [
      { name: "Service", value: service.name,      inline: true },
      { name: "Status",   value: "🟡 Monitoring", inline: true },
      { name: "Duration", value: formatDuration(incident.createdAt, now), inline: false },
      ...extraFields,
    ],
  };
}

function buildResolvedEmbed(service, incident, now) {
  return {
    title: `🟢 Resolved — ${service.name}`,
    description: `Service **${service.name}** has been confirmed as stable and operational.`,
    color: 0x22c55e,
    timestamp: now,
    footer: { text: `Nexora Status • ID: ${incident.id}` },
    fields: [
      { name: "Service",      value: service.name,                          inline: true },
      { name: "Status",       value: "✅ Operational",                      inline: true },
      { name: "Affected time", value: formatDuration(incident.createdAt, now), inline: false },
    ],
  };
}

function buildUpdateEmbed(service, incident, update) {
  const statusLabels = {
    investigating: "🔍 Investigating",
    identified:    "🔎 Identified",
    monitoring:    "🟡 Monitoring",
    resolved:      "✅ Resolved",
    maintenance:   "🔧 Maintenance",
  };
  const colors = {
    investigating: 0xef4444,
    identified:    0xf97316,
    monitoring:    0xf59e0b,
    resolved:      0x22c55e,
    maintenance:   0x3b82f6,
  };

  const fields = [
    { name: "Service", value: service?.name ?? incident.serviceName ?? "—", inline: true },
    { name: "Status",   value: statusLabels[update.status] ?? update.status,  inline: true },
  ];

  if (incident.updates?.length > 1) {
    fields.push({ name: "Duration", value: formatDuration(incident.createdAt, update.at), inline: false });
  }

  return {
    title: `📋 Update — ${incident.title}`,
    description: update.message || "No message.",
    color: colors[update.status] ?? 0x6b7280,
    timestamp: update.at,
    footer: { text: `Nexora Status • ID: ${incident.id}` },
    fields,
  };
}

/**
 * Performs DOWN_CONFIRM_CHECKS additional checks with DOWN_CONFIRM_DELAY ms separation
 * to confirm that the service is really down before opening an incident.
 * Returns true if all confirmatory checks are also DOWN.
 */
async function confirmDown(service) {
  for (let i = 1; i <= DOWN_CONFIRM_CHECKS; i++) {
    await sleep(DOWN_CONFIRM_DELAY);
    const result = await pingService(service);
    info(`[incidents] 🔎 ${service.id} — Confirmatory check ${i}/${DOWN_CONFIRM_CHECKS}: ${result.status}`);
    if (result.status === "up") {
      success(`[incidents] ✅ ${service.id} — False positive discarded at confirmatory check ${i}`);
      return false;
    }
  }
  return true;
}

async function handleServiceDown(store, service) {
  store.incidents    ??= [];
  store.announcements ??= [];

  if (store.incidents.find(i => i.serviceId === service.id && !i.resolvedAt)) return;

  // ── Confirmatory checks: 2 additional pings with 5s separation ──
  // If any responds UP → false positive, do not open incident.
  info(`[incidents] ⚠ ${service.id} — Downtime detected. Running ${DOWN_CONFIRM_CHECKS} confirmatory checks (each ${DOWN_CONFIRM_DELAY / 1000}s)…`);
  const confirmed = await confirmDown(service);
  if (!confirmed) return false; // false positive — service came back in confirmatory checks
  success(`[incidents] 🔴 ${service.id} — Downtime confirmed after ${DOWN_CONFIRM_CHECKS} checks. Opening incident.`);

  const now        = new Date().toISOString();
  const incidentId = `inc-${Date.now()}`;

  const incident = {
    id: incidentId, serviceId: service.id, serviceName: service.name,
    title: `Interruption — ${service.name}`, status: "investigating",
    automatic: true, createdAt: now, resolvedAt: null, discordMessageId: null,
    updates: [{ at: now, status: "investigating", message: "Downtime detected automatically. Investigating." }],
  };

  store.incidents.push(incident);
  store.announcements.push({
    id: `ann-${incidentId}`, type: "incident", title: incident.title,
    body: "We are investigating the issue. Updates will be published shortly.",
    incidentId, createdAt: now, endsAt: null,
  });

  const embed = buildDownEmbed(service, incidentId, now);

  queueEmbed(async () => {
    const msgId = await sendDiscordMessage([embed]);
    if (msgId) {
      incident.discordMessageId = msgId;
      // Persist messageId in JSON immediately
      try {
        const fresh = JSON.parse(await fs.readFile(STATUS_FILE, "utf8"));
        const inc = fresh.incidents?.find(i => i.id === incidentId);
        if (inc) { inc.discordMessageId = msgId; await saveStatus(fresh); }
      } catch {}
      info(`[discord] 📨 Embed sent for ${service.id} (msg: ${msgId})`);
    } else {
      warn(`[discord] ⚠ Could not send embed for ${service.id}`);
    }
  });

  success(`[incidents] 🔴 ${service.id} — Incident created: ${incidentId}`);
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
    message: `Service responding again. Monitoring stability (${STABLE_CHECKS_REQUIRED} confirmatory checks).`,
  });

  const embed = buildMonitoringEmbed(service, incident, now);
  queueEmbed(async () => {
    await editDiscordMessage(incident.discordMessageId, [embed]);
  });

  info(`[incidents] 🟡 ${service.id} — Monitoring stability: ${incident.id}`);
}

async function handleStableCheck(store, service) {
  store.incidents ??= [];
  const incident = store.incidents.find(i => i.serviceId === service.id && !i.resolvedAt && i.status === "monitoring");
  if (!incident) return;

  incident.stableCount = (incident.stableCount ?? 0) + 1;
  const count = incident.stableCount;
  info(`[incidents] 🟡 ${service.id} — Stable check ${count}/${STABLE_CHECKS_REQUIRED}`);

  if (count >= STABLE_CHECKS_REQUIRED) {
    const now = new Date().toISOString();
    incident.resolvedAt = now;
    incident.status     = "resolved";
    incident.updates.push({ at: now, status: "resolved", message: "Stability confirmed. Incident automatically resolved." });

    store.announcements = (store.announcements ?? []).filter(a => a.incidentId !== incident.id);

    const embed = buildResolvedEmbed(service, incident, now);
    queueEmbed(async () => {
      await editDiscordMessage(incident.discordMessageId, [embed]);
    });

    success(`[incidents] 🟢 ${service.id} — Resolved after ${STABLE_CHECKS_REQUIRED} stable checks: ${incident.id}`);
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
 * Called by server.js when an admin adds a comment to an incident.
 * Edits the existing Discord embed.
 */
export async function notifyIncidentUpdate(incident, update, serviceName) {
  if (!incident.discordMessageId) return;
  const embed = buildUpdateEmbed({ name: serviceName ?? incident.serviceName }, incident, update);
  const ok = await editDiscordMessage(incident.discordMessageId, [embed]);
  if (ok) {
    info(`[discord] ✏ Embed edited by admin comment — incident: ${incident.id}`);
  } else {
    warn(`[discord] ⚠ Could not edit embed for incident: ${incident.id}`);
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
   TIMEZONE (UTC-6)
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
   UPTIME — no rounding, exactly 3 decimals
═══════════════════════════════════════════ */

function precise(value) {
  // Returns number with exactly 3 decimals, no additional rounding
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
   KEYWORD DETECTION
═══════════════════════════════════════════ */

/**
 * Check if a keyword pattern matches the response body.
 * Supports multiple search modes:
 *  - "contains": simple substring search (case-insensitive)
 *  - "exact": exact match (case-sensitive)
 *  - "regex": JavaScript regex pattern
 *  - "json": JSON path search (if response is valid JSON)
 * 
 * Default mode: "contains"
 */
function matchesKeyword(responseBody, keyword, mode = "contains") {
  if (!keyword || !responseBody) return false;

  const bodyStr = String(responseBody).trim();

  switch (mode) {
    case "exact":
      return bodyStr === keyword;

    case "regex":
      try {
        const regex = new RegExp(keyword, "i");
        return regex.test(bodyStr);
      } catch {
        warn(`[keyword] Invalid regex pattern: ${keyword}`);
        return false;
      }

    case "json":
      try {
        const json = JSON.parse(bodyStr);
        // Simple JSON path search: look for the keyword in stringified JSON
        return JSON.stringify(json).includes(keyword);
      } catch {
        // Not valid JSON, fall back to contains
        return bodyStr.toLowerCase().includes(keyword.toLowerCase());
      }

    case "contains":
    default:
      return bodyStr.toLowerCase().includes(keyword.toLowerCase());
  }
}

/* ═══════════════════════════════════════════
   PING – supports http, tcp, keyword
═══════════════════════════════════════════ */

const CLOUDFLARE_INDICATORS = [
  "cloudflare", "cf-ray", "attention required", "one moment", "just a moment",
  "checking your browser", "ddos protection", "security check",
];

function isCloudflareBlock(bodyText, headers) {
  const cfRay = headers?.get?.("cf-ray");
  if (cfRay) return true;
  const server = headers?.get?.("server") ?? "";
  if (server.toLowerCase().includes("cloudflare")) return true;
  if (!bodyText) return false;
  const lower = bodyText.toLowerCase();
  return CLOUDFLARE_INDICATORS.some(kw => lower.includes(kw));
}

async function pingService(service) {
  const checkType = service.checkType ?? "http";

  if (checkType === "tcp") {
    const urlPart = service.url.replace(/^tcp:\/\//, "");
    const [host, port] = urlPart.split(":");
    if (!host || !port) return { status: "down", code: 0, latency: null, error: "invalid_address" };
    return tcpPing(host, Number(port));
  }

  if (service.url.startsWith("http://") || service.url.startsWith("https://")) {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), service.timeout ?? TIMEOUT_MS);
    const start      = Date.now();
    try {
      const method = checkType === "keyword" ? "GET" : (service.method ?? "HEAD");
      const res = await fetch(service.url, {
        method,
        headers: service.headers ?? {},
        signal: controller.signal,
      });
      const latency = Date.now() - start;

      if (checkType === "keyword" && service.keyword) {
        const body = await res.text();
        const keywordMode = service.keywordMode ?? "contains";
        const found = matchesKeyword(body, service.keyword, keywordMode);
        return { status: found ? "up" : "down", code: res.status, latency, error: found ? null : "keyword_not_found" };
      }

      if (!res.ok) {
        if (method === "GET") {
          try {
            const body = await res.text();
            if (isCloudflareBlock(body, res.headers)) {
              return { status: "up", code: res.status, latency, error: "cloudflare_bypass" };
            }
          } catch {}
        } else if (method === "HEAD") {
          if (isCloudflareBlock(null, res.headers)) {
            return { status: "up", code: res.status, latency, error: "cloudflare_bypass" };
          }
        }
        return { status: "down", code: res.status, latency };
      }

      if (method === "GET") {
        const body = await res.text();
        if (isCloudflareBlock(body, res.headers)) {
          return { status: "up", code: res.status, latency, error: "cloudflare_bypass" };
        }
      }

      return { status: "up", code: res.status, latency };
    } catch (err) {
      return { status: "down", code: 0, latency: null, error: err.name === "AbortError" ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  const [host, port] = service.url.split(":");
  if (!host || !port) return { status: "down", code: 0, latency: null, error: "invalid_address" };
  return tcpPing(host, Number(port));
}

function tcpPing(host, port) {
  return new Promise(resolve => {
    const start  = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(TIMEOUT_MS);
    socket.once("connect", () => { socket.destroy(); resolve({ status: "up",   code: 1, latency: Date.now() - start }); });
    socket.once("timeout", () => { socket.destroy(); resolve({ status: "down", code: 0, latency: null, error: "timeout" }); });
    socket.once("error",   () => { socket.destroy(); resolve({ status: "down", code: 0, latency: null, error: "connection" }); });
    socket.connect(port, host);
  });
}

/* ═══════════════════════════════════════════
   MAIN LOOP
═══════════════════════════════════════════ */

const nextCheckAt = {};
let lastConfigReloadAt = 0;
const CONFIG_RELOAD_INTERVAL_MS = 30_000; // Check for config reload request every 30s

async function runCheck(sections, forceAll = false) {
  // Before checking services, verify server internet connectivity
  const hasInternet = await checkInternet();
  if (!hasInternet) {
    // No internet → do nothing, wait for next cycle
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
      info(`[uptime] 🗑 Service removed from stats: ${existingId}`);
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

    /* ── Maintenance: if service is under maintenance, skip ping and logging ── */
    const nowIso = new Date().toISOString();
    const isUnderMaintenance = service.maintenance === true ||
      // Open incident with "maintenance" status for this service
      (store.incidents ?? []).some(i =>
        i.serviceId === service.id &&
        i.status === "maintenance" &&
        !i.resolvedAt
      ) ||
      // Maintenance announcement linked to service or incident
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
      // Update only service metadata, without recording checks or opening incidents
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
      info(`[uptime] 🔧 ${service.id} — Under maintenance, skipping check logging`);
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

    /* ── Current hour ── */
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
        info(`[${service.id}] Hour ${old.hour} → ${onlineper}% uptime, ${avgLatency ?? "—"} ms`);
      }
      svc.currentHour = { hour: currentHourKey, startedAt: timestamp, checks: [] };
    }

    svc.currentHour.checks.push({ status: result.status, latency: result.latency, code: result.code, at: timestamp });
    svc.currentHour.checks  = svc.currentHour.checks.slice(-60);
    svc.hourlyHistory        = (svc.hourlyHistory ?? []).slice(-48);

    /* ── Daily history ── */
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

    /* ── Current status ── */
    const prevStatus = svc.status;
    const recent     = svc.currentHour.checks.slice(-10);
    const ups        = recent.filter(c => c.status === "up").length;
    const newStatus  = isNew ? "up" : result.status;

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
          // handleServiceDown performs confirmatory checks internally (2 × 5s)
          const opened = await handleServiceDown(store, service);
          if (opened === false) {
            // False positive — correct the already-recorded check to "up" and revert status
            const last = svc.currentHour.checks[svc.currentHour.checks.length - 1];
            if (last && last.status === "down") last.status = "up";
            svc.status = prevStatus ?? "up";
          }
        } else if (inMonitoring) {
          const inc = store.incidents.find(i => i.serviceId === service.id && !i.resolvedAt);
          if (inc && (inc.stableCount ?? 0) > 0) {
            inc.stableCount = 0;
            success(`[incidents] 🔴 ${service.id} — Fell back down in monitoring, restarting count`);
          }
        }
        // If inMaintenance: ignore downtime, maintenance already covers status
      } else {
        if (hasOpenIncident && !inMonitoring && !inMaintenance) {
          await handleServiceRecovered(store, service);
        } else if (inMonitoring) {
          await handleStableCheck(store, service);
        }
        // If inMaintenance: ignore recovery, admin closes incident manually
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
  success(`[uptime] ✓ Check completed — Total online: ${store.totalonline}%`);
}

/* ═══════════════════════════════════════════
   BOOT
═══════════════════════════════════════════ */

(async function start() {
  await loadEnv();

  const now      = getLocalDate();
  const tzStr    = TIMEZONE_OFFSET >= 0 ? `UTC+${TIMEZONE_OFFSET}` : `UTC${TIMEZONE_OFFSET}`;

  info("╔══════════════════════════════════════════════════════════════════╗");
  info("║   NEXORA UPTIME MONITOR v5.3 – CONFIRM CHECKS + CONFIG RELOAD   ║");
  info("╠══════════════════════════════════════════════════════════════════╣");
  info(`║  • Base interval:     every 1 minute (per-service configurable) ║`);
  info(`║  • Confirm checks:    2 pings × 5s before opening incident      ║`);
  info(`║  • Config reload:     every 30s (FORCE_CONFIG_RELOAD file)     ║`);
  info(`║  • Keyword detection: contains, exact, regex, json modes      ║`);
  info(`║  • Timezone:          ${tzStr.padEnd(45)}║`);
  info(`║  • Local time:        ${now.toISOString().replace("T"," ").substring(0,19).padEnd(45)}║`);
  info(`║  • Config file:       data/services.json                       ║`);
  info("╚══════════════════════════════════════════════════════════════════╝\n");

  await ensureStorage();

  // Verify Discord bot connection at startup
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
      info("[uptime] ⚡ Force check requested — executing now");
    } catch {
      // File does not exist, normal
    }

    // Check if config reload was requested
    let forceConfigReload = false;
    try {
      await fs.access(FORCE_CONFIG_RELOAD_FILE);
      await fs.unlink(FORCE_CONFIG_RELOAD_FILE);
      forceConfigReload = true;
      info("[uptime] ⚙ Config reload requested — reloading services");
    } catch {
      // File does not exist, normal
    }

    // Reload config if forced or if interval elapsed
    const nowMs = Date.now();
    if (forceConfigReload || (nowMs - lastConfigReloadAt) >= CONFIG_RELOAD_INTERVAL_MS) {
      const newSections = await loadSections();
      currentSections = newSections.length > 0 ? newSections : currentSections;
      lastConfigReloadAt = nowMs;
      if (forceConfigReload) {
        info("[uptime] ✓ Config reloaded successfully");
      }
    }

    const shouldRunNormal = (nowMs - lastCheckAt) >= BASE_INTERVAL_MS;

    if (!forceAll && !shouldRunNormal) continue;

    lastCheckAt = nowMs;

    try {
      await runCheck(currentSections, forceAll);
    } catch (err) {
      error("[uptime] ✗ Cycle error:", err);
    }
  }
})();

/* ═══════════════════════════════════════════
   GLOBAL ERROR HANDLING
═══════════════════════════════════════════ */

process.on("uncaughtException", err => {
  error("[Detector] uncaughtException:", err);
});

process.on("unhandledRejection", (reason) => {
  error("[Detector] unhandledRejection:", reason);
});