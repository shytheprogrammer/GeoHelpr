const PLONKIT_BASE = "https://www.plonkit.net";
const INDEX_CACHE_KEY = "plonkitGuideIndex";
const GUIDE_CACHE_PREFIX = "plonkitGuide:";
const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GUIDE_TTL_MS = 24 * 60 * 60 * 1000;

const CODE_ALIASES = { UK: "GB" };

const US_REGION_BY_STATE = [
  { pattern: /\balaska\b/i, slug: "alaska" },
  { pattern: /\bhawaii\b/i, slug: "hawaii" },
  { pattern: /\bpuerto rico\b/i, slug: "puerto-rico" },
];

function parsePreloadedJson(html) {
  const match = html.match(
    /<script id="__PRELOADED_DATA__"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!match) return null;
  try {
    const payload = JSON.parse(match[1]);
    return payload?.success ? payload.data : null;
  } catch {
    return null;
  }
}

async function fetchPlonkitHtml(path) {
  const url = path.startsWith("http") ? path : `${PLONKIT_BASE}${path}`;
  const response = await fetch(url, {
    headers: { Accept: "text/html", "User-Agent": "GeoHelpr/2.0" },
  });
  if (!response.ok) {
    throw new Error(`Plonkit returned ${response.status}`);
  }
  return response.text();
}

async function getCachedEntry(key) {
  const stored = await chrome.storage.local.get(key);
  const entry = stored[key];
  if (!entry || Date.now() - entry.at > entry.ttl) return null;
  return entry.value;
}

async function setCachedEntry(key, value, ttl) {
  await chrome.storage.local.set({
    [key]: { value, at: Date.now(), ttl },
  });
}

async function getGuideIndex() {
  const cached = await getCachedEntry(INDEX_CACHE_KEY);
  if (cached) return cached;

  const html = await fetchPlonkitHtml("/guide");
  const data = parsePreloadedJson(html);
  if (!Array.isArray(data)) {
    throw new Error("Could not read Plonkit country list.");
  }

  const index = data
    .filter((row) => row.slug && row.code && !row.code.startsWith("XX-"))
    .map((row) => ({
      code: String(row.code).toUpperCase(),
      slug: row.slug,
      title: row.title,
    }));

  await setCachedEntry(INDEX_CACHE_KEY, index, INDEX_TTL_MS);
  return index;
}

function resolveGuideSlug(index, countryCode, stateLabel) {
  const code = (countryCode || "").toUpperCase();
  const state = stateLabel && stateLabel !== "—" ? stateLabel : "";

  if (code === "US" && state) {
    for (const region of US_REGION_BY_STATE) {
      if (region.pattern.test(state)) return region.slug;
    }
  }

  const normalized = CODE_ALIASES[code] || code;
  const direct = index.find((row) => row.code === normalized);
  if (direct) return direct.slug;

  return null;
}

function indexEntryForSlug(index, slug) {
  return index.find((row) => row.slug === slug) ?? null;
}

async function fetchCountryGuide(slug) {
  const cacheKey = `${GUIDE_CACHE_PREFIX}${slug}`;
  const cached = await getCachedEntry(cacheKey);
  if (cached) return cached;

  const html = await fetchPlonkitHtml(`/${slug}`);
  const data = parsePreloadedJson(html);
  const guide = data?.public ?? data;
  if (!guide?.steps) {
    throw new Error("Could not read guide content from Plonkit.");
  }

  await setCachedEntry(cacheKey, guide, GUIDE_TTL_MS);
  return guide;
}

function extractTipsFromSteps(steps) {
  const sections = [];

  for (const step of steps || []) {
    if (step.kind !== "tip" || !step.title) continue;

    const section = { title: step.title, tips: [] };
    for (const item of step.items || []) {
      if (item.kind === "tip" && item.data?.text?.length) {
        section.tips.push({
          text: item.data.text.join("\n"),
          imageUrl: item.data.image?.imageUrl ?? null,
          mapLink: item.data.image?.imageLink ?? null,
        });
      }
    }
    if (section.tips.length) sections.push(section);
  }

  return sections;
}

function stateMatchers(stateLabel) {
  if (!stateLabel || stateLabel === "—") return [];
  const matchers = [new RegExp(`\\b${escapeRegExp(stateLabel)}\\b`, "i")];
  const short = stateLabel.match(/\(([A-Z]{2})\)\s*$/);
  if (short) {
    matchers.push(new RegExp(`\\b${short[1]}\\b`, "i"));
  }
  return matchers;
}

function tipMatchesState(text, matchers) {
  if (!matchers.length) return false;
  return matchers.some((re) => re.test(text));
}

function partitionRegionalTips(tips, stateLabel) {
  const matchers = stateMatchers(stateLabel);
  if (!matchers.length) {
    return { relevant: [], other: tips };
  }

  const relevant = [];
  const other = [];
  for (const tip of tips) {
    if (tipMatchesState(tip.text, matchers)) relevant.push(tip);
    else other.push(tip);
  }
  return { relevant, other };
}

function formatTipHtml(text) {
  let out = escapeHtml(text);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );
  out = out.replace(/\n/g, "<br>");
  return out;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTipList(tips, limit) {
  const slice = limit ? tips.slice(0, limit) : tips;
  if (!slice.length) {
    return '<p class="tips-empty">No tips in this section.</p>';
  }

  return `<ul class="tip-list">${slice
    .map(
      (tip) => `
    <li class="tip-item">
      <div class="tip-text">${formatTipHtml(tip.text)}</div>
      ${
        tip.mapLink && tip.mapLink.startsWith("http")
          ? `<a class="tip-map-link" href="${escapeHtml(tip.mapLink)}" target="_blank" rel="noopener">Example on Maps</a>`
          : ""
      }
    </li>`
    )
    .join("")}</ul>${
    limit && tips.length > limit
      ? `<p class="tips-more">${tips.length - limit} more on Plonkit →</p>`
      : ""
  }`;
}

function renderGuidePanel(container, guide, context) {
  const sections = extractTipsFromSteps(guide.steps);
  const guideUrl = `${PLONKIT_BASE}/${guide.slug}`;
  const identifying =
    sections.find((s) => /identifying/i.test(s.title)) ?? sections[0];
  const regional = sections.find((s) => /regional|subdivision/i.test(s.title));
  const spotlight = sections.find((s) => /spotlight/i.test(s.title));

  let regionalHtml = "";
  if (regional) {
    const { relevant, other } = partitionRegionalTips(
      regional.tips,
      context.state
    );
    if (relevant.length) {
      regionalHtml += `<details class="tips-section" open>
        <summary>Regional clues — ${escapeHtml(context.state)}</summary>
        ${renderTipList(relevant, 12)}
      </details>`;
    }
    const showOther = other.length && (!relevant.length || other.length <= 8);
    if (showOther) {
      regionalHtml += `<details class="tips-section" ${relevant.length ? "" : "open"}>
        <summary>${relevant.length ? "Other regional clues" : regional.title}</summary>
        ${renderTipList(other, relevant.length ? 6 : 10)}
      </details>`;
    } else if (!relevant.length) {
      regionalHtml += `<details class="tips-section">
        <summary>${escapeHtml(regional.title)}</summary>
        <p class="tips-hint">No tips matched “${escapeHtml(context.state)}”. Browse the full guide for subdivision clues.</p>
        ${renderTipList(regional.tips, 8)}
      </details>`;
    } else {
      regionalHtml += `<p class="tips-hint">${other.length} other regional tips — open the full Plonkit guide below.</p>`;
    }
  }

  container.innerHTML = `
    <div class="tips-header">
      <h2>${escapeHtml(guide.title)}</h2>
      <p class="tips-meta">From <a href="${escapeHtml(guideUrl)}" target="_blank" rel="noopener">Plonk It</a> · CC BY-NC-SA 4.0</p>
    </div>
    ${
      identifying
        ? `<details class="tips-section" open>
        <summary>${escapeHtml(identifying.title)}</summary>
        ${renderTipList(identifying.tips, 10)}
      </details>`
        : ""
    }
    ${regionalHtml}
    ${
      spotlight
        ? `<details class="tips-section">
        <summary>${escapeHtml(spotlight.title)}</summary>
        ${renderTipList(spotlight.tips, 6)}
      </details>`
        : ""
    }
    <div class="tips-actions">
      <button type="button" class="primary tips-open-guide" data-open="${escapeHtml(guideUrl)}">Open full guide</button>
    </div>
  `;

  container.querySelector(".tips-open-guide")?.addEventListener("click", (e) => {
    chrome.tabs.create({ url: e.currentTarget.dataset.open });
  });
}

async function loadPlonkitTips(container, context, onStatus) {
  if (!context?.countryCode && !context?.countryLabel) {
    container.innerHTML = `<p class="tips-empty">Get a round location on the <strong>Results</strong> tab first, then return here for identifying tips.</p>`;
    return;
  }

  onStatus?.("Loading Plonkit guide index…");
  container.innerHTML = "";

  try {
    const index = await getGuideIndex();
    const slug = resolveGuideSlug(index, context.countryCode, context.state);

    if (!slug) {
      const label = context.countryLabel || context.countryCode || "this country";
      container.innerHTML = `
        <p class="tips-empty">No Plonkit guide found for <strong>${escapeHtml(label)}</strong>.</p>
        <p class="tips-hint"><a href="${PLONKIT_BASE}/guide" target="_blank" rel="noopener">Browse all guides</a> on Plonk It.</p>`;
      onStatus?.("");
      return;
    }

    const meta = indexEntryForSlug(index, slug);
    onStatus?.(`Loading ${meta?.title ?? slug} tips…`);

    const guide = await fetchCountryGuide(slug);
    renderGuidePanel(container, guide, context);
    onStatus?.("");
  } catch (err) {
    container.innerHTML = `<p class="tips-empty error">${escapeHtml(err.message || "Could not load Plonkit tips.")}</p>`;
    onStatus?.(err.message || "Failed to load tips.", true);
  }
}
