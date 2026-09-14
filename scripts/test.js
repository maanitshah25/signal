// End-to-end test of background.js with stubbed chrome.* APIs and a fake TinyFish SSE stream.
// Run from the repo root:  node scripts/test.js
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const log = [];
const listeners = { onMessage: [], onAlarm: [], onInstalled: [], onStartup: [], onNotifClick: [] };

function makeArea(name, itemLimit) {
  const data = {};
  return {
    _data: data,
    async get(keys) {
      const copy = (v) => JSON.parse(JSON.stringify(v));
      if (keys === null || keys === undefined) return copy(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {}; for (const k of list) if (k in data) out[k] = copy(data[k]); return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) {
        const size = Buffer.byteLength(JSON.stringify(v));
        if (itemLimit && size > itemLimit) throw new Error(`QUOTA_BYTES_PER_ITEM exceeded (${size})`);
        data[k] = JSON.parse(JSON.stringify(v));
      }
    },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
  };
}
const local = makeArea("local"), sync = makeArea("sync", 8192);
let scriptResult = null;
let sentMessages = [];
let notifications = [];

global.chrome = {
  runtime: {
    onMessage: { addListener: (f) => listeners.onMessage.push(f) },
    onInstalled: { addListener: (f) => listeners.onInstalled.push(f) },
    onStartup: { addListener: (f) => listeners.onStartup.push(f) },
    sendMessage: async (m) => { sentMessages.push(m); },
    getPlatformInfo: () => {},
  },
  sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
  alarms: { _a: {}, async get(n) { return this._a[n] || null; }, async create(n, o) { this._a[n] = { name: n, ...o }; }, onAlarm: { addListener: (f) => listeners.onAlarm.push(f) } },
  notifications: { create: (id, o) => notifications.push({ id, ...o }), clear: () => {}, onClicked: { addListener: (f) => listeners.onNotifClick.push(f) } },
  windows: { getLastFocused: async () => ({ id: 1 }) },
  storage: { local, sync },
  scripting: { executeScript: async () => { if (scriptResult instanceof Error) throw scriptResult; return [{ result: scriptResult }]; } },
};

// fetch stub: SSE for run-sse, JSON for wallet
let fetchMode = "ok";
let fetchCalls = [];
function sse(events) {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = Buffer.from(body);
  let sent = false;
  return {
    ok: true, status: 200,
    body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }) }) },
  };
}
global.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts });
  if (url.includes("/wallet")) {
    if (fetchMode === "badkey") return { ok: false, status: 401, json: async () => ({ error: { code: "INVALID_API_KEY", message: "nope" } }) };
    return { ok: true, status: 200, json: async () => ({ available_balance: "12.50", currency: "USD" }) };
  }
  if (fetchMode === "badkey") return { ok: false, status: 401, json: async () => ({ error: { code: "INVALID_API_KEY", message: "nope" } }) };
  if (fetchMode === "nocredits") return { ok: false, status: 402, json: async () => ({ error: { code: "INSUFFICIENT_CREDITS", message: "low" } }) };
  if (fetchMode === "blocked") return sse([{ type: "STARTED", run_id: "r" }, { type: "COMPLETE", status: "FAILED", error: { code: "SITE_BLOCKED", message: "x" } }]);
  const goal = JSON.parse(opts.body).goal;
  const isDetect = goal.includes("is_researcher_page");
  const result = isDetect
    ? { is_researcher_page: true, researcher_name: "Ada Lovelace", institution: "Analytical Engine U", department: "Math", research_areas: ["Computing"], scholar_url: null, profile_summary: "First programmer." }
    : { recent_papers: [{ title: "Notes on the Engine", year: 2026, citations: 5, url: "https://example.org/p", summary: "s" }, { title: "Paper Two", year: 2025 }], citation_spikes: [], grants: [], patents: [], collaborations: [], last_checked: "2026-09-13" };
  return sse([
    { type: "STARTED", run_id: "r1" },
    { type: "STREAMING_URL", run_id: "r1", streaming_url: "https://x" },
    { type: "HEARTBEAT" },
    { type: "PROGRESS", run_id: "r1", purpose: "Opening the profile page" },
    { type: "PROGRESS", run_id: "r1", tinyfish_api: "search" },
    { type: "COMPLETE", run_id: "r1", status: "COMPLETED", result: result },
  ]);
};

// load scripts as the SW would
global.importScripts = (...files) => { for (const f of files) new Function(fs.readFileSync(path.join(ROOT, f), "utf8") + "\nfor (const k of ['SIGNAL','signalHostname','signalIsWebUrl','signalIsAutoDetectUrl','signalIsProfileUrl','signalNormalizeUrl','SignalStore']) { try { globalThis[k] = eval(k); } catch (_) {} }")(); };
new Function(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"))();

const call = (msg) => new Promise((res) => listeners.onMessage[0](msg, {}, res));
let failures = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "✓" : "✗"} ${name} ${extra}`); if (!cond) failures++; };

(async () => {
  // legacy migration
  await local.set({ bookmarks: [{ id: "old1", name: "Legacy Person", institution: "Old U", url: "https://old.edu/p", bookmarked_at: "2026-01-01T00:00:00Z", intelligence: null, _loading: true }] });
  for (const f of listeners.onInstalled) await f({ reason: "install" });
  check("legacy bookmark migrated to sync", !!sync._data["bm_old1"] && !("bookmarks" in local._data));
  check("transient fields stripped", !("_loading" in sync._data["bm_old1"]));
  check("alarm created", !!chrome.alarms._a["daily-check"]);

  // status with no key
  let r = await call({ type: "GET_STATUS" });
  check("status: no key, not mock", r.success && !r.hasKey && !r.mock);

  // detection: non-academic without manual -> manual-required, no fetch
  r = await call({ type: "DETECT_PAGE", tabId: 1, url: "https://news.ycombinator.com/" });
  check("non-academic site requires manual scan", r.source === "manual-required" && fetchCalls.length === 0);

  // detection: scholar profile extracted locally without key
  scriptResult = { kind: "scholar-profile", likely: true, title: "Ada", localProfile: { researcher_name: "Ada Lovelace", institution: "AEU", department: "Math", research_areas: ["Computing"], scholar_url: "https://scholar.google.com/citations?user=abc", profile_summary: "" } };
  r = await call({ type: "DETECT_PAGE", tabId: 1, url: "https://scholar.google.com/citations?user=abc&hl=en" });
  check("scholar profile read from page, free", r.source === "page" && r.data.researcher_name === "Ada Lovelace" && fetchCalls.length === 0);
  r = await call({ type: "DETECT_PAGE", tabId: 1, url: "https://scholar.google.com/citations?user=abc&hl=en#x" });
  check("second visit served from cache (hash ignored)", r.source === "cache");

  // detection: .edu page, precheck unlikely -> no agent
  scriptResult = { kind: "generic", likely: false, score: 1, title: "News" };
  r = await call({ type: "DETECT_PAGE", tabId: 1, url: "https://news.stanford.edu/story" });
  check(".edu non-profile blocked by free precheck", r.source === "precheck" && r.data.is_researcher_page === false && fetchCalls.length === 0);

  // detection: .edu page unreadable (PDF) -> no agent
  scriptResult = new Error("Cannot access contents");
  r = await call({ type: "DETECT_PAGE", tabId: 1, url: "https://cs.stanford.edu/paper.pdf" });
  check("unreadable academic page does not spend a run", r.source === "precheck" && fetchCalls.length === 0);

  // detection: .edu likely profile, no key -> NO_API_KEY
  scriptResult = { kind: "generic", likely: true, score: 4, title: "Prof. Ada" };
  r = await call({ type: "DETECT_PAGE", tabId: 1, url: "https://cs.stanford.edu/people/ada" });
  check("likely profile without key returns NO_API_KEY", !r.success && r.code === "NO_API_KEY" && fetchCalls.length === 0);

  // add key, test connection
  await SignalStore.saveSettings({ apiKey: "test-key-123" });
  r = await call({ type: "TEST_CONNECTION", apiKey: "test-key-123" });
  check("test connection returns balance", r.success && r.balance === "12.50", JSON.stringify(r));
  fetchMode = "badkey";
  r = await call({ type: "TEST_CONNECTION", apiKey: "bad" });
  check("bad key rejected with friendly message", !r.success && /rejected/.test(r.error));
  fetchMode = "ok";

  // detection with key -> agent
  r = await call({ type: "DETECT_PAGE", tabId: 1, url: "https://cs.stanford.edu/people/ada" });
  check("likely profile with key runs agent", r.success && r.source === "agent" && r.data.researcher_name === "Ada Lovelace" && fetchCalls.filter(c => c.url.includes("run-sse")).length === 1);
  check("agent request carries API key header", fetchCalls.at(-1).opts.headers["X-API-Key"] === "test-key-123");
  check("goal contains title hint", JSON.parse(fetchCalls.at(-1).opts.body).goal.includes("Prof. Ada"));

  // manual scan on non-academic site -> agent
  r = await call({ type: "DETECT_PAGE", tabId: 1, url: "https://example.com/bio", manual: true, force: true });
  check("manual scan on other site runs agent", r.success && r.source === "agent");

  // track + fetch intelligence
  await SignalStore.saveBookmark({ id: "ada", name: "Ada Lovelace", institution: "AEU", url: "https://cs.stanford.edu/people/ada", scholar_url: null, bookmarked_at: new Date().toISOString(), intelligence: null, lastChecked: null, hasNew: false });
  sentMessages = [];
  r = await call({ type: "FETCH_INTELLIGENCE", researcherId: "ada" });
  const ada = await SignalStore.getBookmark("ada");
  check("intelligence fetched and saved", r.success && r.paperCount === 2 && ada.intelligence.recent_papers.length === 2, JSON.stringify(r));
  check("live steps forwarded to panel", sentMessages.filter(m => m.type === "AGENT_STEP").length === 4 && sentMessages.some(m => m.step.includes("Opening the profile page")));
  check("full intel cached locally", !!local._data["intel_ada"]);

  // failure paths persist lastError, do not wipe intel
  fetchMode = "blocked";
  r = await call({ type: "FETCH_INTELLIGENCE", researcherId: "ada" });
  const ada2 = await SignalStore.getBookmark("ada");
  check("SITE_BLOCKED gives friendly error and keeps old intel", !r.success && /blocked/.test(r.error) && ada2.lastError && ada2.intelligence.recent_papers.length === 2);
  fetchMode = "nocredits";
  r = await call({ type: "FETCH_INTELLIGENCE", researcherId: "ada" });
  check("402 maps to wallet message", !r.success && /wallet/.test(r.error));
  fetchMode = "ok";

  // daily check: skips recently-checked, runs stale ones, notifies on new paper
  await SignalStore.removeBookmark("old1");
  await SignalStore.updateBookmark("ada", { lastChecked: new Date(Date.now() - 25 * 3600e3).toISOString(), intelligence: { recent_papers: [{ title: "Paper Two" }] } });
  await SignalStore.saveBookmark({ id: "fresh", name: "Fresh", institution: "U", url: "https://x.edu", bookmarked_at: new Date().toISOString(), lastChecked: new Date().toISOString(), intelligence: { recent_papers: [] } });
  notifications = [];
  r = await call({ type: "RUN_DAILY_CHECK" });
  const ada3 = await SignalStore.getBookmark("ada");
  check("daily check ran 1, skipped 1", r.checked === 1 && r.skipped === 1, JSON.stringify(r));
  check("new paper detected and notified", notifications.length === 1 && notifications[0].message === "Notes on the Engine" && ada3.hasNew === true);

  // sync compaction: giant intelligence must not break the sync write
  const big = { recent_papers: Array.from({ length: 40 }, (_, i) => ({ title: "T" + i, year: 2026, citations: i, url: null, summary: "x".repeat(600) })), citation_spikes: [], grants: [], patents: [], collaborations: [], last_checked: "2026" };
  await SignalStore.updateBookmark("ada", { intelligence: big, lastChecked: "2026-09-13T00:00:00Z" });
  const syncItem = sync._data["bm_ada"];
  const merged = await SignalStore.getBookmark("ada");
  console.log("   sync item:", Buffer.byteLength(JSON.stringify(syncItem)), "bytes; intel:", syncItem.intelligence === null ? "null" : `${syncItem.intelligence.recent_papers?.length} papers`, "; local_only:", syncItem.intelligence_local_only, "; keys:", Object.keys(syncItem).join(","));
  check("oversized intel compacted for sync", syncItem.intelligence === null || syncItem.intelligence.recent_papers.length <= 6);
  check("full intel still available locally", merged.intelligence.recent_papers.length === 40);

  // remove
  await SignalStore.removeBookmark("ada");
  check("remove clears sync and local", !sync._data["bm_ada"] && !local._data["intel_ada"]);

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
