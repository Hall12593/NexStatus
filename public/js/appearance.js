/* ═══════════════════════════════════════════
   APARIENCIA — aplica config dinámica (logo, favicon,
   fondo, fuente, footer, título) desde /api/config
═══════════════════════════════════════════ */
(async function applyAppearance() {
  let cfg;
  try {
    const res = await fetch("/api/config", { cache: "no-store" });
    if (!res.ok) return;
    cfg = await res.json();
  } catch { return; }

  const root = document.documentElement.style;

  if (cfg.fontFamily) {
    root.setProperty("--font-family", `${cfg.fontFamily}, system-ui, sans-serif`);
    if (cfg.fontFamily !== "Inter" && !document.querySelector(`link[data-font="${cfg.fontFamily}"]`)) {
      const link = document.createElement("link");
      link.rel  = "stylesheet";
      link.dataset.font = cfg.fontFamily;
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(cfg.fontFamily).replace(/%20/g, "+")}:wght@400;500;600;700;800&display=swap`;
      document.head.appendChild(link);
    }
  }
  if (cfg.accentColor) {
    const hex = cfg.accentColor.replace("#", "");
    const rgb = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).join(" ");
    root.setProperty("--accent", rgb);
  }
  if (cfg.backgroundType === "solid" && cfg.backgroundSolidColor) {
    root.setProperty("--page-bg-image", "none");
    root.setProperty("--page-bg-solid", cfg.backgroundSolidColor);
  } else if (cfg.backgroundType === "image" && cfg.backgroundImageUrl) {
    root.setProperty("--page-bg-image", `url(${cfg.backgroundImageUrl})`);
  }

  if (cfg.siteTitle) {
    document.title = `${cfg.siteTitle} – Nexora`;
    document.querySelectorAll(".title strong").forEach(el => { el.textContent = cfg.siteTitle; });
  }
  if (cfg.logoUrl) {
    document.querySelectorAll(".logo img").forEach(el => { el.src = cfg.logoUrl; });
  }
  if (cfg.faviconUrl) {
    document.querySelectorAll("link[rel='icon']").forEach(el => { el.href = cfg.faviconUrl; });
  }
  if (cfg.footerText) {
    document.querySelectorAll("footer").forEach(el => {
      const safe = document.createTextNode(cfg.footerText);
      el.innerHTML = "";
      el.appendChild(safe);
      const y = document.createElement("span");
      y.id = "year";
      y.textContent = new Date().getFullYear();
      el.appendChild(document.createTextNode(" "));
      el.appendChild(y);
    });
  }
})();