/**
 * Wurkflo account session over Firebase Identity Toolkit REST.
 *
 * Sign-in uses backend-minted custom tokens (see lib/auth.ts). This used to
 * go through the firebase/auth SDK, but the SDK bundles remote script
 * loaders (google.com/recaptcha, apis.google.com) that violate the Chrome
 * Web Store MV3 "no remotely hosted code" rule — even though Jot never uses
 * reCAPTCHA-gated features (no phone auth, no App Check). So the SDK is
 * gone; this module speaks the same Identity Toolkit endpoints with plain
 * fetch. Those calls transfer data, not executable code, which is allowed —
 * and the endpoints serve `Access-Control-Allow-Origin: *`, so direct fetch
 * works from extension pages exactly as the SDK's own requests did.
 * (The background worker relays page traffic, but auth calls go direct:
 * the worker cannot use its own `jot:http` relay without a message loop.)
 *
 * State lives in chrome.storage.local (never sync, never logged): the
 * refresh token plus a cached ID token. storage.local is shared by the
 * options page and the background worker, so unlike the old IndexedDB
 * persistence it is not affected by overlay-iframe storage partitioning.
 * Other contexts keep asking the background for tokens via `jot:wurkflo-token`.
 */
import { browser } from "wxt/browser";

export interface SessionUser {
  uid: string;
  email: string | null;
}

const SESSION_KEY = "jot:wurkfloSession";

/** Refresh the ID token this far ahead of its expiry. */
const TOKEN_SKEW_MS = 60_000;

interface PersistedSession {
  refreshToken: string;
  uid: string;
  email: string | null;
  idToken: string;
  idTokenExpiresAt: number;
}

function apiKey(): string {
  const key = import.meta.env.VITE_FIREBASE_API_KEY as string | undefined;
  // Fail fast with an actionable message: without the key the endpoints
  // return cryptic errors. Same Firebase project as the web app; rebuild
  // the extension after changing apps/jot/.env (Vite bakes env at build).
  if (!key) {
    throw new Error(
      "Missing VITE_FIREBASE_API_KEY: copy .env into apps/jot (same Firebase project as the web app) and rebuild the extension.",
    );
  }
  return key;
}

/** Server-side session deaths: drop local state and report signed-out. */
const DEAD_SESSION_RE = /INVALID_REFRESH_TOKEN|TOKEN_EXPIRED|USER_NOT_FOUND|USER_DISABLED|INVALID_ID_TOKEN/i;

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function serverMessage(body: Record<string, unknown> | null): string | null {
  const err = body?.error;
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return null;
}

async function readSession(): Promise<PersistedSession | null> {
  const stored = await browser.storage.local.get(SESSION_KEY);
  const session = stored[SESSION_KEY] as PersistedSession | undefined;
  return session?.refreshToken && session?.uid ? session : null;
}

async function persistSession(session: PersistedSession): Promise<void> {
  await browser.storage.local.set({ [SESSION_KEY]: session });
}

/** In-memory ID token cache; storage.local is the durable fallback. */
let memToken: { token: string; expiresAt: number } | null = null;
/** Singleflight: concurrent callers share one refresh. */
let inflightRefresh: Promise<string> | null = null;

/**
 * Best-effort cleanup of the pre-REST Firebase SDK persistence
 * (IndexedDB databases the removed SDK used to own). Never throws; a
 * leftover legacy session is simply never read again.
 */
async function clearLegacyFirebaseState(): Promise<void> {
  try {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!idb || typeof idb.databases !== "function") return;
    const names = (await idb.databases())
      .map((db) => db.name)
      .filter(
        (name): name is string =>
          typeof name === "string" && (name === "firebaseLocalStorageDb" || name === "firebase-heartbeat-database"),
      );
    await Promise.all(
      names.map(
        (name) =>
          new Promise<void>((resolve) => {
            try {
              const req = idb.deleteDatabase(name);
              req.onsuccess = req.onerror = req.onblocked = () => resolve();
            } catch {
              resolve();
            }
          }),
      ),
    );
  } catch {
    // Cleanup must never break auth.
  }
}

/** Email for the account mirror; null when the lookup itself fails. */
async function lookupEmail(idToken: string): Promise<string | null> {
  try {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    const body = await readJson(res);
    const users = body?.users;
    if (res.ok && Array.isArray(users) && users.length > 0) {
      const email = (users[0] as { email?: unknown }).email;
      return typeof email === "string" && email ? email : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Trade a backend-minted custom token for a durable session. Throws on
 * transport errors and invalid/expired custom tokens.
 */
export async function signInSession(customToken: string): Promise<SessionUser> {
  await clearLegacyFirebaseState();
  const key = apiKey();
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const body = await readJson(res);
  const idToken = body?.idToken;
  const refreshToken = body?.refreshToken;
  const expiresIn = body?.expiresIn;
  const uid = body?.localId;
  if (!res.ok || typeof idToken !== "string" || typeof refreshToken !== "string" || typeof uid !== "string") {
    throw new Error(serverMessage(body) ?? `Link failed (${res.status})`);
  }
  const expiresMs = Number(expiresIn) > 0 ? Number(expiresIn) * 1000 : 3600_000;
  const email = await lookupEmail(idToken);
  const session: PersistedSession = {
    refreshToken,
    uid,
    email,
    idToken,
    idTokenExpiresAt: Date.now() + expiresMs,
  };
  await persistSession(session);
  memToken = { token: idToken, expiresAt: session.idTokenExpiresAt };
  return { uid, email };
}

async function refreshSession(stored: PersistedSession): Promise<PersistedSession> {
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey()}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(stored.refreshToken)}`,
  });
  const body = await readJson(res);
  if (!res.ok) {
    const message = serverMessage(body);
    if (message && DEAD_SESSION_RE.test(message)) {
      memToken = null;
      await browser.storage.local.remove(SESSION_KEY).catch(() => {});
      throw new Error("not-signed-in");
    }
    throw new Error(message ?? `Token refresh failed (${res.status})`);
  }
  const idToken = body?.id_token;
  const expiresIn = body?.expires_in;
  if (typeof idToken !== "string" || !idToken) {
    throw new Error("Token refresh failed");
  }
  const expiresMs = Number(expiresIn) > 0 ? Number(expiresIn) * 1000 : 3600_000;
  const next: PersistedSession = {
    ...stored,
    // Rotation: keep the new refresh token when the server issues one.
    refreshToken: typeof body?.refresh_token === "string" ? (body.refresh_token as string) : stored.refreshToken,
    idToken,
    idTokenExpiresAt: Date.now() + expiresMs,
  };
  await persistSession(next);
  return next;
}

async function loadFreshToken(): Promise<string> {
  const stored = await readSession();
  if (!stored) throw new Error("not-signed-in");
  if (stored.idToken && stored.idTokenExpiresAt - Date.now() > TOKEN_SKEW_MS) {
    memToken = { token: stored.idToken, expiresAt: stored.idTokenExpiresAt };
    return stored.idToken;
  }
  const next = await refreshSession(stored);
  memToken = { token: next.idToken, expiresAt: next.idTokenExpiresAt };
  return next.idToken;
}

/**
 * Fresh ID token for API calls; throws `not-signed-in` when signed out
 * (callers treat that as retryable, matching the old SDK behavior).
 * Concurrent callers share a single refresh request.
 */
export async function getSessionIdToken(): Promise<string> {
  if (memToken && memToken.expiresAt - Date.now() > TOKEN_SKEW_MS) {
    return memToken.token;
  }
  if (!inflightRefresh) {
    inflightRefresh = loadFreshToken().finally(() => {
      inflightRefresh = null;
    });
  }
  return inflightRefresh;
}

/** Revoke server-side (best-effort), then drop all local session state. */
export async function signOutSession(): Promise<void> {
  const stored = await readSession().catch(() => null);
  if (stored?.refreshToken) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(stored.refreshToken)}`, {
        method: "POST",
      });
    } catch {
      // Offline revocation fails silently; local state is still cleared.
    }
  }
  memToken = null;
  await browser.storage.local.remove(SESSION_KEY).catch(() => {});
  await clearLegacyFirebaseState();
}

/** Fires on sign-in/out (and legacy cleanup); returns an unsubscribe fn. */
export function watchSession(cb: (user: SessionUser | null) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== "local" || !(SESSION_KEY in changes)) return;
    const next = changes[SESSION_KEY].newValue as PersistedSession | undefined;
    cb(next?.uid ? { uid: next.uid, email: next.email ?? null } : null);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
