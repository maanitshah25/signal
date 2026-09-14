#!/usr/bin/env bash
# Builds dist/signal-<version>.zip for upload to the Chrome Web Store.
# Fails if the manifest is invalid, a secret is present, or the allowlist drifted from host_permissions.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
CONFIG_VERSION=$(grep -oE 'VERSION: "[^"]+"' shared/config.js | cut -d'"' -f2)

if [[ "$VERSION" != "$CONFIG_VERSION" ]]; then
  echo "✗ manifest.json version ($VERSION) != shared/config.js VERSION ($CONFIG_VERSION)"; exit 1
fi

FILES=(manifest.json background.js content.js sidepanel.html sidepanel.js shared icons)

# No API keys in shipped files.
if grep -rIE 'sk-tinyfish-[A-Za-z0-9_-]{8,}' "${FILES[@]}" >/dev/null; then
  echo "✗ a TinyFish key is present in packaged files"; exit 1
fi

# Every auto-detect host/suffix in shared/config.js must be covered by a host_permission.
python3 - <<'PY'
import json, re, sys
manifest = json.load(open("manifest.json"))
perms = manifest.get("host_permissions", [])
cfg = open("shared/config.js").read()

def block(name):
    m = re.search(name + r":\s*\[(.*?)\]", cfg, re.S)
    return re.findall(r'"([^"]+)"', m.group(1)) if m else []

def covered(host):
    for p in perms:
        m = re.match(r"^(\*|https?)://(\*\.)?([^/]+)/\*$", p)
        if not m: continue
        wildcard, base = m.group(2), m.group(3)
        if host == base or (wildcard and host.endswith("." + base)): return True
    return False

missing = [h for h in block("AUTO_DETECT_HOSTS") if not covered(h)]
missing += [s for s in block("AUTO_DETECT_SUFFIXES") if not covered("x" + s)]
if missing:
    print("✗ auto-detect entries without a host_permission:", ", ".join(missing)); sys.exit(1)
print("✓ allowlist matches host_permissions")
PY

mkdir -p dist
OUT="dist/signal-${VERSION}.zip"
rm -f "$OUT"
zip -qr "$OUT" "${FILES[@]}" -x '*.DS_Store'
echo "✓ built $OUT ($(du -h "$OUT" | cut -f1))"
