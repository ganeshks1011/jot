/** Pure cache-key builder. Source + followUp + site (+ HTML when present). */
export function buildCacheKey(
  text: string,
  followUp: string | undefined,
  site: string | undefined,
  html?: string | null,
): string {
  const base = `${text}||${followUp ?? ""}||${site ?? ""}`;
  return html ? `${base}||${html}` : base;
}

/** Should the cached output be reused for this key? */
export function isCacheHit(cacheKey: string, currentKey: string, cached: string | undefined): boolean {
  return cacheKey === currentKey && !!cached;
}
