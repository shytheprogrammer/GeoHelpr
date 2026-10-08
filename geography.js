function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const elevationCache = new Map();

async function fetchElevation(lat, lng) {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  if (elevationCache.has(key)) return elevationCache.get(key);

  try {
    const url = new URL("https://api.open-meteo.com/v1/elevation");
    url.searchParams.set("latitude", String(lat));
    url.searchParams.set("longitude", String(lng));

    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const meters = data?.elevation?.[0];
    if (meters == null || !Number.isFinite(meters)) return null;

    const rounded = Math.round(meters);
    elevationCache.set(key, rounded);
    return rounded;
  } catch {
    return null;
  }
}

function formatElevation(meters) {
  if (meters == null) return null;
  if (Math.abs(meters) < 5) return "Near sea level";
  return `${meters.toLocaleString()} m`;
}

function formatDistanceToCapital(lat, lng, countryCode) {
  const code = normalizeCountryCode(countryCode);
  const cap = code ? COUNTRY_CAPITALS[code] : null;
  if (!cap) return null;

  const [cLat, cLng, name] = cap;
  const km = haversineKm(lat, lng, cLat, cLng);
  return `${Math.round(km).toLocaleString()} km from ${name}`;
}

function osmEmbedUrl(lat, lng) {
  const pad = 0.12 / Math.cos((lat * Math.PI) / 180);
  const west = lng - pad;
  const east = lng + pad;
  const south = lat - pad * 0.75;
  const north = lat + pad * 0.75;
  const bbox = `${west}%2C${south}%2C${east}%2C${north}`;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat}%2C${lng}`;
}

function extractGuessInfo(round) {
  let guess = round?.guess ?? round?.playerGuess;
  if (Array.isArray(round?.guesses) && round.guesses.length) {
    const last = round.guesses[round.guesses.length - 1];
    guess = last?.location ?? last;
  }

  let guessLat = null;
  let guessLng = null;
  if (guess && typeof guess.lat === "number" && typeof guess.lng === "number") {
    guessLat = guess.lat;
    guessLng = guess.lng;
  }

  let distance =
    round?.distance ??
    round?.distanceInMeters ??
    guess?.distance ??
    guess?.distanceInMeters;
  if (typeof distance === "number" && distance > 50000) {
    distance = distance / 1000;
  }

  const score = round?.score ?? round?.points ?? guess?.score ?? guess?.points;

  return { guessLat, guessLng, distance, score };
}

function formatGuessReview(lat, lng, guessInfo) {
  const { guessLat, guessLng, distance, score } = guessInfo ?? {};
  const parts = [];

  let distKm = distance;
  if (distKm == null && guessLat != null && guessLng != null) {
    distKm = haversineKm(lat, lng, guessLat, guessLng);
  }
  if (typeof distKm === "number" && Number.isFinite(distKm)) {
    parts.push(`${Math.round(distKm).toLocaleString()} km off`);
  }
  if (typeof score === "number" && Number.isFinite(score)) {
    parts.push(`${Math.round(score).toLocaleString()} pts`);
  }

  return parts.length ? parts.join(" · ") : null;
}

function stateRowVisible(stateLabel, countryPosition) {
  if (!hasUsefulState(stateLabel)) return false;
  const state = String(stateLabel).trim();
  if (countryPosition === state) return false;
  if (countryPosition?.includes(state)) return false;
  return true;
}

function plonkitGuideUrl(countryCode) {
  return "https://www.plonkit.net/guide";
}

function geohintsUrl(countryCode) {
  const code = (countryCode || "").toLowerCase();
  if (!code) return "https://geohints.com/";
  return `https://geohints.com/${code}`;
}
