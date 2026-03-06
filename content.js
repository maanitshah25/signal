// Extract readable text from the current page for researcher detection
function getPageText() {
  const selectors = [
    'main', 'article', '.profile', '.bio', '.about',
    '#profile', '#bio', '#about', '.researcher', '.faculty'
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el.innerText?.slice(0, 4000) || "";
  }
  return document.body?.innerText?.slice(0, 4000) || "";
}

// Listen for requests from the side panel
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_PAGE_TEXT") {
    sendResponse({
      text: getPageText(),
      url: window.location.href,
      title: document.title,
    });
    return true;
  }
});