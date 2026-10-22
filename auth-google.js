/**
 * auth-google.js — direct, client-side Google OAuth for a desktop app.
 *
 * There is no backend and no identity broker: the app is the OAuth client. It
 * follows RFC 8252 ("OAuth 2.0 for Native Apps"): the authorization request is
 * opened in the user's *system* browser, and the response comes back to a
 * short-lived loopback HTTP server that only exists for the duration of one
 * sign-in.
 *
 * The refresh token is persisted to `google_token.json` so the polling engine
 * can keep querying the Calendar API across app restarts without re-prompting.
 */

const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const { shell } = require("electron");
const { OAuth2Client } = require("google-auth-library");

/** Loopback address the system browser is redirected back to. */
const REDIRECT_URI = "http://localhost:3000/oauth2callback";
const CALLBACK_PATH = "/oauth2callback";
const PORT = 3000;

/**
 * Loopback servers are bound to 127.0.0.1 rather than every interface so the
 * socket is never reachable from the local network, even for the few seconds it
 * is open. Browsers that resolve `localhost` to ::1 first fall back to the IPv4
 * address on connection refusal.
 */
const LOOPBACK_HOST = "127.0.0.1";

/** Read-only calendar access is all the polling engine needs. */
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];

/** Abandoned sign-ins must not hold port 3000 (and the browser tab) forever. */
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

/** Placeholder prefix used in the checked-in `google_secret.json`. */
const PLACEHOLDER_PREFIX = "PASTE_YOUR";

/**
 * Trust boundary: `google_secret.json` ships with the build, so a missing file,
 * bad JSON, or unreplaced placeholders mean the build was never configured.
 * Fail loudly at sign-in time rather than surfacing later as an opaque 401.
 *
 * @param {string} secretPath
 * @returns {{ clientId: string, clientSecret: string }}
 */
function loadSecret(secretPath) {
  let raw;
  try {
    raw = fs.readFileSync(secretPath, "utf8");
  } catch (cause) {
    throw new Error(
      `This build is missing google_secret.json (${secretPath}). ` +
        "It should ship with the application's Google Desktop OAuth client.",
      { cause },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `google_secret.json is not valid JSON (${secretPath}).`,
      { cause },
    );
  }

  // Google hands out Desktop credentials wrapped in an `installed` key; older
  // downloads use `web`. Accept either wrapper, then a bare object.
  const credentials = parsed.installed ?? parsed.web ?? parsed;
  const clientId = credentials.client_id;
  const clientSecret = credentials.client_secret;

  const unset = (value) =>
    typeof value !== "string" ||
    value.trim() === "" ||
    value.startsWith(PLACEHOLDER_PREFIX);

  if (unset(clientId) || unset(clientSecret)) {
    throw new Error(
      "This build has no Google OAuth client configured. Paste a Google Cloud " +
        `Desktop client's client_id / client_secret into ${secretPath} and ` +
        "rebuild.",
    );
  }

  return { clientId, clientSecret };
}

/**
 * @param {string} secretPath
 * @returns {import("google-auth-library").OAuth2Client}
 */
function createOAuthClient(secretPath) {
  const { clientId, clientSecret } = loadSecret(secretPath);
  return new OAuth2Client({ clientId, clientSecret, redirectUri: REDIRECT_URI });
}

/**
 * Sign-out has to be final, and deleting the file is not enough on its own: a
 * poll that was already in flight still holds a client whose `tokens` listener
 * would write the merged credentials — refresh token included — straight back to
 * disk, silently reconnecting an account the user just disconnected.
 *
 * Every token file therefore carries a generation. Writers capture it when they
 * are built and pass it back at write time; `signOut` bumps it. A write stamped
 * with a superseded generation is dropped at the one boundary every write passes
 * through, so callers cannot forget the check.
 *
 * @type {Map<string, number>}
 */
const tokenGenerations = new Map();

/**
 * @param {string} tokenPath
 * @returns {number}
 */
function tokenGeneration(tokenPath) {
  return tokenGenerations.get(tokenPath) ?? 0;
}

/**
 * Persist credentials with owner-only permissions — the refresh token is a
 * long-lived bearer credential.
 *
 * @param {string} tokenPath
 * @param {import("google-auth-library").Credentials} credentials
 * @param {number} generation Generation the writer was created against.
 * @returns {boolean} False when the write was dropped as superseded by a sign-out.
 */
function saveCredentials(tokenPath, credentials, generation) {
  if (generation !== tokenGeneration(tokenPath)) return false;

  fs.writeFileSync(tokenPath, JSON.stringify(credentials, null, 2), {
    mode: 0o600,
  });
  return true;
}

/**
 * Disconnects the account: the stored credentials are removed and every writer
 * built before this moment is invalidated, so nothing can recreate the file.
 *
 * @param {{ tokenPath: string }} paths
 */
function signOut({ tokenPath }) {
  tokenGenerations.set(tokenPath, tokenGeneration(tokenPath) + 1);
  fs.rmSync(tokenPath, { force: true });
}

/**
 * Builds an authenticated client from the stored token, or returns null when the
 * user is signed out. The library refreshes the access token on demand; the
 * `tokens` event lets the caller write the refreshed values back to disk so a
 * restart does not force a new consent round.
 *
 * @param {{ secretPath: string, tokenPath: string }} paths
 * @returns {import("google-auth-library").OAuth2Client | null}
 */
function createAuthenticatedClient({ secretPath, tokenPath }) {
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  } catch {
    // No token file (or an unreadable one) simply means "signed out".
    return null;
  }

  if (!stored || typeof stored.refresh_token !== "string") {
    throw new Error(
      `${tokenPath} does not contain a refresh token. Sign out and sign in again.`,
    );
  }

  const client = createOAuthClient(secretPath);
  client.setCredentials(stored);

  const generation = tokenGeneration(tokenPath);
  client.on("tokens", (fresh) => {
    // Refreshes usually omit the refresh token; merging keeps the original.
    saveCredentials(tokenPath, { ...stored, ...fresh }, generation);
  });

  return client;
}

/**
 * Renders the browser tab the user is left looking at once the redirect lands.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {string} heading
 * @param {string} detail
 */
function respond(res, status, heading, detail) {
  const escape = (text) =>
    text.replace(
      /[&<>"]/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char],
    );

  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${escape(heading)}</title>` +
      '<body style="font:16px/1.6 system-ui;padding:3rem;max-width:34rem;margin:auto">' +
      `<h1 style="font-size:1.4rem">${escape(heading)}</h1>` +
      `<p>${escape(detail)}</p>` +
      "<p>You can close this tab and return to Calendar Reminder.</p>",
  );
}

/**
 * Runs one interactive sign-in end to end: start the loopback listener, open the
 * system browser, wait for the redirect, exchange the code, store the tokens,
 * and shut the listener down again.
 *
 * Concurrency is the caller's responsibility — the main process serialises
 * sign-ins because both providers share port 3000.
 *
 * @param {{ secretPath: string, tokenPath: string }} paths
 * @returns {Promise<void>}
 */
async function signIn({ secretPath, tokenPath }) {
  // Validate the secret *before* opening a port or a browser tab.
  const client = createOAuthClient(secretPath);

  // Captured before the browser opens: a sign-out landing while the user is
  // still on the consent screen must win over the credentials this flow returns.
  const generation = tokenGeneration(tokenPath);

  // PKCE plus an unguessable `state` protect the loopback redirect: any other
  // local process that races to the callback cannot use the code it sees.
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const expectedState = crypto.randomBytes(32).toString("base64url");

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    state: expectedState,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    // Force the consent screen so Google reliably returns a refresh token even
    // for a user who has already granted these scopes once.
    prompt: "consent",
  });

  const code = await new Promise((resolve, reject) => {
    let settled = false;
    const server = http.createServer();

    // Single exit path so the port, the timer and the promise are always
    // released together, whichever way the flow ends.
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => (error ? reject(error) : resolve(value)));
      // Callbacks keep the socket alive after a successful response; drop them.
      server.closeAllConnections?.();
    };

    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Google sign-in timed out after 5 minutes without a response from the browser.",
          ),
        ),
      SIGN_IN_TIMEOUT_MS,
    );

    server.on("request", (req, res) => {
      const requestUrl = new URL(req.url, `http://localhost:${PORT}`);
      if (requestUrl.pathname !== CALLBACK_PATH) {
        respond(res, 404, "Not found", "This address is not part of the sign-in flow.");
        return;
      }

      const params = requestUrl.searchParams;
      const failure = params.get("error");
      if (failure) {
        respond(res, 400, "Sign-in cancelled", `Google reported: ${failure}`);
        finish(new Error(`Google denied the authorization request: ${failure}`));
        return;
      }

      // Compare in constant time: `state` is a secret for this exchange.
      const received = params.get("state") ?? "";
      const expected = Buffer.from(expectedState);
      const actual = Buffer.from(received);
      const stateMatches =
        expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

      if (!stateMatches) {
        respond(res, 400, "Sign-in rejected", "The security check on the response failed.");
        finish(new Error("Google returned an unexpected OAuth state value."));
        return;
      }

      const authorizationCode = params.get("code");
      if (!authorizationCode) {
        respond(res, 400, "Sign-in failed", "The response carried no authorization code.");
        finish(new Error("Google redirect contained no authorization code."));
        return;
      }

      respond(res, 200, "Google Calendar connected", "Calendar Reminder is now watching this calendar.");
      finish(null, authorizationCode);
    });

    server.on("error", (error) => {
      finish(
        error.code === "EADDRINUSE"
          ? new Error(
              `Port ${PORT} is already in use, so the sign-in redirect cannot be received. ` +
                "Close whatever is using it and try again.",
            )
          : error,
      );
    });

    server.listen(PORT, LOOPBACK_HOST, () => {
      // Hand off to the system browser only once the listener is actually up,
      // otherwise a fast redirect can arrive before the socket is bound.
      shell.openExternal(authUrl).catch(finish);
    });
  });

  const { tokens } = await client.getToken({ code, codeVerifier });

  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token, so background polling would stop " +
        "working within the hour. Remove this app from " +
        "https://myaccount.google.com/permissions and sign in again.",
    );
  }

  if (!saveCredentials(tokenPath, tokens, generation)) {
    throw new Error(
      "Google Calendar was signed out while this sign-in was still running, so " +
        "nothing was stored. Sign in again to connect it.",
    );
  }
}

module.exports = {
  REDIRECT_URI,
  SCOPES,
  TOKEN_FILENAME: "google_token.json",
  SECRET_FILENAME: "google_secret.json",
  createAuthenticatedClient,
  loadSecret,
  signIn,
  signOut,
};
