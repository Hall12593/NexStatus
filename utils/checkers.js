/**
 * Checkers – lógica de ping por servicio (http, tcp, udp, ping, dns, keyword)
 * Extraído de detector.js para poder reutilizarse en server.js (test de config)
 * sin arrancar el loop del detector.
 */

import net from "net";
import dns from "dns/promises";
import dgram from "dgram";
import { exec } from "child_process";

export const TIMEOUT_MS = 10_000;

const CLOUDFLARE_INDICATORS = [
  "cloudflare", "cf-ray", "attention required", "one moment", "just a moment",
  "checking your browser", "ddos protection", "security check",
];

function matchesKeyword(responseBody, keyword, mode = "contains") {
  if (!keyword || !responseBody) return false;
  const bodyStr = String(responseBody).trim();

  switch (mode) {
    case "exact":
      return bodyStr === keyword;
    case "regex":
      try {
        return new RegExp(keyword, "i").test(bodyStr);
      } catch {
        return false;
      }
    case "json":
      try {
        const json = JSON.parse(bodyStr);
        return JSON.stringify(json).includes(keyword);
      } catch {
        return bodyStr.toLowerCase().includes(keyword.toLowerCase());
      }
    case "contains":
    default:
      return bodyStr.toLowerCase().includes(keyword.toLowerCase());
  }
}

function isCloudflareBlock(bodyText, headers) {
  const cfRay = headers?.get?.("cf-ray");
  if (cfRay) return true;
  const server = headers?.get?.("server") ?? "";
  if (server.toLowerCase().includes("cloudflare")) return true;
  if (!bodyText) return false;
  const lower = bodyText.toLowerCase();
  return CLOUDFLARE_INDICATORS.some(kw => lower.includes(kw));
}

export async function pingService(service) {
  const checkType = service.checkType ?? "http";

  if (checkType === "tcp") {
    const urlPart = service.url.replace(/^tcp:\/\//, "");
    const [host, port] = urlPart.split(":");
    if (!host || !port) return { status: "down", code: 0, latency: null, error: "invalid_address" };
    return tcpPing(host, Number(port));
  }

  if (checkType === "udp") {
    const urlPart = service.url.replace(/^udp:\/\//, "");
    const [host, port] = urlPart.split(":");
    if (!host || !port) return { status: "down", code: 0, latency: null, error: "invalid_address" };
    return udpPing(host, Number(port));
  }

  if (checkType === "ping") {
    const host = service.url.replace(/^ping:\/\//, "");
    return icmpPing(host);
  }

  if (checkType === "dns") {
    const host = service.url.replace(/^dns:\/\//, "");
    return dnsPing(host, service.dnsRecordType ?? "A", service.dnsServer ?? null);
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
        const mode = service.keywordMode ?? "contains";
        const match = matchesKeyword(body, service.keyword, mode);
        return {
          status: match ? "up" : "down", code: res.status, latency,
          error: match ? null : "keyword_not_found",
          debug: {
            mode,
            keyword: service.keyword,
            httpStatus: res.status,
            bodyLength: body.length,
            bodySnippet: body.slice(0, 300),
          },
        };
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
        return { status: "down", code: res.status, latency, error: "http_status", debug: { httpStatus: res.status } };
      }

      if (method === "GET") {
        const body = await res.text();
        if (isCloudflareBlock(body, res.headers)) {
          return { status: "up", code: res.status, latency, error: "cloudflare_bypass" };
        }
      }

      return { status: "up", code: res.status, latency };
    } catch (err) {
      const reason = err.name === "AbortError" ? "timeout" : "network";
      return { status: "down", code: 0, latency: null, error: reason, debug: { exception: err.message } };
    } finally {
      clearTimeout(timer);
    }
  }

  const [host, port] = service.url.split(":");
  if (!host || !port) return { status: "down", code: 0, latency: null, error: "invalid_address" };
  return tcpPing(host, Number(port));
}

export function tcpPing(host, port) {
  return new Promise(resolve => {
    const start  = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(TIMEOUT_MS);
    socket.once("connect", () => { socket.destroy(); resolve({ status: "up",   code: 1, latency: Date.now() - start }); });
    socket.once("timeout", () => { socket.destroy(); resolve({ status: "down", code: 0, latency: null, error: "timeout" }); });
    socket.once("error",   (err) => { socket.destroy(); resolve({ status: "down", code: 0, latency: null, error: "connection", debug: { exception: err.message } }); });
    socket.connect(port, host);
  });
}

// UDP: no hay "connect" real, se considera up si el socket puede enviar sin ECONNREFUSED/error inmediato.
function udpPing(host, port) {
  return new Promise(resolve => {
    const start  = Date.now();
    const socket = dgram.createSocket("udp4");
    const timer  = setTimeout(() => { socket.close(); resolve({ status: "down", code: 0, latency: null, error: "timeout" }); }, TIMEOUT_MS);

    socket.once("error", (err) => {
      clearTimeout(timer);
      socket.close();
      resolve({ status: "down", code: 0, latency: null, error: err.code === "ECONNREFUSED" ? "refused" : "network", debug: { exception: err.message } });
    });

    socket.send(Buffer.from("ping"), port, host, (err) => {
      if (err) return; // manejado por "error"
      clearTimeout(timer);
      socket.close();
      resolve({ status: "up", code: 1, latency: Date.now() - start });
    });
  });
}

// ICMP requiere privilegios raw socket → se usa binario "ping" del sistema.
function icmpPing(host) {
  return new Promise(resolve => {
    const start   = Date.now();
    const isWin   = process.platform === "win32";
    const cmd     = isWin ? `ping -n 1 -w ${TIMEOUT_MS} ${host}` : `ping -c 1 -W ${Math.ceil(TIMEOUT_MS / 1000)} ${host}`;
    exec(cmd, { timeout: TIMEOUT_MS + 1000 }, (err, stdout, stderr) => {
      if (err) return resolve({ status: "down", code: 0, latency: null, error: "unreachable", debug: { exception: err.message, stderr: stderr?.slice(0, 300) } });
      resolve({ status: "up", code: 1, latency: Date.now() - start });
    });
  });
}

function dnsPing(host, recordType = "A", server = null) {
  return new Promise(async resolve => {
    const start    = Date.now();
    const resolver = new dns.Resolver();
    if (server) resolver.setServers([server]);
    const timer = setTimeout(() => resolve({ status: "down", code: 0, latency: null, error: "timeout" }), TIMEOUT_MS);
    try {
      const records = await resolver.resolve(host, recordType);
      clearTimeout(timer);
      resolve({ status: "up", code: 1, latency: Date.now() - start, debug: { records } });
    } catch (err) {
      clearTimeout(timer);
      resolve({ status: "down", code: 0, latency: null, error: "resolve_failed", debug: { exception: err.message } });
    }
  });
}