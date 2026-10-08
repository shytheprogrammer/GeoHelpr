// Polling Rate - Default 800
const POLL_MS = 800;

let lastFingerprint = null;

function getGameFromPage() {
  const nextEl = document.getElementById("__NEXT_DATA__");
  if (nextEl?.textContent) {
    try {
      const data = JSON.parse(nextEl.textContent);
      const pp = data?.props?.pageProps ?? {};
      return pp.game ?? pp.challenge?.game ?? pp.challenge ?? null;
    } catch {
      /* fall through */
    }
  }

  const resources = performance.getEntriesByType("resource");
  for (let i = resources.length - 1; i >= 0; i--) {
    const m = resources[i].name.match(
      /geoguessr\.com\/api\/v3\/(?:games|challenges)\/([A-Za-z0-9_-]+)/i
    );
    if (m && m[1] !== "streak") {
      return { token: m[1], fromNetwork: true };
    }
  }

  const pathMatch = location.pathname.match(
    /\/(?:game|challenge|duels|battle-royale|competitive|ranked|streak|infinity|results|party|standard)\/([A-Za-z0-9_-]+)/i
  );
  if (pathMatch) {
    return { token: pathMatch[1], pathnameOnly: true };
  }

  return null;
}

function fingerprintFromGame(game) {
  if (!game?.rounds?.length) return null;

  const index = Math.max(0, (Number(game.round) || 1) - 1);
  const r = game.rounds[index] ?? game.rounds[game.rounds.length - 1];
  if (typeof r?.lat !== "number" || typeof r?.lng !== "number") return null;

  const token = game.token ?? "";
  return `${token}:${index + 1}:${r.lat.toFixed(5)},${r.lng.toFixed(5)}:${r.heading ?? ""}`;
}

function checkAndNotify() {
  const game = getGameFromPage();
  if (!game) return;

  const fp = fingerprintFromGame(game);
  if (!fp || fp === lastFingerprint) return;

  lastFingerprint = fp;
  chrome.runtime
    .sendMessage({ type: "GEOHELPR_ROUND_CHANGED", fingerprint: fp })
    .catch(() => {});
}

function startWatching() {
  checkAndNotify();
  setInterval(checkAndNotify, POLL_MS);

  const nextEl = document.getElementById("__NEXT_DATA__");
  if (nextEl) {
    new MutationObserver(checkAndNotify).observe(nextEl, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  const origPushState = history.pushState;
  history.pushState = function (...args) {
    origPushState.apply(this, args);
    checkAndNotify();
  };
  window.addEventListener("popstate", checkAndNotify);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startWatching);
} else {
  startWatching();
}
