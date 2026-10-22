# Meeting Flight Banner Design

## Goal

Replace the airplane emoji overlay with an original blue 2D airplane towing a
meeting banner. The banner communicates the meeting title, local start time, and
relative start time without changing the app's zero-backend architecture.

## Approved visual design

- Original inline SVG airplane, not copied or traced from the supplied reference.
- Cobalt-blue fuselage, deep-blue wings and outline, pale-blue highlight, white
  cockpit.
- The plane faces and flies right.
- A short tow line connects the plane to a white rectangular banner trailing on
  its left.
- Banner border and inset rule use the same blue palette.
- Existing transparent, click-through, always-on-top full-screen window remains.
- The complete plane/banner group flies from off-screen left to off-screen right
  in four seconds and the overlay closes after 4.5 seconds.

## Banner content

Format:

```text
<meeting title> · <local start time> · in <N> min
```

Example:

```text
Weekly product sync · 10:30 · in 2 min
```

- Time uses the operating system's local clock formatting.
- Relative time is rounded up to whole minutes so an event 61–120 seconds away
  reads `in 2 min`; an event under 60 seconds away reads `in 1 min`.
- Meeting title gets the flexible width and truncates with an ellipsis.
- Time and relative text never truncate.
- Provider names are not displayed.

## Architecture and data flow

1. Polling continues to normalize Google and Outlook events into `id`, `title`,
   and `startMs`.
2. `poll()` collects all newly imminent events and sorts them by `startMs`.
3. Each event is appended to a small in-memory overlay queue.
4. When no overlay is active, the main process dequeues one event and calls
   `showOverlay(event)`.
5. `showOverlay` loads `animation.html` with URL query parameters containing the
   title, formatted local time, and relative text.
6. A small, unprivileged script in `animation.html` reads the query parameters
   and assigns them using `textContent`.
7. When the overlay closes, the next queued event starts. Multiple simultaneous
   meetings therefore produce back-to-back flights.

No IPC or preload is added. The overlay retains `nodeIntegration: false` and
`contextIsolation: true`. The overlay CSP permits its fixed inline rendering
script but continues to block network requests and external resources.

## Queue and duplicate behavior

- The existing `announced` map remains the cross-poll deduplication source.
- A separate set prevents an event appearing in the queue more than once.
- Events are marked announced only after the overlay reaches `ready-to-show`.
  A failed paint can therefore be retried on a later poll.
- Before starting a queued flight, discard the event if it has already started.
- One overlay exists at a time.
- Closing or failing one overlay advances to the next queued event instead of
  blocking the queue.

## Failure handling

- Missing or malformed query values render safe fallbacks rather than HTML.
- Titles are inserted only through `textContent`; calendar text cannot inject
  markup.
- The existing ready-to-show watchdog remains.
- A `loadFile` failure destroys the current window and advances the queue.
- If the queue is empty, closing the overlay does nothing.

## Files changed

- `main.js`: pass event data to overlays; format local/relative time; maintain the
  sequential queue.
- `animation.html`: replace emoji with approved SVG/banner; render query data;
  animate the combined group.
- `.tribunal/verify-logic.js`: add runnable checks for formatting and queue-safe
  event ordering where practical.

No new runtime dependency or production file is required.

## Verification

1. Add checks first and verify they fail before implementation.
2. Verify title/time/relative formatting, including long titles and one-minute
   boundary behavior.
3. Verify two simultaneous events are ordered and both become eligible for
   sequential flights.
4. Run existing logic checks and JavaScript syntax checks.
5. Launch the Electron app with a focused local test event and visually confirm:
   blue SVG; banner trails left; title ellipsis; full content format; second
   meeting flies after the first; overlay remains click-through.

## Local-only test button

Dashboard shows a small **"Test flight"** button only when the app is running from
source (`!app.isPackaged`). Packaged `.dmg` / `.AppImage` builds never render it.

Clicking it enqueues one synthetic meeting with title `Test meeting`, start time
≈ now + 90 seconds (so relative reads `in 2 min`), and flies the overlay through
the same code path as a real calendar event.

## Out of scope

- Using or downloading the Shutterstock artwork.
- Sound or clickable overlay content (dashboard buttons are allowed).
- User-selectable colors or animation duration.
- Multiple monitors beyond the existing primary-screen behavior.
- Fixing the separately documented unbounded OAuth refresh timeout.
