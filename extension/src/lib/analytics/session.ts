/**
 * GA4 session handling, following the official Chrome-extension guide:
 * a session id + last-seen timestamp in chrome.storage.session, rotating
 * after 30 minutes of inactivity. Session ids are timestamps, not identity.
 */

export const SESSION_EXPIRATION_MS = 30 * 60 * 1000;
export const DEFAULT_ENGAGEMENT_TIME_MSEC = 100;

export interface SessionData {
  session_id: string;
  timestamp: number;
}

export interface SessionStore {
  get: () => Promise<SessionData | null>;
  set: (data: SessionData) => Promise<void>;
}

function isValidSession(data: SessionData | null): data is SessionData {
  return (
    !!data &&
    typeof data.session_id === "string" &&
    data.session_id.length > 0 &&
    typeof data.timestamp === "number" &&
    Number.isFinite(data.timestamp)
  );
}

/**
 * Pure core: returns the live session id, refreshing or rotating as needed.
 * Never throws. Callers must not await analytics for UX.
 */
export async function resolveSessionId(store: SessionStore, now: number = Date.now()): Promise<string> {
  let existing: SessionData | null = null;
  try {
    existing = await store.get();
  } catch {
    existing = null;
  }
  if (isValidSession(existing) && now - existing.timestamp <= SESSION_EXPIRATION_MS) {
    const refreshed: SessionData = { session_id: existing.session_id, timestamp: now };
    try {
      await store.set(refreshed);
    } catch {
      // Memory-only at worst; the id is still correct for this batch.
    }
    return existing.session_id;
  }
  const fresh: SessionData = { session_id: String(now), timestamp: now };
  try {
    await store.set(fresh);
  } catch {
    // Unpersisted sessions still work for a single batch.
  }
  return fresh.session_id;
}

let memoryFallback: SessionData | null = null;

/** Production binding over chrome.storage.session with memory fallback. */
export function chromeSessionStore(): SessionStore {
  return {
    get: async () => {
      try {
        const { browser } = await import("wxt/browser");
        const stored = await browser.storage.session.get("sessionData");
        const data = (stored as Record<string, unknown>).sessionData;
        if (data && typeof data === "object" && typeof (data as SessionData).session_id === "string") {
          return data as SessionData;
        }
        return memoryFallback;
      } catch {
        return memoryFallback;
      }
    },
    set: async (data: SessionData) => {
      memoryFallback = data;
      try {
        const { browser } = await import("wxt/browser");
        await browser.storage.session.set({ sessionData: data });
      } catch {
        // Memory fallback already updated above.
      }
    },
  };
}

export function getOrCreateSessionId(now?: number): Promise<string> {
  return resolveSessionId(chromeSessionStore(), now);
}
