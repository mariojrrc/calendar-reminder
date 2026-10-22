#!/usr/bin/env bash
# Compile + sign the EventKit helper so macOS can show a Calendar permission dialog.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/macos-calendar/main.swift"
PLIST="$ROOT/native/macos-calendar/Info.plist"
ENTITLEMENTS="$ROOT/native/macos-calendar/macos-calendar-helper.entitlements"
OUT_DIR="$ROOT/native/macos-calendar/bin"
OUT="$OUT_DIR/macos-calendar-helper"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "skip: macos-calendar-helper is macOS-only"
  exit 0
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "error: swiftc not found. Install Xcode Command Line Tools." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# Embed Info.plist in the Mach-O so TCC can show a usage-description dialog for
# this helper when it is the responsible process (Terminal, or disclaimed spawn).
swiftc -O -o "$OUT" "$SRC" \
  -framework EventKit \
  -framework Foundation \
  -Xlinker -sectcreate \
  -Xlinker __TEXT \
  -Xlinker __info_plist \
  -Xlinker "$PLIST"

chmod +x "$OUT"

# Ad-hoc sign with a stable identifier + calendar entitlement. Without this,
# hardened-runtime parents (Electron) and modern TCC often deny silently.
codesign \
  --force \
  --options runtime \
  --identifier "com.calendarreminder.macos-calendar-helper" \
  --entitlements "$ENTITLEMENTS" \
  --sign - \
  "$OUT"

echo "built and signed $OUT"
