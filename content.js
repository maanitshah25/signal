// Free, local page pre-check. Injected on demand by background.js via
// chrome.scripting.executeScript on allowlisted academic sites only.
// The value of the final expression is returned to the service worker.
//
// Two jobs:
//   1. On a Google Scholar profile, extract the researcher directly. No API call needed.
//   2. Elsewhere, score the page text for researcher-profile signals so Signal only
//      spends a TinyFish run when the page plausibly is one.
(() => {
  const textOf = (selector) => document.querySelector(selector)?.textContent?.trim() || "";

  // --- Google Scholar profile: extract locally ---
  if (location.hostname === "scholar.google.com" && location.pathname.startsWith("/citations") && document.querySelector("#gsc_prf_in")) {
    const name = textOf("#gsc_prf_in");
    const affiliationLine = document.querySelector(".gsc_prf_il")?.textContent?.trim() || "";
    const interests = Array.from(document.querySelectorAll("#gsc_prf_int a")).map((a) => a.textContent.trim()).filter(Boolean);

    // "Professor of Computer Science, University of Toronto" -> department / institution
    let institution = affiliationLine;
    let department = "";
    const comma = affiliationLine.lastIndexOf(",");
    if (comma > 0) {
      institution = affiliationLine.slice(comma + 1).trim();
      department = affiliationLine.slice(0, comma).trim();
    }

    const user = new URLSearchParams(location.search).get("user");
    const scholarUrl = user ? `https://scholar.google.com/citations?user=${encodeURIComponent(user)}` : location.href;

    return {
      kind: "scholar-profile",
      likely: true,
      title: document.title,
      localProfile: {
        researcher_name: name,
        institution,
        department,
        research_areas: interests.slice(0, 6),
        scholar_url: scholarUrl,
        profile_summary: "",
      },
    };
  }

  // --- Generic pre-check: score the visible text ---
  const root = document.querySelector("main, article, #content, .content, #main") || document.body;
  const text = (root?.innerText || "").slice(0, 8000);

  const SIGNALS = [
    ["role", /\b(professor|lecturer|postdoc(toral)?|research (scientist|fellow|associate)|principal investigator|faculty|group leader)\b/i],
    ["publications", /\b(publications|selected papers|journal articles|conference papers|preprints|working papers)\b/i],
    ["research", /\b(research (interests|areas|group|lab|focus)|laboratory|lab members|our team|current projects)\b/i],
    ["scholarly-ids", /\b(cited by|h-index|citations|google scholar|orcid|semantic scholar|dblp|researchgate)\b/i],
    ["academic-life", /\b(ph\.?\s?d\.?|dissertation|thesis|graduate students|advisees|postdocs|teaching)\b/i],
    ["affiliation", /\b(curriculum vitae|office hours|department of|school of|institute (of|for)|college of)\b/i],
  ];

  const matched = SIGNALS.filter(([, re]) => re.test(text)).map(([label]) => label);
  let score = matched.length;

  // Links to scholarly identity pages are a strong hint this page is about a researcher.
  if (document.querySelector('a[href*="scholar.google.com/citations"], a[href*="orcid.org/0"]')) {
    score += 2;
    matched.push("identity-link");
  }

  return {
    kind: "generic",
    likely: score >= 3,
    score,
    signals: matched,
    title: document.title,
  };
})();
