#!/usr/bin/env bash
# Pads/fits every PNG in store-assets/raw to exactly 1280x800 on the Signal background colour
# and writes the result to store-assets/final. Chrome Web Store screenshots must be 1280x800 or 640x400.
set -euo pipefail
cd "$(dirname "$0")/.."
shopt -s nullglob
files=(store-assets/raw/*.png store-assets/raw/*.PNG)
if [[ ${#files[@]} -eq 0 ]]; then echo "Drop screenshots into store-assets/raw/ first."; exit 1; fi
i=1
for f in "${files[@]}"; do
  out="store-assets/final/screenshot-$i.png"
  cp "$f" "$out"
  # Fit inside 1280x800 keeping aspect ratio, then pad to exact size.
  sips -Z 1280 "$out" >/dev/null
  h=$(sips -g pixelHeight "$out" | awk '/pixelHeight/{print $2}')
  if (( h > 800 )); then sips --resampleHeight 800 "$out" >/dev/null; fi
  sips --padToHeightWidth 800 1280 --padColor 0F0F13 "$out" >/dev/null
  echo "✓ $out ($(sips -g pixelWidth -g pixelHeight "$out" | awk '/pixel/{printf "%s ", $2}'))"
  i=$((i+1))
done
