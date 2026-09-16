/** Pure cache-key builder. Source + followUp + site (+ HTML when present, + prior output when tweaking). */
export function buildCacheKey(
  text: string,
  followUp: string | undefined,
  site: string | undefined,
  html?: string | null,
  priorOutput?: string | null,
): string {
  const base = `${text}||${followUp ?? ""}||${site ?? ""}`;
  const withHtml = html ? `${base}||${html}` : base;
  // Appended only when present so existing keys stay byte-stable; a tweak
  // against a different prior output must never reuse a cached rewrite.
  return priorOutput ? `${withHtml}||${priorOutput}` : withHtml;
}

/** Should the cached output be reused for this key? */
export function isCacheHit(cacheKey: string, currentKey: string, cached: string | undefined): boolean {
  return cacheKey === currentKey && !!cached;
}
