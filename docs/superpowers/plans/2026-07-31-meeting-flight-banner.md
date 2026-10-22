# Meeting Flight Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the emoji overlay with the approved blue 2D tow-banner SVG, show meeting title · local time · relative time, fly meetings back-to-back, and add a local-only Test flight button.

**Architecture:** Main process formats banner fields and loads `animation.html` with query params. Overlay stays unprivileged. A queue drives sequential flights. Dashboard shows Test flight only when `!app.isPackaged`.

**Tech Stack:** Electron, plain HTML/CSS/SVG, existing `.tribunal/verify-logic.js`.

## Global Constraints

- Keep overlay click-through, transparent, primary-screen, 4s flight / 4.5s lifetime.
- Banner trails left of the right-facing plane.
- No new dependencies. No IPC into the overlay.
- Test button must never appear in packaged builds.

---

## Task 1: Banner formatting helpers (TDD)

**Files:**
- Modify: `.tribunal/verify-logic.js`
- Modify: `main.js`

- [ ] Add failing checks for `formatLocalTime`, `formatRelativeMinutes`, and title ellipsis helper behavior.
- [ ] Export helpers from `main.js` and implement until checks pass.

## Task 2: Overlay queue + query-param flight

**Files:**
- Modify: `main.js`
- Modify: `animation.html`

- [ ] Change `showOverlay(event)` to load query params and queue sequential events.
- [ ] Rebuild `animation.html` with approved blue SVG + white tow banner + script that fills via `textContent`.

## Task 3: Local-only Test flight button

**Files:**
- Modify: `main.js`
- Modify: `config.html`

- [ ] Expose `app.isPackaged` (inverted) via status IPC.
- [ ] Render Test flight only when unpackaged; invoke synthetic event through the same queue path.

## Task 4: Verify

- [ ] `node .tribunal/verify-logic.js`
- [ ] `node --check` on JS files
- [ ] Manual: `npm start` → Test flight → blue plane with banner
