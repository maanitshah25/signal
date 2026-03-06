const TINYFISH_API_KEY = "sk-tinyfish-Hh17L5CpyH3gFCXA_GqTohD6v13uZmTO";
const TINYFISH_URL = "https://agent.tinyfish.ai/v1/automation/run-sse";

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Listen for messages from sidepanel and content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "FETCH_RESEARCHER_INFO") {
    fetchResearcherInfo(msg.url, msg.pageText).then(sendResponse);
    return true;
  }
  if (msg.type === "FETCH_INTELLIGENCE") {
    fetchIntelligence(msg.researcher).then(sendResponse);
    return true;
  }
});

// Daily alarm for monitoring bookmarked researchers
chrome.alarms.create("daily-check", { periodInMinutes: 1440 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "daily-check") await runDailyChecks();
});

// ── TINYFISH CALL ──────────────────────────────────────────────────────────
async function callTinyfish(url, goal) {
  console.log("[Signal] Calling TinyFish for URL:", url);

  try {
    const response = await fetch(TINYFISH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TINYFISH_API_KEY,
      },
      body: JSON.stringify({ url, goal }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("[Signal] TinyFish HTTP error:", response.status, errText);
      return { success: false, error: `HTTP ${response.status}: ${errText}` };
    }

    console.log("[Signal] TinyFish connected, reading SSE stream...");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastResult = null;
    let rawLines = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        rawLines.push(line);
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === "[DONE]") continue;

        try {
          const data = JSON.parse(raw);
          console.log("[Signal] SSE event:", data.type || data.status, data);

          if (
            data.type === "COMPLETE" || data.type === "complete" ||
            data.status === "COMPLETED" || data.status === "completed"
          ) {
            if (data.resultJson) {
              lastResult = data.resultJson;
            } else if (data.result) {
              lastResult = typeof data.result === "string" ? JSON.parse(data.result) : data.result;
            } else if (data.output) {
              lastResult = typeof data.output === "string" ? JSON.parse(data.output) : data.output;
            }
          }
          if (data.type === "RESULT" && data.data) lastResult = data.data;

        } catch (parseErr) {
          try { lastResult = JSON.parse(raw); } catch (_) {}
        }
      }
    }

    console.log("[Signal] Stream complete. Final result:", lastResult);
    console.log("[Signal] All SSE lines:", rawLines);

    if (!lastResult) {
      return { success: false, error: "TinyFish returned no result. Check service worker console for raw SSE output." };
    }
    return { success: true, data: lastResult };

  } catch (err) {
    console.error("[Signal] Fetch error:", err);
    return { success: false, error: err.message };
  }
}

// ── RESEARCHER DETECTION ───────────────────────────────────────────────────
async function fetchResearcherInfo(pageUrl, pageText) {
  const goal = `Navigate to this URL and identify whether it is an academic researcher or research lab profile page: ${pageUrl}

If it is a researcher or lab page, extract:
- researcher_name: full name of the researcher or lab director
- institution: university or institution name
- department: department or research field
- research_areas: array of up to 4 main research topics
- is_researcher_page: true
- scholar_url: the current URL if it is a Google Scholar page, else null
- profile_summary: 1-2 sentence summary of who this person is

If it is NOT a researcher page, just return is_researcher_page as false.

Respond in json format: { "researcher_name": "", "institution": "", "department": "", "research_areas": [], "is_researcher_page": true, "scholar_url": null, "profile_summary": "" }`;

  return await callTinyfish(pageUrl, goal);
}

// ── INTELLIGENCE FETCH ─────────────────────────────────────────────────────
async function fetchIntelligence(researcher) {
  const searchUrl = researcher.scholar_url || researcher.url ||
    `https://scholar.google.com/scholar?q=${encodeURIComponent(researcher.name + " " + researcher.institution)}`;

  const goal = `Navigate to this page and research the academic profile of ${researcher.name} at ${researcher.institution}: ${searchUrl}

Find and extract:
- recent_papers: up to 5 most recent papers, each with title, year, citations count, url, and a one sentence summary
- citation_spikes: any papers with notably high or rapidly growing citations, each with title, total_citations, and spike_note
- grants: any grants or funding awarded, each with title, funder, year, and amount
- patents: any patents filed or granted, each with title, year, and patent_number
- collaborations: any notable industry or cross-institution collaborations, each with partner and description
- last_checked: today's date in ISO format

Return empty arrays for any categories where nothing is found.

Respond in json format: { "recent_papers": [], "citation_spikes": [], "grants": [], "patents": [], "collaborations": [], "last_checked": "" }`;

  return await callTinyfish(searchUrl, goal);
}

// ── DAILY MONITORING ───────────────────────────────────────────────────────
async function runDailyChecks() {
  const { bookmarks = [] } = await chrome.storage.local.get("bookmarks");
  for (const researcher of bookmarks) {
    const result = await fetchIntelligence(researcher);
    if (!result.success || !result.data) continue;

    const prevTitles = new Set((researcher.intelligence?.recent_papers || []).map(p => p.title));
    const newPapers = (result.data.recent_papers || []).filter(p => !prevTitles.has(p.title));

    if (newPapers.length > 0) {
      chrome.notifications.create(`notif-${Date.now()}`, {
        type: "basic",
        iconUrl: "icons/icon48.png",
        title: `New paper — ${researcher.name}`,
        message: newPapers[0].title,
      });
    }

    const { bookmarks: current = [] } = await chrome.storage.local.get("bookmarks");
    const updated = current.map(b =>
      b.id === researcher.id
        ? { ...b, intelligence: result.data, lastChecked: new Date().toISOString(), hasNew: newPapers.length > 0 }
        : b
    );
    await chrome.storage.local.set({ bookmarks: updated });
  }
}