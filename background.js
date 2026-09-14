// Signal service worker.
// Owns every TinyFish call, the detection pipeline, the daily re-scan, and notifications.
// The side panel never talks to TinyFish directly.

importScripts("shared/config.js", "shared/storage.js");

const ALARM_NAME = "daily-check";
const NOTIFICATION_PREFIX = "signal-new-paper:";

// ---------- lifecycle ----------

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  const moved = await SignalStore.migrateLegacy();
  if (moved) console.log(`[Signal] migrated ${moved} tracked researcher(s) to synced storage`);
});

chrome.runtime.onStartup.addListener(() => { ensureAlarm(); });

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1440 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runDailyChecks();
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  chrome.notifications.clear(notificationId);
  try {
    const win = await chrome.windows.getLastFocused();
    await chrome.sidePanel.open({ windowId: win.id });
  } catch (_) {
    // Opening the panel needs a user gesture; if Chrome does not count this click, the badge still shows.
  }
});

// ---------- message router ----------

const handlers = {
  GET_STATUS: async () => {
    const settings = await SignalStore.getSettings();
    return { success: true, mock: SignalStore.isMock(settings), hasKey: Boolean(settings.apiKey), developerMode: settings.developerMode };
  },
  DETECT_PAGE: (msg) => detectPage(msg),
  FETCH_INTELLIGENCE: (msg) => fetchIntelligence(msg.researcherId),
  TEST_CONNECTION: (msg) => testConnection(msg.apiKey),
  TEST_NOTIFICATION: (msg) => testNotification(msg.researcherId),
  CLEAR_DETECT_CACHE: async () => { await SignalStore.clearDetectionCache(); return { success: true }; },
  RUN_DAILY_CHECK: async () => { const summary = await runDailyChecks(); return { success: true, ...summary }; },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg))
    .then(sendResponse)
    .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
  return true; // keep the channel open for the async response
});

// ---------- helpers ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pushStep(researcherId, steps) {
  chrome.runtime.sendMessage({
    type: "AGENT_STEP",
    researcherId,
    step: steps[steps.length - 1],
    allSteps: [...steps],
  }).catch(() => { /* side panel closed; nobody listening */ });
}

function safeParseJson(str) {
  try {
    const clean = String(str).replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(clean);
  } catch (_) { return null; }
}

function asObject(value) {
  if (!value) return null;
  if (typeof value === "string") return safeParseJson(value);
  return typeof value === "object" ? value : null;
}

// ---------- TinyFish ----------

async function describeHttpError(response) {
  let body = null;
  try { body = await response.json(); } catch (_) { /* not JSON */ }
  const apiCode = body?.error?.code || "";
  const apiMessage = body?.error?.message || "";
  const status = response.status;

  let error;
  if (status === 401) error = "TinyFish rejected your API key. Open Settings and check it.";
  else if (status === 402) error = "Your TinyFish wallet balance is too low. Top up at agent.tinyfish.ai and try again.";
  else if (status === 403) error = "TinyFish refused this request. Your account may be out of credits.";
  else if (status === 429) error = "TinyFish rate limit reached. Wait a minute and try again.";
  else if (status === 400) error = `TinyFish rejected the request${apiMessage ? `: ${apiMessage}` : "."}`;
  else error = `TinyFish error ${status}${apiMessage ? `: ${apiMessage}` : ""}`;

  return { error, code: apiCode || `HTTP_${status}`, status };
}

function describeRunFailure(event, status) {
  const err = typeof event.error === "object" && event.error ? event.error : { message: event.error };
  const code = err.code || status;
  const map = {
    SITE_BLOCKED: "The site blocked the TinyFish agent (anti-bot or CAPTCHA). Try tracking from a Google Scholar profile instead.",
    TIMEOUT: "The TinyFish run timed out. Try again in a few minutes.",
    SERVICE_BUSY: "TinyFish is at capacity right now. Try again in a few minutes.",
    MAX_STEPS_EXCEEDED: "The agent ran out of steps before finishing. Try a more specific profile URL.",
    CONTENT_POLICY_VIOLATION: "TinyFish declined this page under its content policy.",
    BILLING_REJECTED: "TinyFish declined the run for billing reasons. Check your wallet at agent.tinyfish.ai.",
    CANCELLED: "The run was cancelled.",
  };
  const error = map[code] || err.message || err.help_message || `TinyFish run ${status.toLowerCase()}.`;
  return { error, code };
}

function extractResult(event) {
  return asObject(event.resultJson) || asObject(event.result) || asObject(event.output) || asObject(event.data);
}

function extractStepMessage(event) {
  const type = String(event.type || "").toUpperCase();
  if (type === "STARTED") return "🚀 Agent started";
  if (type === "STREAMING_URL") return "🖥 Live browser session ready";
  if (type === "PROGRESS") {
    if (event.purpose) return `⚡ ${String(event.purpose).slice(0, 160)}`;
    if (event.tinyfish_api) return `🔍 Using TinyFish ${event.tinyfish_api}…`;
    return "⚡ Working…";
  }
  if (type === "TF_API_RESULT") return `📥 Received ${event.tinyfish_api || "search"} results`;
  // Older event shapes, kept so nothing goes silent if the stream format shifts.
  if (type === "NAVIGATING") return `🌐 Navigating to ${event.url || "page"}…`;
  if (type === "SEARCHING") return `🔍 Searching for ${event.query || "results"}…`;
  if (type === "EXTRACTING") return "📄 Extracting data from page…";
  if (type === "THINKING" || type === "PLANNING") return "🧠 Analyzing results…";
  if (event.message) return `⚡ ${String(event.message).slice(0, 160)}`;
  return null;
}

async function callTinyfish({ apiKey, url, goal, researcherId = null }) {
  console.log("[Signal] TinyFish run for:", url);
  // Any extension API call resets the service worker idle timer, so poll one during long streams.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  const steps = [];

  try {
    const response = await fetch(SIGNAL.TINYFISH_RUN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ url, goal }),
    });

    if (!response.ok) {
      const described = await describeHttpError(response);
      console.error("[Signal] HTTP error:", described);
      return { success: false, ...described };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult = null;
    let failure = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;

        let event;
        try { event = JSON.parse(raw); } catch (_) { continue; }

        const type = String(event.type || "").toUpperCase();
        const status = String(event.status || "").toUpperCase();
        if (type === "HEARTBEAT") continue;

        if (type === "COMPLETE" || status === "COMPLETED" || status === "FAILED" || status === "CANCELLED") {
          if (!status || status === "COMPLETED") finalResult = extractResult(event) || finalResult;
          else failure = describeRunFailure(event, status);
          continue;
        }

        // Some responses put the payload in a data field on a non-COMPLETE event.
        if (!finalResult && event.data && typeof event.data === "object" &&
            (event.data.recent_papers || event.data.researcher_name || event.data.is_researcher_page !== undefined)) {
          finalResult = event.data;
        }

        const stepMsg = extractStepMessage(event);
        if (stepMsg && researcherId) {
          steps.push(stepMsg);
          pushStep(researcherId, steps);
        }
      }
    }

    if (failure) return { success: false, ...failure, steps };
    if (!finalResult) {
      return { success: false, code: "NO_RESULT", error: "TinyFish finished without returning data. The page may have blocked the agent or the run timed out.", steps };
    }
    return { success: true, data: finalResult, steps };
  } catch (err) {
    console.error("[Signal] fetch failed:", err);
    return { success: false, code: "NETWORK", error: `Could not reach TinyFish: ${err.message}` };
  } finally {
    clearInterval(keepAlive);
  }
}

// Free key check: GET /v1/wallet costs nothing and returns the balance.
async function testConnection(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) return { success: false, error: "Enter an API key first." };

  try {
    const response = await fetch(SIGNAL.TINYFISH_WALLET_URL, { headers: { "X-API-Key": key } });
    if (response.ok) {
      const wallet = await response.json();
      return { success: true, balance: wallet.available_balance ?? null, currency: wallet.currency || "USD" };
    }
    if (response.status === 401) return { success: false, error: "TinyFish rejected this key. Copy it again from agent.tinyfish.ai/api-keys." };
    if (response.status === 404) return { success: true, balance: null, note: "Key accepted. This account does not use wallet billing, so no balance is shown." };
    const described = await describeHttpError(response);
    return { success: false, error: described.error };
  } catch (err) {
    return { success: false, error: `Could not reach TinyFish: ${err.message}` };
  }
}

// ---------- mock data (developer mode only) ----------

function getMockResearcher(url) {
  const isArxiv = url.includes("arxiv.org");
  return {
    is_researcher_page: true,
    researcher_name: isArxiv ? "Yann LeCun" : "Geoffrey Hinton",
    institution: isArxiv ? "Meta AI / NYU" : "University of Toronto / Google Brain",
    department: "Computer Science & Machine Learning",
    research_areas: ["Deep Learning", "Neural Networks", "Computer Vision", "AI Safety"],
    scholar_url: url.includes("scholar.google.com") ? url : null,
    profile_summary: "A pioneering researcher in deep learning and neural networks whose work on backpropagation and convolutional networks laid the foundation for modern AI systems.",
  };
}

function getMockIntelligence() {
  const now = new Date();
  const year = now.getFullYear();
  return {
    recent_papers: [
      { title: "Scaling Laws for Neural Language Models in Low-Resource Settings", year, citations: 312, url: "https://arxiv.org/abs/2401.00001", summary: "Investigates how scaling laws apply when training data is limited, finding diminishing returns beyond certain parameter thresholds." },
      { title: "Sparse Autoencoders for Interpretable Feature Extraction", year, citations: 187, url: "https://arxiv.org/abs/2401.00002", summary: "Proposes a new architecture for learning sparse, interpretable representations in large language models." },
      { title: "Towards Robust Out-of-Distribution Detection in Vision Transformers", year: year - 1, citations: 540, url: "https://arxiv.org/abs/2312.00001", summary: "Benchmarks OOD detection methods across ViT variants and proposes an ensemble approach that outperforms baselines." },
      { title: "Efficient Fine-Tuning of Foundation Models via Gradient Checkpointing", year: year - 1, citations: 229, url: null, summary: "Demonstrates 60% memory reduction during fine-tuning with minimal accuracy tradeoff using selective gradient checkpointing." },
    ],
    citation_spikes: [
      { title: "Attention Is All You Need — Revisited", total_citations: 4821, spike_note: "Citations up 38% in the last 6 months — likely driven by renewed interest in transformer efficiency research" },
      { title: "Dropout: A Simple Way to Prevent Neural Networks from Overfitting", total_citations: 39200, spike_note: "Consistently high citation velocity — referenced in almost every new deep learning paper" },
    ],
    grants: [
      { title: "Foundation Models for Scientific Discovery", funder: "NSF", year, amount: "$1,200,000" },
      { title: "Robust Machine Learning Systems", funder: "DARPA", year: year - 1, amount: "$850,000" },
    ],
    patents: [
      { title: "Method for training sparse neural networks with dynamic pruning", year: year - 1, patent_number: "US11,823,456" },
    ],
    collaborations: [
      { partner: "Google DeepMind", description: "Joint research on scaling efficient transformer architectures for on-device inference" },
      { partner: "OpenAI", description: "Co-authored paper on mechanistic interpretability of attention heads" },
    ],
    last_checked: now.toISOString(),
  };
}

async function simulateMockStream(researcherId) {
  const script = [
    "🌐 Navigating to Google Scholar profile…",
    "📄 Reading publications list…",
    "🔍 Extracting recent papers and citation counts…",
    "🌐 Checking NIH Reporter for grant awards…",
    "🌐 Searching USPTO for patent filings…",
    "🧠 Analyzing collaboration signals…",
    "✓ Intelligence scan complete",
  ];
  const steps = [];
  for (const step of script) {
    await sleep(600 + Math.random() * 400);
    steps.push(step);
    pushStep(researcherId, steps);
  }
  await sleep(800);
  return steps;
}

// ---------- detection ----------

async function runPrecheck(tabId) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return results?.[0]?.result || null;
  } catch (err) {
    // No host permission for this tab, or the page cannot be scripted. Fall through to the agent.
    console.log("[Signal] pre-check unavailable:", err?.message);
    return null;
  }
}

function buildDetectGoal(url, title) {
  const hint = title ? `\nThe page title is: "${String(title).slice(0, 200)}"` : "";
  return `Navigate to this URL: ${url}${hint}

Determine if this is the profile page of an academic researcher (a person) or a research lab/group.

If YES, extract and respond in json format:
{
  "is_researcher_page": true,
  "researcher_name": "full name",
  "institution": "university name",
  "department": "department or field",
  "research_areas": ["topic1", "topic2", "topic3"],
  "scholar_url": "this URL if it is a Google Scholar page, else null",
  "profile_summary": "2 sentence summary of who this person is and what they research"
}

If NO, respond in json format: { "is_researcher_page": false }`;
}

function normalizeDetection(data) {
  if (!data || typeof data !== "object") return { is_researcher_page: false };
  const isResearcher = data.is_researcher_page === true ||
    (data.is_researcher_page === undefined && Boolean(data.researcher_name));
  if (!isResearcher) return { is_researcher_page: false };
  return {
    is_researcher_page: true,
    researcher_name: String(data.researcher_name || "").trim(),
    institution: String(data.institution || "").trim(),
    department: String(data.department || "").trim(),
    research_areas: Array.isArray(data.research_areas) ? data.research_areas.map(String).slice(0, 6) : [],
    scholar_url: data.scholar_url ? String(data.scholar_url) : null,
    profile_summary: String(data.profile_summary || "").trim(),
  };
}

// Pipeline: cache -> allowlist gate -> free local pre-check -> (mock | TinyFish agent).
async function detectPage({ tabId, url, force = false, manual = false }) {
  if (!signalIsWebUrl(url)) return { success: true, source: "unsupported", data: null };

  const settings = await SignalStore.getSettings();
  const mock = SignalStore.isMock(settings);
  const cacheKey = signalNormalizeUrl(url);

  if (!force) {
    const cached = await SignalStore.getCachedDetection(cacheKey);
    if (cached) return { success: true, source: "cache", data: cached };
  }

  const auto = signalIsAutoDetectUrl(url);
  if (!auto && !manual) return { success: true, source: "manual-required", data: null };

  let precheck = null;
  if (auto && tabId != null) precheck = await runPrecheck(tabId);

  if (precheck?.localProfile?.researcher_name) {
    const data = normalizeDetection({ is_researcher_page: true, ...precheck.localProfile });
    await SignalStore.setCachedDetection(cacheKey, data);
    return { success: true, source: "page", data };
  }

  // On academic sites, only spend a run when the free check says "likely", the URL is a known
  // profile shape, or the user explicitly asked. A page we could not read (PDF, error page) counts as "no".
  if (auto && !manual && !signalIsProfileUrl(url) && !precheck?.likely) {
    const data = { is_researcher_page: false, reason: precheck ? "precheck" : "unreadable" };
    await SignalStore.setCachedDetection(cacheKey, data, SIGNAL.PRECHECK_NEGATIVE_TTL_MS);
    return { success: true, source: "precheck", data };
  }

  if (mock) {
    await sleep(1200);
    const data = getMockResearcher(url);
    await SignalStore.setCachedDetection(cacheKey, data);
    return { success: true, source: "mock", data };
  }

  if (!settings.apiKey) {
    return { success: false, code: "NO_API_KEY", error: "Add your TinyFish API key in Settings to detect researchers on this page." };
  }

  const result = await callTinyfish({ apiKey: settings.apiKey, url, goal: buildDetectGoal(url, precheck?.title) });
  if (!result.success) return result;

  const data = normalizeDetection(result.data);
  await SignalStore.setCachedDetection(cacheKey, data);
  return { success: true, source: "agent", data };
}

// ---------- intelligence ----------

function buildIntelligenceGoal(researcher, url) {
  return `Navigate to this academic profile page: ${url}

Research everything available about ${researcher.name} at ${researcher.institution}.
Look through their publications list, check citation counts, and find any mentions of grants, patents or industry collaborations.

Respond in json format:
{
  "recent_papers": [
    { "title": "paper title", "year": 2024, "citations": 150, "url": "link or null", "summary": "one sentence about what this paper is about" }
  ],
  "citation_spikes": [
    { "title": "paper title", "total_citations": 1200, "spike_note": "why this is notable e.g. highly cited in 2024" }
  ],
  "grants": [
    { "title": "grant name", "funder": "NIH / NSF / etc", "year": 2023, "amount": "$500,000 or null" }
  ],
  "patents": [
    { "title": "patent title", "year": 2022, "patent_number": "US1234567 or null" }
  ],
  "collaborations": [
    { "partner": "company or institution", "description": "nature of the collaboration" }
  ],
  "last_checked": "today's date in ISO format"
}

Include up to 6 recent papers sorted by most recent first. Return empty arrays for categories with no data found.`;
}

// Runs the agent for one researcher and returns the raw outcome without touching storage.
async function gatherIntelligence(researcher, settings) {
  if (SignalStore.isMock(settings)) {
    const steps = await simulateMockStream(researcher.id);
    return { success: true, data: getMockIntelligence(), steps };
  }
  if (!settings.apiKey) {
    return { success: false, code: "NO_API_KEY", error: "Add your TinyFish API key in Settings to scan this researcher." };
  }
  const url = researcher.scholar_url || researcher.url ||
    `https://scholar.google.com/scholar?q=${encodeURIComponent(`${researcher.name} ${researcher.institution}`)}`;
  return callTinyfish({ apiKey: settings.apiKey, url, goal: buildIntelligenceGoal(researcher, url), researcherId: researcher.id });
}

function diffNewPapers(previousIntel, nextIntel) {
  const prevTitles = new Set((previousIntel?.recent_papers || []).map((p) => p.title));
  return (nextIntel?.recent_papers || []).filter((p) => p.title && !prevTitles.has(p.title));
}

// User-initiated scan from the side panel. Saves the result and clears the "new" badge.
async function fetchIntelligence(researcherId) {
  const researcher = await SignalStore.getBookmark(researcherId);
  if (!researcher) return { success: false, error: "This researcher is no longer tracked." };

  const settings = await SignalStore.getSettings();
  const result = await gatherIntelligence(researcher, settings);

  if (!result.success) {
    await SignalStore.updateBookmark(researcherId, { lastError: result.error });
    return result;
  }

  await SignalStore.updateBookmark(researcherId, {
    intelligence: result.data,
    lastChecked: new Date().toISOString(),
    lastError: null,
    hasNew: false,
  });
  return { success: true, paperCount: result.data.recent_papers?.length || 0 };
}

function notifyNewPaper(researcher, paper) {
  chrome.notifications.create(`${NOTIFICATION_PREFIX}${researcher.id}`, {
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: `New paper — ${researcher.name}`,
    message: paper.title,
  });
}

// Developer-mode button. Never wipes stored data; just re-scans and fires a notification.
async function testNotification(researcherId) {
  const researcher = await SignalStore.getBookmark(researcherId);
  if (!researcher) return { success: false, error: "Researcher not found." };

  const settings = await SignalStore.getSettings();
  if (SignalStore.isMock(settings)) {
    await sleep(800);
    notifyNewPaper(researcher, { title: "Scaling Laws for Neural Language Models in Low-Resource Settings" });
    await SignalStore.updateBookmark(researcherId, { hasNew: true });
    return { success: true, paperCount: 1 };
  }

  const result = await gatherIntelligence(researcher, settings);
  if (!result.success) return result;

  const papers = result.data.recent_papers || [];
  if (papers.length) notifyNewPaper(researcher, papers[0]);
  await SignalStore.updateBookmark(researcherId, {
    intelligence: result.data,
    lastChecked: new Date().toISOString(),
    lastError: null,
    hasNew: papers.length > 0,
  });
  return { success: true, paperCount: papers.length };
}

// ---------- daily monitoring ----------

async function runDailyChecks() {
  const settings = await SignalStore.getSettings();
  const summary = { checked: 0, skipped: 0, failed: 0, newPapers: 0 };

  if (!settings.apiKey && !SignalStore.isMock(settings)) {
    console.log("[Signal] daily check skipped: no API key");
    return summary;
  }

  const bookmarks = await SignalStore.getBookmarks();
  for (const researcher of bookmarks) {
    const lastChecked = researcher.lastChecked ? new Date(researcher.lastChecked).getTime() : 0;
    if (Date.now() - lastChecked < SIGNAL.DAILY_CHECK_MIN_GAP_MS) {
      summary.skipped++;
      continue;
    }

    const result = await gatherIntelligence(researcher, settings);
    if (!result.success) {
      summary.failed++;
      await SignalStore.updateBookmark(researcher.id, { lastError: result.error });
      if (result.code === "INVALID_API_KEY" || result.status === 401 || result.status === 402) break; // pointless to continue
      continue;
    }

    const newPapers = diffNewPapers(researcher.intelligence, result.data);
    if (newPapers.length) notifyNewPaper(researcher, newPapers[0]);

    await SignalStore.updateBookmark(researcher.id, {
      intelligence: result.data,
      lastChecked: new Date().toISOString(),
      lastError: null,
      hasNew: newPapers.length > 0 || Boolean(researcher.hasNew),
    });
    summary.checked++;
    summary.newPapers += newPapers.length;
  }

  console.log("[Signal] daily check:", summary);
  return summary;
}
