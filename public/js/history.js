/* ═══════════════════════════════════════════
   CALENDAR HISTORY — 30 días
   Formato tipo GitHub: filas = semanas, cols = día-semana
═══════════════════════════════════════════ */
const DAY_LABELS_ES = ["L", "M", "X", "J", "V", "S", "D"];

function buildCalendarHistory(container, history) {
  const histMap = {};
  for (const h of history) { if (h?.date) histMap[h.date] = h; }

  const serverNow  = getServerNow();
  const todayKey   = `${serverNow.getFullYear()}-${pad(serverNow.getMonth() + 1)}-${pad(serverNow.getDate())}`;

  // Ventana: 30 días hacia atrás
  const windowStart = new Date(serverNow);
  windowStart.setDate(windowStart.getDate() - 29);
  windowStart.setHours(0, 0, 0, 0);

  // Retroceder al lunes de esa semana (0=Dom → 6, 1=Lun → 0, ...)
  const wd0 = windowStart.getDay() === 0 ? 6 : windowStart.getDay() - 1;
  const gridStart = new Date(windowStart);
  gridStart.setDate(gridStart.getDate() - wd0);

  // Avanzar hasta el domingo de la semana actual
  const todayWd = serverNow.getDay() === 0 ? 6 : serverNow.getDay() - 1;
  const gridEnd = new Date(serverNow);
  gridEnd.setDate(gridEnd.getDate() + (6 - todayWd));
  gridEnd.setHours(23, 59, 59, 0);

  const totalDays = Math.ceil((gridEnd - gridStart) / 86_400_000) + 1;
  const numWeeks  = Math.ceil(totalDays / 7);

  // ── Cabecera día-semana ──────────────────
  const header = document.createElement("div");
  header.className = "cal-header";
  DAY_LABELS_ES.forEach(d => {
    const cell = document.createElement("div");
    cell.className = "cal-day-label";
    cell.textContent = d;
    header.appendChild(cell);
  });
  container.appendChild(header);

  // ── Grid ────────────────────────────────
  const grid = document.createElement("div");
  grid.className = "cal-grid";

  let lastMonthLabel = -1;
  const monthBreaks = []; // {weekIdx, label}

  for (let week = 0; week < numWeeks; week++) {
    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      const cellDate = new Date(gridStart);
      cellDate.setDate(gridStart.getDate() + week * 7 + dayIdx);
      cellDate.setHours(12, 0, 0, 0);

      const key = `${cellDate.getFullYear()}-${pad(cellDate.getMonth() + 1)}-${pad(cellDate.getDate())}`;
      const inWindow = cellDate >= windowStart && cellDate <= gridEnd;
      const isFuture = cellDate > serverNow;

      // Detectar inicio de mes para labels
      if (inWindow && !isFuture && dayIdx === 0 && cellDate.getMonth() !== lastMonthLabel) {
        lastMonthLabel = cellDate.getMonth();
        monthBreaks.push({ weekIdx: week, label: cellDate.toLocaleDateString("es-MX", { month: "short" }) });
      }

      const cell = document.createElement("div");

      if (!inWindow || isFuture) {
        cell.className = "cal-cell empty";
      } else {
        cell.className = "cal-cell";

        const dayNum = document.createElement("span");
        dayNum.className = "cal-day-num";
        dayNum.textContent = cellDate.getDate();
        cell.appendChild(dayNum);

        const h = histMap[key];
        if (h && typeof h.onlineper === "number") {
          let v = h.onlineper;
          if (v >= 0 && v <= 1) v *= 100;
          const cls = v >= 95 ? "excellent" : v >= 89 ? "good" : "poor";
          cell.classList.add(cls);
          const pctStr = truncate3(v).toFixed(3) + "%";
          cell.dataset.time      = key;
          cell.dataset.percent   = pctStr;
          cell.dataset.monitored = "true";
          cell.dataset.isToday   = key === todayKey ? "true" : "false";
          cell.setAttribute("aria-label", `${formatDateOnly(key)}: ${pctStr} uptime`);
        } else {
          cell.classList.add("nm");
          cell.dataset.time      = key;
          cell.dataset.monitored = "false";
          cell.dataset.isToday   = "false";
          cell.setAttribute("aria-label", `${formatDateOnly(key)}: sin datos`);
        }

        if (key === todayKey) cell.classList.add("today");

        cell.addEventListener("mouseenter", e => showTooltip(e, cell));
        cell.addEventListener("mousemove",  moveTooltip);
        cell.addEventListener("mouseleave", hideTooltip);
      }
      grid.appendChild(cell);
    }
  }
  container.appendChild(grid);

  // ── Labels de mes debajo ─────────────────
  if (monthBreaks.length) {
    const monthRow = document.createElement("div");
    monthRow.className = "cal-month-row";
    monthRow.style.gridTemplateColumns = `repeat(${numWeeks}, 1fr)`;

    for (let w = 0; w < numWeeks; w++) {
      const cell = document.createElement("div");
      cell.className = "cal-month-cell";
      const mb = monthBreaks.find(m => m.weekIdx === w);
      if (mb) cell.textContent = mb.label;
      monthRow.appendChild(cell);
    }
    container.appendChild(monthRow);
  }
}

/* ─── Versión compacta para tarjetas (barra de 30 puntos) ─── */
function createHistory(history = []) {
  const container = document.createElement("div");
  container.className = "history";
  container.setAttribute("role", "list");
  container.setAttribute("aria-label", "Historial de disponibilidad últimos 30 días");

  const serverNow    = getServerNow();
  const todayKey     = `${serverNow.getFullYear()}-${pad(serverNow.getMonth() + 1)}-${pad(serverNow.getDate())}`;
  const historyMap   = {};
  for (const h of history) { if (h?.date) historyMap[h.date] = h; }

  const fragment = document.createDocumentFragment();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(serverNow);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const h   = historyMap[key];
    const dot = document.createElement("span");
    dot.setAttribute("role", "listitem");
    const isToday = key === todayKey;
    const hasReal = h && (h.onlineper > 0 || !isToday);

    if (hasReal) {
      dot.classList.add(getUptimeClass(h.onlineper) || "poor");
      dot.dataset.time      = h.date;
      dot.dataset.percent   = formatShortPercent(h.onlineper);
      dot.dataset.monitored = "true";
      dot.dataset.isToday   = isToday ? "true" : "false";
      dot.setAttribute("aria-label", `${formatDateOnly(h.date)}: ${formatShortPercent(h.onlineper)} uptime`);
    } else {
      dot.classList.add("not-monitored");
      dot.dataset.time      = key;
      dot.dataset.percent   = "—";
      dot.dataset.monitored = "false";
      dot.dataset.isToday   = "false";
      dot.setAttribute("aria-label", `${formatDateOnly(key)}: no monitoreado`);
    }

    dot.addEventListener("mouseenter", e => showTooltip(e, dot));
    dot.addEventListener("mousemove",  moveTooltip);
    dot.addEventListener("mouseleave", hideTooltip);
    fragment.appendChild(dot);
  }
  container.appendChild(fragment);
  return container;
}

/* ═══════════════════════════════════════════
   HOURLY HISTORY — últimas 24 horas
   Usa latencySparkline como proxy de estado por hora
═══════════════════════════════════════════ */
function buildHourlyHistory(container, latencySparkline) {
  const points = Array.isArray(latencySparkline) ? latencySparkline : [];

  // Mapa: clave "YYYY-MM-DDTHH" → avgLatency
  const hourMap = {};
  for (const p of points) {
    if (p?.hour) hourMap[p.hour.slice(0, 13)] = p.avgLatency;
  }

  // Calcular umbrales de color basados en percentiles de los datos
  const vals = Object.values(hourMap).filter(v => v != null).sort((a, b) => a - b);
  const median    = vals.length ? vals[Math.floor(vals.length * 0.5)] : 150;
  const threshWarn = Math.max(median * 2.5, 300);
  const threshBad  = Math.max(median * 6,   800);

  // Últimas 24 horas completas
  const now = new Date();
  const cells = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(d.getHours() - i, 0, 0, 0);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`;
    cells.push({ key, lat: hourMap[key] ?? null, hour: d.getHours(), date: d });
  }

  // Grid de 24 celdas
  const grid = document.createElement("div");
  grid.className = "hourly-grid";

  cells.forEach(({ lat, hour, date }) => {
    const cell = document.createElement("div");
    cell.className = "hour-cell";

    if (lat == null) {
      cell.classList.add("na");
    } else if (lat <= threshWarn) {
      cell.classList.add("good");
    } else if (lat <= threshBad) {
      cell.classList.add("warn");
    } else {
      cell.classList.add("bad");
    }

    const timeLabel = date.toLocaleString("es-MX", { hour: "2-digit", minute: "2-digit", hour12: false });
    const tipText   = lat != null ? `${timeLabel} — ${lat} ms` : `${timeLabel} — sin datos`;

    cell.addEventListener("mouseenter", e => showSimpleTooltip(e, tipText));
    cell.addEventListener("mousemove",  moveTooltip);
    cell.addEventListener("mouseleave", hideTooltip);
    grid.appendChild(cell);
  });

  container.appendChild(grid);

  // Etiquetas cada 6 horas (00 / 06 / 12 / 18)
  const labelRow = document.createElement("div");
  labelRow.className = "hourly-labels";
  cells.forEach(({ hour }) => {
    const lbl = document.createElement("div");
    lbl.className = "hour-label";
    if (hour % 6 === 0) lbl.textContent = pad(hour);
    labelRow.appendChild(lbl);
  });
  container.appendChild(labelRow);
}