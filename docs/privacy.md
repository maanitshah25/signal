---
title: Privacy Policy – Signal
permalink: /privacy/
---

# Privacy Policy for Signal

**Effective date:** September 13, 2026

Signal – Research Intelligence Tracker ("Signal") is a Chrome extension that helps you follow academic researchers. This policy explains what data Signal handles, where it goes, and how you control it.

## The short version

- Signal has no servers of its own and no analytics. We never see your data.
- Your TinyFish API key is stored only on your device and sent only to TinyFish.
- Page URLs are sent to TinyFish only on academic sites you visit, or when you click **Scan this page**.
- Your list of tracked researchers is saved in Chrome's storage and syncs through your Google account if you have Chrome sync turned on.

## Data Signal stores

| Data | Where it is stored | Purpose |
|---|---|---|
| TinyFish API key | `chrome.storage.local` on this device only | Authenticates requests you make to TinyFish |
| Tracked researchers (name, institution, profile URL, research areas) | `chrome.storage.sync` (your Chrome profile) | Your tracking list, available on every device where you use Chrome |
| Researcher intelligence (papers, grants, patents, collaborations) | `chrome.storage.sync` in compact form and `chrome.storage.local` in full | The feed you see in the side panel |
| Detection cache (page URL and whether a researcher was found) | `chrome.storage.local`, expires after 7 days | Avoids repeating paid lookups for pages you revisit |
| Settings (developer mode, mock mode) | `chrome.storage.local` | Your preferences |

Signal does not collect browsing history, does not store page contents, and does not use cookies or tracking identifiers.

## Data sent to TinyFish

Signal is powered by the TinyFish Web Agent API, which you access with your own API key. Signal sends TinyFish:

- **The URL of the page you are viewing**, only when (a) the page is on an academic site such as Google Scholar, ORCID, ResearchGate, Semantic Scholar, arXiv, dblp, OpenReview, or a university domain, and Signal's free local check suggests it is a researcher profile, or (b) you click **Scan this page** or **Scan anyway**. Pages on other sites are never sent automatically.
- **The page title**, as a hint, in the same cases.
- **The name, institution, and profile URL of a researcher you chose to track**, when Signal runs a scan for that researcher, including the automatic daily check.
- **Your API key**, in the request header, so TinyFish can bill your account.

TinyFish processes this data under its own terms and privacy policy, available at [tinyfish.ai](https://www.tinyfish.ai). Signal has no control over TinyFish's handling of data.

## Page content read locally

On academic sites, Signal reads the visible text of the page inside your browser to decide whether it is a researcher profile, and on Google Scholar profile pages it extracts the researcher's name, affiliation, and interests directly. This text stays in your browser. It is not stored and is not sent anywhere.

## Permissions Signal requests

- **Side panel, storage, alarms, notifications:** to show the panel, save your data, run the daily check, and alert you to new papers.
- **Tabs:** to read the URL of the tab you are looking at so Signal can tell whether it is an academic site.
- **Scripting on academic domains only:** to run the free local profile check described above.
- **agent.tinyfish.ai:** to call the TinyFish API with your key.

Signal does not request access to non-academic websites.

## Your controls

- Remove a researcher with the **×** button under **Tracked**. Its data is deleted from sync and local storage.
- Clear the detection cache at any time in **Settings**.
- Remove your API key in **Settings**, or remove the extension to delete all Signal data from your device. Synced data is removed from your Chrome profile when you remove the extension while signed in.

## Children

Signal is not directed at children under 13 and does not knowingly collect information from them.

## Changes

If this policy changes, the new version will be posted at this address with an updated effective date.

## Contact

Questions about this policy: open an issue at [github.com/maanitshah25/signal/issues](https://github.com/maanitshah25/signal/issues) or email **[YOUR CONTACT EMAIL]**.
