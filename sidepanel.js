// ── STATE ──────────────────────────────────────────────────────────────────
let state = {
  view: "feed",           // "feed" | "bookmarks" | "researcher"
  bookmarks: [],
  activeResearcher: null,
  currentPage: null,      // detected researcher on active tab
  detecting: true,
};

// ── INIT ───────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Wire up nav buttons
  document.getElementById("nav-feed").addEventListener("click", () => showView("feed"));
  document.getElementById("nav-bookmarks").addEventListener("click", () => showView("bookmarks"));

  // Event delegation for all dynamically rendered buttons
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    const id = el.dataset.id;

    if (action === "open-researcher") {
      // Don't open if clicking the remove button inside the card
      if (e.target.closest("[data-action='remove-bookmark']")) return;
      openResearcher(id);
    } else if (action === "remove-bookmark") {
      e.stopPropagation();
      removeBookmark(id);
    } else if (action === "refresh-researcher") {
      refreshResearcher(id);
    } else if (action === "back") {
      showView("feed");
    }
  });

  await loadBookmarks();
  await detectCurrentPage();
  renderView();
});

async function loadBookmarks() {
  const { bookmarks = [] } = await chrome.storage.local.get("bookmarks");
  state.bookmarks = bookmarks;
}

async function detectCurrentPage() {
  state.detecting = true;
  updateDetectCard();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
      state.detecting = false;
      state.currentPage = null;
      updateDetectCard();
      return;
    }

    // Try getting page text from content script, but don't block on it
    let pageText = tab.title || "";
    try {
      const pageData = await Promise.race([
        chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_TEXT" }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000))
      ]);
      pageText = pageData?.text || pageText;
    } catch (_) {
      // Content script unavailable (e.g. Google Scholar CSP) — use URL + title only
    }

    // Ask background to call TinyFish with the URL directly
    const result = await chrome.runtime.sendMessage({
      type: "FETCH_RESEARCHER_INFO",
      url: tab.url,
      pageText,
    });

    state.detecting = false;

    if (result?.success && result?.data?.is_researcher_page) {
      state.currentPage = {
        ...result.data,
        url: tab.url,
      };
    } else {
      state.currentPage = null;
    }
  } catch (err) {
    state.detecting = false;
    state.currentPage = null;
  }

  updateDetectCard();
}

// ── PAGE DETECTION CARD ────────────────────────────────────────────────────
function updateDetectCard() {
  const card = document.getElementById("detect-status");
  const container = document.getElementById("page-card");

  if (state.detecting) {
    container.innerHTML = `
      <div class="page-card-label">Current Page</div>
      <div class="detecting-row">
        <div class="pulse"></div>
        <span>Analyzing page…</span>
      </div>`;
    return;
  }

  if (!state.currentPage) {
    container.innerHTML = `
      <div class="page-card-label">Current Page</div>
      <div class="detect-placeholder">No researcher or lab detected on this page.</div>`;
    return;
  }

  const p = state.currentPage;
  const alreadyBookmarked = state.bookmarks.some(b => b.url === p.url);

  container.innerHTML = `
    <div class="page-card-label">Detected on this page</div>
    <div class="page-detect-row">
      <div class="detect-info">
        <div class="detect-name">${esc(p.researcher_name || "Unknown Researcher")}</div>
        <div class="detect-institution">${esc(p.institution || "")}${p.department ? " · " + esc(p.department) : ""}</div>
        ${p.research_areas?.length ? `
          <div class="detect-tags">
            ${p.research_areas.slice(0, 3).map(a => `<span class="tag">${esc(a)}</span>`).join("")}
          </div>` : ""}
        ${p.profile_summary ? `<div class="detect-summary">${esc(p.profile_summary)}</div>` : ""}
      </div>
      <button class="bookmark-btn ${alreadyBookmarked ? "bookmarked" : ""}"
        id="bookmark-btn"
        ${alreadyBookmarked ? "disabled" : ""}>
        ${alreadyBookmarked ? "✓ Tracked" : "+ Track"}
      </button>
    </div>`;

  if (!alreadyBookmarked) {
    document.getElementById("bookmark-btn")?.addEventListener("click", bookmarkCurrent);
  }
}

// ── BOOKMARK ───────────────────────────────────────────────────────────────
async function bookmarkCurrent() {
  if (!state.currentPage) return;
  const btn = document.getElementById("bookmark-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }

  const researcher = {
    id: Date.now().toString(),
    name: state.currentPage.researcher_name || "Unknown",
    institution: state.currentPage.institution || "",
    department: state.currentPage.department || "",
    research_areas: state.currentPage.research_areas || [],
    scholar_url: state.currentPage.scholar_url || null,
    url: state.currentPage.url,
    bookmarked_at: new Date().toISOString(),
    intelligence: null,
    lastChecked: null,
    hasNew: false,
  };

  state.bookmarks.push(researcher);
  await chrome.storage.local.set({ bookmarks: state.bookmarks });
  updateDetectCard();

  // Immediately fetch intelligence
  fetchAndStoreIntelligence(researcher.id);

  // Switch to researcher detail view
  state.activeResearcher = researcher;
  state.view = "researcher";
  renderView();
}

// ── FETCH INTELLIGENCE ─────────────────────────────────────────────────────
async function fetchAndStoreIntelligence(researcherId) {
  const { bookmarks = [] } = await chrome.storage.local.get("bookmarks");
  const researcher = bookmarks.find(b => b.id === researcherId);
  if (!researcher) return;

  // Show loading state
  if (state.activeResearcher?.id === researcherId) {
    state.activeResearcher = { ...researcher, _loading: true };
    renderFeed();
  }

  const result = await chrome.runtime.sendMessage({
    type: "FETCH_INTELLIGENCE",
    researcher,
  });

  const { bookmarks: current = [] } = await chrome.storage.local.get("bookmarks");
  const updated = current.map(b =>
    b.id === researcherId
      ? { ...b, intelligence: result?.data || null, lastChecked: new Date().toISOString(), hasNew: false, _error: !result?.success ? result?.error : null }
      : b
  );
  await chrome.storage.local.set({ bookmarks: updated });
  state.bookmarks = updated;

  if (state.activeResearcher?.id === researcherId) {
    state.activeResearcher = updated.find(b => b.id === researcherId);
    renderFeed();
  }
}

// ── VIEWS ──────────────────────────────────────────────────────────────────
function showView(view) {
  state.view = view;
  state.activeResearcher = null;
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  document.getElementById(`nav-${view}`)?.classList.add("active");
  renderView();
}

function renderView() {
  const content = document.getElementById("main-content");
  if (state.view === "feed") renderFeedList();
  else if (state.view === "bookmarks") renderBookmarksList();
  else if (state.view === "researcher") renderFeed();
}

// ── FEED LIST (home) ───────────────────────────────────────────────────────
function renderFeedList() {
  const content = document.getElementById("main-content");
  if (state.bookmarks.length === 0) {
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔬</div>
        <div class="empty-title">No researchers tracked yet</div>
        <div class="empty-desc">Navigate to a researcher or lab page and click <strong>+ Track</strong> to start receiving intelligence.</div>
      </div>`;
    return;
  }

  const cards = state.bookmarks.map(r => {
    const paperCount = r.intelligence?.recent_papers?.length || 0;
    const grantCount = r.intelligence?.grants?.length || 0;
    return `
      <div class="researcher-card ${r.hasNew ? "active" : ""}" data-action="open-researcher" data-id="${r.id}">
        <div class="rc-top">
          <div>
            <div class="rc-name">${esc(r.name)}</div>
            <div class="rc-institution">${esc(r.institution)}</div>
          </div>
          ${r.hasNew ? '<span class="rc-badge new">New</span>' : r.intelligence ? '<span class="rc-badge ok">Up to date</span>' : '<span class="rc-badge" style="color:var(--muted)">Pending</span>'}
        </div>
        <div class="rc-meta">
          <div class="rc-stat">Papers <span>${paperCount}</span></div>
          <div class="rc-stat">Grants <span>${grantCount}</span></div>
          ${r.lastChecked ? `<div class="rc-stat">Updated <span>${timeAgo(r.lastChecked)}</span></div>` : ""}
        </div>
      </div>`;
  }).join("");

  content.innerHTML = `
    <div class="section-title">Tracked Researchers</div>
    ${cards}`;
}

// ── BOOKMARKS LIST ─────────────────────────────────────────────────────────
function renderBookmarksList() {
  const content = document.getElementById("main-content");
  if (state.bookmarks.length === 0) {
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📌</div>
        <div class="empty-title">Nothing tracked yet</div>
        <div class="empty-desc">Your bookmarked researchers will appear here.</div>
      </div>`;
    return;
  }

  const items = state.bookmarks.map(r => `
    <div class="researcher-card" data-action="open-researcher" data-id="${r.id}">
      <div class="rc-top">
        <div>
          <div class="rc-name">${esc(r.name)}</div>
          <div class="rc-institution">${esc(r.institution)}${r.department ? " · " + esc(r.department) : ""}</div>
        </div>
        <button data-action="remove-bookmark" data-id="${r.id}"
          style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;padding:2px 6px;">×</button>
      </div>
      ${r.research_areas?.length ? `
        <div class="detect-tags" style="margin-top:6px;">
          ${r.research_areas.slice(0,3).map(a => `<span class="tag">${esc(a)}</span>`).join("")}
        </div>` : ""}
      <div class="rc-meta" style="margin-top:6px;">
        <div class="rc-stat">Tracked since <span>${formatDate(r.bookmarked_at)}</span></div>
      </div>
    </div>`).join("");

  content.innerHTML = `
    <div class="section-title">All Tracked (${state.bookmarks.length})</div>
    ${items}`;
}

// ── RESEARCHER DETAIL FEED ─────────────────────────────────────────────────
function openResearcher(id) {
  const researcher = state.bookmarks.find(b => b.id === id);
  if (!researcher) return;
  state.activeResearcher = researcher;
  state.view = "researcher";
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));

  // Mark as read
  if (researcher.hasNew) {
    state.bookmarks = state.bookmarks.map(b => b.id === id ? { ...b, hasNew: false } : b);
    chrome.storage.local.set({ bookmarks: state.bookmarks });
  }

  renderFeed();
}

function renderFeed() {
  const content = document.getElementById("main-content");
  const r = state.activeResearcher;
  if (!r) return;

  const intel = r.intelligence;

  let feedHtml = `
    <div class="feed-header">
      <div>
        <div class="feed-name">${esc(r.name)}</div>
        <div class="feed-inst">${esc(r.institution)}</div>
      </div>
      <button class="back-btn" data-action="back">← Back</button>
    </div>`;

  feedHtml += `
    <button data-action="refresh-researcher" data-id="${r.id}"
      style="width:100%;background:var(--surface);border:1px solid var(--border);color:var(--muted);cursor:pointer;padding:8px;border-radius:8px;font-size:11px;margin-bottom:12px;transition:all 0.15s;">
      ↻ Refresh Intelligence Feed
    </button>`;

  if (r._loading) {
    feedHtml += `
      <div class="loading-card">
        <div class="spinner"></div>
        <div class="loading-text">TinyFish agents are searching arXiv, Google Scholar, grant databases, and patent offices…<br><br>This may take 30–60 seconds.</div>
      </div>`;
    content.innerHTML = feedHtml;
    return;
  }

  if (r._error) {
    feedHtml += `<div class="error-msg">⚠ Error fetching intelligence: ${esc(r._error)}<br><br>Check your TinyFish API key and try refreshing.</div>`;
    content.innerHTML = feedHtml;
    return;
  }

  if (!intel) {
    feedHtml += `
      <div class="loading-card">
        <div class="spinner"></div>
        <div class="loading-text">Fetching initial intelligence feed…</div>
      </div>`;
    content.innerHTML = feedHtml;
    if (!r._fetchStarted) {
      state.activeResearcher = { ...r, _fetchStarted: true };
      fetchAndStoreIntelligence(r.id);
    }
    return;
  }

  // ── Papers
  if (intel.recent_papers?.length) {
    feedHtml += `<div class="section-title">📄 Recent Papers</div>`;
    intel.recent_papers.forEach(p => {
      feedHtml += `
        <div class="signal-card">
          <div class="signal-card-type paper">Paper · ${p.year || ""}</div>
          <div class="signal-title">
            ${p.url ? `<a href="${esc(p.url)}" target="_blank">${esc(p.title)}</a>` : esc(p.title)}
          </div>
          ${p.citations ? `<div class="signal-meta">${p.citations} citations</div>` : ""}
          ${p.summary ? `<div class="signal-summary">${esc(p.summary)}</div>` : ""}
        </div>`;
    });
  }

  // ── Citation spikes
  if (intel.citation_spikes?.length) {
    feedHtml += `<div class="section-title">📈 Citation Spikes</div>`;
    intel.citation_spikes.forEach(p => {
      feedHtml += `
        <div class="signal-card">
          <div class="signal-card-type citation">Citation Spike</div>
          <div class="signal-title">${esc(p.title)}</div>
          <div class="signal-meta">${p.total_citations} total citations · ${esc(p.spike_note)}</div>
        </div>`;
    });
  }

  // ── Grants
  if (intel.grants?.length) {
    feedHtml += `<div class="section-title">💰 Grants & Funding</div>`;
    intel.grants.forEach(g => {
      feedHtml += `
        <div class="signal-card">
          <div class="signal-card-type grant">Grant · ${g.funder || ""}</div>
          <div class="signal-title">${esc(g.title)}</div>
          <div class="signal-meta">${g.year ? g.year + " · " : ""}${g.amount || ""}</div>
        </div>`;
    });
  }

  // ── Patents
  if (intel.patents?.length) {
    feedHtml += `<div class="section-title">⚙ Patents</div>`;
    intel.patents.forEach(p => {
      feedHtml += `
        <div class="signal-card">
          <div class="signal-card-type patent">Patent${p.year ? " · " + p.year : ""}</div>
          <div class="signal-title">${esc(p.title)}</div>
          ${p.patent_number ? `<div class="signal-meta">${esc(p.patent_number)}</div>` : ""}
        </div>`;
    });
  }

  // ── Collaborations
  if (intel.collaborations?.length) {
    feedHtml += `<div class="section-title">🤝 Collaborations</div>`;
    intel.collaborations.forEach(c => {
      feedHtml += `
        <div class="signal-card">
          <div class="signal-card-type collab">Collaboration</div>
          <div class="signal-title">${esc(c.partner)}</div>
          <div class="signal-summary">${esc(c.description)}</div>
        </div>`;
    });
  }

  if (!intel.recent_papers?.length && !intel.grants?.length && !intel.patents?.length && !intel.collaborations?.length) {
    feedHtml += `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">No signals found yet</div>
        <div class="empty-desc">TinyFish searched but couldn't find structured data for this researcher. Try refreshing, or check that the page URL is a valid researcher profile.</div>
      </div>`;
  }

  if (intel.last_checked) {
    feedHtml += `<div style="text-align:center;color:var(--muted);font-size:10px;margin-top:12px;padding-bottom:8px;">Last checked ${formatDate(intel.last_checked)}</div>`;
  }

  content.innerHTML = feedHtml;
}

// ── ACTIONS ────────────────────────────────────────────────────────────────
async function refreshResearcher(id) {
  await loadBookmarks();
  const researcher = state.bookmarks.find(b => b.id === id);
  if (!researcher) return;
  state.activeResearcher = { ...researcher, _loading: true, _fetchStarted: false };
  renderFeed();
  fetchAndStoreIntelligence(id);
}

async function removeBookmark(id) {
  state.bookmarks = state.bookmarks.filter(b => b.id !== id);
  await chrome.storage.local.set({ bookmarks: state.bookmarks });
  renderView();
}

// Re-detect when tab changes
chrome.tabs.onActivated.addListener(() => {
  detectCurrentPage();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") detectCurrentPage();
});

// ── UTILS ──────────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}