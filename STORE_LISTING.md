# Chrome Web Store submission guide

Everything needed to publish Signal. Copy text from here into the developer dashboard.

## 0. One-time setup

1. Register at https://chrome.google.com/webstore/devconsole (one-time $5 fee, needs a Google account).
2. Enable GitHub Pages for this repo: **Settings → Pages → Source: Deploy from a branch → main, folder `/docs`**. The privacy policy then lives at https://maanitshah25.github.io/signal/privacy/ (allow a few minutes after the first push).
3. Fill in the contact email in `docs/privacy.md` before publishing.

## 1. Build the package

```bash
./scripts/build.sh
```

Upload `dist/signal-<version>.zip`. Bump `version` in `manifest.json` **and** `VERSION` in `shared/config.js` for every new upload; the build script refuses to run if they differ.

## 2. Store listing

**Name** (45 chars max): `Signal – Research Intelligence Tracker`

If the store rejects the name for resembling Signal Messenger, use `S1gnal – Research Intelligence Tracker` or `Signal Research Tracker`. The extension ID and user data are unaffected by a rename.

**Summary** (132 chars max):
`Track any researcher with one click. Get new papers, citation spikes, grants, and patents in your side panel. Bring your own TinyFish key.`

**Category:** Productivity → Tools

**Language:** English

**Description:**

```
Signal turns Chrome's side panel into an intelligence feed for the researchers you follow.

HOW IT WORKS
1. Open a researcher's Google Scholar or university profile.
2. Signal detects them in the side panel. Google Scholar profiles are read instantly, for free.
3. Click "+ Track". TinyFish web agents gather their recent papers, citation activity, grants, patents, and industry collaborations.
4. Signal re-checks everyone you track once a day and notifies you when a new paper appears.

WHAT YOU GET PER RESEARCHER
• Recent papers with citation counts and one-line summaries
• Citation spikes on older work
• Grants and funding (NSF, NIH, DARPA, and more)
• Patents
• Industry and academic collaborations

BRING YOUR OWN KEY
Signal runs on the TinyFish Web Agent API using your own API key, entered once in Settings. You pay TinyFish directly for what you use; Signal has no servers, no accounts, and no analytics.

PRIVACY BY DESIGN
• Auto-detection only runs on academic sites (Google Scholar, ORCID, ResearchGate, Semantic Scholar, arXiv, dblp, OpenReview, university domains). Everywhere else, nothing is sent unless you click "Scan this page".
• A free local check runs before any paid lookup, so you are not billed for pages that aren't researcher profiles.
• Your API key never leaves your device except to reach TinyFish.
• Tracked researchers sync across your devices through your Chrome profile.

Open source: https://github.com/maanitshah25/signal
```

## 3. Graphics you need to capture

Load the extension unpacked, turn on **Developer mode → Mock mode** in Settings for realistic data, then capture:

| Asset | Size | Required | What to show |
|---|---|---|---|
| Screenshot 1 | 1280×800 (or 640×400) | Yes | Side panel open on a Google Scholar profile, researcher detected, "+ Track" visible |
| Screenshot 2 | 1280×800 | Recommended | Researcher feed with papers, grants, patents populated |
| Screenshot 3 | 1280×800 | Recommended | Feed list with several tracked researchers, one showing "New" |
| Screenshot 4 | 1280×800 | Optional | Settings page with API key field and "Connected. Wallet balance" status |
| Small promo tile | 440×280 | Yes | Logo mark + "Signal" + one-line tagline on the dark purple palette |
| Marquee promo tile | 1400×560 | Optional | Same, wide |

Screenshots must be PNG or JPEG with no transparency. Turn mock mode off again before you take the Settings screenshot if you want a real balance shown.

**Already generated:** both promo tiles are in `store-assets/final/` (`promo-small-440x280.png`, `promo-marquee-1400x560.png`). Regenerate with `python3 scripts/make-promo-tiles.py`.

**Screenshots:** capture with ⌘⇧4 (drag a region) or ⌘⇧4 then Space (whole window), drop the PNGs into `store-assets/raw/`, then run:

```bash
./scripts/normalize-screenshots.sh
```

It fits each image inside 1280×800 and pads the rest with the Signal background colour, writing `store-assets/final/screenshot-N.png`.

## 4. Privacy tab answers

**Single purpose description:**
`Signal lets users track academic researchers and receive a feed of their new publications, citations, grants, and patents in Chrome's side panel.`

**Permission justifications:**

| Permission | Justification |
|---|---|
| `sidePanel` | The entire UI lives in the side panel. |
| `storage` | Saves the user's API key (local), tracked researchers (sync), and a detection cache (local). |
| `tabs` | Reads the active tab's URL to decide whether it is an academic site and to detect researcher profiles. |
| `alarms` | Runs the once-a-day re-check of tracked researchers. |
| `notifications` | Alerts the user when a tracked researcher publishes a new paper. |
| `scripting` | Injects a read-only script on academic domains to check locally whether the page is a researcher profile before any paid API call. |
| Host: `agent.tinyfish.ai` | Calls the TinyFish API with the user's own key. |
| Host: academic domains | Needed for the read-only local pre-check above. No other sites are accessed. |

**Remote code:** No. All code ships in the package.

**Data usage disclosures** (check these boxes):
- Website content: **Yes** (page URL and title of academic profile pages, sent to TinyFish at the user's direction).
- Authentication information: **Yes** (the user's own TinyFish API key, stored locally).
- Personally identifiable information: **No** (researcher names are public professional data, not the user's).
- Web history: **No** (only the active tab URL on academic sites is read; nothing is logged).

Certify: not sold to third parties, not used for unrelated purposes, not used for creditworthiness.

**Privacy policy URL:** `https://maanitshah25.github.io/signal/privacy/`

## 5. Distribution

- Visibility: Public.
- Regions: all.
- Pricing: free (users pay TinyFish directly).

## 6. Before every submission

- [ ] `./scripts/build.sh` passes
- [ ] Mock mode is off in your own test profile before taking real screenshots
- [ ] Privacy policy contact email is filled in
- [ ] Version bumped in both places
- [ ] Tested on a fresh Chrome profile: install → add key → Test connection → track a Scholar profile → see feed
