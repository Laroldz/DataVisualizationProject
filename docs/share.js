// Save & share: copyable links that reopen a drive or county with the same settings, plus a saved
// "usual drive" and "my area" remembered in this browser. Uses helpers from main.js, county.js, route.js.

const SAVED_DRIVE = "tfe-my-drive", SAVED_AREA = "tfe-my-area";
const DRIVE_FIELDS = { from: "r-from", to: "r-to", day: "r-day", time: "r-time", season: "r-season", within: "r-buffer" };

function store(key, value) {
  try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
function stored(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function driveSettings() {
  return Object.fromEntries(Object.entries(DRIVE_FIELDS).map(([k, id]) => [k, $(id).value]));
}
function fillDrive(settings) {
  for (const [k, id] of Object.entries(DRIVE_FIELDS)) {
    if (settings[k] != null && settings[k] !== "") $(id).value = settings[k];
  }
}

// Links look like  page#share&from=...&to=...&day=weekday&years=2020-2024  or  page#share&county=48201
function shareLink(params) {
  const q = new URLSearchParams({ ...params, years: `${ui.y0.value}-${ui.y1.value}` });
  return `${location.origin}${location.pathname}#share&${q}`;
}

async function copyLink(url, msgEl) {
  try {
    await navigator.clipboard.writeText(url);
    msgEl.textContent = "Link copied.";
  } catch {
    // Clipboard blocked (e.g. not https): show the link so it can be copied by hand.
    msgEl.innerHTML = `Copy this link: <input class="share-input" readonly value="${url.replace(/"/g, "&quot;")}">`;
    msgEl.querySelector("input").select();
  }
  setTimeout(() => { if (msgEl.textContent === "Link copied.") msgEl.textContent = ""; }, 4000);
}

function updateAreaButton() {
  const saved = stored(SAVED_AREA);
  const here = detail.fips;
  $("save-area").textContent = saved && saved.fips === here ? "★ My area (saved)" : "☆ Save as my area";
}

function initShare() {
  $("share-drive").addEventListener("click", () => copyLink(shareLink(driveSettings()), $("share-msg")));
  $("save-drive").addEventListener("click", () => {
    store(SAVED_DRIVE, driveSettings());
    $("share-msg").textContent = "Saved. This drive will be filled in next time you open the page.";
  });
  $("share-area").addEventListener("click", () => {
    if (!detail.fips) return;
    copyLink(shareLink({ county: detail.fips }), $("area-msg"));
  });
  $("save-area").addEventListener("click", () => {
    if (!detail.fips) return;
    const saved = stored(SAVED_AREA);
    store(SAVED_AREA, saved && saved.fips === detail.fips ? null : { fips: detail.fips });
    updateAreaButton();
  });
  new MutationObserver(updateAreaButton).observe($("d-title"), { childList: true });

  // A shared link wins; otherwise restore what this browser saved.
  const hash = location.hash;
  if (hash.startsWith("#share")) {
    const p = new URLSearchParams(hash.slice("#share".length).replace(/^&/, ""));
    const [y0, y1] = (p.get("years") ?? "").split("-").map(Number);
    if (y0 >= FIRST_YEAR && y1 <= LAST_YEAR && y0 <= y1) { ui.y0.value = y0; ui.y1.value = y1; render(); }
    if (p.get("county")) goToPlace({ level: "county", id: +p.get("county") }, $("detail"));
    if (p.get("from") && p.get("to")) {
      fillDrive(Object.fromEntries(p));
      reveal($("g-drive"));
      findRoute();
    }
    return;
  }
  $("forget-drive").addEventListener("click", () => { store(SAVED_DRIVE, null); $("drive-saved").hidden = true; });
  const drive = stored(SAVED_DRIVE);
  if (drive) {
    fillDrive(drive);
    $("drive-saved").hidden = false;
  }
  const area = stored(SAVED_AREA);
  if (area?.fips) goToPlace({ level: "county", id: area.fips }, null);
}
