/**
 * Pure helpers for classifying transient relay/auth errors.
 * Shared by `net.ts` (background relay) and `api.ts` (Wurkflo streaming).
 * No Chrome/React/window dependencies. Fully unit-testable.
 */

const RELAY_TRANSIENT_RE =
  /relay-failed|stream-failed|network-error|Failed to fetch|Receiving end does not exist|Could not establish connection|Extension context invalidated|Could not reach/i;

const TOKEN_TRANSIENT_RE =
  /not-signed-in|relay-failed|stream-failed|auth-timeout|Receiving end does not exist|Could not establish connection|Failed to fetch|network-error|Extension context invalidated/i;

/** Relay transport is retryable (cold SW, CORS, transient network). */
export function isTransientRelayError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return RELAY_TRANSIENT_RE.test(msg);
}

/** Relay message string is retryable (used by net.ts). */
export function isTransientRelayMessage(msg: string): boolean {
  return RELAY_TRANSIENT_RE.test(msg);
}

/** Auth token fetch is retryable (includes not-signed-in / auth-timeout). */
export function isTransientTokenError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return TOKEN_TRANSIENT_RE.test(msg);
}

/** For testing: expose patterns if needed. */
export const _patterns = {
  relay: RELAY_TRANSIENT_RE,
  token: TOKEN_TRANSIENT_RE,
};
