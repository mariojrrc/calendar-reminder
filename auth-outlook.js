/**
 * auth-outlook.js — direct, client-side Microsoft OAuth for a desktop app.
 *
 * Uses an MSAL **Public Client Application**, which is the registration type
 * meant for desktop and mobile apps: there is no client secret to protect, so
 * the app can talk to Microsoft Entra ID on its own with no backend and no
 * identity broker in the middle. PKCE stands in for the missing secret.
 *
 * MSAL owns the token lifecycle (it deliberately does not expose refresh tokens).
 * Persistence is therefore done through a cache plugin that mirrors MSAL's cache
 * blob to `outlook_token.json`.
 */

const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const { shell } = require("electron");
const { PublicClientApplication, CryptoProvider } = require("@azure/msal-node");

/** Loopback address the system browser is redirected back to. */
const REDIRECT_URI = "http://localhost:3000/outlookcallback";
const CALLBACK_PATH = "/outlookcallback";
const PORT = 3000;

/** See the matching note in auth-google.js: loopback-only, never LAN-visible. */
const LOOPBACK_HOST = "127.0.0.1";

/**
 * Read-only calendar access. MSAL adds `openid`, `profile` and `offline_access`
 * itself, so requesting them here would only duplicate them.
 */
const SCOPES = ["Calendars.Read"];

/** Abandoned sign-ins must not hold port 3000 (and the browser tab) forever. */
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

/** Placeholder prefix used in the checked-in `outlook_secret.json`. */
const PLACEHOLDER_PREFIX = "PASTE_YOUR";

/**
 * Trust boundary: `outlook_secret.json` ships with the build, so a missing file,
 * bad JSON, or an unreplaced placeholder means the build was never configured.
 * Fail at sign-in time instead of turning into an opaque Entra ID error later.
 *
 * @param {string} secretPath
 * @returns {{ clientId: string, tenantId: string }}
 */
function loadSecret(secretPath) {
  let raw;
  try {
    raw = fs.readFileSync(secretPath, "utf8");
  } catch (cause) {
    throw new Error(
      `This build is missing outlook_secret.json (${secretPath}). ` +
        "It should ship with the application's Azure public client registration.",
      { cause },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`outlook_secret.json is not valid JSON (${secretPath}).`, {
      cause,
    });
  }

  const clientId = parsed.clientId;
  if (
    typeof clientId !== "string" ||
    clientId.trim() === "" ||
    clientId.startsWith(PLACEHOLDER_PREFIX)
  ) {
    throw new Error(
      "This build has no Outlook OAuth client configured. Paste your Azure app " +
        `registration's Application (client) ID into ${secretPath} and rebuild.`,
    );
  }

  // `common` lets both work and personal Microsoft accounts sign in, which is
  // the right default for a single-user desktop utility.
  const tenantId =
    typeof parsed.tenantId === "string" && parsed.tenantId.trim() !== ""
      ? parsed.tenantId.trim()
      : "common";

  return { clientId, tenantId };
}

/**
 * Sign-out has to be final, and deleting the file is not enough on its own: a
 * poll that was already in flight still holds an application whose
 * `afterCacheAccess` hook would serialise its in-memory cache — refresh token
 * included — straight back to disk, silently reconnecting an account the user
 * just disconnected.
 *
 * Every token file therefore carries a generation. An application captures it
 * when it is built; `signOut` bumps it. A cache flush stamped with a superseded
 * generation is dropped at the one boundary every write passes through.
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
 * Disconnects the account: the serialised cache is removed and every application
 * built before this moment is barred from writing, so nothing can recreate the
 * file. The instance itself still holds an in-memory cache, so the caller drops
 * its reference too.
 *
 * @param {{ tokenPath: string }} paths
 */
function signOut({ tokenPath }) {
  tokenGenerations.set(tokenPath, tokenGeneration(tokenPath) + 1);
  fs.rmSync(tokenPath, { force: true });
}

/**
 * Builds the MSAL application with a cache plugin that reads from and writes to
 * `outlook_token.json`. MSAL calls `beforeCacheAccess` before touching its cache
 * and `afterCacheAccess` afterwards, so silent refreshes are persisted without
 * the caller having to think about it.
 *
 * The returned instance holds an in-memory cache, so the caller must drop it on
 * sign-out — see `signOut`.
 *
 * @param {{ secretPath: string, tokenPath: string }} paths
 * @returns {PublicClientApplication}
 */
function createApplication({ secretPath, tokenPath }) {
  const { clientId, tenantId } = loadSecret(secretPath);
  const generation = tokenGeneration(tokenPath);

  return new PublicClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
    cache: {
      cachePlugin: {
        async beforeCacheAccess(cacheContext) {
          try {
            cacheContext.tokenCache.deserialize(
              fs.readFileSync(tokenPath, "utf8"),
            );
          } catch {
            // No cache file yet (or it is unreadable): start from an empty cache
            // and let the interactive flow populate it.
          }
        },
        async afterCacheAccess(cacheContext) {
          if (!cacheContext.cacheHasChanged) return;
          // Superseded by a sign-out: this cache must not reach the disk again.
          if (generation !== tokenGeneration(tokenPath)) return;
          // The blob holds refresh tokens, so keep it owner-readable only.
          fs.writeFileSync(tokenPath, cacheContext.tokenCache.serialize(), {
            mode: 0o600,
          });
        },
      },
    },
  });
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
 * system browser, wait for the redirect, exchange the code, let the cache plugin
 * persist the result, and shut the listener down again.
 *
 * Concurrency is the caller's responsibility — the main process serialises
 * sign-ins because both providers share port 3000.
 *
 * @param {{ secretPath: string, tokenPath: string }} paths
 * @returns {Promise<void>}
 */
async function signIn({ secretPath, tokenPath }) {
  // Validate the configuration *before* opening a port or a browser tab.
  const pca = createApplication({ secretPath, tokenPath });

  // PKCE is what makes a secretless public client safe: the authorization code
  // is worthless to anyone who does not hold this verifier.
  const cryptoProvider = new CryptoProvider();
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
  const expectedState = crypto.randomBytes(32).toString("base64url");

  const authUrl = await pca.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    state: expectedState,
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
      server.closeAllConnections?.();
    };

    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Outlook sign-in timed out after 5 minutes without a response from the browser.",
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
        const description = params.get("error_description") ?? failure;
        respond(res, 400, "Sign-in cancelled", `Microsoft reported: ${description}`);
        finish(new Error(`Microsoft denied the authorization request: ${description}`));
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
        finish(new Error("Microsoft returned an unexpected OAuth state value."));
        return;
      }

      const authorizationCode = params.get("code");
      if (!authorizationCode) {
        respond(res, 400, "Sign-in failed", "The response carried no authorization code.");
        finish(new Error("Microsoft redirect contained no authorization code."));
        return;
      }

      respond(res, 200, "Outlook Calendar connected", "Calendar Reminder is now watching this calendar.");
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
      // Hand off to the system browser only once the listener is actually up.
      shell.openExternal(authUrl).catch(finish);
    });
  });

  const result = await pca.acquireTokenByCode({
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
    code,
    codeVerifier: verifier,
  });

  if (!result?.account) {
    throw new Error(
      "Microsoft returned a token without an account, so the calendar cannot be polled.",
    );
  }

  // The cache plugin has already written `outlook_token.json` at this point; a
  // missing file means persistence failed — or a sign-out landed mid-flow and
  // superseded it — and background polling would silently never start.
  if (!fs.existsSync(tokenPath)) {
    throw new Error(`Signed in, but the token cache was not written to ${tokenPath}.`);
  }
}

/**
 * Returns a Graph access token for the signed-in account, refreshing silently if
 * the cached one has expired, or null when the user is signed out.
 *
 * Takes an application instance rather than paths so the caller can reuse one
 * across polls: MSAL caches authority metadata on the instance, and rebuilding
 * it every minute would mean re-discovering that metadata every minute.
 *
 * @param {PublicClientApplication} pca
 * @returns {Promise<string | null>}
 */
async function getAccessToken(pca) {
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length === 0) return null;

  // A desktop utility signs in one account, so the first is the account.
  const result = await pca.acquireTokenSilent({
    account: accounts[0],
    scopes: SCOPES,
  });

  return result?.accessToken ?? null;
}

module.exports = {
  REDIRECT_URI,
  SCOPES,
  TOKEN_FILENAME: "outlook_token.json",
  SECRET_FILENAME: "outlook_secret.json",
  createApplication,
  getAccessToken,
  loadSecret,
  signIn,
  signOut,
};
