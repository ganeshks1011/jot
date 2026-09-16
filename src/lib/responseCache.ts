/**
 * Cross-open response cache for rewrites: same text + same resolved system
 * prompt (+ provider, model, tweak, formatting) reuses the last output
 * instead of refetching. Hits never reach the backend, so no quota is
 * consumed. Backend is untouched; this lives entirely in the extension.
 *
 * Persistence is `chrome.storage.local` (never sync — outputs can be
 * large and are device-local). All storage access is guarded and falls
 * back to skipping the cache; a corrupt or oversized entry is dropped.
 * Model temperature means identical keys return byte-identical output
 * instead of fresh variation — that is the requested behavior. Keying on
 * the full resolved system prompt (plus provider/model) means mode,
 * personalization, or endpoint changes miss naturally.
 */

import { browser } from "wxt/browser";

const STORE_KEY = "jot:responseCache";
const CACHE_VERSION = 1;
const MAX_ENTRIES = 20;
const MAX_BODY_CHARS = 20000;

export interface ResponseCacheKeyParts {
  provider: string;
  model: string;
  systemPrompt: string;
  source: string;
  followUp?: string;
  html?: string | null;
  /** JSON of keyed [[id, text]] entries for the Lexical flow. */
  nodes?: string | null;
  /** Latest output when tweaking; tweaks against different rewrites never share. */
  priorOutput?: string | null;
}

interface CacheStore {
  v: number;
  entries: Record<string, { body: string; savedAt: number }>;
}

function isStore(value: unknown): value is CacheStore {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.v !== CACHE_VERSION || typeof record.entries !== "object" || record.entries === null) return false;
  return Object.values(record.entries as Record<string, unknown>).every(
    (e) => typeof e === "object" && e !== null && typeof (e as { body?: unknown }).body === "string",
  );
}

async function sha256Hex(text: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // Non-crypto fallback for contexts without SubtleCrypto. Collisions
    // only ever return a stale cached rewrite; the entry cap keeps the
    // birthday risk negligible.
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return `fnv1a-${(hash >>> 0).toString(16)}`;
  }
}

/** Stable key: fixed field order, JSON separators (no `||` ambiguity). */
export async function buildResponseKey(parts: ResponseCacheKeyParts): Promise<string> {
  const canonical = JSON.stringify([
    `v${CACHE_VERSION}`,
    parts.provider,
    parts.model,
    parts.systemPrompt,
    parts.source,
    parts.followUp ?? "",
    parts.html ?? "",
    parts.nodes ?? "",
    // Appended (never inserted): old entries simply miss once and self-heal.
    parts.priorOutput ?? "",
  ]);
  return sha256Hex(canonical);
}

async function readStore(): Promise<CacheStore> {
  try {
    const stored = await browser.storage.local.get(STORE_KEY);
    const raw = stored[STORE_KEY];
    if (isStore(raw)) return raw;
  } catch {
    // Corrupt or inaccessible storage reads as empty.
  }
  return { v: CACHE_VERSION, entries: {} };
}

async function writeStore(store: CacheStore): Promise<void> {
  try {
    await browser.storage.local.set({ [STORE_KEY]: store });
  } catch {
    // Quota or access failure: caching degrades to a miss next time.
  }
}

/** Cached output body for a key, or null on any miss. Never throws. */
export async function cachedResponseFor(key: string): Promise<string | null> {
  try {
    const store = await readStore();
    const entry = store.entries[key];
    return typeof entry?.body === "string" ? entry.body : null;
  } catch {
    return null;
  }
}

/** Store an output body; oversized or failing writes are skipped. Never throws. */
export async function storeResponse(key: string, body: string): Promise<void> {
  try {
    if (!body || body.length > MAX_BODY_CHARS) return;
    const store = await readStore();
    delete store.entries[key];
    store.entries[key] = { body, savedAt: Date.now() };
    while (Object.keys(store.entries).length > MAX_ENTRIES) {
      const oldest = Object.keys(store.entries)[0];
      if (oldest === undefined) break;
      delete store.entries[oldest];
    }
    await writeStore(store);
  } catch {
    // Caching is best-effort; the rewrite already succeeded.
  }
}

/** Drop all cached responses. Never throws. */
export async function clearResponseCache(): Promise<void> {
  try {
    await browser.storage.local.remove(STORE_KEY);
  } catch {
    // Nothing to do when storage is unavailable.
  }
}
