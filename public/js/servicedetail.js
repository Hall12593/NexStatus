/* ═══════════════════════════════════════════
   SERVICE DETAIL — página completa (SPA)
═══════════════════════════════════════════ */

function calcRangeUptime(svc, days) {
  const history = svc.history ?? [];
  if (history.length === 0) {
    if (typeof svc.onlineper === "number") {
      let v = svc.onlineper;
      if (v >= 0 && v <= 1) v *= 100;
      return v;
    }
    return null;
  }
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const relevant = history.filter(h => h.date && new Date(h.date + "T12:00:00") >= cutoff && typeof h.onlineper === "number");
  if (relevant.length === 0) return null;
  const avg = relevant.reduce((s, h) => {
    let v = h.onlineper;
    if (v >= 0 && v <= 1) v *= 100;
    return s + v;
  }, 0) / relevant.length;
  return avg;
}

function uptimeTileEl(label, pct) {
  let cls = "na", val = "—";
  if (typeof pct === "number" && !Number.isNaN(pct)) {
    val = truncate3(pct).toFixed(3) + "%";
    cls = pct >= 95 ? "excellent" : pct >= 89 ? "good" : "poor";
  }
  const tile = document.createElement("div");
  tile.className = "svc-uptime-tile";
  tile.appendChild(el("div", label, "svc-tile-label"));
  tile.appendChild(el("div", val, `svc-tile-val ${cls}`));
  return tile;
}

function renderServiceDetail(container, svc, allIncidents) {
  container.innerHTML = "";

  /* ── Back nav ────────────────────────────── */
  const nav = document.createElement("div");
  nav.className = "svc-nav";

  const backBtn = document.createElement("button");
  backBtn.className = "svc-back-btn";
  backBtn.setAttribute("aria-label", "Volver al inicio");
  const backIcon = document.createElement("i");
  backIcon.className = "fa-solid fa-arrow-left";
  backIcon.setAttribute("aria-hidden", "true");
  backBtn.appendChild(backIcon);
  backBtn.appendChild(document.createTextNode(" Todos los servicios"));
  backBtn.addEventListener("click", navigateHome);
  nav.appendChild(backBtn);

  const navBrand = document.createElement("div");
  navBrand.className = "svc-nav-brand";
  const navLogo = document.createElement("img");
  navLogo.src = "https://cdn.nexorabot.xyz/nexora/img/logo.svg";
  navLogo.alt = "Nexora";
  navLogo.width = 22; navLogo.height = 22;
  navBrand.appendChild(navLogo);
  navBrand.appendChild(document.createTextNode("Nexora Status"));
  nav.appendChild(navBrand);
  container.appendChild(nav);

  /* ── Hero del servicio ────────────────────── */
  const hero = document.createElement("div");
  hero.className = `svc-hero ${svc.status}`;

  const heroLeft = document.createElement("div");
  heroLeft.className = "svc-hero-left";

  const iconWrap = document.createElement("div");
  iconWrap.className = `svc-hero-icon ${svc.status}`;
  const iconEl = document.createElement("i");
  iconEl.className = getServiceIcon(svc);
  iconEl.setAttribute("aria-hidden", "true");
  iconWrap.appendChild(iconEl);

  const heroInfo = document.createElement("div");
  heroInfo.className = "svc-hero-info";
  heroInfo.appendChild(el("h1", svc.name, "svc-hero-name"));
  heroInfo.appendChild(el("div", svc.id ?? "—", "svc-hero-id"));

  heroLeft.appendChild(iconWrap);
  heroLeft.appendChild(heroInfo);
  hero.appendChild(heroLeft);

  const heroRight = document.createElement("div");
  heroRight.className = "svc-hero-right";

  const statusPill = document.createElement("div");
  statusPill.className = `svc-status-pill ${svc.status}`;
  const dotEl = document.createElement("span");
  dotEl.className = `svc-status-dot ${svc.status}`;
  statusPill.appendChild(dotEl);
  statusPill.appendChild(document.createTextNode(svc.status === "up" ? "Operativo" : "Interrumpido"));
  heroRight.appendChild(statusPill);

  const lat = typeof svc.latency === "number" ? svc.latency + " ms" : svc.latency ?? "—";
  const latencyDiv = document.createElement("div");
  latencyDiv.className = "svc-latency-block";
  latencyDiv.appendChild(el("span", lat, "svc-latency-val"));
  latencyDiv.appendChild(el("span", "latencia actual", "svc-latency-lbl"));
  heroRight.appendChild(latencyDiv);

  if (svc.checkedAt) {
    heroRight.appendChild(el("div", `Verificado: ${formatDate(svc.checkedAt)}`, "svc-checked"));
  }
  hero.appendChild(heroRight);
  container.appendChild(hero);

  /* ── Disponibilidad ───────────────────────── */
  const tilesSection = document.createElement("div");
  tilesSection.className = "svc-section";
  tilesSection.appendChild(el("div", "Disponibilidad", "svc-section-title"));

  const tilesGrid = document.createElement("div");
  tilesGrid.className = "svc-uptime-tiles";
  tilesGrid.appendChild(uptimeTileEl("Hoy",     calcRangeUptime(svc, 1)));
  tilesGrid.appendChild(uptimeTileEl("7 días",  calcRangeUptime(svc, 7)));
  tilesGrid.appendChild(uptimeTileEl("30 días", calcRangeUptime(svc, 30)));
  tilesSection.appendChild(tilesGrid);
  container.appendChild(tilesSection);

  /* ── Historial 30 días (calendario) ──────── */
  const calSection = document.createElement("div");
  calSection.className = "svc-section";
  calSection.appendChild(el("div", "Historial 30 días", "svc-section-title"));
  const calLegend = document.createElement("div");
  calLegend.className = "cal-legend";
  [["excellent","≥ 95%"], ["good","89–95%"], ["poor","< 89%"], ["nm","Sin datos"]].forEach(([cls, label]) => {
    const item = document.createElement("div");
    item.className = "cal-legend-item";
    const dot = document.createElement("span");
    dot.className = `cal-legend-dot ${cls}`;
    item.appendChild(dot);
    item.appendChild(document.createTextNode(label));
    calLegend.appendChild(item);
  });
  calSection.appendChild(calLegend);
  const calContainer = document.createElement("div");
  calContainer.className = "cal-container";
  buildCalendarHistory(calContainer, svc.history ?? []);
  calSection.appendChild(calContainer);
  container.appendChild(calSection);

  /* ── Historial por hora (24h) ─────────────── */
  if (Array.isArray(svc.latencySparkline) && svc.latencySparkline.length > 0) {
    const hourSection = document.createElement("div");
    hourSection.className = "svc-section";

    const hourTitleRow = document.createElement("div");
    hourTitleRow.className = "svc-section-title-row";
    hourTitleRow.appendChild(el("div", "Estado por hora — últimas 24h", "svc-section-title"));
    const hourLegend = document.createElement("div");
    hourLegend.className = "hourly-legend";
    [["good","Baja latencia"], ["warn","Alta latencia"], ["bad","Muy alta"], ["na","Sin datos"]].forEach(([cls, label]) => {
      const item = document.createElement("div");
      item.className = "cal-legend-item";
      const dot = document.createElement("span");
      dot.className = `hourly-legend-dot ${cls}`;
      item.appendChild(dot);
      item.appendChild(document.createTextNode(label));
      hourLegend.appendChild(item);
    });
    hourTitleRow.appendChild(hourLegend);
    hourSection.appendChild(hourTitleRow);

    buildHourlyHistory(hourSection, svc.latencySparkline);
    container.appendChild(hourSection);

    /* ── Sparkline de latencia ────────────────── */
    const sparkSection = document.createElement("div");
    sparkSection.className = "svc-section";
    sparkSection.appendChild(el("div", "Latencia 24h", "svc-section-title"));
    const sparkEl = createSparkline(svc.latencySparkline);
    if (sparkEl) sparkSection.appendChild(sparkEl);
    container.appendChild(sparkSection);
  }

  /* ── Incidentes relacionados ──────────────── */
  const related = (allIncidents ?? [])
    .filter(i => i.serviceId === svc.id || i.serviceName === svc.name)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 8);

  const incSection = document.createElement("div");
  incSection.className = "svc-section";
  incSection.appendChild(el("div", "Incidentes relacionados", "svc-section-title"));

  if (related.length === 0) {
    const noData = document.createElement("div");
    noData.className = "svc-no-data";
    const checkIcon = document.createElement("i");
    checkIcon.className = "fa-solid fa-circle-check";
    checkIcon.setAttribute("aria-hidden", "true");
    noData.appendChild(checkIcon);
    noData.appendChild(document.createTextNode(" Sin incidentes registrados"));
    incSection.appendChild(noData);
  } else {
    related.forEach(inc => incSection.appendChild(renderIncidentCard(inc, false)));
  }
  container.appendChild(incSection);

  /* ── Footer ───────────────────────────────── */
  const footer = document.createElement("footer");
  footer.className = "svc-footer";
  footer.textContent = `© ${new Date().getFullYear()} Nexora – Status Monitor`;
  container.appendChild(footer);
}