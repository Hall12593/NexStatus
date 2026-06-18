/* ═══════════════════════════════════════════
   LATENCY SPARKLINE
═══════════════════════════════════════════ */
function createSparkline(data) {
  const points = data.filter(d => d.avgLatency != null);
  if (points.length < 2) return null;

  const wrap = document.createElement("div");
  wrap.className = "sparkline-wrap";

  const values  = points.map(p => p.avgLatency);
  const minVal  = Math.min(...values);
  const maxVal  = Math.max(...values);
  const range   = maxVal - minVal || 1;

  const W = 300, H = 32, PAD = 2;
  const normalize = v => H - PAD - ((v - minVal) / range) * (H - PAD * 2);
  const step    = (W - PAD * 2) / (points.length - 1);
  const coords  = points.map((p, i) => [PAD + i * step, normalize(p.avgLatency)]);
  const linePts = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaD   = `M${coords[0][0].toFixed(1)},${H} ` +
    coords.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(" ") +
    ` L${coords[coords.length - 1][0].toFixed(1)},${H} Z`;
  const lastPt  = coords[coords.length - 1];
  const avgLat  = Math.round(values.reduce((a, b) => a + b) / values.length);

  // Label
  const labelDiv = document.createElement("div");
  labelDiv.className = "sparkline-label";
  labelDiv.appendChild(el("span", "Latencia 24h"));

  const avgLabel = document.createElement("span");
  avgLabel.className = "sparkline-avg-label";
  avgLabel.style.cursor = "help";
  avgLabel.textContent = `${avgLat} ms promedio`;
  avgLabel.addEventListener("mouseenter", e => showSimpleTooltip(e, `Promedio últimas 24h: ${avgLat} ms\nMín: ${minVal} ms  Máx: ${maxVal} ms`));
  avgLabel.addEventListener("mousemove",  moveTooltip);
  avgLabel.addEventListener("mouseleave", hideTooltip);
  labelDiv.appendChild(avgLabel);
  wrap.appendChild(labelDiv);

  // SVG
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "sparkline-svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Gráfica de latencia promedio: ${avgLat} ms`);

  const defs = document.createElementNS(NS, "defs");
  const grad = document.createElementNS(NS, "linearGradient");
  grad.setAttribute("id", "sparkGrad");
  grad.setAttribute("x1", "0"); grad.setAttribute("y1", "0");
  grad.setAttribute("x2", "0"); grad.setAttribute("y2", "1");
  const stop1 = document.createElementNS(NS, "stop");
  stop1.setAttribute("offset", "0%"); stop1.setAttribute("stop-color", "rgba(56,189,248,.25)");
  const stop2 = document.createElementNS(NS, "stop");
  stop2.setAttribute("offset", "100%"); stop2.setAttribute("stop-color", "rgba(56,189,248,0)");
  grad.appendChild(stop1); grad.appendChild(stop2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  const area = document.createElementNS(NS, "path");
  area.setAttribute("class", "sparkline-area"); area.setAttribute("d", areaD);
  svg.appendChild(area);

  const line = document.createElementNS(NS, "polyline");
  line.setAttribute("class", "sparkline-line"); line.setAttribute("points", linePts);
  svg.appendChild(line);

  // Hover dots
  coords.forEach(([x, y], i) => {
    const hd = document.createElementNS(NS, "circle");
    hd.setAttribute("cx", x.toFixed(1)); hd.setAttribute("cy", y.toFixed(1));
    hd.setAttribute("r", "5");
    hd.style.opacity = "0"; hd.style.cursor = "crosshair";
    const ms   = points[i].avgLatency;
    const hour = points[i].hour ? points[i].hour.replace("T", " ").substring(0, 16) : "—";
    hd.addEventListener("mouseenter", e => { showSimpleTooltip(e, `${ms} ms • ${hour}`); hd.style.opacity = "0.6"; });
    hd.addEventListener("mousemove",  moveTooltip);
    hd.addEventListener("mouseleave", () => { hideTooltip(); hd.style.opacity = "0"; });
    svg.appendChild(hd);
  });

  // Envolver SVG en div relativo para superponer el dot como HTML
  // (un <div> no hereda el transform preserveAspectRatio="none" del SVG)
  const svgWrap = document.createElement("div");
  svgWrap.style.cssText = "position:relative;";
  svgWrap.appendChild(svg);

  // X: porcentaje sobre el ancho real del contenedor (escala igual que el SVG)
  // Y: píxeles directos — el viewBox H == CSS H == 32, mapeo 1:1
  const rightPct = ((W - lastPt[0]) / W * 100).toFixed(2);
  const dotDiv = document.createElement("div");
  dotDiv.className = "sparkline-dot";
  dotDiv.style.cssText = `position:absolute;right:${rightPct}%;top:${(lastPt[1] - 4).toFixed(1)}px;pointer-events:none;`;
  svgWrap.appendChild(dotDiv);

  wrap.appendChild(svgWrap);
  return wrap;
}