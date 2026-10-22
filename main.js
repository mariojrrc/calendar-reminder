/**
 * main.js — the whole background utility.
 *
 * The main process owns everything with side effects: the two windows, the
 * auth orchestration, and the single polling loop that queries both calendars.
 * The renderer (config.html) only renders state and sends intents over IPC.
 *
 * Shape of the loop: every 60 seconds, ask each connected calendar for events
 * starting in the next 5 minutes. If any of them starts within 2 minutes, fly an
 * airplane across the primary screen.
 */

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { google } = require("googleapis");
const googleAuth = require("./auth-google");
const outlookAuth = require("./auth-outlook");
const macosAuth = require("./auth-macos");

/** How often both calendars are queried. */
const POLL_INTERVAL_MS = 60 * 1000;

/** How far ahead each query looks. */
const LOOKAHEAD_MS = 5 * 60 * 1000;

/** An event this close to starting triggers the overlay. */
const ALERT_WINDOW_MS = 2 * 60 * 1000;

/**
 * Overlay lifetime: the CSS flight lasts 12s, and the window is destroyed 0.5s
 * later so the plane is fully clear of the screen before it disappears.
 */
const OVERLAY_LIFETIME_MS = 12500;

/**
 * A window that never paints would keep `overlayWindow` occupied forever, and
 * because one overlay at a time is the rule, every later meeting would be
 * swallowed. Nothing legitimate takes three seconds to load a local static file,
 * so past that the window is written off and cleared.
 */
const OVERLAY_READY_TIMEOUT_MS = 3000;

/**
 * How long an event stays in the "already announced" set. It only has to outlive
 * the alert window; a generous margin costs nothing and keeps the set small.
 */
const ANNOUNCED_TTL_MS = 15 * 60 * 1000;

/** Nothing useful can start more than this many times in a 5-minute window. */
const MAX_EVENTS_PER_POLL = 25;

/**
 * Calendar API calls get a deadline. Known bug (deferred): this timeout is
 * applied only to the calendar HTTP request — Google's token refresh and
 * Outlook's getAccessToken() run unbounded before it. A hung refresh can latch
 * `pollInFlight` until the socket eventually dies (minutes), so later ticks
 * no-op while the dashboard still shows Connected. Upgrade: wrap each
 * fetchUpcoming (refresh + query) in Promise.race / AbortSignal with this
 * budget so `finally` always clears the guard within ~REQUEST_TIMEOUT_MS.
 */
const REQUEST_TIMEOUT_MS = 15 * 1000;

/**
 * Event ids already shown, mapped to when they were shown, so one meeting does
 * not trigger the overlay again on every poll inside its alert window.
 * Time-bounded rather than append-only, so a long-running session cannot grow it
 * without limit.
 *
 * @type {Map<string, number>}
 */
const announced = new Map();

/** Events waiting for a flight; drained one overlay at a time. @type {UpcomingEvent[]} */
const overlayQueue = [];
/** Prevents the same id entering the queue twice. @type {Set<string>} */
const queuedIds = new Set();

/** @type {BrowserWindow | null} */
let configWindow = null;
/** @type {BrowserWindow | null} */
let overlayWindow = null;
/** @type {NodeJS.Timeout | null} */
let pollTimer = null;

/** Both OAuth flows bind port 3000, so only one may run at a time. */
let signInInFlight = false;
/** Guards against a slow poll overlapping the next tick. */
let pollInFlight = false;
/** Distinguishes "user closed the dashboard" from "the app is really quitting". */
let quitting = false;

/**
 * @param {string} scope
 * @param {unknown} error
 */
function logError(scope, error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[${new Date().toISOString()}] ${scope}: ${detail}`);
}

/**
 * A calendar event, normalised across the two providers.
 *
 * @typedef {{ id: string, title: string, startMs: number }} UpcomingEvent
 */

/**
 * Local clock time for the banner, using the OS locale.
 *
 * @param {number} startMs
 * @returns {string}
 */
function formatLocalTime(startMs) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(startMs));
}

/**
 * Relative start text. Always whole minutes, never "in 0 min".
 *
 * @param {number} startMs
 * @param {number} [now]
 * @returns {string}
 */
function formatRelativeMinutes(startMs, now = Date.now()) {
  const until = Math.max(0, startMs - now);
  const minutes = Math.max(1, Math.ceil(until / 60_000));
  return `in ${minutes} min`;
}

/**
 * @param {{ title: string, startMs: number, now?: number }} input
 * @returns {{ title: string, time: string, relative: string }}
 */
function bannerParts({ title, startMs, now = Date.now() }) {
  return {
    title: title || "(no title)",
    time: formatLocalTime(startMs),
    relative: formatRelativeMinutes(startMs, now),
  };
}

/**
 * @param {UpcomingEvent[]} events
 * @returns {UpcomingEvent[]}
 */
function sortEventsForOverlay(events) {
  return [...events].sort((a, b) => a.startMs - b.startMs);
}

/**
 * Google returns all-day events as `start.date` and timed events as
 * `start.dateTime`. Only timed events can be "starting in two minutes".
 *
 * @param {import("googleapis").calendar_v3.Schema$Event} item
 * @returns {UpcomingEvent[]}
 */
function toGoogleEvent(item) {
  const dateTime = item.start?.dateTime;
  if (!item.id || !dateTime) return [];

  const startMs = Date.parse(dateTime);
  if (Number.isNaN(startMs)) return [];

  // Namespaced so a Google and an Outlook event can never collide in `announced`.
  return [{ id: `google:${item.id}`, title: item.summary ?? "(no title)", startMs }];
}

/**
 * Microsoft Graph returns `start.dateTime` without a UTC designator and puts the
 * zone in a sibling `start.timeZone` field, so the string cannot be handed
 * straight to `Date.parse` — that would silently read it as local time. The poll
 * requests UTC via the `Prefer` header, so an explicit `Z` is appended.
 *
 * @param {{ id?: string, subject?: string, start?: { dateTime?: string, timeZone?: string } }} item
 * @returns {UpcomingEvent[]}
 */
function toOutlookEvent(item) {
  const dateTime = item.start?.dateTime;
  if (!item.id || !dateTime) return [];

  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(dateTime);
  if (!hasOffset && item.start?.timeZone !== "UTC") {
    // Graph ignored the requested timezone; guessing one would produce a wrong
    // alert time, so skip rather than fire the overlay at the wrong moment.
    logError("outlook", `event ${item.id} has an unusable start timezone`);
    return [];
  }

  const startMs = Date.parse(hasOffset ? dateTime : `${dateTime}Z`);
  if (Number.isNaN(startMs)) return [];

  return [{ id: `outlook:${item.id}`, title: item.subject ?? "(no title)", startMs }];
}

/**
 * Google Calendar API v3. `singleEvents` expands recurring series into concrete
 * instances, which is what a "does anything start soon" question needs.
 *
 * @param {Service} service
 * @param {number} now
 * @returns {Promise<UpcomingEvent[]>}
 */
async function fetchGoogleEvents(service, now) {
  service.session ??= googleAuth.createAuthenticatedClient({
    secretPath: service.secretPath,
    tokenPath: service.tokenPath,
  });
  if (!service.session) return [];

  const calendar = google.calendar({ version: "v3", auth: service.session });
  const { data } = await calendar.events.list(
    {
      calendarId: "primary",
      timeMin: new Date(now).toISOString(),
      timeMax: new Date(now + LOOKAHEAD_MS).toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: MAX_EVENTS_PER_POLL,
    },
    { timeout: REQUEST_TIMEOUT_MS },
  );

  return (data.items ?? []).flatMap(toGoogleEvent);
}

/**
 * Microsoft Graph `/v1.0/me/calendarview`, which is the endpoint that expands
 * recurring series across a time range (unlike `/me/events`).
 *
 * @param {Service} service
 * @param {number} now
 * @returns {Promise<UpcomingEvent[]>}
 */
async function fetchOutlookEvents(service, now) {
  service.session ??= outlookAuth.createApplication({
    secretPath: service.secretPath,
    tokenPath: service.tokenPath,
  });

  const accessToken = await outlookAuth.getAccessToken(service.session);
  if (!accessToken) return [];

  const url = new URL("https://graph.microsoft.com/v1.0/me/calendarview");
  url.searchParams.set("startDateTime", new Date(now).toISOString());
  url.searchParams.set("endDateTime", new Date(now + LOOKAHEAD_MS).toISOString());
  url.searchParams.set("$select", "id,subject,start");
  url.searchParams.set("$orderby", "start/dateTime");
  url.searchParams.set("$top", String(MAX_EVENTS_PER_POLL));

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      // Ask Graph to express every event time in UTC, so `toOutlookEvent` has a
      // single known zone to parse.
      Prefer: 'outlook.timezone="UTC"',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Microsoft Graph returned ${response.status} ${response.statusText}`,
    );
  }

  const body = await response.json();
  return (body.value ?? []).flatMap(toOutlookEvent);
}

/**
 * @param {Service} service
 * @param {number} now
 * @returns {Promise<UpcomingEvent[]>}
 */
async function fetchMacosEvents(service, now) {
  return macosAuth.fetchUpcoming(
    { tokenPath: service.tokenPath },
    now,
    LOOKAHEAD_MS,
  );
}

/**
 * True when an event is close enough to announce: already in the future, and no
 * more than the alert window away. Events that have already started are excluded
 * — the query window reaches back to "now", and Graph's calendarview also
 * returns events merely overlapping it.
 *
 * @param {UpcomingEvent} event
 * @param {number} now
 * @returns {boolean}
 */
function isImminent(event, now) {
  const untilStart = event.startMs - now;
  return untilStart >= 0 && untilStart <= ALERT_WINDOW_MS;
}

/**
 * @typedef {object} Service
 * @property {string} label
 * @property {"oauth" | "native"} kind
 * @property {boolean} [soon]
 * @property {string} [secretPath]
 * @property {string} tokenPath
 * @property {unknown} session
 * @property {(paths: { secretPath?: string, tokenPath: string }) => Promise<void>} signIn
 * @property {(paths: { tokenPath: string }) => void} signOut
 * @property {(service: Service, now: number) => Promise<UpcomingEvent[]>} fetchUpcoming
 */

/**
 * Tokens live under `app.getPath('userData')` rather than next to the
 * executable, because a packaged .app or .AppImage is read-only. The dashboard
 * checks these exact token paths to decide which button to show.
 */
const userDataDir = app.getPath("userData");

/** @type {Record<string, Service>} */
const services = {
  google: {
    label: "Google Calendar",
    kind: "oauth",
    soon: true,
    tokenPath: path.join(userDataDir, googleAuth.TOKEN_FILENAME),
    session: null,
    signIn: googleAuth.signIn,
    signOut: googleAuth.signOut,
    fetchUpcoming: fetchGoogleEvents,
  },
  outlook: {
    label: "Outlook Calendar",
    kind: "oauth",
    soon: true,
    tokenPath: path.join(userDataDir, outlookAuth.TOKEN_FILENAME),
    session: null,
    signIn: outlookAuth.signIn,
    signOut: outlookAuth.signOut,
    fetchUpcoming: fetchOutlookEvents,
  },
};

if (process.platform === "darwin") {
  services.macos = {
    label: "Mac Calendar",
    kind: "native",
    tokenPath: path.join(userDataDir, macosAuth.ENABLED_FILENAME),
    session: null,
    signIn: macosAuth.connect,
    signOut: macosAuth.disconnect,
    fetchUpcoming: fetchMacosEvents,
  };
}

/**
 * Presence of the token file *is* the connection status, which keeps the
 * dashboard and the polling loop reading from one source of truth.
 *
 * @param {Service} service
 * @returns {boolean}
 */
function isConnected(service) {
  if (service.soon) return false;
  return fs.existsSync(service.tokenPath);
}

/**
 * The renderer supplies the service id, so it is validated like any other
 * input crossing into the main process.
 *
 * @param {unknown} serviceId
 * @returns {Service}
 */
function requireService(serviceId) {
  if (typeof serviceId !== "string" || !Object.hasOwn(services, serviceId)) {
    throw new Error(`Unknown calendar service: ${String(serviceId)}`);
  }
  return services[serviceId];
}

/** @returns {{ services: Array<{ id: string, label: string, connected: boolean, kind: string, soon: boolean }>, showTestFlight: boolean }} */
function dashboardPayload() {
  return {
    services: Object.entries(services).map(([id, service]) => ({
      id,
      label: service.label,
      connected: isConnected(service),
      kind: service.kind,
      soon: service.soon === true,
    })),
    // Packaged builds never expose the synthetic Test flight control.
    showTestFlight: !app.isPackaged,
  };
}

function broadcastStatus() {
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.webContents.send("calendar:status-changed", dashboardPayload());
  }
}

/**
 * @param {UpcomingEvent} event
 */
function enqueueOverlay(event) {
  if (announced.has(event.id) || queuedIds.has(event.id)) return;
  queuedIds.add(event.id);
  overlayQueue.push(event);
  drainOverlayQueue();
}

/**
 * Starts the next queued flight when no overlay is on screen. Skips meetings
 * that have already started while they waited.
 */
function drainOverlayQueue() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return;

  while (overlayQueue.length > 0) {
    const event = overlayQueue.shift();
    if (!event) break;
    queuedIds.delete(event.id);
    if (event.startMs < Date.now()) continue;
    showOverlay(event);
    return;
  }
}

/**
 * Spawns the click-through overlay: borderless, frameless, transparent, always
 * on top, covering the primary display, and completely inert to the mouse so the
 * user can keep working underneath it.
 *
 * @param {UpcomingEvent} event
 */
function showOverlay(event) {
  // One plane at a time. Later meetings wait in the queue.
  if (overlayWindow && !overlayWindow.isDestroyed()) return;

  const { bounds } = screen.getPrimaryDisplay();
  const parts = bannerParts({ title: event.title, startMs: event.startMs });

  overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Never take focus or a taskbar slot: this is decoration, not a window the
    // user interacts with.
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      // animation.html only needs a tiny inline script to read query params.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // The reason the overlay is safe to throw over the whole screen: every click,
  // scroll and hover passes straight through to whatever is underneath.
  overlayWindow.setIgnoreMouseEvents(true);
  // 'screen-saver' is the level that also floats above full-screen apps.
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  /** @type {NodeJS.Timeout | undefined} */
  let destroyTimer;

  // Watchdog for the alert path itself: if first paint never happens, tear the
  // window down anyway so the next meeting is not silently unannounced.
  const readyTimer = setTimeout(() => {
    logError("overlay", "the alert window never painted; discarding it");
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  }, OVERLAY_READY_TIMEOUT_MS);

  // Fires for destroy() as well as a normal close, so both timers are always
  // released with the window.
  overlayWindow.on("closed", () => {
    clearTimeout(readyTimer);
    clearTimeout(destroyTimer);
    overlayWindow = null;
    drainOverlayQueue();
  });

  overlayWindow.once("ready-to-show", () => {
    clearTimeout(readyTimer);
    announced.set(event.id, Date.now());
    // Show only once painted, otherwise a transparent window can flash white.
    // showInactive keeps the user's focus where it was.
    overlayWindow?.showInactive();

    // The lifetime is measured from the moment the animation actually starts,
    // so however long the window took to load, the 12s flight always finishes
    // before the window is torn down.
    destroyTimer = setTimeout(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
    }, OVERLAY_LIFETIME_MS);
  });

  overlayWindow
    .loadFile(path.join(__dirname, "animation.html"), {
      query: {
        title: parts.title,
        time: parts.time,
        relative: parts.relative,
      },
    })
    .catch((error) => {
      logError("overlay", error);
      // Nothing will ever be painted, so do not leave an invisible window behind.
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
    });
}

/**
 * Drops announced events that can no longer be inside anyone's alert window.
 *
 * @param {number} now
 */
function pruneAnnounced(now) {
  for (const [id, shownAt] of announced) {
    if (now - shownAt > ANNOUNCED_TTL_MS) announced.delete(id);
  }
}

/**
 * One polling tick: query every connected calendar concurrently, then decide
 * whether anything is close enough to announce.
 */
async function poll() {
  if (pollInFlight) return;
  pollInFlight = true;

  try {
    const now = Date.now();
    const connected = Object.entries(services).filter(([, service]) =>
      isConnected(service),
    );

    // allSettled, not all: one broken calendar must not stop the other.
    const results = await Promise.allSettled(
      connected.map(async ([id, service]) => ({
        id,
        events: await service.fetchUpcoming(service, now),
      })),
    );

    /** @type {UpcomingEvent[]} */
    const imminent = [];

    for (const [index, result] of results.entries()) {
      const [serviceId, service] = connected[index];

      if (result.status === "rejected") {
        logError(`poll:${serviceId}`, result.reason);
        continue;
      }

      // The user may have signed out while this request was in flight; those
      // results are no longer wanted.
      if (!isConnected(service)) continue;

      for (const event of result.value.events) {
        if (!isImminent(event, now) || announced.has(event.id) || queuedIds.has(event.id)) {
          continue;
        }

        imminent.push(event);
        console.log(
          `[${new Date().toISOString()}] starting soon (${serviceId}): ${event.title}`,
        );
      }
    }

    pruneAnnounced(now);
    for (const event of sortEventsForOverlay(imminent)) {
      enqueueOverlay(event);
    }
  } catch (error) {
    // The loop must survive anything a provider throws.
    logError("poll", error);
  } finally {
    pollInFlight = false;
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  void poll();
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function showConfigWindow() {
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.show();
    configWindow.focus();
    return;
  }

  configWindow = new BrowserWindow({
    width: 540,
    height: 600,
    resizable: false,
    title: "Calendar Reminder",
    webPreferences: {
      // config.html reaches the main process with `ipcRenderer` directly. The
      // fixed file layout for this utility has no preload script, which is the
      // only way to bridge IPC while contextIsolation is on.
      //
      // simplification: Node integration in this renderer. It is only ever
      // pointed at this local file and never loads remote content, so there is
      // no untrusted code in the window. Upgrade trigger: the moment this window
      // renders anything fetched over the network, move IPC behind a preload
      // script with contextBridge and restore the defaults below.
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  configWindow.loadFile(path.join(__dirname, "config.html"));

  // Background utility: closing the dashboard hides it so polling continues.
  // Quit properly from the application menu.
  configWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    configWindow?.hide();
  });

  configWindow.on("closed", () => {
    configWindow = null;
  });
}

ipcMain.handle("calendar:get-status", () => dashboardPayload());

ipcMain.handle("calendar:test-flight", () => {
  if (app.isPackaged) {
    return { ok: false, message: "Test flight is only available when running from source." };
  }

  const startMs = Date.now() + 90_000;
  enqueueOverlay({
    id: `test:${startMs}`,
    title: "Test meeting",
    startMs,
  });
  return { ok: true };
});

ipcMain.handle("calendar:sign-in", async (_event, serviceId) => {
  const service = requireService(serviceId);

  if (service.soon) {
    return { ok: false, message: "Soon" };
  }

  // Both providers redirect to port 3000, so a second concurrent flow would
  // fail on EADDRINUSE. Refuse it with something the user can act on instead.
  if (signInInFlight) {
    return {
      ok: false,
      message:
        "Another sign-in is already running. Finish it in your browser, then try again.",
    };
  }

  signInInFlight = true;
  try {
    await service.signIn({
      secretPath: service.secretPath,
      tokenPath: service.tokenPath,
    });
    // Force the next poll to build a client from the token just written.
    service.session = null;
    broadcastStatus();
    // Poll straight away so a meeting inside the alert window is not missed
    // while waiting up to a minute for the next tick.
    void poll();
    return { ok: true };
  } catch (error) {
    logError(`sign-in:${serviceId}`, error);
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    signInInFlight = false;
  }
});

ipcMain.handle("calendar:sign-out", (_event, serviceId) => {
  const service = requireService(serviceId);

  try {
    // The provider deletes the token file *and* invalidates every writer built
    // before now, so an in-flight poll cannot write its still-live credentials
    // back and quietly reconnect. Dropping the cached client removes what is
    // left in memory — together that is what "stops polling immediately" means.
    service.signOut({ tokenPath: service.tokenPath });
    service.session = null;
    broadcastStatus();
    return { ok: true };
  } catch (error) {
    logError(`sign-out:${serviceId}`, error);
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});

// A second instance would fight the first for port 3000 and double every poll.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showConfigWindow());

  app.whenReady().then(() => {
    showConfigWindow();
    startPolling();

    // macOS: re-opening from the dock brings the dashboard back.
    app.on("activate", () => showConfigWindow());
  });

  app.on("before-quit", () => {
    quitting = true;
    stopPolling();
  });
}

// Electron ignores exports on the entry point; these expose the decision logic
// that has no UI (event normalisation and the alert boundary). Importing this
// file resolves `app.getPath('userData')` and registers IPC handlers at module
// scope, so a plain-node consumer has to stub `electron` first — the logic check
// in .tribunal/verify-logic.js does exactly that.
module.exports = {
  ALERT_WINDOW_MS,
  isImminent,
  toGoogleEvent,
  toOutlookEvent,
  formatLocalTime,
  formatRelativeMinutes,
  bannerParts,
  sortEventsForOverlay,
};
