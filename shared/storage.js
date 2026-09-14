// Storage layer shared by the service worker and the side panel.
//
// Where things live:
//   chrome.storage.local  - settings (API key, developer flags), detection cache,
//                           and the full intelligence payload per researcher.
//   chrome.storage.sync   - one item per tracked researcher ("bm_<id>") so the list
//                           follows the user's Chrome profile across devices. Sync
//                           items are capped at 8 KB, so intelligence is compacted
//                           before it goes in and dropped if it still does not fit.

const SignalStore = (() => {
  const SETTINGS_KEY = "settings";
  const BOOKMARK_PREFIX = "bm_";
  const INTEL_PREFIX = "intel_";
  const DETECT_CACHE_KEY = "detect_cache";
  const LEGACY_BOOKMARKS_KEY = "bookmarks";
  const SYNC_ITEM_BUDGET_BYTES = 7400; // headroom under Chrome's 8192-byte item limit
  const TRANSIENT_FIELDS = ["_loading", "_fetchStarted", "_error"];

  const DEFAULT_SETTINGS = { apiKey: "", developerMode: false, mockMode: false };

  // ---------- settings ----------

  async function getSettings() {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
  }

  async function saveSettings(patch) {
    const next = { ...(await getSettings()), ...patch };
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  }

  // Mock mode only counts while developer mode is on, so it cannot be left on by accident.
  function isMock(settings) {
    return Boolean(settings.developerMode && settings.mockMode);
  }

  // ---------- bookmarks ----------

  function byteSize(value) {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  }

  function capList(list, n) {
    return Array.isArray(list) ? list.slice(0, n) : [];
  }

  function compactIntelligence(intel) {
    if (!intel || typeof intel !== "object") return null;
    return {
      recent_papers: capList(intel.recent_papers, 6),
      citation_spikes: capList(intel.citation_spikes, 3),
      grants: capList(intel.grants, 4),
      patents: capList(intel.patents, 3),
      collaborations: capList(intel.collaborations, 3),
      last_checked: intel.last_checked || null,
    };
  }

  function stripSummaries(intel) {
    if (!intel) return null;
    return {
      ...intel,
      recent_papers: (intel.recent_papers || []).map(({ summary, ...rest }) => rest),
      collaborations: (intel.collaborations || []).map((c) => ({ partner: c.partner })),
    };
  }

  function stripTransient(record) {
    const clean = { ...record };
    for (const field of TRANSIENT_FIELDS) delete clean[field];
    return clean;
  }

  async function saveBookmark(bookmark) {
    const record = stripTransient(bookmark);
    record.intelligence_local_only = false;

    if (record.intelligence) {
      // Keep the full payload locally; sync gets a compact copy.
      await chrome.storage.local.set({
        [INTEL_PREFIX + record.id]: { lastChecked: record.lastChecked, intelligence: record.intelligence },
      });
      record.intelligence = compactIntelligence(record.intelligence);
      if (byteSize(record) > SYNC_ITEM_BUDGET_BYTES) record.intelligence = stripSummaries(record.intelligence);
      if (byteSize(record) > SYNC_ITEM_BUDGET_BYTES) {
        record.intelligence = null;
        record.intelligence_local_only = true;
      }
    }

    const key = BOOKMARK_PREFIX + record.id;
    try {
      await chrome.storage.sync.set({ [key]: record });
    } catch (err) {
      // Total sync quota exhausted: keep the researcher in the list, intelligence stays local.
      console.warn("[Signal] sync write failed, storing intelligence locally only:", err?.message);
      record.intelligence = null;
      record.intelligence_local_only = true;
      await chrome.storage.sync.set({ [key]: record });
    }
    return record;
  }

  async function getBookmarks() {
    const all = await chrome.storage.sync.get(null);
    const items = Object.keys(all)
      .filter((k) => k.startsWith(BOOKMARK_PREFIX))
      .map((k) => all[k])
      .filter((b) => b && b.id);

    if (items.length) {
      const local = await chrome.storage.local.get(items.map((b) => INTEL_PREFIX + b.id));
      for (const b of items) {
        const full = local[INTEL_PREFIX + b.id];
        if (full?.intelligence && full.lastChecked === b.lastChecked) b.intelligence = full.intelligence;
      }
    }

    items.sort((a, b) => String(a.bookmarked_at || "").localeCompare(String(b.bookmarked_at || "")));
    return items;
  }

  async function getBookmark(id) {
    const list = await getBookmarks();
    return list.find((b) => b.id === id) || null;
  }

  async function updateBookmark(id, patch) {
    const current = await getBookmark(id);
    if (!current) return null;
    return saveBookmark({ ...current, ...patch });
  }

  async function removeBookmark(id) {
    await chrome.storage.sync.remove(BOOKMARK_PREFIX + id);
    await chrome.storage.local.remove(INTEL_PREFIX + id);
  }

  // One-time move from the pre-1.1 "bookmarks" array in local storage.
  async function migrateLegacy() {
    const stored = await chrome.storage.local.get(LEGACY_BOOKMARKS_KEY);
    const legacy = stored[LEGACY_BOOKMARKS_KEY];
    if (!Array.isArray(legacy)) return 0;
    for (const b of legacy) {
      if (b && b.id) await saveBookmark(b);
    }
    await chrome.storage.local.remove(LEGACY_BOOKMARKS_KEY);
    return legacy.length;
  }

  // ---------- detection cache ----------

  async function readCache() {
    const stored = await chrome.storage.local.get(DETECT_CACHE_KEY);
    return stored[DETECT_CACHE_KEY] || {};
  }

  async function getCachedDetection(url) {
    const cache = await readCache();
    const entry = cache[url];
    if (!entry) return null;
    if (Date.now() > entry.expires) return null;
    return entry.data;
  }

  async function setCachedDetection(url, data, ttlMs = SIGNAL.DETECT_CACHE_TTL_MS) {
    const cache = await readCache();
    cache[url] = { data, expires: Date.now() + ttlMs, savedAt: Date.now() };

    const keys = Object.keys(cache);
    if (keys.length > SIGNAL.DETECT_CACHE_MAX_ENTRIES) {
      keys.sort((a, b) => cache[a].savedAt - cache[b].savedAt);
      for (const k of keys.slice(0, keys.length - SIGNAL.DETECT_CACHE_MAX_ENTRIES)) delete cache[k];
    }
    await chrome.storage.local.set({ [DETECT_CACHE_KEY]: cache });
  }

  async function clearDetectionCache() {
    await chrome.storage.local.remove(DETECT_CACHE_KEY);
  }

  return {
    getSettings, saveSettings, isMock,
    getBookmarks, getBookmark, saveBookmark, updateBookmark, removeBookmark, migrateLegacy,
    getCachedDetection, setCachedDetection, clearDetectionCache,
    BOOKMARK_PREFIX, INTEL_PREFIX, SETTINGS_KEY,
  };
})();
