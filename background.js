const TINYFISH_API_KEY = "REPLACE_WITH_YOUR_TINYFISH_KEY";
const TINYFISH_URL = "https://agent.tinyfish.ai/v1/automation/run-sse";
const MOCK_MODE = true;

// Keep service worker alive during long SSE streams
const keepAlive = () => setInterval(() => chrome.runtime.getPlatformInfo(), 20000);

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_MODE") {
    sendResponse({ mock: MOCK_MODE });
    return true;
  }
  if (msg.type === "FETCH_RESEARCHER_INFO") {
    fetchResearcherInfo(msg.url).then(sendResponse);
    return true;
  }
  if (msg.type === "FETCH_INTELLIGENCE") {
    fetchIntelligence(msg.researcher, msg.researcherId).then(sendResponse);
    return true;
  }
  if (msg.type === "TEST_NOTIFICATION") {
    testNotification(msg.researcherId).then(sendResponse);
    return true;
  }
});

chrome.alarms.create("daily-check", { periodInMinutes: 1440 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "daily-check") await runDailyChecks();
});

// MOCK DATA
function getMockResearcher(url) {
  // Extract a plausible name from the URL for realism
  const isScholar = url.includes("scholar.google.com");
  const isArxiv = url.includes("arxiv.org");
  return {
    is_researcher_page: true,
    researcher_name: isArxiv ? "Yann LeCun" : "Geoffrey Hinton",
    institution: isArxiv ? "Meta AI / NYU" : "University of Toronto / Google Brain",
    department: "Computer Science & Machine Learning",
    research_areas: ["Deep Learning", "Neural Networks", "Computer Vision", "AI Safety"],
    scholar_url: isScholar ? url : null,
    profile_summary: "A pioneering researcher in deep learning and neural networks whose work on backpropagation and convolutional networks laid the foundation for modern AI systems.",
  };
}

function getMockIntelligence(name) {
  const now = new Date();
  const year = now.getFullYear();
  return {
    recent_papers: [
      {
        title: "Scaling Laws for Neural Language Models in Low-Resource Settings",
        year,
        citations: 312,
        url: "https://arxiv.org/abs/2401.00001",
        summary: "Investigates how scaling laws apply when training data is limited, finding diminishing returns beyond certain parameter thresholds.",
      },
      {
        title: "Sparse Autoencoders for Interpretable Feature Extraction",
        year,
        citations: 187,
        url: "https://arxiv.org/abs/2401.00002",
        summary: "Proposes a new architecture for learning sparse, interpretable representations in large language models.",
      },
      {
        title: "Towards Robust Out-of-Distribution Detection in Vision Transformers",
        year: year - 1,
        citations: 540,
        url: "https://arxiv.org/abs/2312.00001",
        summary: "Benchmarks OOD detection methods across ViT variants and proposes an ensemble approach that outperforms baselines.",
      },
      {
        title: "Efficient Fine-Tuning of Foundation Models via Gradient Checkpointing",
        year: year - 1,
        citations: 229,
        url: null,
        summary: "Demonstrates 60% memory reduction during fine-tuning with minimal accuracy tradeoff using selective gradient checkpointing.",
      },
    ],
    citation_spikes: [
      {
        title: "Attention Is All You Need — Revisited",
        total_citations: 4821,
        spike_note: `Citations up 38% in the last 6 months — likely driven by renewed interest in transformer efficiency research`,
      },
      {
        title: "Dropout: A Simple Way to Prevent Neural Networks from Overfitting",
        total_citations: 39200,
        spike_note: "Consistently high citation velocity — referenced in almost every new deep learning paper",
      },
    ],
    grants: [
      {
        title: "Foundation Models for Scientific Discovery",
        funder: "NSF",
        year,
        amount: "$1,200,000",
      },
      {
        title: "Robust Machine Learning Systems",
        funder: "DARPA",
        year: year - 1,
        amount: "$850,000",
      },
    ],
    patents: [
      {
        title: "Method for training sparse neural networks with dynamic pruning",
        year: year - 1,
        patent_number: "US11,823,456",
      },
    ],
    collaborations: [
      {
        partner: "Google DeepMind",
        description: "Joint research on scaling efficient transformer architectures for on-device inference",
      },
      {
        partner: "OpenAI",
        description: "Co-authored paper on mechanistic interpretability of attention heads",
      },
    ],
    last_checked: now.toISOString(),
  };
}

// MOCK SSE STREAM SIMULATION 
async function simulateMockStream(researcherId, steps) {
  const delay = (ms) => new Promise(res => setTimeout(res, ms));
  for (const step of steps) {
    await delay(600 + Math.random() * 400);
    try {
      chrome.runtime.sendMessage({
        type: "AGENT_STEP",
        researcherId,
        step,
        allSteps: steps.slice(0, steps.indexOf(step) + 1),
      });
    } catch (_) {}
  }
  await delay(800);
}

// CORE TINYFISH CALL
async function callTinyfish(url, goal, researcherId = null) {
  console.log("[Signal] → TinyFish call for:", url);
  const interval = keepAlive();

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
      console.error("[Signal] HTTP error:", response.status, errText);
      clearInterval(interval);
      return { success: false, error: `HTTP ${response.status}: ${errText}` };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult = null;
    let steps = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === "[DONE]") continue;

        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { continue; }

        console.log("[Signal] SSE:", parsed.type || parsed.status, parsed);

        // Forward live step updates to the sidepanel for the activity log
        if (researcherId && parsed.type && parsed.type !== "COMPLETE") {
          const stepMsg = extractStepMessage(parsed);
          if (stepMsg) {
            steps.push(stepMsg);
            try {
              chrome.runtime.sendMessage({
                type: "AGENT_STEP",
                researcherId,
                step: stepMsg,
                allSteps: [...steps],
              });
            } catch (_) {}
          }
        }

        // Capture final result
        if (
          parsed.type === "COMPLETE" || parsed.type === "complete" ||
          parsed.status === "COMPLETED" || parsed.status === "completed"
        ) {
          if (parsed.resultJson && typeof parsed.resultJson === "object") {
            finalResult = parsed.resultJson;
          } else if (parsed.result) {
            finalResult = typeof parsed.result === "string"
              ? safeParseJson(parsed.result) : parsed.result;
          } else if (parsed.output) {
            finalResult = typeof parsed.output === "string"
              ? safeParseJson(parsed.output) : parsed.output;
          }
        }

        // Some TinyFish responses wrap result in data field
        if (!finalResult && parsed.data && typeof parsed.data === "object") {
          if (parsed.data.recent_papers || parsed.data.researcher_name || parsed.data.is_researcher_page !== undefined) {
            finalResult = parsed.data;
          }
        }
      }
    }

    clearInterval(interval);
    console.log("[Signal] ✓ Final result:", finalResult);

    if (!finalResult) {
      return { success: false, error: "No result returned from TinyFish. The page may have been blocked or the agent timed out." };
    }
    return { success: true, data: finalResult, steps };

  } catch (err) {
    clearInterval(interval);
    console.error("[Signal] Fetch failed:", err);
    return { success: false, error: err.message };
  }
}

function safeParseJson(str) {
  try {
    const clean = str.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(clean);
  } catch (_) { return null; }
}

function extractStepMessage(event) {
  if (event.type === "NAVIGATING" || event.action === "navigate") return `🌐 Navigating to ${event.url || "page"}…`;
  if (event.type === "SEARCHING") return `🔍 Searching for ${event.query || "results"}…`;
  if (event.type === "EXTRACTING") return `📄 Extracting data from page…`;
  if (event.type === "THINKING" || event.type === "PLANNING") return `🧠 Analyzing results…`;
  if (event.type === "CLICKING") return `👆 Interacting with page…`;
  if (event.type === "SCROLLING") return `📜 Reading page content…`;
  if (event.message) return `⚡ ${event.message}`;
  if (event.step) return `⚡ ${event.step}`;
  return null;
}

// RESEARCHER DETECTION
async function fetchResearcherInfo(pageUrl) {
  if (MOCK_MODE) {
    await new Promise(r => setTimeout(r, 1500));
    return { success: true, data: getMockResearcher(pageUrl) };
  }

  const goal = `Navigate to this URL: ${pageUrl}

Determine if this is an academic researcher or research lab profile page.

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

  return await callTinyfish(pageUrl, goal);
}

// INTELLIGENCE FETCH
async function fetchIntelligence(researcher, researcherId) {
  if (MOCK_MODE) {
    const steps = [
      "🌐 Navigating to Google Scholar profile…",
      "📄 Reading publications list…",
      "🔍 Extracting recent papers and citation counts…",
      "🌐 Checking NIH Reporter for grant awards…",
      "🌐 Searching USPTO for patent filings…",
      "🧠 Analyzing collaboration signals…",
      "✓ Intelligence scan complete",
    ];
    await simulateMockStream(researcherId, steps);
    return { success: true, data: getMockIntelligence(researcher.name), steps };
  }

  const url = researcher.scholar_url || researcher.url ||
    `https://scholar.google.com/scholar?q=${encodeURIComponent(researcher.name + " " + researcher.institution)}`;

  const goal = `Navigate to this academic profile page: ${url}

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

  return await callTinyfish(url, goal, researcherId);
}

// TEST NOTIFICATION
async function testNotification(researcherId) {
  const { bookmarks = [] } = await chrome.storage.local.get("bookmarks");
  const researcher = bookmarks.find(b => b.id === researcherId);
  if (!researcher) return { success: false };

  if (MOCK_MODE) {
    await new Promise(r => setTimeout(r, 1000));
    const mockPaper = "Scaling Laws for Neural Language Models in Low-Resource Settings";
    chrome.notifications.create(`test-notif-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: `📄 New paper — ${researcher.name}`,
      message: mockPaper,
    });
    const { bookmarks: current = [] } = await chrome.storage.local.get("bookmarks");
    await chrome.storage.local.set({
      bookmarks: current.map(b =>
        b.id === researcherId ? { ...b, hasNew: true } : b
      )
    });
    return { success: true, paperCount: 1 };
  }

  // Temporarily wipe stored intelligence so everything looks "new"
  const wiped = bookmarks.map(b =>
    b.id === researcherId ? { ...b, intelligence: null } : b
  );
  await chrome.storage.local.set({ bookmarks: wiped });

  // Re-fetch — everything will appear as new papers
  const result = await fetchIntelligence(researcher, researcherId);
  if (!result.success || !result.data) return { success: false, error: result.error };

  const newPapers = result.data.recent_papers || [];

  if (newPapers.length > 0) {
    chrome.notifications.create(`test-notif-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: `📄 New paper — ${researcher.name}`,
      message: newPapers[0].title,
    });
  }

  // Save back the fresh intelligence
  const { bookmarks: current = [] } = await chrome.storage.local.get("bookmarks");
  await chrome.storage.local.set({
    bookmarks: current.map(b =>
      b.id === researcherId
        ? { ...b, intelligence: result.data, lastChecked: new Date().toISOString(), hasNew: true }
        : b
    )
  });

  return { success: true, paperCount: newPapers.length };
}

// DAILY MONITORING
async function runDailyChecks() {
  const { bookmarks = [] } = await chrome.storage.local.get("bookmarks");
  for (const researcher of bookmarks) {
    const result = await fetchIntelligence(researcher, researcher.id);
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
    await chrome.storage.local.set({
      bookmarks: current.map(b =>
        b.id === researcher.id
          ? { ...b, intelligence: result.data, lastChecked: new Date().toISOString(), hasNew: newPapers.length > 0 }
          : b
      )
    });
  }
}