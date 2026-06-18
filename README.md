# Nexora Status

Self-hosted status page with real-time uptime monitoring, incident management, and Discord integration. Built with Node.js + vanilla JS. No external database required — everything persists in JSON files.

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)

---

## Features

- **Uptime monitoring** — HTTP, TCP, and keyword checks with configurable intervals
- **Confirmatory re-checks** — 2 additional pings before marking a service down (avoids false positives)
- **Incident management** — create, update, and resolve incidents with a full update timeline
- **Announcements** — info, maintenance, and incident banners on the public page
- **Discord integration** — auto-posts and edits embeds in a channel when incidents are created or updated
- **TOTP 2FA** — optional second factor for admin login (RFC 6238 compatible, e.g. Google Authenticator)
- **Appearance customization** — site title, logo, favicon, accent color, background, font family, footer text
- **30-day uptime history** — sparkline graphs and per-day latency history per service
- **Service sections** — group services into sections on the public page
- **Rate limiting** — separate limits for public endpoints, admin endpoints, and auth
- **Setup wizard** — first-run `/setup` page, no manual config file editing required
- **Zero dependencies on external DBs** — all data stored in `data/*.json`

---

## Stack

- **Backend** — Node.js (ESM), Express
- **Frontend** — Vanilla JS, HTML, CSS (no frameworks)
- **Persistence** — JSON files
- **Auth** — token-based (`x-admin-token` header) + optional TOTP

---

## Getting Started

### Requirements

- Node.js ≥ 18

### Install

```bash
git clone https://github.com/Hall12593/NexStatus.git
cd NexStatus
npm install
```

### Run

```bash
node server.js
```

Open `http://localhost:3015/setup` to run the setup wizard on first launch.

### Production

```bash
NODE_ENV=production node server.js
```

Or with PM2:

```bash
pm2 start server.js --name nexora-status
```

---

## Environment Variables

All variables live in `.env` in the project root. The setup wizard writes them for you, but you can also set them manually.

| Variable | Required | Description |
|---|---|---|
| `ADMIN_TOKEN` | ✅ | Admin password (min 16 chars) |
| `PORT` | ❌ | HTTP port (default: `3015`) |
| `NODE_ENV` | ❌ | Set to `production` to enable HSTS and prod warnings |
| `TOTP_SECRET` | ❌ | Base32 TOTP secret for 2FA on admin login |
| `DISCORD_BOT_TOKEN` | ❌ | Bot token for Discord incident embeds |
| `DISCORD_CHANNEL_ID` | ❌ | Channel ID where embeds are posted |
| `ALLOWED_ORIGINS` | ❌ | Comma-separated allowed CORS origins (e.g. `https://status.yourdomain.com`). If unset, CORS is open — set this in production. |
| `TRUST_PROXY` | ❌ | Set to `1` if running behind nginx/Cloudflare to correctly read client IPs for rate limiting |

---

## Service Check Types

| Type | URL format | Description |
|---|---|---|
| `http` | `https://example.com` | HEAD request, checks for 2xx/3xx |
| `keyword` | `https://example.com` | GET request, checks if response body contains a keyword |
| `tcp` | `tcp://host:port` | TCP connection check |

---

## Admin Panel

`/admin` — full management panel:

- Live service status dashboard
- Force-check all services
- Manage services and sections
- Create / update / resolve incidents
- Create / delete announcements
- Discord and TOTP settings
- Appearance customization

---

## Pages

| Route | Description |
|---|---|
| `/` | Public status page |
| `/setup` | First-run setup wizard |
| `/login` | Admin login |
| `/admin` | Admin panel |

---

## Data Files

All data is stored in `data/` (auto-created on first run):

| File | Contents |
|---|---|
| `services.json` | Sections and services config |
| `status.json` | Live uptime/latency state |
| `appearance.json` | Appearance settings |

---

## License

MIT © Hall — see [LICENSE](LICENSE).

Forks and modifications are welcome. Attribution to the original project is required — keep the copyright notice intact in all copies or substantial portions of the software.