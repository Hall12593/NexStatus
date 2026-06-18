/* ═══════════════════════════════════════════
   ANNOUNCEMENTS
═══════════════════════════════════════════ */
const ANN_ICON = {
  maintenance: "fa-solid fa-wrench",
  incident:    "fa-solid fa-triangle-exclamation",
  info:        "fa-solid fa-circle-info",
};

const DISMISSED_KEY = "nexora_dismissed_anns";

function getDismissed() {
  try { return JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? "[]"); }
  catch { return []; }
}

function dismiss(id) {
  const d = getDismissed();
  if (!d.includes(id)) {
    d.push(id);
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(d));
  }
}

function renderAnnouncements(announcements) {
  const bar = document.getElementById("announcements-bar");
  if (!bar) return;
  bar.innerHTML = "";

  const dismissed = getDismissed();
  const active = (announcements ?? []).filter(a => {
    if (!a?.id || !a?.title) return false;
    if (dismissed.includes(a.id)) return false;
    if (a.endsAt && new Date(a.endsAt) < new Date()) return false;
    return true;
  });

  const fragment = document.createDocumentFragment();
  active.forEach(a => {
    const annEl = document.createElement("div");
    annEl.className = `announcement announcement-${esc(a.type ?? "info")}`;

    const iconClass = FA_CLASS_RE.test(ANN_ICON[a.type]) ? ANN_ICON[a.type] : "fa-solid fa-bell";
    const iconEl = document.createElement("i");
    iconEl.className = `ann-icon ${iconClass}`;
    iconEl.setAttribute("aria-hidden", "true");
    annEl.appendChild(iconEl);

    const content = document.createElement("div");
    content.className = "announcement-content";
    content.appendChild(el("div", a.title, "announcement-title"));
    if (a.body) content.appendChild(el("div", a.body, "announcement-body"));
    if (a.endsAt) content.appendChild(el("div", `Hasta: ${formatDate(a.endsAt)}`, "announcement-meta"));
    annEl.appendChild(content);

    const closeBtn = document.createElement("button");
    closeBtn.className = "announcement-close";
    closeBtn.setAttribute("aria-label", "Cerrar anuncio");
    const closeIcon = document.createElement("i");
    closeIcon.className = "fa-solid fa-xmark";
    closeIcon.setAttribute("aria-hidden", "true");
    closeBtn.appendChild(closeIcon);
    closeBtn.addEventListener("click", () => { dismiss(a.id); annEl.remove(); });
    annEl.appendChild(closeBtn);

    fragment.appendChild(annEl);
  });
  bar.appendChild(fragment);
}