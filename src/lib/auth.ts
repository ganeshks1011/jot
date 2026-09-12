/**
 * Wurkflo account session.
 *
 * Sign-in happens on wurkflo.app/extension/auth in a normal browser tab (the
 * web route mints a single-use code and redirects back to the extension's
 * auth-callback page). The options page trades that code for a Firebase
 * custom token via signInWithCustomToken, producing a durable local session
 * whose ID tokens refresh silently. A lightweight {uid,email} snapshot is
 * mirrored into chrome.storage.local so the overlay can reflect account
 * state without bundling the Firebase SDK.
 */
import { signOut as firebaseSignOut, onAuthStateChanged, signInWithCustomToken, type User } from "firebase/auth";
import { browser } from "wxt/browser";
import { getFirebaseAuth } from "./firebase";
import { relayFetch } from "./net";

export interface WurkfloUser {
  uid: string;
  email: string | null;
}

export const WURKFLO_USER_KEY = "jot:wurkfloUser";

import { WURKFLO_ORIGIN } from "./config";

export { WURKFLO_ORIGIN };

export function extensionAuthUrl(extensionId: string): string {
  return `${WURKFLO_ORIGIN}/extension/auth?ext=${extensionId}`;
}

const LINK_EXCHANGE_URL = `${WURKFLO_ORIGIN}/api/auth/link/exchange`;

async function mirrorUser(user: User | null): Promise<void> {
  if (user) {
    await browser.storage.local.set({
      [WURKFLO_USER_KEY]: { uid: user.uid, email: user.email } satisfies WurkfloUser,
    });
  } else {
    await browser.storage.local.remove(WURKFLO_USER_KEY);
  }
}

export async function signOutWurkflo(): Promise<void> {
  await firebaseSignOut(getFirebaseAuth());
  await mirrorUser(null);
}

/**
 * Keeps the storage snapshot in sync while the options page is open (and
 * refreshes it once on mount). Returns an unsubscribe function.
 */
export function watchWurkfloAuth(): () => void {
  const auth = getFirebaseAuth();
  return onAuthStateChanged(auth, (user) => {
    void mirrorUser(user);
  });
}

/**
 * Fresh ID token for API calls; throws when signed out.
 *
 * The persisted Firebase session is owned by the background service worker.
 * Contexts with a local currentUser (options page) use it directly; the
 * overlay iframe's storage is partitioned, so it asks the background for a
 * token instead.
 */
export async function getWurkfloToken(): Promise<string> {
  let token: string | null = null;
  try {
    const auth = getFirebaseAuth();
    // Wait briefly for IndexedDB persistence to restore on cold start.
    try {
      await Promise.race([
        auth.authStateReady(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("auth-timeout")), 2500)),
      ]);
    } catch {
      // authStateReady timeout is non-fatal; fall through to currentUser check.
    }
    const local = auth.currentUser;
    if (local) token = await local.getIdToken();
  } catch {
    // Partitioned iframe storage can break local init; fall through to the
    // background worker below.
  }
  if (token) return token;

  const res = (await browser.runtime.sendMessage({ type: "jot:wurkflo-token" })) as
    | { ok: boolean; token?: string; error?: string }
    | undefined;
  if (!res?.ok || typeof res.token !== "string") {
    throw new Error(res?.error ?? "not-signed-in");
  }
  return res.token;
}

/**
 * Complete a web-initiated link: exchange the single-use code from the
 * auth-callback page for a custom token and sign in locally. Mirrors the
 * snapshot explicitly so the UI updates even when no watcher is attached.
 */
export async function completeWurkfloLink(code: string): Promise<WurkfloUser> {
  let customToken: string;
  try {
    // Relayed through the background worker - Jot declares no host
    // permissions, so direct extension-page fetches would be CORS-bound.
    const res = await relayFetch({
      url: LINK_EXCHANGE_URL,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const body = (JSON.parse(res.text) ?? null) as {
      success?: boolean;
      customToken?: unknown;
      error?: { message?: string };
    } | null;
    if (!res.ok || !body?.success || typeof body.customToken !== "string") {
      throw new Error(body?.error?.message || `Exchange failed (${res.status})`);
    }
    customToken = body.customToken;
  } catch (err) {
    if (err instanceof SyntaxError || (err as Error).message === "relay-failed") {
      throw new Error("Could not reach the Wurkflo backend - check your connection");
    }
    throw err;
  }

  const cred = await signInWithCustomToken(getFirebaseAuth(), customToken);
  await mirrorUser(cred.user);
  return { uid: cred.user.uid, email: cred.user.email };
}
