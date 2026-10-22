/**
 * auth-macos.js — Mac Calendar via a small EventKit Swift helper.
 *
 * There is no OAuth loop. Connect asks macOS for Calendar Full Access; a marker
 * file in userData records that the user opted this app into polling.
 */

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { app } = require("electron");

const execFileAsync = promisify(execFile);

const ENABLED_FILENAME = "macos_calendar_enabled.json";
const HELPER_NAME = "macos-calendar-helper";

/**
 * @returns {string}
 */
function helperPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, HELPER_NAME);
  }
  return path.join(__dirname, "native", "macos-calendar", "bin", HELPER_NAME);
}

/**
 * @param {string[]} args
 * @returns {Promise<object>}
 */
async function runHelper(args) {
  const bin = helperPath();
  if (!fs.existsSync(bin)) {
    throw new Error(
      `Mac Calendar helper not found at ${bin}. Run: npm run build:macos-calendar`,
    );
  }

  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(bin, args, {
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    }));
  } catch (error) {
    // The helper prints JSON on both success and expected failure paths; prefer
    // parsing stdout when present so auth denials surface cleanly.
    const raw = typeof error.stdout === "string" ? error.stdout.trim() : "";
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.ok === false && typeof parsed.error === "string") {
          throw new Error(parsed.error);
        }
      } catch (inner) {
        if (inner instanceof Error && inner.message !== raw) throw inner;
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    const errText = typeof stderr === "string" && stderr.trim() ? stderr.trim() : detail;
    throw new Error(errText);
  }

  const text = String(stdout || "").trim();
  if (!text) {
    throw new Error(stderr?.trim() || "Mac Calendar helper returned no output");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`Mac Calendar helper returned invalid JSON: ${text}`, { cause });
  }

  if (!parsed || parsed.ok !== true) {
    throw new Error(
      typeof parsed?.error === "string"
        ? parsed.error
        : "Mac Calendar helper reported failure",
    );
  }

  return parsed;
}

/**
 * @param {{ enabledPath: string }} paths
 */
async function connect({ tokenPath }) {
  await runHelper(["auth"]);
  fs.writeFileSync(
    tokenPath,
    JSON.stringify(
      {
        enabled: true,
        connectedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

/**
 * @param {{ tokenPath: string }} paths
 */
function disconnect({ tokenPath }) {
  fs.rmSync(tokenPath, { force: true });
}

/**
 * @param {{ id?: string, title?: string, start?: string }} item
 * @returns {{ id: string, title: string, startMs: number }[]}
 */
function toMacosEvent(item) {
  if (!item?.id || !item?.start) return [];
  const startMs = Date.parse(item.start);
  if (Number.isNaN(startMs)) return [];
  return [
    {
      id: `macos:${item.id}`,
      title: item.title || "(no title)",
      startMs,
    },
  ];
}

/**
 * @param {{ tokenPath: string }} paths
 * @param {number} now
 * @param {number} lookaheadMs
 * @returns {Promise<{ id: string, title: string, startMs: number }[]>}
 */
async function fetchUpcoming({ tokenPath }, now, lookaheadMs) {
  if (!fs.existsSync(tokenPath)) return [];

  const start = new Date(now).toISOString();
  const end = new Date(now + lookaheadMs).toISOString();
  const result = await runHelper(["events", "--start", start, "--end", end]);
  const events = Array.isArray(result.events) ? result.events : [];
  return events.flatMap(toMacosEvent);
}

module.exports = {
  ENABLED_FILENAME,
  helperPath,
  connect,
  disconnect,
  fetchUpcoming,
  toMacosEvent,
  runHelper,
};
