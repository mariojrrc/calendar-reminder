# Mac Calendar (EventKit) Integration Design

## Goal

On macOS, Calendar Reminder can watch **all calendars in Calendar.app**
(iCloud, local, and anything synced into Calendar) via Apple’s EventKit API, and
trigger the same airplane overlay used for Google and Outlook.

On Linux the Mac Calendar row is never shown.

## UI

- Dashboard row label: **Mac Calendar**
- Visible only when `process.platform === "darwin"`
- Buttons: **Connect** / **Disconnect** (not OAuth wording)
- Connected state uses the same green/red affordances as the other providers

## Connect / Disconnect

- **Connect** runs the bundled Swift helper’s `auth` command, which calls
  `EKEventStore.requestFullAccessToEvents()` (or the pre–macOS 14 equivalent).
- On success, write a marker file in userData:
  `macos_calendar_enabled.json`
- **Disconnect** deletes that marker and stops polling Mac Calendar. It does not
  revoke system Calendar permission (user can revoke in System Settings).
- “Connected” for this provider means the marker file exists (same file-presence
  pattern as Google/Outlook token files).

## Swift helper CLI

Path (dev): `native/macos-calendar/bin/macos-calendar-helper`  
Path (packaged): `process.resourcesPath/macos-calendar-helper`

Commands:

| Command | Behavior |
|---|---|
| `auth` | Request Calendar Full Access; print `{ "ok": true }` or `{ "ok": false, "error": "…" }` |
| `status` | Print authorization status JSON |
| `events --start <ISO8601> --end <ISO8601>` | Print `{ "ok": true, "events": [ { "id", "title", "start" } ] }` |

Requirements:

- Use `predicateForEvents` so **recurring instances expand** correctly
- Skip all-day events (no clock start; same rule as Google)
- Timed events only; `start` as ISO-8601 with timezone

## Main-process integration

- New module: `auth-macos.js` — locate helper, run commands, connect/disconnect,
  normalize events to `{ id: "macos:…", title, startMs }`
- Register the Mac Calendar service only on Darwin
- Poll path unchanged: 60s interval, 5-minute lookahead, ≤2-minute alert window,
  shared overlay queue

## Packaging

- `electron-builder` `extraResources` ships the helper binary on macOS
- Helper is compiled with an embedded Info.plist (`NSCalendars*`), calendar entitlement, and ad-hoc codesign id `com.calendarreminder.macos-calendar-helper`
- Packaged app uses `build/entitlements.mac.plist` (+ inherit) including `com.apple.security.personal-information.calendars`
- `prestart` patches `Electron.app` Info.plist with the same usage strings so unpackaged `npm start` can show the TCC dialog
- `extendInfo` / Info.plist keys:
  - `NSCalendarsFullAccessUsageDescription`
  - `NSCalendarsUsageDescription` (legacy ≤ macOS 13)
- `npm run build:macos-calendar` compiles the Swift sources with `swiftc`
- `npm start` / `npm run dist` depend on the helper existing on Darwin

## Permissions note (dev vs packaged)

- Packaged `.app`: permission dialog attributes to Calendar Reminder when the
  Info.plist keys are present.
- Unpackaged `electron .`: if the system dialog does not appear for Electron,
  run the helper once from Terminal (`./native/macos-calendar/bin/macos-calendar-helper auth`)
  and grant access to that binary; Connect then succeeds using the same helper path.

## Out of scope

- Writing or editing events
- Per-calendar filtering UI
- Linux/Windows native calendars
- Revoking TCC from inside the app

## Files

| File | Role |
|---|---|
| `docs/superpowers/specs/2026-08-04-macos-calendar-design.md` | This spec |
| `native/macos-calendar/main.swift` | EventKit CLI source |
| `native/macos-calendar/bin/macos-calendar-helper` | Compiled binary (gitignored if large; build script produces it) |
| `scripts/build-macos-calendar.sh` | `swiftc` build |
| `auth-macos.js` | Node bridge |
| `main.js` | Register service on Darwin, fetch path |
| `config.html` | Connect/Disconnect labels; Darwin-only row comes from main |
| `package.json` | Scripts, extraResources, plist keys |
| `README.md` | Mac Calendar setup notes |
