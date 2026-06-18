/* ═══════════════════════════════════════════
   INCIDENTS
═══════════════════════════════════════════ */

function renderIncidentCard(inc, collapsed = false) {
  const card = document.createElement("div");
  card.className = `incident-card status-${esc(inc.status)}`;

  const header = document.createElement("div");
  header.className = "incident-header";
  header.appendChild(el("div", inc.title, "incident-title"));
  header.appendChild(incidentBadgeEl(inc.status));
  card.appendChild(header);

  const duration = inc.resolvedAt
    ? ` • Duración: ${formatDuration(inc.createdAt, inc.resolvedAt)}`
    : "";

  const metaEl = document.createElement("div");
  metaEl.className = "incident-meta";
  metaEl.textContent = `${formatRelative(inc.createdAt)} • ${formatDate(inc.createdAt)}${duration}`;
  if (inc.serviceName) metaEl.textContent += ` • ${inc.serviceName}`;
  card.appendChild(metaEl);

  if (!collapsed) {
    const updates = [...(inc.updates ?? [])].reverse();
    if (updates.length > 0) {
      const updatesContainer = document.createElement("div");
      updatesContainer.className = "incident-updates";
      updates.forEach(u => {
        const updateEl = document.createElement("div");
        updateEl.className = "incident-update";
        updateEl.appendChild(el("div", BADGE_MAP[u.status]?.label ?? esc(u.status), "incident-update-status"));
        updateEl.appendChild(el("div", u.message, "incident-update-msg"));
        updateEl.appendChild(el("div", formatDate(u.at), "incident-update-time"));
        updatesContainer.appendChild(updateEl);
      });
      card.appendChild(updatesContainer);
    }
  }
  return card;
}

function renderIncidents(incidents) {
  const incidentsSection = document.getElementById("incidents-section");
  const incidentsHistory = document.getElementById("incidents-history");
  if (!incidentsSection) return;
  incidentsSection.innerHTML = "";

  const active   = (incidents ?? []).filter(i => !i.resolvedAt);
  const resolved = (incidents ?? [])
    .filter(i => i.resolvedAt)
    .sort((a, b) => new Date(b.resolvedAt) - new Date(a.resolvedAt))
    .slice(0, 10);

  if (active.length > 0) {
    const section = document.createElement("div");
    section.className = "incidents-active-section";

    const title = document.createElement("div");
    title.className = "incidents-section-title";
    const icon = document.createElement("i");
    icon.className = "fa-solid fa-triangle-exclamation";
    icon.setAttribute("aria-hidden", "true");
    title.appendChild(icon);
    title.appendChild(document.createTextNode(" Incidentes activos"));
    section.appendChild(title);

    active.forEach(inc => section.appendChild(renderIncidentCard(inc)));
    incidentsSection.appendChild(section);
  }

  if (!incidentsHistory) return;
  incidentsHistory.innerHTML = "";

  if (resolved.length > 0) {
    const section = document.createElement("div");
    section.className = "incidents-history-section";

    const titleRow = document.createElement("div");
    titleRow.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;";
    const sectionTitle = document.createElement("div");
    sectionTitle.className = "incidents-section-title";
    sectionTitle.style.margin = "0";
    const histIcon = document.createElement("i");
    histIcon.className = "fa-solid fa-clock-rotate-left";
    histIcon.setAttribute("aria-hidden", "true");
    sectionTitle.appendChild(histIcon);
    sectionTitle.appendChild(document.createTextNode(" Historial reciente"));
    titleRow.appendChild(sectionTitle);
    section.appendChild(titleRow);

    section.appendChild(renderIncidentCard(resolved[0], false));

    if (resolved.length > 1) {
      const remaining = resolved.length - 1;
      const rest = document.createElement("div");
      rest.hidden = true;
      resolved.slice(1).forEach(inc => rest.appendChild(renderIncidentCard(inc, true)));

      const toggle = document.createElement("button");
      toggle.className = "incidents-history-toggle";
      let expanded = false;
      const updateLabel = () => {
        toggle.innerHTML = "";
        const chevron = document.createElement("i");
        chevron.className = expanded ? "fa-solid fa-chevron-up" : "fa-solid fa-chevron-down";
        chevron.setAttribute("aria-hidden", "true");
        toggle.appendChild(chevron);
        toggle.appendChild(document.createTextNode(
          expanded
            ? " Mostrar menos"
            : ` Ver ${remaining} incidente${remaining > 1 ? "s" : ""} anterior${remaining > 1 ? "es" : ""}`
        ));
      };
      updateLabel();
      toggle.addEventListener("click", () => { expanded = !expanded; rest.hidden = !expanded; updateLabel(); });

      section.appendChild(rest);
      section.appendChild(toggle);
    }

    incidentsHistory.appendChild(section);
  }
}