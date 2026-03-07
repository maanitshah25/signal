// ── STATE ──────────────────────────────────────────────────────────────────
let state = {
  view: "feed",
  bookmarks: [],
  activeResearcher: null,
  currentPage: null,
  detecting: true,
  agentSteps: {}, // researcherId -> array of step strings
};

// ── INIT ───────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("nav-feed").addEventListener("click", () => showView("feed"));
  document.getElementById("nav-bookmarks").addEventListener("click", () => showView("bookmarks"));

  // Show mock badge if background is in mock mode
  chrome.runtime.sendMessage({ type: "GET_MODE" }, (res) => {
    if (res?.mock) document.getElementById("mock-badge").style.display = "inline";
  });

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    const id = el.dataset.id;
    if (action === "open-researcher") {
      if (e.target.closest("[data-action='remove-bookmark']")) return;
      openResearcher(id);
    } else if (action === "remove-bookmark") {
      e.stopPropagation();
      removeBookmark(id);
    } else if (action === "refresh-researcher") {
      refreshResearcher(id);
    } else if (action === "test-notification") {
      triggerTestNotification(id);
    } else if (action === "back") {
      showView("feed");
    }
  });

  // Listen for live agent step updates from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "AGENT_STEP") {
      state.agentSteps[msg.researcherId] = msg.allSteps;
      if (state.activeResearcher?.id === msg.researcherId) {
        updateAgentLog(msg.allSteps);
      }
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

// ── PAGE DETECTION ─────────────────────────────────────────────────────────
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

    const result = await chrome.runtime.sendMessage({
      type: "FETCH_RESEARCHER_INFO",
      url: tab.url,
    });

    state.detecting = false;
    state.currentPage = (result?.success && result?.data?.is_researcher_page)
      ? { ...result.data, url: tab.url }
      : null;

  } catch (err) {
    state.detecting = false;
    state.currentPage = null;
  }

  updateDetectCard();
}

// ── DETECT CARD ────────────────────────────────────────────────────────────
function updateDetectCard() {
  const container = document.getElementById("page-card");

  if (state.detecting) {
    container.innerHTML = `
      <div class="page-card-label">Current Page</div>
      <div class="detecting-row">
        <div class="pulse"></div>
        <span>Signal is analyzing this page…</span>
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
        ${p.research_areas?.length ? `<div class="detect-tags">${p.research_areas.slice(0,3).map(a => `<span class="tag">${esc(a)}</span>`).join("")}</div>` : ""}
        ${p.profile_summary ? `<div class="detect-summary">${esc(p.profile_summary)}</div>` : ""}
      </div>
      <button class="bookmark-btn ${alreadyBookmarked ? "bookmarked" : ""}" id="bookmark-btn" ${alreadyBookmarked ? "disabled" : ""}>
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
  if (btn) { btn.disabled = true; btn.textContent = "Tracking…"; }

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
  state.agentSteps[researcher.id] = [];
  updateDetectCard();

  state.activeResearcher = { ...researcher, _loading: true };
  state.view = "researcher";
  renderView();

  fetchAndStoreIntelligence(researcher.id);
}

// ── FETCH INTELLIGENCE ─────────────────────────────────────────────────────
async function fetchAndStoreIntelligence(researcherId) {
  const { bookmarks = [] } = await chrome.storage.local.get("bookmarks");
  const researcher = bookmarks.find(b => b.id === researcherId);
  if (!researcher) return;

  const result = await chrome.runtime.sendMessage({
    type: "FETCH_INTELLIGENCE",
    researcher,
    researcherId,
  });

  const { bookmarks: current = [] } = await chrome.storage.local.get("bookmarks");
  const updated = current.map(b =>
    b.id === researcherId
      ? {
          ...b,
          intelligence: result?.data || null,
          lastChecked: new Date().toISOString(),
          hasNew: false,
          _error: (!result?.success && result?.error) ? result.error : null,
        }
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
  if (state.view === "feed") renderFeedList();
  else if (state.view === "bookmarks") renderBookmarksList();
  else if (state.view === "researcher") renderFeed();
}

// ── FEED LIST ──────────────────────────────────────────────────────────────
function renderFeedList() {
  const content = document.getElementById("main-content");
  if (!state.bookmarks.length) {
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔬</div>
        <div class="empty-title">No researchers tracked yet</div>
        <div class="empty-desc">Navigate to a researcher or lab page and click <strong>+ Track</strong> to start receiving intelligence.</div>
      </div>`;
    return;
  }

  content.innerHTML = `
    <div class="section-title">Tracked Researchers</div>
    ${state.bookmarks.map(r => {
      const paperCount = r.intelligence?.recent_papers?.length || 0;
      const grantCount = r.intelligence?.grants?.length || 0;
      const isLoading = !r.intelligence && !r._error;
      return `
        <div class="researcher-card ${r.hasNew ? "active" : ""}" data-action="open-researcher" data-id="${r.id}">
          <div class="rc-top">
            <div>
              <div class="rc-name">${esc(r.name)}</div>
              <div class="rc-institution">${esc(r.institution)}</div>
            </div>
            ${isLoading
              ? `<span class="rc-badge" style="color:var(--accent2);background:rgba(124,106,247,0.15)">Scanning…</span>`
              : r.hasNew
                ? `<span class="rc-badge new">New</span>`
                : `<span class="rc-badge ok">✓</span>`}
          </div>
          <div class="rc-meta">
            ${isLoading
              ? `<div class="rc-stat" style="color:var(--muted)">TinyFish agents searching…</div>`
              : `<div class="rc-stat">Papers <span>${paperCount}</span></div>
                 <div class="rc-stat">Grants <span>${grantCount}</span></div>
                 ${r.lastChecked ? `<div class="rc-stat">Updated <span>${timeAgo(r.lastChecked)}</span></div>` : ""}`}
          </div>
        </div>`;
    }).join("")}`;
}

// ── BOOKMARKS LIST ─────────────────────────────────────────────────────────
function renderBookmarksList() {
  const content = document.getElementById("main-content");
  if (!state.bookmarks.length) {
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📌</div>
        <div class="empty-title">Nothing tracked yet</div>
      </div>`;
    return;
  }

  content.innerHTML = `
    <div class="section-title">All Tracked (${state.bookmarks.length})</div>
    ${state.bookmarks.map(r => `
      <div class="researcher-card" data-action="open-researcher" data-id="${r.id}">
        <div class="rc-top">
          <div>
            <div class="rc-name">${esc(r.name)}</div>
            <div class="rc-institution">${esc(r.institution)}${r.department ? " · " + esc(r.department) : ""}</div>
          </div>
          <button data-action="remove-bookmark" data-id="${r.id}"
            style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;padding:2px 6px;line-height:1;">×</button>
        </div>
        ${r.research_areas?.length ? `<div class="detect-tags" style="margin-top:6px;">${r.research_areas.slice(0,3).map(a=>`<span class="tag">${esc(a)}</span>`).join("")}</div>` : ""}
        <div class="rc-meta" style="margin-top:6px;">
          <div class="rc-stat">Tracked since <span>${formatDate(r.bookmarked_at)}</span></div>
        </div>
      </div>`).join("")}`;
}

// ── RESEARCHER FEED ────────────────────────────────────────────────────────
function openResearcher(id) {
  const researcher = state.bookmarks.find(b => b.id === id);
  if (!researcher) return;
  state.activeResearcher = researcher;
  state.view = "researcher";
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
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
  const steps = state.agentSteps[r.id] || [];
  const isLoading = r._loading || (!intel && !r._error);

  let html = `
    <div class="feed-header">
      <div>
        <div class="feed-name">${esc(r.name)}</div>
        <div class="feed-inst">${esc(r.institution)}</div>
      </div>
      <button class="back-btn" data-action="back">← Back</button>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:12px;">
      <button data-action="refresh-researcher" data-id="${r.id}" class="refresh-btn" style="flex:1;">
        ↻ Refresh
      </button>
      <button data-action="test-notification" data-id="${r.id}" class="refresh-btn" style="flex:1;border-color:var(--accent);color:var(--accent2);" title="Simulate a new paper notification">
        🔔 Test Alert
      </button>
    </div>`;

  // ── Live agent activity log (always show while loading, collapse after)
  if (isLoading || steps.length > 0) {
    html += `
      <div class="agent-log ${isLoading ? "active" : "done"}">
        <div class="agent-log-header">
          ${isLoading
            ? `<div class="pulse"></div><span>TinyFish agents are running…</span>`
            : `<span style="color:var(--green)">✓ Scan complete</span>`}
        </div>
        <div class="agent-log-steps" id="agent-steps-${r.id}">
          ${steps.length === 0
            ? `<div class="agent-step">⚡ Dispatching agents to Google Scholar, arXiv, grant databases…</div>`
            : steps.map(s => `<div class="agent-step">${esc(s)}</div>`).join("")}
          ${isLoading ? `<div class="agent-step blink">▍</div>` : ""}
        </div>
      </div>`;
  }

  if (isLoading) {
    if (!r._fetchStarted) {
      state.activeResearcher = { ...r, _fetchStarted: true };
      fetchAndStoreIntelligence(r.id);
    }
    content.innerHTML = html;
    return;
  }

  if (r._error) {
    html += `<div class="error-msg">⚠ ${esc(r._error)}</div>`;
    content.innerHTML = html;
    return;
  }

  if (!intel) {
    content.innerHTML = html;
    return;
  }

  // ── Papers
  if (intel.recent_papers?.length) {
    html += `<div class="section-title">📄 Recent Papers</div>`;
    intel.recent_papers.forEach(p => {
      html += `
        <div class="signal-card">
          <div class="signal-card-type paper">Paper · ${p.year || ""}</div>
          <div class="signal-title">${p.url ? `<a href="${esc(p.url)}" target="_blank">${esc(p.title)}</a>` : esc(p.title)}</div>
          ${p.citations ? `<div class="signal-meta">${p.citations} citations</div>` : ""}
          ${p.summary ? `<div class="signal-summary">${esc(p.summary)}</div>` : ""}
        </div>`;
    });
  }

  // ── Citation spikes
  if (intel.citation_spikes?.length) {
    html += `<div class="section-title">📈 Citation Spikes</div>`;
    intel.citation_spikes.forEach(p => {
      html += `
        <div class="signal-card">
          <div class="signal-card-type citation">Citation Spike</div>
          <div class="signal-title">${esc(p.title)}</div>
          <div class="signal-meta">${p.total_citations} citations · ${esc(p.spike_note)}</div>
        </div>`;
    });
  }

  // ── Grants
  if (intel.grants?.length) {
    html += `<div class="section-title">💰 Grants & Funding</div>`;
    intel.grants.forEach(g => {
      html += `
        <div class="signal-card">
          <div class="signal-card-type grant">Grant · ${esc(g.funder || "")}</div>
          <div class="signal-title">${esc(g.title)}</div>
          <div class="signal-meta">${g.year ? g.year + " · " : ""}${esc(g.amount || "")}</div>
        </div>`;
    });
  }

  // ── Patents
  if (intel.patents?.length) {
    html += `<div class="section-title">⚙ Patents</div>`;
    intel.patents.forEach(p => {
      html += `
        <div class="signal-card">
          <div class="signal-card-type patent">Patent${p.year ? " · " + p.year : ""}</div>
          <div class="signal-title">${esc(p.title)}</div>
          ${p.patent_number ? `<div class="signal-meta">${esc(p.patent_number)}</div>` : ""}
        </div>`;
    });
  }

  // ── Collaborations
  if (intel.collaborations?.length) {
    html += `<div class="section-title">🤝 Collaborations</div>`;
    intel.collaborations.forEach(c => {
      html += `
        <div class="signal-card">
          <div class="signal-card-type collab">Collaboration</div>
          <div class="signal-title">${esc(c.partner)}</div>
          <div class="signal-summary">${esc(c.description)}</div>
        </div>`;
    });
  }

  if (!intel.recent_papers?.length && !intel.citation_spikes?.length &&
      !intel.grants?.length && !intel.patents?.length && !intel.collaborations?.length) {
    html += `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">No signals found</div>
        <div class="empty-desc">TinyFish couldn't find structured data for this researcher. Try refreshing or tracking a Google Scholar profile URL directly.</div>
      </div>`;
  }

  if (intel.last_checked) {
    html += `<div style="text-align:center;color:var(--muted);font-size:10px;margin:16px 0 8px;">Last checked ${formatDate(intel.last_checked)}</div>`;
  }

  content.innerHTML = html;
}

// Patch live agent log without re-rendering the whole feed
function updateAgentLog(steps) {
  const r = state.activeResearcher;
  if (!r) return;
  const el = document.getElementById(`agent-steps-${r.id}`);
  if (!el) { renderFeed(); return; }
  el.innerHTML = steps.map(s => `<div class="agent-step">${esc(s)}</div>`).join("") +
    `<div class="agent-step blink">▍</div>`;
  el.scrollTop = el.scrollHeight;
}

// ── ACTIONS ────────────────────────────────────────────────────────────────
async function triggerTestNotification(id) {
  const btn = document.querySelector(`[data-action="test-notification"][data-id="${id}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "Running…"; }

  const result = await chrome.runtime.sendMessage({
    type: "TEST_NOTIFICATION",
    researcherId: id,
  });

  if (btn) {
    if (result?.success) {
      btn.textContent = "✓ Sent!";
      btn.style.borderColor = "var(--green)";
      btn.style.color = "var(--green)";
    } else {
      btn.textContent = "⚠ Failed";
      btn.style.borderColor = "var(--red)";
      btn.style.color = "var(--red)";
    }
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = "🔔 Test Alert";
      btn.style.borderColor = "var(--accent)";
      btn.style.color = "var(--accent2)";
    }, 3000);
  }

  // Reload bookmarks to reflect hasNew flag
  await loadBookmarks();
  renderFeedList();
}

async function refreshResearcher(id) {
  await loadBookmarks();
  const researcher = state.bookmarks.find(b => b.id === id);
  if (!researcher) return;
  state.agentSteps[id] = [];
  state.activeResearcher = { ...researcher, _loading: true, _fetchStarted: false, intelligence: null, _error: null };
  renderFeed();
  fetchAndStoreIntelligence(id);
}

async function removeBookmark(id) {
  state.bookmarks = state.bookmarks.filter(b => b.id !== id);
  await chrome.storage.local.set({ bookmarks: state.bookmarks });
  renderView();
}

chrome.tabs.onActivated.addListener(() => detectCurrentPage());
chrome.tabs.onUpdated.addListener((_, changeInfo) => {
  if (changeInfo.status === "complete") detectCurrentPage();
});

// ── UTILS ──────────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
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