/* ═══════════════════════════════════════════
   SECTION HEADER
═══════════════════════════════════════════ */
function createSectionHeader(name, containerClass) {
  const header = document.createElement("div");
  header.className = `section-header ${containerClass}`;
  const span = document.createElement("span");
  span.className = "section-label";
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-layer-group";
  icon.setAttribute("aria-hidden", "true");
  span.appendChild(icon);
  span.appendChild(document.createTextNode(name));
  header.appendChild(span);
  return header;
}

/* ═══════════════════════════════════════════
   QUICK VIEW CARD
═══════════════════════════════════════════ */
function createQuickViewCard(service) {
  const article = document.createElement("article");
  article.className = "quick-view-item";
  article.setAttribute("role", "button");
  article.setAttribute("tabindex", "0");
  article.setAttribute("aria-label", `${service.name}: ${service.status === "up" ? "Operativo" : "Interrumpido"}`);
  if (service.status === "down") article.classList.add("service-down");

  const latencyText     = typeof service?.latency === "number" ? `${service.latency} ms` : service?.latency ?? "—";
  const iconClass       = getServiceIcon(service);
  const iconStatusClass = service.status === "up" ? "up" : "down";

  const left = document.createElement("div");
  left.className = "quick-view-left";

  const iconWrap = document.createElement("div");
  iconWrap.className = `quick-view-icon ${iconStatusClass}`;
  const iconEl = document.createElement("i");
  iconEl.className = iconClass;
  iconEl.setAttribute("aria-hidden", "true");
  iconWrap.appendChild(iconEl);

  const info = document.createElement("div");
  info.className = "quick-view-info";
  info.appendChild(el("div", service.name, "quick-view-name"));
  info.appendChild(el("div", latencyText, "quick-view-latency"));

  left.appendChild(iconWrap);
  left.appendChild(info);

  const right = document.createElement("div");
  right.className = "quick-view-right";
  const statusSpan = document.createElement("span");
  statusSpan.className = `quick-view-status ${service.status}`;
  statusSpan.textContent = service.status === "up" ? "Operativo" : "Interrumpido";
  right.appendChild(statusSpan);

  article.appendChild(left);
  article.appendChild(right);

  const openDetail = () => navigateToService(service.id);
  article.addEventListener("click", openDetail);
  article.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(); } });

  return article;
}

/* ═══════════════════════════════════════════
   DETAIL CARD
═══════════════════════════════════════════ */
function createCard(service) {
  const card = document.createElement("article");
  card.className = "card";
  card.setAttribute("role", "button");
  card.setAttribute("tabindex", "0");
  card.setAttribute("aria-label", `${service.name}: ${service.status === "up" ? "Operativo" : "Interrumpido"}`);

  const uptimeText     = formatPercent(service?.onlineper ?? NaN) + " uptime";
  const latencyText    = typeof service?.latency === "number" ? `${service.latency} ms` : service?.latency ?? "—";
  const iconClass      = getServiceIcon(service);
  const iconStatusClass = service.status === "up" ? "icon-up" : "icon-down";

  const row = document.createElement("div");
  row.className = "row";

  const iconWrap = document.createElement("div");
  iconWrap.className = `service-icon ${iconStatusClass}`;
  const iconEl = document.createElement("i");
  iconEl.className = iconClass;
  iconEl.setAttribute("aria-hidden", "true");
  iconWrap.appendChild(iconEl);

  const info = document.createElement("div");
  info.appendChild(el("div", service.name, "service-title"));
  info.appendChild(el("div", latencyText, "service-desc"));

  row.appendChild(iconWrap);
  row.appendChild(info);
  card.appendChild(row);

  const footer = document.createElement("div");
  footer.style.cssText = "margin-top:12px;display:flex;justify-content:space-between;align-items:center;gap:10px;";

  const pill = document.createElement("span");
  pill.className = `pill ${service.status}`;
  pill.textContent = service.status === "up" ? "Operativo" : "Interrumpido";

  const uptimeSpan = document.createElement("span");
  uptimeSpan.style.cssText = "font-size:13px;color:rgb(148,163,184);";
  uptimeSpan.textContent = uptimeText;

  footer.appendChild(pill);
  footer.appendChild(uptimeSpan);
  card.appendChild(footer);

  card.appendChild(createHistory(service.history));

  if (Array.isArray(service.latencySparkline) && service.latencySparkline.length > 1) {
    const sparkline = createSparkline(service.latencySparkline);
    if (sparkline) card.appendChild(sparkline);
  }

  const openDetail = () => navigateToService(service.id);
  card.addEventListener("click", openDetail);
  card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(); } });

  return card;
}

/* ═══════════════════════════════════════════
   RENDER POR SECCIONES
═══════════════════════════════════════════ */
function renderBySections(sections, serviceMap, quickContainer, detailContainer) {
  quickContainer.innerHTML  = "";
  detailContainer.innerHTML = "";

  const qFrag = document.createDocumentFragment();
  const dFrag = document.createDocumentFragment();

  for (const section of sections) {
    const svcList = Object.values(serviceMap).filter(s => s.sectionId === section.id);
    if (svcList.length === 0) continue;

    qFrag.appendChild(createSectionHeader(section.name, "quick-section-header"));
    const quickGroup = document.createElement("div");
    quickGroup.className = "quick-view-group";
    svcList.forEach(svc => quickGroup.appendChild(createQuickViewCard(svc)));
    qFrag.appendChild(quickGroup);

    dFrag.appendChild(createSectionHeader(section.name, "detail-section-header"));
    const detailGroup = document.createElement("div");
    detailGroup.className = "grid section-grid";
    svcList.forEach(svc => detailGroup.appendChild(createCard(svc)));
    dFrag.appendChild(detailGroup);
  }

  quickContainer.appendChild(qFrag);
  detailContainer.appendChild(dFrag);
}