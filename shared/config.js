// Shared constants and helpers.
// Loaded by the service worker via importScripts() and by the side panel via <script>.

const SIGNAL = {
  VERSION: "1.1.0",
  TINYFISH_RUN_URL: "https://agent.tinyfish.ai/v1/automation/run-sse",
  TINYFISH_WALLET_URL: "https://agent.tinyfish.ai/v1/wallet",
  TINYFISH_KEYS_URL: "https://agent.tinyfish.ai/api-keys",
  PRIVACY_URL: "https://maanitshah25.github.io/signal/privacy/",
  SOURCE_URL: "https://github.com/maanitshah25/signal",

  // Detection results are cached per URL for this long.
  DETECT_CACHE_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  // Negative results from the free local pre-check are cached for a shorter time,
  // in case the page had not finished rendering when we looked.
  PRECHECK_NEGATIVE_TTL_MS: 60 * 60 * 1000,
  DETECT_CACHE_MAX_ENTRIES: 300,

  // The daily re-scan skips a researcher checked more recently than this.
  // Keeps two synced devices from both paying for the same scan.
  DAILY_CHECK_MIN_GAP_MS: 20 * 60 * 60 * 1000,

  // Exact hostnames where Signal auto-detects.
  // Must stay in sync with host_permissions in manifest.json (scripts/build.sh checks this).
  AUTO_DETECT_HOSTS: [
    "scholar.google.com",
    "orcid.org",
    "www.researchgate.net", "researchgate.net",
    "www.semanticscholar.org", "semanticscholar.org",
    "arxiv.org", "www.arxiv.org",
    "dblp.org", "dblp.uni-trier.de",
    "openreview.net", "www.openreview.net",
  ],

  // Domain suffixes where Signal auto-detects (university domains).
  AUTO_DETECT_SUFFIXES: [
    ".edu",
    ".ac.uk", ".ac.jp", ".ac.in", ".ac.kr", ".ac.il", ".ac.nz", ".ac.za", ".ac.at",
    ".ac.be", ".ac.cn", ".ac.ir", ".ac.id", ".ac.th", ".ac.ae",
    ".edu.au", ".edu.cn", ".edu.sg", ".edu.hk", ".edu.tw", ".edu.in", ".edu.br",
    ".edu.mx", ".edu.co", ".edu.ar", ".edu.tr", ".edu.pk", ".edu.my", ".edu.sa",
  ],

  // URL shapes that are always a researcher profile. These skip the text pre-check gate.
  PROFILE_URL_PATTERNS: [
    /^https:\/\/scholar\.google\.com\/citations\?.*\buser=/i,
    /^https:\/\/orcid\.org\/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/i,
    /^https:\/\/(www\.)?researchgate\.net\/profile\//i,
    /^https:\/\/(www\.)?semanticscholar\.org\/author\//i,
    /^https:\/\/(www\.)?arxiv\.org\/a\//i,
    /^https:\/\/dblp\.(org|uni-trier\.de)\/pid\//i,
    /^https:\/\/(www\.)?openreview\.net\/profile/i,
  ],
};

function signalHostname(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ""; }
}

function signalIsWebUrl(url) {
  return /^https?:\/\//i.test(url || "");
}

function signalIsAutoDetectUrl(url) {
  if (!signalIsWebUrl(url)) return false;
  const host = signalHostname(url);
  if (!host) return false;
  if (SIGNAL.AUTO_DETECT_HOSTS.includes(host)) return true;
  return SIGNAL.AUTO_DETECT_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function signalIsProfileUrl(url) {
  return SIGNAL.PROFILE_URL_PATTERNS.some((re) => re.test(url || ""));
}

// Cache key for detection: same page ignoring the fragment.
function signalNormalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch (_) { return url; }
}
