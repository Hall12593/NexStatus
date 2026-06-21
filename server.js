import express  from "express";
import path      from "path";
import { fileURLToPath } from "url";
import fs        from "fs/promises";
import fsSync    from "fs";
import { spawn } from "child_process";
import cors      from "cors";
import crypto    from "crypto";
import dotenv   from "dotenv";
import { info, success, error, warn } from "./utils/console.js";

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3015;
const IS_PROD = process.env.NODE_ENV === "production";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DATA_DIR              = path.join(__dirname, "data");
const STATUS_FILE           = path.join(DATA_DIR, "status.json");
const SERVICES_FILE         = path.join(DATA_DIR, "services.json");
const FORCE_CHECK_FILE      = path.join(DATA_DIR, "force_check");
const FORCE_CONFIG_RELOAD_FILE = path.join(DATA_DIR, "force_config_reload");
const APPEARANCE_FILE       = path.join(DATA_DIR, "appearance.json");
const ENV_FILE              = path.join(__dirname, ".env");

/* ═══════════════════════════════════════════
   LOAD .env
═══════════════════════════════════════════ */

async function loadEnv() {
  try {
    const raw = await fs.readFile(ENV_FILE, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) process.env[key] = val;
    }
    info("[Server] .env loaded successfully");
  } catch {
    info("[Server] No .env file — using system environment variables");
  }
}

async function writeEnv(updates) {
  let content = "";
  try {
    content = await fs.readFile(ENV_FILE, "utf8");
  } catch { /* no existe aún */ }

  // Parsear .env actual
  const lines = content.split("\n");
  const existing = new Map();
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    existing.set(key, i);
  });

  // Actualizar o añadir claves
  for (const [key, val] of Object.entries(updates)) {
    if (val === undefined || val === null) continue;
    const safeVal = String(val).includes(" ") ? `"${val}"` : val;
    const newLine = `${key}=${safeVal}`;
    if (existing.has(key)) {
      lines[existing.get(key)] = newLine;
    } else {
      lines.push(newLine);
    }
    // Actualizar en proceso también
    process.env[key] = String(val);
  }

  const tmp = ENV_FILE + ".tmp";
  await fs.writeFile(tmp, lines.filter((l, i) => i === 0 || l.trim() !== "" || lines[i - 1]?.trim() !== "").join("\n") + "\n");
  await fs.rename(tmp, ENV_FILE);
}

/* ═══════════════════════════════════════════
   APPEARANCE CONFIG
═══════════════════════════════════════════ */

const DEFAULT_APPEARANCE = {
  siteTitle:            "Estado del sistema",
  logoUrl:              "",
  faviconUrl:           "",
  backgroundType:       "image",
  backgroundImageUrl:   "",
  backgroundSolidColor: "#071025",
  footerText:           "",
  fontFamily:           "Inter",
  accentColor:          "",
};

async function readAppearance() {
  try { return { ...DEFAULT_APPEARANCE, ...await readJson(APPEARANCE_FILE) }; }
  catch { return { ...DEFAULT_APPEARANCE }; }
}

/* ═══════════════════════════════════════════
   SECURITY HEADERS
═══════════════════════════════════════════ */

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options",  "nosniff");
  res.setHeader("X-Frame-Options",         "SAMEORIGIN");
  res.setHeader("Referrer-Policy",         "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy",      "geolocation=(), microphone=(), camera=()");
  if (IS_PROD) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; " +
    "img-src 'self' https: data: blob:; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none';"
  );
  next();
});

/* ═══════════════════════════════════════════
   RATE LIMITING
═══════════════════════════════════════════ */

function makeRateLimiter(maxRequests, windowMs) {
  const clients = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, data] of clients) {
      if (data.resetAt < cutoff) clients.delete(ip);
    }
  }, 60_000).unref();

  return (req, res, next) => {
    const trustProxy = process.env.TRUST_PROXY === "1";
    const ip = (trustProxy && req.headers["x-forwarded-for"])
      ? req.headers["x-forwarded-for"].split(",")[0].trim()
      : req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    let data = clients.get(ip);
    if (!data || now > data.resetAt) { data = { count: 0, resetAt: now + windowMs }; clients.set(ip, data); }
    data.count++;
    if (data.count > maxRequests) {
      res.setHeader("Retry-After", Math.ceil((data.resetAt - now) / 1000));
      return res.status(429).json({ error: "Demasiadas solicitudes. Intenta más tarde." });
    }
    next();
  };
}

const publicLimiter = makeRateLimiter(120, 60_000);
const adminLimiter  = makeRateLimiter(20,  60_000);
const authLimiter   = makeRateLimiter(5,   60_000);

/* ═══════════════════════════════════════════
   MIDDLEWARE
═══════════════════════════════════════════ */

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
  : null;

if (IS_PROD && !allowedOrigins) {
  warn("[Server] ⚠ ALLOWED_ORIGINS no configurado — CORS acepta cualquier origen. Configura ALLOWED_ORIGINS en .env para producción.");
}

app.use(cors({
  origin: allowedOrigins
    ? (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error("CORS: origen no permitido"));
      }
    : true,
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "x-admin-token"],
}));

app.use(express.json({ limit: "64kb" }));

/* ═══════════════════════════════════════════
   DETECTOR (proceso hijo)
═══════════════════════════════════════════ */

let detector;

try {
  detector = spawn("node", [path.join(__dirname, "utils", "detector.js")], {
    stdio: "inherit",
    env: { ...process.env },
  });
  detector.on("exit", (code, signal) => {
    info(`[Uptime Detector] Proceso terminado (code=${code}, signal=${signal})`);
  });
  info("[Uptime Detector] Started in background");
} catch (err) {
  error("[Uptime Detector] Error starting:", err);
}

/* ═══════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════ */

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeJson(file, data) {
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

function getAdminToken() {
  return process.env.ADMIN_TOKEN ?? null;
}

/* ═══════════════════════════════════════════
   DISCORD — estado del bot en memoria
═══════════════════════════════════════════ */

const botState = { verified: false, username: null, lastCheck: null };

async function verifyBotToken(token) {
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { "Authorization": `Bot ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      botState.verified  = true;
      botState.username  = data.username;
      botState.lastCheck = new Date().toISOString();
      return { ok: true, username: data.username };
    }
    botState.verified = false;
    return { ok: false, status: res.status };
  } catch (e) {
    botState.verified = false;
    return { ok: false, error: e.message };
  }
}

let _statusMessageId = process.env.DISCORD_STATUS_MESSAGE_ID ?? null;

async function sendStatusEmbed() {
  if (!botState.verified) return;
  const token     = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_STATUS_CHANNEL_ID;
  if (!token || !channelId) return;

  try {
    const [statusData, appearance] = await Promise.all([readJson(STATUS_FILE), readAppearance()]);
    // Get service filter with order preserved
    const serviceOrderStr = (process.env.DISCORD_STATUS_SERVICES ?? "").split(",").map(s => s.trim()).filter(Boolean);
    
    // If no specific order is set, use all services in their natural order
    const allServicesObj = Object.values(statusData.services ?? {});
    const allServices = serviceOrderStr.length === 0 
      ? allServicesObj
      : serviceOrderStr
          .map(svcId => allServicesObj.find(s => s.id === svcId))
          .filter(s => s != null); // Remove nulls from non-existent services

    const allUp    = allServices.length > 0 && allServices.every(s => s.status === "up");
    const someDown = allServices.some(s => s.status === "down");
    const globalUp = statusData.totalonline != null
      ? Number(statusData.totalonline).toFixed(2)
      : (allServices.length > 0
          ? (allServices.reduce((s, v) => s + (v.onlineper ?? 100), 0) / allServices.length).toFixed(2)
          : "100.00");
    const color     = someDown ? 0xef4444 : (allUp ? 0x22c55e : 0xf59e0b);
    const statusStr = someDown ? "⚠️ Degradado" : (allUp ? "✅ Operacional" : "🔄 Parcial");
    const siteTitle  = appearance.siteTitle?.trim() || "del sistema";
    const embedTitle = `📡 Estado de ${siteTitle}`;

    const fields = allServices.map(svc => {
      const icon   = svc.status === "up" ? "🟢" : "🔴";
      const uptime = typeof svc.onlineper === "number" ? `${svc.onlineper.toFixed(2)}%` : "—";
      const lat    = svc.latency != null ? `${svc.latency}ms` : "—";
      return { name: `${icon} ${svc.name}`, value: `📈 Uptime: \`${uptime}\`\n⚡ Latencia: \`${lat}\``, inline: true };
    });

    const chunks = [];
    for (let i = 0; i < fields.length; i += 9) chunks.push(fields.slice(i, i + 9));
    if (chunks.length === 0) chunks.push([]);

    const embeds = chunks.map((chunk, idx) => ({
      title:       idx === 0 ? embedTitle : undefined,
      description: idx === 0 ? `**Uptime Global:** \`${globalUp}%\`\n**Estado:** ${statusStr}\n**Actualización:** <t:${Math.floor(Date.now() / 1000)}:R>` : undefined,
      color,
      timestamp:   idx === 0 ? new Date().toISOString() : undefined,
      fields:      chunk,
    }));

    // Intentar editar mensaje existente
    if (_statusMessageId) {
      const editRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${_statusMessageId}`, {
        method: "PATCH",
        headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ embeds }),
      });
      if (editRes.ok) {
        info("[discord] 📡 Embed de estado actualizado");
        return;
      }
      // Mensaje no existe o no se puede editar — crear nuevo
      warn(`[discord] No se pudo editar mensaje (${editRes.status}), creando nuevo`);
      _statusMessageId = null;
    }

    // Crear mensaje nuevo
    const postRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ embeds }),
    });
    if (postRes.ok) {
      const msg = await postRes.json();
      _statusMessageId = msg.id;
      await writeEnv({ DISCORD_STATUS_MESSAGE_ID: msg.id });
      info(`[discord] 📡 Embed de estado creado: ${msg.id}`);
    } else {
      warn(`[discord] ⚠ status embed: ${postRes.status} — ${await postRes.text()}`);
    }
  } catch (e) {
    warn("[discord] Error en sendStatusEmbed:", e.message);
  }
}

// Watcher: sends status embed each time detector.js updates status.json
let _statusWatchDebounce = null;
function watchStatusFile() {
  // fsSync.watch pierde el inode tras rename atómico (tmp → file).
  // watchFile usa polling y siempre apunta al path, no al inode.
  fsSync.watchFile(STATUS_FILE, { interval: 5000, persistent: false }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    clearTimeout(_statusWatchDebounce);
    _statusWatchDebounce = setTimeout(() => sendStatusEmbed(), 1500);
  });
  info("[discord] 👁 Watching status.json para auto-embed (polling 5s)");
}

/* ═══════════════════════════════════════════
   DISCORD — editar embed cuando admin comenta
═══════════════════════════════════════════ */

async function editDiscordEmbed(incident, update, serviceName) {
  const token     = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  if (!token || !channelId || !incident.discordMessageId) return;

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
    { name: "Servicio", value: serviceName ?? incident.serviceName ?? "—", inline: true },
    { name: "Estado",   value: statusLabels[update.status] ?? update.status,  inline: true },
  ];

  if (incident.updates?.length > 1) {
    const ms = new Date(update.at) - new Date(incident.createdAt);
    const m  = Math.floor(ms / 60_000);
    const h  = Math.floor(m / 60);
    fields.push({ name: "Duración", value: h > 0 ? `${h}h ${m % 60}m` : `${m}m`, inline: false });
  }

  const embed = {
    title: `📋 Actualización — ${incident.title}`,
    description: update.message || "Sin mensaje.",
    color: colors[update.status] ?? 0x6b7280,
    timestamp: update.at,
    footer: { text: `Nexora Status • ID: ${incident.id}` },
    fields,
  };

  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${incident.discordMessageId}`,
      {
        method: "PATCH",
        headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      }
    );
    if (res.ok) {
      info(`[discord] ✏ Embed editado por comentario admin — incidente: ${incident.id}`);
    } else {
      const err = await res.text();
      warn(`[discord] ⚠ No se pudo editar embed: ${res.status} — ${err}`);
    }
  } catch (e) {
    warn("[discord] Error de red al editar embed:", e.message);
  }
}

/* ═══════════════════════════════════════════
   TOTP HELPER — RFC 6238
═══════════════════════════════════════════ */

function base32Decode(str) {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0;
  const output = [];
  const clean  = str.toUpperCase().replace(/=+$/, "").replace(/\s/g, "")
                    .replace(/0/g, "O")
                    .replace(/1/g, "I")
                    .replace(/8/g, "B");
  for (const c of clean) {
    const idx = CHARS.indexOf(c);
    if (idx === -1) continue;
    val  = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) { bits -= 8; output.push((val >> bits) & 0xff); }
  }
  return Buffer.from(output);
}

function verifyTotp(secret, userCode, window = 1) {
  if (!secret) return false;
  const timeStep = 30, digits = 6;
  const key      = base32Decode(secret);
  const now      = Math.floor(Date.now() / 1000 / timeStep);
  for (let i = -window; i <= window; i++) {
    const counter = now + i;
    const buf     = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac   = crypto.createHmac("sha1", key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const valid  = ((hmac.readUInt32BE(offset) & 0x7fffffff) % Math.pow(10, digits))
                    .toString().padStart(digits, "0");
    if (crypto.timingSafeEqual(Buffer.from(valid), Buffer.from(String(userCode).trim().padStart(digits, "0")))) {
      return true;
    }
  }
  return false;
}

/* ═══════════════════════════════════════════
   AUTH MIDDLEWARE
═══════════════════════════════════════════ */

function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"];
  const valid = getAdminToken();
  if (!valid) return res.status(500).json({ error: "Token de administrador no configurado" });
  if (!token || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(valid))) {
    return res.status(401).json({ error: "Token inválido o ausente" });
  }
  next();
}

/* ═══════════════════════════════════════════
   VALIDACIONES
═══════════════════════════════════════════ */

function isValidId(id) {
  return typeof id === "string" && /^[\w-]{1,64}$/.test(id);
}

function isValidUrl(url) {
  if (typeof url !== "string" || url.length > 512) return false;
  try {
    const u = new URL(url);
    return ["http:", "https:", "tcp:"].includes(u.protocol) ||
           /^tcp:\/\/[\w.-]+:\d+$/.test(url);
  } catch {
    return /^[\w.-]+:\d{1,5}$/.test(url);
  }
}

/* ═══════════════════════════════════════════
   ARCHIVOS ESTÁTICOS
═══════════════════════════════════════════ */

/* ═══════════════════════════════════════════
   SETUP GUARD — redirect to /setup if unconfigured
═══════════════════════════════════════════ */

app.use((req, res, next) => {
  if (getAdminToken()) return next();
  const p = req.path;
  if (p === "/setup" || p === "/setup/" ||
      p.startsWith("/admin/api/setup") ||
      p === "/api/config") return next();
  if (path.extname(p)) return next(); // static assets
  if (req.method === "GET") return res.redirect("/setup");
  if (p.startsWith("/admin/api") || p.startsWith("/api"))
    return res.status(503).json({ error: "No configurado. Completa /setup." });
  next();
});

app.use(publicLimiter);
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    } else if (/\.[a-f0-9]{8}\.(js|css)$/.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.setHeader("Cache-Control", "public, max-age=3600");
    }
  },
}));

/* ═══════════════════════════════════════════
   RUTAS PÚBLICAS
═══════════════════════════════════════════ */

/* Setup wizard */
app.get("/setup",  (_req, res) => res.sendFile(path.join(__dirname, "public", "setup.html")));
app.get("/setup/", (_req, res) => res.sendFile(path.join(__dirname, "public", "setup.html")));

/* Public appearance config */
app.get("/api/config", async (_req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store");
  res.json(await readAppearance());
});

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.get("/uptime", async (_req, res) => {
  try {
    const json = await readJson(STATUS_FILE);
    res.setHeader("Cache-Control", "no-cache, no-store");
    res.json({ ok: true, ...json });
  } catch (err) {
    error("[/uptime] Error:", err.message);
    res.status(500).json({ ok: false, error: "No se pudo leer status.json" });
  }
});

/* ═══════════════════════════════════════════
   ADMIN – UI
   /admin y /admin/ → redirigen a login si no hay sesión (client-side)
   El HTML de admin solo se sirve; la verificación de sesión es en el cliente.
   La página de login es login.html (sin nada del panel).
═══════════════════════════════════════════ */

app.get("/login",  (_req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/login/", (_req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));

app.get("/admin",  adminLimiter, (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/admin/", adminLimiter, (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

app.post("/admin/api/setup", authLimiter, async (req, res) => {
  if (getAdminToken()) return res.status(403).json({ error: "Ya configurado" });

  const { adminToken, totpSecret, sections, appearance } = req.body ?? {};

  if (typeof adminToken !== "string" || adminToken.length < 16) {
    return res.status(400).json({ error: "adminToken debe tener al menos 16 caracteres" });
  }

  const updates = { ADMIN_TOKEN: adminToken };
  if (totpSecret?.trim()) updates.TOTP_SECRET = totpSecret.trim().toUpperCase();
  await writeEnv(updates);

  if (Array.isArray(sections)) {
    for (const s of sections) {
      if (!isValidId(s.id) || typeof s.name !== "string" || !Array.isArray(s.services)) {
        return res.status(400).json({ error: `Sección inválida: ${s.id}` });
      }
      for (const svc of s.services) {
        if (!isValidId(svc.id) || typeof svc.name !== "string" || !isValidUrl(svc.url)) {
          return res.status(400).json({ error: `Servicio inválido: ${svc.id}` });
        }
      }
    }
    await writeJson(SERVICES_FILE, { sections });
    try { await fs.writeFile(FORCE_CHECK_FILE, "1"); } catch {}
  }

  if (appearance && typeof appearance === "object") {
    const VALID_BG = ["image", "solid"];
    if (appearance.backgroundType && !VALID_BG.includes(appearance.backgroundType)) {
      return res.status(400).json({ error: "backgroundType inválido" });
    }
    for (const f of ["logoUrl", "faviconUrl", "backgroundImageUrl"]) {
      if (appearance[f] && typeof appearance[f] !== "string") {
        return res.status(400).json({ error: `${f} inválida` });
      }
    }
    if (appearance.backgroundSolidColor && !/^#[0-9a-fA-F]{6}$/.test(appearance.backgroundSolidColor)) {
      return res.status(400).json({ error: "backgroundSolidColor inválido" });
    }
    if (appearance.accentColor && !/^#[0-9a-fA-F]{6}$/.test(appearance.accentColor)) {
      return res.status(400).json({ error: "accentColor inválido" });
    }
    if (appearance.siteTitle && (typeof appearance.siteTitle !== "string" || appearance.siteTitle.length > 128)) {
      return res.status(400).json({ error: "siteTitle inválido" });
    }
    if (appearance.footerText && (typeof appearance.footerText !== "string" || appearance.footerText.length > 256)) {
      return res.status(400).json({ error: "footerText inválido" });
    }
    if (appearance.fontFamily && (typeof appearance.fontFamily !== "string" || appearance.fontFamily.length > 64)) {
      return res.status(400).json({ error: "fontFamily inválido" });
    }
    await writeJson(APPEARANCE_FILE, { ...DEFAULT_APPEARANCE, ...appearance });
  }

  res.json({ ok: true });
});

app.get("/admin/api/setup/status", (_req, res) => {
  res.json({ configured: !!getAdminToken() });
});



app.post("/admin/api/auth", authLimiter, async (req, res) => {
  const { token, code } = req.body ?? {};
  const totpSecret  = process.env.TOTP_SECRET ?? null;
  const adminToken  = getAdminToken();

  if (!adminToken) return res.status(500).json({ ok: false, error: "Servidor no configurado correctamente" });

  if (totpSecret) {
    const tokenOk = token && crypto.timingSafeEqual(Buffer.from(String(token)), Buffer.from(adminToken));
    const totpOk  = code && verifyTotp(totpSecret, String(code).trim());
    if (!tokenOk) return res.status(401).json({ ok: false, error: "Contraseña incorrecta" });
    if (!totpOk)  return res.status(401).json({ ok: false, error: "Código TOTP inválido" });
    return res.json({ ok: true });
  }

  const tokenOk = token && crypto.timingSafeEqual(Buffer.from(String(token)), Buffer.from(adminToken));
  if (tokenOk) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: "Contraseña incorrecta" });
});

/* ═══════════════════════════════════════════
   ADMIN – STATUS
═══════════════════════════════════════════ */

app.get("/admin/api/status", adminLimiter, adminAuth, async (_req, res) => {
  try { res.json(await readJson(STATUS_FILE)); }
  catch { res.status(500).json({ error: "No se pudo leer status.json" }); }
});

/* ═══════════════════════════════════════════
   ADMIN – FORCE CHECK
═══════════════════════════════════════════ */

app.post("/admin/api/force-check", adminLimiter, adminAuth, async (_req, res) => {
  try {
    await fs.writeFile(FORCE_CHECK_FILE, "1");
    res.json({ ok: true, message: "Force check requested. Will update in seconds." });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

/* ═══════════════════════════════════════════
   ADMIN – FORCE CONFIG RELOAD
═══════════════════════════════════════════ */

app.post("/admin/api/force-config-reload", adminLimiter, adminAuth, async (_req, res) => {
  try {
    await fs.writeFile(FORCE_CONFIG_RELOAD_FILE, "1");
    res.json({ ok: true, message: "Config reload requested. Services will be reloaded in seconds." });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

/* ═══════════════════════════════════════════
   ADMIN – ANNOUNCEMENTS
═══════════════════════════════════════════ */

app.get("/admin/api/announcements", adminLimiter, adminAuth, async (_req, res) => {
  const store = await readJson(STATUS_FILE);
  res.json(store.announcements ?? []);
});

app.post("/admin/api/announcements", adminLimiter, adminAuth, async (req, res) => {
  const { type, title, body, endsAt } = req.body;
  if (!type || !title) return res.status(400).json({ error: "type y title son requeridos" });
  const VALID_TYPES = ["maintenance", "incident", "info"];
  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: "type inválido" });
  if (typeof title !== "string" || title.length > 256) return res.status(400).json({ error: "title inválido o demasiado largo" });
  if (endsAt && isNaN(new Date(endsAt).getTime())) return res.status(400).json({ error: "endsAt no es una fecha válida" });

  const store = await readJson(STATUS_FILE);
  store.announcements ??= [];
  const ann = {
    id: `ann-${Date.now()}`, type,
    title: String(title).trim(),
    body:  typeof body === "string" ? body.trim() : "",
    endsAt: endsAt ?? null, createdAt: new Date().toISOString(), manual: true,
  };
  store.announcements.push(ann);
  await writeJson(STATUS_FILE, store);
  res.json(ann);
});

app.delete("/admin/api/announcements/:id", adminLimiter, adminAuth, async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "ID inválido" });
  const store = await readJson(STATUS_FILE);
  const before = (store.announcements ?? []).length;
  store.announcements = (store.announcements ?? []).filter(a => a.id !== id);
  if (store.announcements.length === before) return res.status(404).json({ error: "Anuncio no encontrado" });
  await writeJson(STATUS_FILE, store);
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════
   ADMIN – INCIDENTES
═══════════════════════════════════════════ */

app.get("/admin/api/incidents", adminLimiter, adminAuth, async (_req, res) => {
  const store = await readJson(STATUS_FILE);
  res.json(store.incidents ?? []);
});

app.post("/admin/api/incidents", adminLimiter, adminAuth, async (req, res) => {
  const { title, status = "investigating", message, serviceId, serviceName } = req.body;
  if (!title || typeof title !== "string" || title.length > 256) {
    return res.status(400).json({ error: "title es requerido (máx 256 chars)" });
  }
  const VALID_STATUSES = ["investigating", "identified", "monitoring", "resolved", "maintenance"];
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: "status inválido" });
  if (serviceId && !isValidId(serviceId)) return res.status(400).json({ error: "serviceId inválido" });

  const store      = await readJson(STATUS_FILE);
  const now        = new Date().toISOString();
  const incidentId = `inc-${Date.now()}`;

  store.incidents    ??= [];
  store.announcements ??= [];

  const incident = {
    id: incidentId, serviceId: serviceId ?? null,
    serviceName: typeof serviceName === "string" ? serviceName.trim().slice(0, 128) : null,
    title: title.trim(), status, automatic: false, createdAt: now, resolvedAt: null,
    discordMessageId: null,
    updates: [{ at: now, status, message: typeof message === "string" ? message.trim() : "Incidente creado manualmente." }],
  };

  store.incidents.push(incident);
  store.announcements.push({
    id: `ann-${incidentId}`,
    type: status === "maintenance" ? "maintenance" : "incident",
    title: incident.title,
    body: typeof message === "string" ? message.trim() : "",
    incidentId, serviceId: serviceId ?? null, createdAt: now, endsAt: null, manual: true,
  });

  await writeJson(STATUS_FILE, store);

  // Intentar enviar embed inicial a Discord (incidente manual)
  const token     = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  if (token && channelId) {
    const colors = { investigating: 0xef4444, identified: 0xf97316, monitoring: 0xf59e0b, resolved: 0x22c55e, maintenance: 0x3b82f6 };
    const statusLabels = { investigating: "🔍 Investigando", identified: "🔎 Identificado", monitoring: "🟡 Monitoreando", resolved: "✅ Resuelto", maintenance: "🔧 Mantenimiento" };
    try {
      const dres = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [{
          title: `📋 Incidente — ${incident.title}`,
          description: typeof message === "string" ? message.trim() : "Incidente creado manualmente.",
          color: colors[status] ?? 0x6b7280,
          timestamp: now,
          footer: { text: `Nexora Status • ID: ${incidentId}` },
          fields: [
            { name: "Servicio", value: incident.serviceName ?? "—",        inline: true },
            { name: "Estado",   value: statusLabels[status] ?? status,     inline: true },
          ],
        }] }),
      });
      if (dres.ok) {
        const dmsg = await dres.json();
        if (dmsg?.id) {
          incident.discordMessageId = dmsg.id;
          // Re-guardar con el messageId
          const fresh = await readJson(STATUS_FILE);
          const inc = fresh.incidents?.find(i => i.id === incidentId);
          if (inc) { inc.discordMessageId = dmsg.id; await writeJson(STATUS_FILE, fresh); }
          info(`[discord] 📨 Embed enviado para incidente manual ${incidentId} (msg: ${dmsg.id})`);
        }
      }
    } catch (e) {
      warn("[discord] Error al enviar embed de incidente manual:", e.message);
    }
  }

  res.json(incident);
});

/* ── Añadir comentario/actualización a incidente ── */
app.post("/admin/api/incidents/:id/updates", adminLimiter, adminAuth, async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "ID inválido" });

  const { status, message } = req.body;
  if (!message || typeof message !== "string" || message.length > 2048) {
    return res.status(400).json({ error: "message es requerido (máx 2048 chars)" });
  }
  const VALID_STATUSES = ["investigating", "identified", "monitoring", "resolved", "maintenance"];
  if (status && !VALID_STATUSES.includes(status)) return res.status(400).json({ error: "status inválido" });

  const store = await readJson(STATUS_FILE);
  const inc   = (store.incidents ?? []).find(i => i.id === id);
  if (!inc) return res.status(404).json({ error: "Incidente no encontrado" });

  const now = new Date().toISOString();
  const update = { at: now, status: status ?? inc.status, message: message.trim() };
  inc.updates.push(update);
  if (status) inc.status = status;

  if (status === "resolved" && !inc.resolvedAt) {
    inc.resolvedAt = now;
    store.announcements = (store.announcements ?? []).filter(a => a.incidentId !== inc.id);
  }

  const ann = (store.announcements ?? []).find(a => a.incidentId === inc.id);
  if (ann && message) ann.body = message.trim();

  await writeJson(STATUS_FILE, store);

  // Editar embed de Discord con el nuevo comentario
  await editDiscordEmbed(inc, update, inc.serviceName);

  res.json(inc);
});

app.delete("/admin/api/incidents/:id", adminLimiter, adminAuth, async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "ID inválido" });
  const store = await readJson(STATUS_FILE);
  const before = (store.incidents ?? []).length;
  store.incidents     = (store.incidents     ?? []).filter(i => i.id !== id);
  store.announcements = (store.announcements ?? []).filter(a => a.incidentId !== id);
  if (store.incidents.length === before) return res.status(404).json({ error: "Incidente no encontrado" });
  await writeJson(STATUS_FILE, store);
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════
   ADMIN – SERVICIOS
═══════════════════════════════════════════ */

app.get("/admin/api/services", adminLimiter, adminAuth, async (_req, res) => {
  try { res.json(await readJson(SERVICES_FILE)); }
  catch { res.json({ sections: [] }); }
});

app.put("/admin/api/services", adminLimiter, adminAuth, async (req, res) => {
  const { sections } = req.body;
  if (!Array.isArray(sections)) return res.status(400).json({ error: "sections debe ser un array" });
  for (const s of sections) {
    if (!isValidId(s.id) || typeof s.name !== "string" || !Array.isArray(s.services)) {
      return res.status(400).json({ error: `Sección inválida: ${s.id}` });
    }
    if (s.name.length > 128) return res.status(400).json({ error: "Nombre de sección demasiado largo" });
    for (const svc of s.services) {
      if (!isValidId(svc.id) || typeof svc.name !== "string" || !svc.url) {
        return res.status(400).json({ error: `Servicio inválido en sección ${s.id}: ${svc.id}` });
      }
      if (!isValidUrl(svc.url)) {
        return res.status(400).json({ error: `URL inválida para servicio ${svc.id}: ${svc.url}` });
      }
    }
  }
  await writeJson(SERVICES_FILE, { sections });
  try { await fs.writeFile(FORCE_CHECK_FILE, "1"); } catch {}
  res.json({ ok: true, message: "Guardado. Iniciando re-scan inmediato..." });
});

/* ═══════════════════════════════════════════
   ADMIN – SETTINGS (lee/escribe .env)
═══════════════════════════════════════════ */

app.get("/admin/api/settings", adminLimiter, adminAuth, async (_req, res) => {
  const botToken = process.env.DISCORD_BOT_TOKEN ?? "";
  res.json({
    discordBotToken:        botToken  ? `${botToken.slice(0, 8)}…`  : "",
    discordChannelId:       process.env.DISCORD_CHANNEL_ID ?? "",
    discordStatusChannelId: process.env.DISCORD_STATUS_CHANNEL_ID ?? "",
    discordStatusServices:  process.env.DISCORD_STATUS_SERVICES ?? "",
    discordStatusMessageId: _statusMessageId ?? "",
    botState,
    hasAdminToken:    !!(process.env.ADMIN_TOKEN),
    hasTotpSecret:    !!(process.env.TOTP_SECRET),
    totpSecretHint:   process.env.TOTP_SECRET ? `${process.env.TOTP_SECRET.slice(0, 4)}…` : "",
    appearance:       await readAppearance(),
  });
});

app.put("/admin/api/settings", adminLimiter, adminAuth, async (req, res) => {
  const { discordBotToken, discordChannelId, discordStatusChannelId, discordStatusServices, adminToken, totpSecret } = req.body;

  if (discordChannelId && !/^\d{1,25}$/.test(discordChannelId)) {
    return res.status(400).json({ error: "discordChannelId inválido" });
  }
  if (discordStatusChannelId && !/^\d{1,25}$/.test(discordStatusChannelId)) {
    return res.status(400).json({ error: "discordStatusChannelId inválido" });
  }
  if (adminToken && IS_PROD && adminToken.length < 16) {
    return res.status(400).json({ error: "adminToken debe tener al menos 16 caracteres" });
  }

  const updates = {};
  if (discordChannelId)                              updates.DISCORD_CHANNEL_ID        = discordChannelId;
  if (discordStatusChannelId !== undefined) {
    if (discordStatusChannelId !== process.env.DISCORD_STATUS_CHANNEL_ID) {
      // Canal cambió — resetear message ID para que cree nuevo mensaje
      _statusMessageId = null;
      updates.DISCORD_STATUS_MESSAGE_ID = "";
    }
    updates.DISCORD_STATUS_CHANNEL_ID = discordStatusChannelId;
  }
  if (discordStatusServices   !== undefined)         updates.DISCORD_STATUS_SERVICES   = discordStatusServices;
  if (adminToken)                                    updates.ADMIN_TOKEN               = adminToken;
  if (discordBotToken && !discordBotToken.includes("…")) updates.DISCORD_BOT_TOKEN    = discordBotToken;
  if (totpSecret?.trim())                            updates.TOTP_SECRET               = totpSecret.trim().toUpperCase();

  await writeEnv(updates);
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════
   ADMIN – APPEARANCE
═══════════════════════════════════════════ */

app.put("/admin/api/appearance", adminLimiter, adminAuth, async (req, res) => {
  const body = req.body ?? {};
  const VALID_BG = ["image", "solid"];
  if (body.backgroundType && !VALID_BG.includes(body.backgroundType)) {
    return res.status(400).json({ error: "backgroundType inválido" });
  }
  for (const f of ["logoUrl", "faviconUrl", "backgroundImageUrl"]) {
    if (body[f] && !isValidUrl(body[f]) && !/^\/[\w./-]+$/.test(body[f])) {
      return res.status(400).json({ error: `${f} inválida` });
    }
  }
  if (body.backgroundSolidColor && !/^#[0-9a-fA-F]{6}$/.test(body.backgroundSolidColor)) {
    return res.status(400).json({ error: "backgroundSolidColor inválido" });
  }
  if (body.accentColor && !/^#[0-9a-fA-F]{6}$/.test(body.accentColor)) {
    return res.status(400).json({ error: "accentColor inválido" });
  }
  if (body.siteTitle && (typeof body.siteTitle !== "string" || body.siteTitle.length > 128)) {
    return res.status(400).json({ error: "siteTitle inválido" });
  }
  if (body.footerText && (typeof body.footerText !== "string" || body.footerText.length > 256)) {
    return res.status(400).json({ error: "footerText inválido" });
  }
  if (body.fontFamily && (typeof body.fontFamily !== "string" || body.fontFamily.length > 64)) {
    return res.status(400).json({ error: "fontFamily inválido" });
  }

  const current = await readAppearance();
  const next    = { ...current, ...body };
  await writeJson(APPEARANCE_FILE, next);
  res.json({ ok: true, appearance: next });
});

/* ═══════════════════════════════════════════
   ADMIN – DISCORD RELOAD / TEST / STATUS EMBED
═══════════════════════════════════════════ */

app.post("/admin/api/discord/reload", adminLimiter, adminAuth, async (_req, res) => {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return res.status(400).json({ ok: false, error: "Sin token configurado" });
  const result = await verifyBotToken(token);
  if (result.ok) {
    res.json({ ok: true, username: result.username });
  } else {
    res.status(400).json({ ok: false, error: `Token inválido (${result.status ?? result.error})` });
  }
});

app.get("/admin/api/discord/status", adminLimiter, adminAuth, (_req, res) => {
  res.json({ ...botState });
});

app.post("/admin/api/discord/test", adminLimiter, adminAuth, async (_req, res) => {
  if (!botState.verified) {
    return res.status(400).json({ ok: false, error: "Parece que el bot no está configurado, o si lo está, ¿has probado darle al botón de recargar?" });
  }
  const token          = process.env.DISCORD_BOT_TOKEN;
  const alertChannelId  = process.env.DISCORD_CHANNEL_ID;
  const statusChannelId = process.env.DISCORD_STATUS_CHANNEL_ID;

  if (!alertChannelId && !statusChannelId) {
    return res.status(400).json({ ok: false, error: "No hay ningún canal configurado" });
  }

  const embed = { title: "✅ Test de conexión", description: "El bot está conectado y funcionando correctamente.", color: 0x22c55e, timestamp: new Date().toISOString() };
  const sendTo = async (channelId) => {
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!r.ok) throw new Error(`Canal ${channelId}: Discord ${r.status} — ${await r.text()}`);
  };

  try {
    const targets = [alertChannelId, statusChannelId].filter(Boolean);
    await Promise.all(targets.map(sendTo));
    res.json({ ok: true, sent: targets.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/admin/api/discord/send-status", adminLimiter, adminAuth, async (_req, res) => {
  if (!botState.verified) {
    return res.status(400).json({ ok: false, error: "Bot no verificado. Dale a Recargar primero." });
  }
  if (!process.env.DISCORD_STATUS_CHANNEL_ID) {
    return res.status(400).json({ ok: false, error: "No hay canal de estado configurado" });
  }
  try {
    await sendStatusEmbed();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════
   404
═══════════════════════════════════════════ */

app.use((_req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public", "index.html"));
});

/* ═══════════════════════════════════════════
   ERROR HANDLER GLOBAL
═══════════════════════════════════════════ */

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  error("[Server] Error no manejado:", err.message);
  res.status(500).json({ error: "Error interno del servidor" });
});

/* ═══════════════════════════════════════════
   BOOT
═══════════════════════════════════════════ */

(async () => {
  await loadEnv();
  watchStatusFile();

  app.listen(PORT, () => {
    info(`[Web Server] http://localhost:${PORT}`);
    info(`[Admin Panel] http://localhost:${PORT}/admin`);
    info(`[Login Page] http://localhost:${PORT}/login`);
    if (!IS_PROD) info("[Server] Modo desarrollo — logs extendidos activos");
  });
})();

function shutdown(signal) {
  info(`\n[Server] Apagando (${signal})...`);
  if (detector && !detector.killed) {
    detector.kill("SIGTERM");
    setTimeout(() => { if (!detector.killed) detector.kill("SIGKILL"); process.exit(0); }, 3000).unref();
    detector.once("exit", () => process.exit(0));
  } else {
    process.exit(0);
  }
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", err => { error("[Server] uncaughtException:", err); });
process.on("unhandledRejection", (reason) => { error("[Server] unhandledRejection:", reason); });