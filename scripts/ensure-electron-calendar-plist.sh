#!/usr/bin/env bash
# Unpackaged `electron .` uses Electron.app, which ships without Calendar usage
# strings — macOS then denies EventKit with no dialog. Inject the keys Electron
# needs for local development, then ad-hoc re-sign the app.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

APP="$ROOT/node_modules/electron/dist/Electron.app"
PLIST="$APP/Contents/Info.plist"

if [[ ! -f "$PLIST" ]]; then
  echo "warn: Electron.app Info.plist not found; skip calendar plist patch" >&2
  exit 0
fi

USAGE="Calendar Reminder reads your calendars to alert you before meetings start."

/usr/libexec/PlistBuddy -c "Delete :NSCalendarsUsageDescription" "$PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Delete :NSCalendarsFullAccessUsageDescription" "$PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :NSCalendarsUsageDescription string $USAGE" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :NSCalendarsFullAccessUsageDescription string $USAGE" "$PLIST"

# Re-sign after Info.plist mutation; otherwise Gatekeeper/TCC may ignore the app.
codesign --force --deep --sign - "$APP" >/dev/null
echo "patched Electron.app Calendar usage descriptions"
