/**
 * Wurkflo account session.
 *
 * Sign-in happens on wurkflo.app/extension/auth in a normal browser tab (the
 * web route mints a single-use code and redirects back to the extension's
 * auth-callback page). The options page trades that code for a Firebase
 * custom token, which lib/session.ts turns into a durable local session
 * (Identity Toolkit REST, no SDK) whose ID tokens refresh silently.
 * A lightweight {uid,email} snapshot is mirrored into chrome.storage.local
 * so the overlay can reflect account state without touching the session.
 */
import { browser } from "wxt/browser";
import { relayFetch } from "./net";
import { getSessionIdToken, type SessionUser, signInSession, signOutSession, watchSession } from "./session";

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

async function mirrorUser(user: SessionUser | null): Promise<void> {
  if (user) {
    await browser.storage.local.set({
      [WURKFLO_USER_KEY]: { uid: user.uid, email: user.email } satisfies WurkfloUser,
    });
  } else {
    await browser.storage.local.remove(WURKFLO_USER_KEY);
  }
}

export async function signOutWurkflo(): Promise<void> {
  await signOutSession();
  await mirrorUser(null);
}

/**
 * Keeps the storage snapshot in sync while the options page is open (and
 * refreshes it once on mount). Returns an unsubscribe function.
 */
export function watchWurkfloAuth(): () => void {
  return watchSession((user) => {
    void mirrorUser(user);
  });
}

/**
 * Fresh ID token for API calls; throws when signed out.
 *
 * The persisted session lives in chrome.storage.local, shared by the
 * options page and the background service worker. Contexts read it locally
 * first; the overlay iframe's storage is partitioned, so it asks the
 * background for a token instead.
 */
export async function getWurkfloToken(): Promise<string> {
  let token: string | null = null;
  try {
    token = await getSessionIdToken();
  } catch {
    // Partitioned iframe storage can break local reads; fall through to the
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

  const session = await signInSession(customToken);
  await mirrorUser(session);
  return { uid: session.uid, email: session.email };
}
