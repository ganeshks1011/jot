import type { DetectedSpan } from "./types";

/**
 * Optional local person-name detection via compromise (NLP, no network).
 * Loaded lazily so the ~365KB minified parser never enters the initial
 * bundle: importers must await `ensureNamesLoaded()` (or just call
 * `detectNameSpans`, which loads on first use) before redacting.
 *
 * Conservative by design: trailing punctuation is trimmed ("Alice," →
 * "Alice"), single letters are dropped, and every span is verified against
 * the source slice to guard against offset drift. Callers should rank name
 * spans below every pattern detector (see `redactAllWithNames`).
 */

type OffsetMatch = { text?: unknown; offset?: { start?: unknown; length?: unknown } };

type NlpDoc = {
  people: () => { out: (format: "offsets") => OffsetMatch[] };
};

type NlpLib = (text: string) => NlpDoc;

let cached: NlpLib | null = null;
let attempted = false;

export async function ensureNamesLoaded(): Promise<boolean> {
  if (cached) return true;
  if (attempted) return cached !== null;
  attempted = true;
  try {
    const mod = (await import("compromise")) as { default?: unknown };
    const lib = mod.default ?? mod;
    if (typeof lib !== "function") return false;
    cached = lib as NlpLib;
    return true;
  } catch {
    return false;
  }
}

/** Test hook: forget the cached instance so load-failure paths are testable. */
export function resetNamesForTests(): void {
  cached = null;
  attempted = false;
}

const TRAILING_PUNCT = /[.,;:!?'"*)}\]>]+$/;

export async function detectNameSpans(text: string): Promise<DetectedSpan[]> {
  if (!text || !(await ensureNamesLoaded()) || !cached) return [];
  let matches: OffsetMatch[];
  try {
    matches = cached(text).people().out("offsets");
  } catch {
    return [];
  }
  if (!Array.isArray(matches)) return [];
  const out: DetectedSpan[] = [];
  for (const m of matches) {
    const raw = typeof m.text === "string" ? m.text : "";
    const value = raw.replace(TRAILING_PUNCT, "");
    if (value.length < 2) continue;
    const start = typeof m.offset?.start === "number" ? m.offset.start : -1;
    if (start < 0 || start + raw.length > text.length) continue;
    if (text.slice(start, start + raw.length) !== raw) continue;
    out.push({ start, end: start + value.length, value });
  }
  return out;
}
