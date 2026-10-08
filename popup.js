const API_BASE = "https://www.geoguessr.com/api/v3";
const PATH_TOKEN_RE =
  /\/(?:game|challenge|duels|battle-royale|competitive|ranked|streak|infinity|results|party|standard)\/([A-Za-z0-9_-]+)/i;

const DRIVES_LEFT = new Set([
  "au", "bd", "bt", "bw", "cy", "fk", "gb", "gg", "gy", "hk", "ie", "im", "in",
  "je", "jp", "ke", "ki", "lk", "ls", "mo", "mg", "mt", "mu", "mw", "my", "mz",
  "na", "np", "nz", "pg", "pk", "sg", "sh", "sr", "sz", "th", "to", "tt", "tv",
  "tz", "ug", "uk", "vu", "za", "zm", "zw",
]);

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const tipsStatusEl = document.getElementById("tipsStatus");
const tipsContentEl = document.getElementById("tipsContent");

// Polling Rate - Default 12000
const PANEL_POLL_MS = 3000;
const COMPETITIVE_PATH_RE =
  /\/(competitive|ranked|duels|battle-royale)\//i;
const STORAGE_SESSION = "sessionLog";
const SESSION_MAX = 30;

const modeWarningEl = document.getElementById("modeWarning");
const sessionLogEl = document.getElementById("sessionLog");
const sessionLogListEl = document.getElementById("sessionLogList");
const clearSessionBtn = document.getElementById("clearSessionBtn");

let lastTipsContext = null;
let activeTabId = "results";
let lastRoundFingerprint = null;
let lastSessionFingerprint = null;
let locationLoadInProgress = false;
let panelWatchTimer = null;

init();

async function init() {
  setupTabs();
  startSidePanelWatch();
  await renderSessionLog();

  clearSessionBtn?.addEventListener("click", async () => {
    await chrome.storage.local.set({ [STORAGE_SESSION]: [] });
    await renderSessionLog();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "GEOHELPR_ROUND_CHANGED") return;
    if (message.fingerprint && message.fingerprint === lastRoundFingerprint) return;
    loadLocation({ auto: true });
  });

  loadLocation();
}

function updateModeWarning(tabUrl) {
  if (!modeWarningEl) return;
  const show = COMPETITIVE_PATH_RE.test(tabUrl || "");
  modeWarningEl.classList.toggle("hidden", !show);
}

async function appendSessionEntry(entry) {
  const { [STORAGE_SESSION]: log = [] } = await chrome.storage.local.get(
    STORAGE_SESSION
  );
  log.unshift({ ...entry, at: Date.now() });
  await chrome.storage.local.set({
    [STORAGE_SESSION]: log.slice(0, SESSION_MAX),
  });
  await renderSessionLog();
}

async function renderSessionLog() {
  if (!sessionLogEl || !sessionLogListEl) return;
  const { [STORAGE_SESSION]: log = [] } = await chrome.storage.local.get(
    STORAGE_SESSION
  );
  if (!log.length) {
    sessionLogEl.classList.add("hidden");
    sessionLogListEl.innerHTML = "";
    return;
  }

  sessionLogEl.classList.remove("hidden");
  sessionLogListEl.innerHTML = log
    .map(
      (item) =>
        `<li><span class="session-round">R${item.roundNumber}</span> ${escapeHtml(item.summary)}</li>`
    )
    .join("");
}

function startSidePanelWatch() {
  stopSidePanelWatch();
  panelWatchTimer = setInterval(() => checkForRoundChange(), PANEL_POLL_MS);
  document.addEventListener("visibilitychange", onPanelVisibilityChange);
}

function stopSidePanelWatch() {
  if (panelWatchTimer != null) {
    clearInterval(panelWatchTimer);
    panelWatchTimer = null;
  }
  document.removeEventListener("visibilitychange", onPanelVisibilityChange);
}

function onPanelVisibilityChange() {
  if (!document.hidden) checkForRoundChange();
}

function fingerprintFromRounds(rounds, token) {
  if (!rounds?.length) return null;
  const parts = rounds
    .map(
      (r) =>
        `${r.roundNumber}:${r.lat.toFixed(5)},${r.lng.toFixed(5)}:${r.heading ?? ""}`
    )
    .join("|");
  return `${token ?? ""}:${parts}`;
}

async function peekCurrentRounds() {
  const { token, isChallenge, tabUrl } = await resolveGameToken();
  if (!token) return null;

  const data = await fetchGameByToken(token, isChallenge, tabUrl);
  const rounds = extractRounds(data);
  if (!rounds.length) return null;

  return { token, rounds };
}

async function checkForRoundChange() {
  if (locationLoadInProgress || document.hidden) return;

  try {
    const snap = await peekCurrentRounds();
    if (!snap) return;

    const fp = fingerprintFromRounds(snap.rounds, snap.token);
    if (!fp || fp === lastRoundFingerprint) return;

    await loadLocation({ auto: true });
  } catch {
    /* fallback poll — content script is primary */
  }
}

function setupTabs() {
  const tabs = document.querySelectorAll(".tab");
  const panels = {
    results: document.getElementById("panel-results"),
    tips: document.getElementById("panel-tips"),
    help: document.getElementById("panel-help"),
  };

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const id = tab.dataset.tab;
      activeTabId = id;
      tabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle("active", active);
        t.setAttribute("aria-selected", active ? "true" : "false");
      });
      Object.entries(panels).forEach(([key, panel]) => {
        panel.classList.toggle("hidden", key !== id);
      });
      if (id === "tips") refreshTips();
    });
  });
}

function countryLabelFromContext(ctx) {
  return ctx?.countryLabel ?? ctx?.state ?? "Round";
}

function setTipsStatus(message, isError = false) {
  if (!tipsStatusEl) return;
  tipsStatusEl.textContent = message;
  tipsStatusEl.classList.toggle("error", isError);
}

function refreshTips() {
  if (!tipsContentEl) return;
  loadPlonkitTips(tipsContentEl, lastTipsContext, setTipsStatus);
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setLoading(loading) {
  resultsEl.classList.toggle("is-loading", loading);
}

async function loadLocation(options = {}) {
  const { auto = false } = options;
  if (locationLoadInProgress) return;

  locationLoadInProgress = true;
  setLoading(true);

  if (!auto) {
    resultsEl.classList.add("hidden");
    resultsEl.innerHTML = "";
    setStatus("Fetching game data (town lookup may take a few seconds)…");
  } else {
    setStatus("New round detected — updating…");
  }

  let gameToken = null;

  try {
    const { token, isChallenge, tabUrl } = await resolveGameToken();
    updateModeWarning(tabUrl);
    gameToken = token;
    if (!token) {
      throw new Error(
        "No game token found. Open an active round on geoguessr.com (e.g. /game/…), then try again."
      );
    }

    const data = await fetchGameByToken(token, isChallenge, tabUrl);
    const rounds = extractRounds(data);
    if (!rounds.length) {
      throw new Error(
        "No round coordinates found. Open an active GeoGuessr game, then try again."
      );
    }

    resultsEl.innerHTML = "";
    let primaryContext = null;
    for (const round of rounds) {
      const card = await buildRoundCard(round);
      resultsEl.appendChild(card);
      if (!primaryContext) {
        primaryContext = card.tipsContext;
      }
    }
    resultsEl.classList.remove("hidden");
    lastTipsContext = primaryContext;
    lastRoundFingerprint = fingerprintFromRounds(rounds, gameToken);

    if (lastRoundFingerprint !== lastSessionFingerprint && primaryContext) {
      const firstCard = resultsEl.querySelector(".round-card");
      await appendSessionEntry({
        roundNumber: rounds[0].roundNumber,
        summary: firstCard?.sessionSummary ?? countryLabelFromContext(primaryContext),
      });
      lastSessionFingerprint = lastRoundFingerprint;
    }

    setStatus(`Round ${rounds[0]?.roundNumber ?? "?"} ready · watching for changes`);
    refreshTips();
  } catch (err) {
    if (!auto) {
      setStatus(err.message || "Something went wrong.", true);
    }
  } finally {
    locationLoadInProgress = false;
    setLoading(false);
  }
}

async function resolveGameToken() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = tab?.url ?? "";

  let token = tokenFromUrl(tabUrl);
  let isChallenge = /\/challenge\//i.test(tabUrl);

  if (!token && tab?.id && tabUrl.includes("geoguessr.com")) {
    const fromPage = await getGameTokenFromPage(tab.id);
    token = fromPage?.token ?? null;
    if (fromPage?.isChallenge) isChallenge = true;
  }

  return { token, isChallenge, tabUrl };
}

function tokenFromUrl(url) {
  if (!url) return null;
  try {
    const path = new URL(url).pathname;
    return path.match(PATH_TOKEN_RE)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function getGameTokenFromPage(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const pathMatch = location.pathname.match(
          /\/(?:game|challenge|duels|battle-royale|competitive|ranked|streak|infinity|results|party|standard)\/([A-Za-z0-9_-]+)/i
        );
        if (pathMatch) {
          return {
            token: pathMatch[1],
            isChallenge: /\/challenge\//i.test(location.pathname),
          };
        }

        const resources = performance.getEntriesByType("resource");
        for (let i = resources.length - 1; i >= 0; i--) {
          const gameMatch = resources[i].name.match(
            /\/api\/v3\/games\/([A-Za-z0-9_-]+)/
          );
          if (gameMatch && gameMatch[1] !== "streak") {
            return { token: gameMatch[1], isChallenge: false };
          }
          const challengeMatch = resources[i].name.match(
            /\/api\/v3\/challenges\/([A-Za-z0-9_-]+)/
          );
          if (challengeMatch) {
            return { token: challengeMatch[1], isChallenge: true };
          }
        }

        const nextEl = document.getElementById("__NEXT_DATA__");
        if (nextEl?.textContent) {
          const tokens = [
            ...nextEl.textContent.matchAll(/"token":"([A-Za-z0-9_-]{8,})"/g),
          ];
          if (tokens.length) {
            return {
              token: tokens[tokens.length - 1][1],
              isChallenge: /challenge/i.test(location.pathname),
            };
          }
        }

        return null;
      },
    });
    return result ?? null;
  } catch {
    return null;
  }
}

function gameApiUrl(token, isChallenge) {
  const segment = isChallenge ? "challenges" : "games";
  return `${API_BASE}/${segment}/${token}`;
}

async function fetchGameByToken(token, isChallenge, tabUrl) {
  let data = await fetchJson(gameApiUrl(token, isChallenge));

  if (!hasRoundData(data) && isChallenge) {
    data = await fetchJson(`${API_BASE}/games/${token}`);
  } else if (!hasRoundData(data) && /challenge/i.test(tabUrl)) {
    data = await fetchJson(`${API_BASE}/challenges/${token}`);
  }

  return data;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/json",
      Referer: "https://www.geoguessr.com/",
    },
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("Not signed in. Log in at geoguessr.com and try again.");
    }
    if (response.status === 405) {
      throw new Error(
        "API method not allowed. Reload the game page and try again."
      );
    }
    if (response.status === 404) {
      throw new Error("Game not found. The round may have ended — start a new game.");
    }
    throw new Error(`API returned ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  if (!text.trim()) {
    throw new Error("Empty API response. Start a game on GeoGuessr first.");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Could not parse API response as JSON.");
  }
}

function hasRoundData(data) {
  return extractRounds(data).length > 0;
}

function extractRounds(data) {
  const games = normalizeGames(data);
  const rounds = [];

  for (const game of games) {
    const gameRounds = game?.rounds;
    if (!Array.isArray(gameRounds) || !gameRounds.length) continue;

    const currentIndex = Math.max(0, (Number(game.round) || 1) - 1);
    const showAll = gameRounds.length <= 1 || game.state === "finished";

    const push = (r, i) => {
      if (!isValidCoord(r)) return;
      rounds.push({
        roundNumber: i + 1,
        lat: r.lat,
        lng: r.lng,
        heading: r.heading,
        countryCode: pickCountryCode(r),
        gameToken: game.token,
        guessInfo: extractGuessInfo(r),
      });
    };

    if (showAll) {
      gameRounds.forEach((r, i) => push(r, i));
    } else {
      const r = gameRounds[currentIndex] ?? gameRounds[gameRounds.length - 1];
      push(r, currentIndex);
    }
  }

  return rounds;
}

function normalizeGames(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.games)) return data.games;
  if (Array.isArray(data.items)) return data.items;
  if (data.rounds) return [data];
  return [data];
}

function pickCountryCode(round) {
  return round?.streakLocationCode || round?.countryCode || null;
}

function isValidCoord(round) {
  return (
    round &&
    typeof round.lat === "number" &&
    typeof round.lng === "number" &&
    Number.isFinite(round.lat) &&
    Number.isFinite(round.lng)
  );
}

async function buildRoundCard({
  roundNumber,
  lat,
  lng,
  heading,
  countryCode,
  gameToken,
  guessInfo,
}) {
  const card = document.createElement("article");
  card.className = "round-card";

  const [geo, elevationM] = await Promise.all([
    reverseGeocode(lat, lng),
    fetchElevation(lat, lng),
  ]);

  const resolvedCode =
    countryCode?.toLowerCase() || geo.countryCode?.toLowerCase() || null;
  const countryLabel = formatCountry(resolvedCode);
  const townLabel = geo.town ?? "Unknown";
  const stateLabel = geo.state ?? "—";
  const hemisphere = formatHemisphere(lat, lng);
  const drivingSide = formatDrivingSide(resolvedCode);
  const headingLabel = formatHeading(heading);
  const countryPosition =
    formatCountryPosition(lat, lng, resolvedCode, stateLabel) ?? "—";
  const elevationLabel = formatElevation(elevationM) ?? "—";
  const capitalDistance =
    formatDistanceToCapital(lat, lng, resolvedCode) ?? "—";
  const guessReview = formatGuessReview(lat, lng, guessInfo);
  const coordText = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  const mapEmbed = osmEmbedUrl(lat, lng);

  const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
  const osmUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=14/${lat}/${lng}`;
  const plonkitUrl = plonkitGuideUrl(resolvedCode);
  const geohints = geohintsUrl(resolvedCode);

  const headingRow = headingLabel
    ? `<div class="row"><dt>Camera heading</dt><dd class="mono">${escapeHtml(headingLabel)}</dd></div>`
    : "";

  const stateRow = stateRowVisible(stateLabel, countryPosition)
    ? `<div class="row"><dt>State / region</dt><dd>${escapeHtml(stateLabel)}</dd></div>`
    : "";

  const guessRow = guessReview
    ? `<div class="guess-review"><strong>Your guess:</strong> ${escapeHtml(guessReview)}</div>`
    : "";

  card.sessionSummary = `${countryPosition} · ${townLabel}`;

  card.innerHTML = `
    <div class="round-header">
      <p class="round-label">Round ${roundNumber}${gameToken ? ` · ${escapeHtml(gameToken.slice(0, 8))}…` : ""}</p>
    </div>
    <div class="round-map">
      <iframe title="Round location map" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="${escapeHtml(mapEmbed)}"></iframe>
    </div>
    ${guessRow}
    <dl>
      <div class="row">
        <dt>Nearest town</dt>
        <dd class="highlight-alt">${escapeHtml(townLabel)}</dd>
      </div>
      <div class="row">
        <dt>Country</dt>
        <dd class="highlight">${escapeHtml(countryLabel)}</dd>
      </div>
      <div class="row">
        <dt>Position in country</dt>
        <dd class="highlight">${escapeHtml(countryPosition)}</dd>
      </div>
      ${stateRow}
      <div class="row">
        <dt>Elevation</dt>
        <dd>${escapeHtml(elevationLabel)}</dd>
      </div>
      <div class="row">
        <dt>Distance to capital</dt>
        <dd>${escapeHtml(capitalDistance)}</dd>
      </div>
      <div class="row">
        <dt>Hemisphere</dt>
        <dd>${escapeHtml(hemisphere)}</dd>
      </div>
      <div class="row">
        <dt>Driving side</dt>
        <dd>${escapeHtml(drivingSide)}</dd>
      </div>
      ${headingRow}
      <div class="row">
        <dt>Coordinates</dt>
        <dd class="mono">${coordText}</dd>
      </div>
    </dl>
    <div class="actions">
      <button type="button" data-copy="${escapeHtml(coordText)}">Copy coords</button>
      <button type="button" data-copy="${escapeHtml(townLabel)}">Copy town</button>
      <button type="button" data-copy="${escapeHtml(countryLabel)}">Copy country</button>
      <button type="button" data-open="${escapeHtml(mapsUrl)}">Google Maps</button>
      <button type="button" data-open="${escapeHtml(osmUrl)}">OpenStreetMap</button>
      <button type="button" data-open="${escapeHtml(plonkitUrl)}">Plonkit guide</button>
      <button type="button" data-open="${escapeHtml(geohints)}">GeoHints</button>
    </div>
  `;

  wireCopyButtons(card);
  card.querySelectorAll("[data-open]").forEach((btn) => {
    btn.addEventListener("click", () => chrome.tabs.create({ url: btn.dataset.open }));
  });

  card.tipsContext = {
    countryCode: resolvedCode,
    countryLabel,
    state: stateLabel,
    lat,
    lng,
  };

  return card;
}

function wireCopyButtons(card) {
  card.querySelectorAll("[data-copy]").forEach((btn) => {
    const label = btn.textContent;
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = "Copied!";
      setTimeout(() => {
        btn.textContent = label;
      }, 1200);
    });
  });
}

function formatCountry(code) {
  if (!code) return "Unknown";
  const upper = code.toUpperCase();
  try {
    const name = regionNames.of(upper);
    return name ? `${name} (${upper})` : upper;
  } catch {
    return upper;
  }
}

function formatHemisphere(lat, lng) {
  const ns = lat >= 0 ? "Northern" : "Southern";
  const ew = lng >= 0 ? "Eastern" : "Western";
  return `${ns} · ${ew}`;
}

function formatDrivingSide(countryCode) {
  if (!countryCode) return "Unknown";
  return DRIVES_LEFT.has(countryCode.toLowerCase())
    ? "Left-hand traffic"
    : "Right-hand traffic";
}

function formatHeading(degrees) {
  if (degrees == null || !Number.isFinite(degrees)) return null;
  const norm = ((degrees % 360) + 360) % 360;
  const ix = Math.round(norm / 45) % 8;
  return `${Math.round(norm)}° (${COMPASS[ix]})`;
}

const geocodeCache = new Map();
let lastNominatimAt = 0;

const PLACE_RANK = {
  city: 6,
  town: 5,
  municipality: 5,
  borough: 4,
  city_district: 4,
  county: 3,
  suburb: 3,
  quarter: 2,
  village: 1,
  hamlet: 0,
  isolated_dwelling: 0,
};

async function reverseGeocode(lat, lng) {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  try {
    const local = await nominatimReverse(lat, lng, 14);
    const regional = await nominatimReverse(lat, lng, 10);
    const wider = await nominatimReverse(lat, lng, 8);

    let town = pickNearestBigTown([
      wider?.address,
      regional?.address,
      local?.address,
    ]);
    if (town === "Unknown") {
      const label = regional?.display_name || local?.display_name;
      if (label) town = label.split(",")[0].trim();
    }

    const state = pickState(regional?.address || local?.address || wider?.address);

    const result = {
      countryCode:
        local?.address?.country_code ??
        regional?.address?.country_code ??
        wider?.address?.country_code ??
        null,
      town,
      state: state ?? "—",
    };
    geocodeCache.set(key, result);
    return result;
  } catch {
    return { countryCode: null, town: "Unknown", state: "—" };
  }
}

function pickState(address) {
  if (!address) return null;
  return (
    address.state ||
    address.region ||
    address.province ||
    address.state_district ||
    address.county ||
    null
  );
}

function pickNearestBigTown(addresses) {
  const candidates = [];

  for (const address of addresses) {
    if (!address) continue;
    for (const [type, rank] of Object.entries(PLACE_RANK)) {
      const name = address[type];
      if (name) candidates.push({ name, rank });
    }
  }

  if (!candidates.length) return "Unknown";

  candidates.sort((a, b) => b.rank - a.rank);
  const bestRank = candidates[0].rank;

  if (bestRank >= 5) return candidates[0].name;

  const big = candidates.find((c) => c.rank >= 5);
  if (big) return big.name;

  const medium = candidates.find((c) => c.rank >= 3);
  if (medium) return medium.name;

  return candidates[0].name;
}

async function nominatimReverse(lat, lng, zoom) {
  const now = Date.now();
  const wait = Math.max(0, 1100 - (now - lastNominatimAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatimAt = Date.now();

  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "json");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("zoom", String(zoom));
  url.searchParams.set("addressdetails", "1");

  const res = await fetch(url, {
    headers: {
      "Accept-Language": "en",
      "User-Agent": "GeoHelpr/2.0",
    },
  });
  if (!res.ok) return null;
  return res.json();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
