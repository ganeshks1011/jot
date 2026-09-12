/**
 * Overlay `ready` retry: if the host's `init` was sent before this frame's
 * listener attached (cold first-invoke), no `init` ever arrives and the
 * panel stalls with no text and no request. Re-posting `ready` prompts the
 * host's forced resend until the first `init` lands. Bounded so a broken
 * host can't spin forever; the caller stops the loop on unmount.
 */

/** Delay between `ready` re-posts while no `init` has arrived. */
export const READY_RETRY_INTERVAL_MS = 1000;
/** Upper bound on `ready` re-posts (excluding the initial post). */
export const READY_MAX_RETRIES = 3;

/**
 * Re-post `post` on an interval until `isInitReceived()` is true or the
 * retry budget is spent. Returns a stop function for effect cleanup.
 */
export function startReadyRetry(
  post: () => void,
  isInitReceived: () => boolean,
  intervalMs: number = READY_RETRY_INTERVAL_MS,
  maxRetries: number = READY_MAX_RETRIES,
): () => void {
  let attempts = 0;
  const id = setInterval(() => {
    if (isInitReceived() || attempts >= maxRetries) {
      clearInterval(id);
      return;
    }
    attempts += 1;
    post();
  }, intervalMs);
  return () => clearInterval(id);
}
