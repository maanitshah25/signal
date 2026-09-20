// Signal side panel.
// Reads tracked researchers through SignalStore; anything that costs money (detection,
// intelligence scans) goes through background.js so there is exactly one TinyFish caller.

const state = {
  view: "feed",                     // feed | bookmarks | researcher | settings
  bookmarks: [],
  activeId: null,
  status: { mock: false, hasKey: false, developerMode: false },
  detect: { status: "idle", url: null, tabId: null, data: null, error: null, source: null },
  agentSteps: {},                   // researcherId -> string[]
  loading: new Set(),               // researcherIds with an in-flight scan
};
let detectSeq = 0;

const send = (msg) => chrome.runtime.sendMessage(msg)
  .catch((err) => ({ success: false, error: err?.message || String(err) }));

// ---------- init ----------

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("nav-feed").addEventListener("click", () => showView("feed"));
  document.getElementById("nav-bookmarks").addEventListener("click", () => showView("bookmarks"));
  document.getElementById("nav-settings").addEventListener("click", () => showView("settings"));
  document.addEventListener("click", onDelegatedClick);
  document.addEventListener("change", onDelegatedChange);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "AGENT_STEP") return;
    state.agentSteps[msg.researcherId] = msg.allSteps;
    if (state.view === "researcher" && state.activeId === msg.researcherId) updateAgentLog(msg.allSteps);
  });

  // Another device (or the background worker) changed tracked researchers.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    const touchesBookmarks = area === "sync" ||
      Object.keys(changes).some((k) => k.startsWith(SignalStore.INTEL_PREFIX));
    if (!touchesBookmarks) return;
    await loadBookmarks();
    if (state.view !== "settings") renderView();
    if (state.detect.status === "detected") renderDetectCard();
  });

  chrome.tabs.onActivated.addListener(() => detectCurrentPage());
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.status !== "complete") return;
    const tab = await getActiveTab();
    if (tab?.id === tabId) detectCurrentPage();
  });

  await refreshStatus();
  await loadBookmarks();
  renderView();
  detectCurrentPage();
});

async function refreshStatus() {
  const res = await send({ type: "GET_STATUS" });
  if (res?.success) state.status = { mock: res.mock, hasKey: res.hasKey, developerMode: res.developerMode };
  document.getElementById("mock-badge").style.display = state.status.mock ? "inline" : "none";
}

async function loadBookmarks() {
  state.bookmarks = await SignalStore.getBookmarks();
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// ---------- event delegation ----------

function onDelegatedClick(e) {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const { action, id } = el.dataset;

  switch (action) {
    case "open-researcher":
      if (e.target.closest("[data-action='remove-bookmark']")) return;
      return openResearcher(id);
    case "remove-bookmark":
      e.stopPropagation();
      return removeBookmark(id);
    case "refresh-researcher": return startScan(id);
    case "test-notification": return triggerTestNotification(id);
    case "back": return showView("feed");
    case "track": return trackCurrent();
    case "scan-page": return detectCurrentPage({ manual: true, force: true });
    case "rescan": return detectCurrentPage({ force: true });
    case "open-settings": return showView("settings");
    case "save-key": return saveApiKey();
    case "test-key": return testApiKey();
    case "toggle-key-visibility": {
      const input = document.getElementById("api-key-input");
      if (input) {
        const showing = input.type === "text";
        input.type = showing ? "password" : "text";
        el.textContent = showing ? "Show" : "Hide";
      }
      return;
    }
    case "clear-cache": return clearDetectionCache(el);
    case "run-daily": return runDailyNow(el);
    default: return;
  }
}

async function onDelegatedChange(e) {
  const el = e.target.closest("[data-setting]");
  if (!el) return;
  const setting = el.dataset.setting;
  if (setting === "developerMode" || setting === "mockMode") {
    await SignalStore.saveSettings({ [setting]: el.checked });
    await refreshStatus();
    if (state.view === "settings") renderSettings();
  }
}

// ---------- page detection ----------

async function detectCurrentPage({ manual = false, force = false } = {}) {
  const seq = ++detectSeq;
  const tab = await getActiveTab();

  if (!tab?.url || !signalIsWebUrl(tab.url)) {
    state.detect = { status: "unsupported", url: tab?.url || null, tabId: tab?.id ?? null, data: null, error: null, source: null };
    renderDetectCard();
    return;
  }

  state.detect = { status: "detecting", url: tab.url, tabId: tab.id, data: null, error: null, source: null };
  renderDetectCard();

  const res = await send({ type: "DETECT_PAGE", tabId: tab.id, url: tab.url, manual, force });
  if (seq !== detectSeq) return; // user moved on; drop the stale result

  if (!res?.success) {
    state.detect.status = res?.code === "NO_API_KEY" ? "no-key" : "error";
    state.detect.error = res?.error || "Detection failed.";
  } else if (res.source === "unsupported") {
    state.detect.status = "unsupported";
  } else if (res.source === "manual-required") {
    state.detect.status = "manual";
  } else if (res.data?.is_researcher_page) {
    state.detect.status = "detected";
    state.detect.data = { ...res.data, url: tab.url };
    state.detect.source = res.source;
  } else {
    state.detect.status = "none";
    state.detect.source = res.source;
  }
  renderDetectCard();
}

function renderDetectCard() {
  const container = document.getElementById("page-card");
  const d = state.detect;
  const label = (text, extra = "") => `<div class="page-card-label"><span>${text}</span>${extra}</div>`;
  const rescan = `<button class="link-btn" data-action="rescan">Rescan</button>`;

  switch (d.status) {
    case "idle":
    case "detecting":
      container.innerHTML = `${label("Current Page")}
        <div class="detecting-row"><div class="status-dot"></div><span>Checking this page</span></div>`;
      return;

    case "unsupported":
      container.innerHTML = `${label("Current Page")}
        <div class="detect-placeholder">Signal can't read this page. Open a researcher's profile to get started.</div>`;
      return;

    case "no-key":
      container.innerHTML = `${label("Setup needed")}
        <div class="detect-placeholder">Add your TinyFish API key to detect researchers. Google Scholar profiles are read for free without one.</div>
        <div class="detect-actions"><button class="btn primary small" data-action="open-settings">Add API key</button></div>`;
      return;

    case "error":
      container.innerHTML = `${label("Current Page", rescan)}
        <div class="detect-placeholder" style="color:var(--red)">${esc(d.error)}</div>`;
      return;

    case "manual":
      container.innerHTML = `${label("Current Page")}
        <div class="detect-placeholder">Signal only auto-scans academic sites. Scan this page for a researcher?</div>
        <div class="detect-actions">
          <button class="btn small" data-action="scan-page">Scan this page</button>
          <span class="cost-hint">Uses one TinyFish run</span>
        </div>`;
      return;

    case "none":
      container.innerHTML = `${label("Current Page", rescan)}
        <div class="detect-placeholder">No researcher or lab detected on this page.</div>
        <div class="detect-actions">
          <button class="btn ghost small" data-action="scan-page">Scan anyway</button>
          <span class="cost-hint">Uses one TinyFish run</span>
        </div>`;
      return;

    case "detected": {
      const p = d.data;
      const tracked = state.bookmarks.some((b) => b.url === p.url || (p.scholar_url && b.scholar_url === p.scholar_url));
      const sourceNote = d.source === "page" ? "Read locally, no API call" : d.source === "cache" ? "Cached result" : "";
      container.innerHTML = `${label("Detected on this page", `<span class="cost-hint">${esc(sourceNote)}</span>`)}
        <div class="page-detect-row">
          <div class="detect-info">
            <div class="detect-name">${esc(p.researcher_name || "Unknown Researcher")}</div>
            <div class="detect-institution">${esc(p.institution || "")}${p.department ? " | " + esc(p.department) : ""}</div>
            ${p.research_areas?.length ? `<div class="detect-tags">${p.research_areas.slice(0, 3).map((a) => `<span class="tag">${esc(a)}</span>`).join("")}</div>` : ""}
            ${p.profile_summary ? `<div class="detect-summary">${esc(p.profile_summary)}</div>` : ""}
          </div>
          <button class="btn ${tracked ? "success" : "primary"}" data-action="track" ${tracked ? "disabled" : ""}>
            ${tracked ? "Tracked" : "Track"}
          </button>
        </div>`;
      return;
    }
  }
}

// ---------- tracking ----------

async function trackCurrent() {
  const p = state.detect.data;
  if (!p) return;
  const btn = document.querySelector("[data-action='track']");
  if (btn) { btn.disabled = true; btn.textContent = "Adding"; }

  const researcher = {
    id: Date.now().toString(),
    name: p.researcher_name || "Unknown",
    institution: p.institution || "",
    department: p.department || "",
    research_areas: p.research_areas || [],
    scholar_url: p.scholar_url || null,
    url: p.url,
    bookmarked_at: new Date().toISOString(),
    intelligence: null,
    lastChecked: null,
    lastError: null,
    hasNew: false,
  };

  await SignalStore.saveBookmark(researcher);
  await loadBookmarks();
  renderDetectCard();

  state.activeId = researcher.id;
  state.view = "researcher";
  clearNavHighlight();
  startScan(researcher.id);
}

async function startScan(id) {
  state.loading.add(id);
  state.agentSteps[id] = [];
  renderView();

  const res = await send({ type: "FETCH_INTELLIGENCE", researcherId: id });
  state.loading.delete(id);
  if (!res?.success && res?.code === "NO_API_KEY") await refreshStatus();
  await loadBookmarks();
  renderView();
}

async function removeBookmark(id) {
  const r = state.bookmarks.find((b) => b.id === id);
  if (!r) return;
  if (!confirm(`Stop tracking ${r.name}?`)) return;
  await SignalStore.removeBookmark(id);
  await loadBookmarks();
  if (state.activeId === id) { state.activeId = null; state.view = "feed"; }
  renderView();
  if (state.detect.status === "detected") renderDetectCard();
}

// ---------- views ----------

function clearNavHighlight() {
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
}

function showView(view) {
  state.view = view;
  state.activeId = null;
  clearNavHighlight();
  document.getElementById(`nav-${view}`)?.classList.add("active");
  renderView();
}

function renderView() {
  if (state.view === "feed") renderFeedList();
  else if (state.view === "bookmarks") renderBookmarksList();
  else if (state.view === "researcher") renderResearcher();
  else if (state.view === "settings") renderSettings();
}

function activeResearcher() {
  return state.bookmarks.find((b) => b.id === state.activeId) || null;
}

function statusBadge(r) {
  if (state.loading.has(r.id)) return `<span class="rc-badge scanning">Updating</span>`;
  if (r.hasNew) return `<span class="rc-badge new">New</span>`;
  if (r.lastError && !r.intelligence) return `<span class="rc-badge warn">Failed</span>`;
  if (!r.intelligence) return `<span class="rc-badge idle">Not scanned</span>`;
  return `<span class="rc-badge ok">Current</span>`;
}

function renderFeedList() {
  const content = document.getElementById("main-content");
  let html = "";

  if (!state.status.hasKey && !state.status.mock) {
    html += `<div class="notice">Signal needs your TinyFish API key to scan researchers.
      <button class="link-btn" data-action="open-settings">Add it in Settings</button>.</div>`;
  }

  if (!state.bookmarks.length) {
    content.innerHTML = html + `
      <div class="empty-state">
        <div class="empty-title">No researchers tracked yet</div>
        <div class="empty-desc">Open a researcher's Google Scholar or university profile, then select <strong>Track</strong>.</div>
      </div>`;
    return;
  }

  html += `<div class="section-title">Tracked Researchers</div>`;
  html += state.bookmarks.map((r) => {
    const paperCount = r.intelligence?.recent_papers?.length || 0;
    const grantCount = r.intelligence?.grants?.length || 0;
    const scanning = state.loading.has(r.id);
    return `
      <div class="researcher-card ${r.hasNew ? "active" : ""}" data-action="open-researcher" data-id="${esc(r.id)}">
        <div class="rc-top">
          <div>
            <div class="rc-name">${esc(r.name)}</div>
            <div class="rc-institution">${esc(r.institution)}</div>
          </div>
          ${statusBadge(r)}
        </div>
        <div class="rc-meta">
          ${scanning
            ? `<div class="rc-stat">Updating research data</div>`
            : r.intelligence
              ? `<div class="rc-stat">Papers <span>${esc(paperCount)}</span></div>
                 <div class="rc-stat">Grants <span>${esc(grantCount)}</span></div>
                 ${r.lastChecked ? `<div class="rc-stat">Updated <span>${esc(timeAgo(r.lastChecked))}</span></div>` : ""}`
              : `<div class="rc-stat">${r.lastError ? "Last update failed. Open to retry." : "Open to run the first update."}</div>`}
        </div>
      </div>`;
  }).join("");
  content.innerHTML = html;
}

function renderBookmarksList() {
  const content = document.getElementById("main-content");
  if (!state.bookmarks.length) {
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">Nothing tracked yet</div>
        <div class="empty-desc">Tracked researchers sync across every Chrome where you're signed in.</div>
      </div>`;
    return;
  }

  content.innerHTML = `
    <div class="section-title">All Tracked (${state.bookmarks.length})</div>
    ${state.bookmarks.map((r) => `
      <div class="researcher-card" data-action="open-researcher" data-id="${esc(r.id)}">
        <div class="rc-top">
          <div>
            <div class="rc-name">${esc(r.name)}</div>
            <div class="rc-institution">${esc(r.institution)}${r.department ? " | " + esc(r.department) : ""}</div>
          </div>
          <button class="rc-remove" data-action="remove-bookmark" data-id="${esc(r.id)}" title="Stop tracking" aria-label="Stop tracking">×</button>
        </div>
        ${r.research_areas?.length ? `<div class="detect-tags" style="margin-top:6px;">${r.research_areas.slice(0, 3).map((a) => `<span class="tag">${esc(a)}</span>`).join("")}</div>` : ""}
        <div class="rc-meta" style="margin-top:6px;">
          <div class="rc-stat">Tracked since <span>${esc(formatDate(r.bookmarked_at))}</span></div>
        </div>
      </div>`).join("")}`;
}

function openResearcher(id) {
  const r = state.bookmarks.find((b) => b.id === id);
  if (!r) return;
  state.activeId = id;
  state.view = "researcher";
  clearNavHighlight();
  if (r.hasNew) SignalStore.updateBookmark(id, { hasNew: false }); // storage listener re-renders
  renderResearcher();
}

function renderResearcher() {
  const content = document.getElementById("main-content");
  const r = activeResearcher();
  if (!r) { showView("feed"); return; }

  const intel = r.intelligence;
  const steps = state.agentSteps[r.id] || [];
  const isLoading = state.loading.has(r.id);

  let html = `
    <div class="feed-header">
      <div>
        <div class="feed-name">${esc(r.name)}</div>
        <div class="feed-inst">${esc(r.institution)}</div>
      </div>
      <button class="btn ghost small" data-action="back">Back</button>
    </div>
    <div class="action-row">
      <button class="btn small" data-action="refresh-researcher" data-id="${esc(r.id)}" ${isLoading ? "disabled" : ""}>Refresh</button>
      ${state.status.developerMode
        ? `<button class="btn small" data-action="test-notification" data-id="${esc(r.id)}" style="border-color:var(--accent);color:var(--accent-strong);" title="Simulate a new-paper notification">Test alert</button>`
        : ""}
    </div>`;

  if (isLoading || steps.length > 0) {
    html += `
      <div class="agent-log ${isLoading ? "active" : "done"}">
        <div class="agent-log-header">
          ${isLoading ? `<div class="status-dot"></div><span>Updating research data</span>` : `<span style="color:var(--green)">Update complete</span>`}
        </div>
        <div class="agent-log-steps" id="agent-steps-${esc(r.id)}">
          ${steps.length === 0
            ? `<div class="agent-step">Starting research update</div>`
            : steps.map((s) => `<div class="agent-step">${esc(s)}</div>`).join("")}
        </div>
      </div>`;
  }

  if (isLoading) { content.innerHTML = html; return; }

  if (r.lastError) html += `<div class="error-msg">${esc(r.lastError)}</div>`;

  if (!intel) {
    if (!r.lastError) {
      html += `<div class="notice">${r.intelligence_local_only
        ? "This researcher's data was too large to sync. Refresh to scan on this device."
        : "Not scanned yet. Click Refresh to run the first scan."}</div>`;
    }
    content.innerHTML = html;
    return;
  }

  if (intel.recent_papers?.length) {
    html += `<div class="section-title">Recent papers</div>`;
    for (const p of intel.recent_papers) {
      html += `
        <div class="signal-card">
          <div class="signal-card-type paper">Paper${p.year ? " | " + esc(p.year) : ""}</div>
          <div class="signal-title">${safeHref(p.url) ? `<a href="${safeHref(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title)}</div>
          ${p.citations ? `<div class="signal-meta">${esc(p.citations)} citations</div>` : ""}
          ${p.summary ? `<div class="signal-summary">${esc(p.summary)}</div>` : ""}
        </div>`;
    }
  }

  if (intel.citation_spikes?.length) {
    html += `<div class="section-title">Citation activity</div>`;
    for (const p of intel.citation_spikes) {
      html += `
        <div class="signal-card">
          <div class="signal-card-type citation">Citation Spike</div>
          <div class="signal-title">${esc(p.title)}</div>
          <div class="signal-meta">${p.total_citations ? esc(p.total_citations) + " citations | " : ""}${esc(p.spike_note)}</div>
        </div>`;
    }
  }

  if (intel.grants?.length) {
    html += `<div class="section-title">Grants and funding</div>`;
    for (const g of intel.grants) {
      html += `
        <div class="signal-card">
          <div class="signal-card-type grant">Grant${g.funder ? " | " + esc(g.funder) : ""}</div>
          <div class="signal-title">${esc(g.title)}</div>
          <div class="signal-meta">${g.year ? esc(g.year) + " | " : ""}${esc(g.amount || "")}</div>
        </div>`;
    }
  }

  if (intel.patents?.length) {
    html += `<div class="section-title">Patents</div>`;
    for (const p of intel.patents) {
      html += `
        <div class="signal-card">
          <div class="signal-card-type patent">Patent${p.year ? " | " + esc(p.year) : ""}</div>
          <div class="signal-title">${esc(p.title)}</div>
          ${p.patent_number ? `<div class="signal-meta">${esc(p.patent_number)}</div>` : ""}
        </div>`;
    }
  }

  if (intel.collaborations?.length) {
    html += `<div class="section-title">Collaborations</div>`;
    for (const c of intel.collaborations) {
      html += `
        <div class="signal-card">
          <div class="signal-card-type collab">Collaboration</div>
          <div class="signal-title">${esc(c.partner)}</div>
          ${c.description ? `<div class="signal-summary">${esc(c.description)}</div>` : ""}
        </div>`;
    }
  }

  const empty = !intel.recent_papers?.length && !intel.citation_spikes?.length &&
    !intel.grants?.length && !intel.patents?.length && !intel.collaborations?.length;
  if (empty) {
    html += `
      <div class="empty-state">
        <div class="empty-title">No signals found</div>
        <div class="empty-desc">No structured research data was found. Try refreshing or track the researcher's Google Scholar profile directly.</div>
      </div>`;
  }

  if (r.lastChecked) html += `<div class="footnote">Last checked ${esc(formatDate(r.lastChecked))}</div>`;
  content.innerHTML = html;
}

function updateAgentLog(steps) {
  const r = activeResearcher();
  if (!r) return;
  const el = document.getElementById(`agent-steps-${r.id}`);
  if (!el) { renderResearcher(); return; }
  el.innerHTML = steps.map((s) => `<div class="agent-step">${esc(s)}</div>`).join("");
  el.scrollTop = el.scrollHeight;
}

// ---------- settings ----------

async function renderSettings() {
  const content = document.getElementById("main-content");
  const settings = await SignalStore.getSettings();
  if (state.view !== "settings") return;

  content.innerHTML = `
    <div class="feed-header">
      <div class="feed-name">Settings</div>
      <button class="btn ghost small" data-action="back">Back</button>
    </div>

    <div class="settings-section">
      <div class="settings-label">TinyFish API key</div>
      <div class="input-row">
        <input class="text-input" type="password" id="api-key-input" placeholder="Paste your API key" value="${esc(settings.apiKey)}" autocomplete="off" spellcheck="false" />
        <button class="btn small" data-action="toggle-key-visibility">Show</button>
      </div>
      <div class="input-row" style="margin-top:8px;">
        <button class="btn primary small" data-action="save-key">Save</button>
        <button class="btn small" data-action="test-key">Test connection</button>
      </div>
      <div class="status-line" id="key-status"></div>
      <div class="hint">
        Stored only on this device and sent only to TinyFish. Each detection and scan runs on your TinyFish account.
        Get a key at <a href="${esc(SIGNAL.TINYFISH_KEYS_URL)}" target="_blank" rel="noopener">agent.tinyfish.ai/api-keys</a>.
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-label">Detection</div>
      <div class="hint" style="margin-top:0;">
        Signal auto-detects on Google Scholar, ORCID, ResearchGate, Semantic Scholar, arXiv, dblp, OpenReview, and university domains.
        Everywhere else you choose when to scan. Results are cached for 7 days.
      </div>
      <div class="input-row" style="margin-top:10px;">
        <button class="btn small" data-action="clear-cache">Clear detection cache</button>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-label">Advanced</div>
      <div class="toggle-row">
        <label for="dev-mode">Developer mode</label>
        <input type="checkbox" id="dev-mode" data-setting="developerMode" ${settings.developerMode ? "checked" : ""} />
      </div>
      ${settings.developerMode ? `
        <div class="toggle-row">
          <label for="mock-mode">Mock mode <span class="cost-hint">(fake data, no API calls)</span></label>
          <input type="checkbox" id="mock-mode" data-setting="mockMode" ${settings.mockMode ? "checked" : ""} />
        </div>
        <div class="input-row" style="margin-top:8px;">
          <button class="btn small" data-action="run-daily">Run daily check now</button>
        </div>
        <div class="hint">Developer mode also shows the Test Alert button on each researcher.</div>
      ` : ""}
    </div>

    <div class="settings-footer">
      Signal v${esc(SIGNAL.VERSION)}<br/>
      <a href="${esc(SIGNAL.PRIVACY_URL)}" target="_blank" rel="noopener">Privacy policy</a> |
      <a href="${esc(SIGNAL.SOURCE_URL)}" target="_blank" rel="noopener">Source</a>
    </div>`;
}

function setKeyStatus(text, ok) {
  const el = document.getElementById("key-status");
  if (!el) return;
  el.textContent = text;
  el.className = `status-line ${ok ? "ok" : "err"}`;
}

async function saveApiKey() {
  const input = document.getElementById("api-key-input");
  const apiKey = (input?.value || "").trim();
  await SignalStore.saveSettings({ apiKey });
  await refreshStatus();
  setKeyStatus(apiKey ? "Saved." : "Key removed.", true);
  if (state.detect.status === "no-key" && apiKey) detectCurrentPage({ force: true });
}

async function testApiKey() {
  const input = document.getElementById("api-key-input");
  const apiKey = (input?.value || "").trim();
  if (!apiKey) { setKeyStatus("Enter an API key first.", false); return; }
  setKeyStatus("Checking", true);

  const res = await send({ type: "TEST_CONNECTION", apiKey });
  if (!res?.success) { setKeyStatus(res?.error || "Connection failed.", false); return; }
  if (res.note) { setKeyStatus(res.note, true); return; }
  const balance = res.balance != null ? ` Wallet balance: ${formatMoney(res.balance, res.currency)}.` : "";
  setKeyStatus(`Connected.${balance}`, true);
}

async function clearDetectionCache(btn) {
  await send({ type: "CLEAR_DETECT_CACHE" });
  flashButton(btn, "Cleared", "Clear detection cache");
  detectCurrentPage({ force: true });
}

async function runDailyNow(btn) {
  if (btn) { btn.disabled = true; btn.textContent = "Running"; }
  const res = await send({ type: "RUN_DAILY_CHECK" });
  const summary = res?.success ? `${res.checked} checked, ${res.skipped} skipped, ${res.failed} failed` : "Failed";
  flashButton(btn, summary, "Run daily check now", 4000);
  await loadBookmarks();
}

async function triggerTestNotification(id) {
  const btn = document.querySelector(`[data-action="test-notification"][data-id="${id}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "Running"; }
  const res = await send({ type: "TEST_NOTIFICATION", researcherId: id });
  flashButton(btn, res?.success ? "Sent" : (res?.error || "Failed"), "Test alert");
  await loadBookmarks();
  if (state.view === "researcher") renderResearcher();
}

function flashButton(btn, text, original, ms = 3000) {
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = text;
  setTimeout(() => { btn.disabled = false; btn.textContent = original; }, ms);
}

// ---------- utils ----------

function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Only http(s) links may be rendered as anchors.
function safeHref(url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return "";
  return esc(url);
}

function timeAgo(iso) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatMoney(value, currency) {
  const n = Number(value);
  if (!Number.isFinite(n)) return `${value} ${currency || ""}`.trim();
  try { return n.toLocaleString("en-US", { style: "currency", currency: currency || "USD" }); }
  catch (_) { return `${n.toFixed(2)} ${currency || ""}`.trim(); }
}
