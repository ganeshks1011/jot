/**
 * Host → overlay init handshake helpers.
 *
 * The host posts `{ type: "init" }` once the overlay iframe loads, and again
 * when the overlay posts `{ type: "ready" }` (listener attached). Rapid
 * double sends for the same captured text are deduped. Except forced sends,
 * which always deliver. Forcing matters because `ready` explicitly means the
 * overlay missed any earlier `init` (cold first-invoke race); suppressing
 * that retry leaves the panel stuck with no text and no request.
 */

/** Window in which repeat `init` posts for identical captures are dropped. */
export const INIT_DEDUPE_WINDOW_MS = 1200;

/** Stable key identifying a captured invocation for dedupe purposes. */
export function buildInitKey(text: string, hasFormatting: boolean, htmlLength: number, hostname: string): string {
  return `${text}||${hasFormatting ? "html" : "plain"}||${htmlLength}||${hostname}`;
}

/**
 * Whether an `init` post should be sent. Forced sends (the `ready` retry and
 * the load safety net) always deliver; otherwise a repeat of the last key
 * inside the dedupe window is dropped.
 */
export function shouldSendInit(lastKey: string, lastAt: number, key: string, nowMs: number, force: boolean): boolean {
  if (force) return true;
  return !(key === lastKey && nowMs - lastAt < INIT_DEDUPE_WINDOW_MS);
}
