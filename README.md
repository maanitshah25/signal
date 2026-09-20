# Signal – Research Intelligence Tracker

A Chrome side-panel extension that lets you track any researcher or lab with one click
and receive a feed of their papers, citation spikes, grants, and patents. Powered by the
[TinyFish](https://www.tinyfish.ai) Web Agent API using **your own API key**.

## Install from source

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select this folder.
3. Click the Signal icon to open the side panel, open **Settings**, and paste your TinyFish API key
   from [agent.tinyfish.ai/api-keys](https://agent.tinyfish.ai/api-keys). **Test connection** checks the key for free.

## How it works

- Open a researcher page. On academic sites (Google Scholar, ORCID, ResearchGate, Semantic Scholar,
  arXiv, dblp, OpenReview, university domains) Signal detects the researcher automatically.
  Google Scholar profiles are read locally at no cost; other pages get a free text pre-check
  before a TinyFish agent is spent. On any other site, click **Scan this page**.
- Click **+ Track**. A TinyFish agent gathers recent papers, citation activity, grants, patents, and collaborations.
- Once a day Signal re-scans tracked researchers and notifies you about new papers.
- Tracked researchers sync across your Chrome profile.

## Project layout

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. Host permissions are limited to TinyFish and the academic allowlist. |
| `background.js` | Service worker: the only TinyFish caller. Detection pipeline, scans, daily alarm, notifications. |
| `content.js` | Injected on demand on allowlisted sites. Extracts Scholar profiles and scores other pages locally. |
| `sidepanel.html` / `sidepanel.js` | UI: current-page card, feed, tracked list, settings. |
| `shared/config.js` | Constants, allowlist, URL helpers (shared by worker and panel). |
| `shared/storage.js` | Storage layer: settings and cache in `local`, tracked researchers in `sync`. |
| `docs/` | GitHub Pages site with the privacy policy. |
| `scripts/build.sh` | Builds the Web Store zip and checks manifest/allowlist consistency. |
| `STORE_LISTING.md` | Everything needed for the Chrome Web Store submission. |

## Developer mode

Settings → **Developer mode** reveals **Mock mode** (fake data, no API calls), **Run daily check now**,
and a **Test Alert** button on each researcher.

## Tests

```bash
node scripts/test.js
```

Runs the detection pipeline, TinyFish error handling, sync compaction, and the daily check against stubbed Chrome APIs. No network, no key needed.

## Release

```bash
./scripts/build.sh
```

Bump `version` in `manifest.json` and `VERSION` in `shared/config.js` first. See `STORE_LISTING.md`.
