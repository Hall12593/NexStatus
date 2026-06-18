/* ═══════════════════════════════════════════
   ICONOS DE SERVICIO
═══════════════════════════════════════════ */
const SERVICE_ICONS = {
  bot:     "fa-brands fa-discord",
  main:    "fa-solid fa-globe",
  panel:   "fa-solid fa-user-shield",
  dash:    "fa-solid fa-gauge",
  api:     "fa-solid fa-code",
  node0:   "fa-solid fa-server",
  node1:   "fa-solid fa-server",
  node2:   "fa-solid fa-server",
  node3:   "fa-solid fa-server",
  db1:     "fa-solid fa-database",
  db2:     "fa-solid fa-database",
  pxpanel: "fa-solid fa-network-wired",
  monitor: "fa-solid fa-chart-line",
  pulse:   "fa-solid fa-heart-pulse",
  llsc:    "fa-solid fa-music",
  llyt:    "fa-brands fa-youtube",
  llyf:    "fa-brands fa-youtube",
  llyp:    "fa-brands fa-youtube",
  nexplay: "fa-solid fa-play",
  cdn:     "fa-solid fa-cloud",
};

const DEFAULT_ICON = "fa-solid fa-gears";

/* Whitelist de clases FA — evita inyección de clases arbitrarias */
const FA_CLASS_RE = /^fa-(brands|solid|regular|light|thin|duotone)\s+fa-[\w-]+$/;

function getServiceIcon(service) {
  const icon = service.icon ?? SERVICE_ICONS[service.id] ?? DEFAULT_ICON;
  return FA_CLASS_RE.test(icon) ? icon : DEFAULT_ICON;
}