/**
 * Post-processing normalization for AI-generated rewrite output.
 *
 * Shared by the Wurkflo web backend (`app/core/routes/api.ai.rewrite.ts`)
 * and the Jot extension (`apps/jot/src/lib/api.ts`). Single source of
 * truth — do not duplicate this logic back into either app.
 *
 * The rewrite prompts prohibit typographic characters; models occasionally
 * emit them anyway. This pass normalizes exactly the prohibited characters
 * and nothing else - legitimate non-ASCII content (accents, CJK, emoji,
 * scripts) passes through untouched.
 *
 * Every target character is a single UTF-16 code unit, so this is safe to
 * apply per streamed delta (no multi-unit sequences can be split).
 */

const REPLACEMENTS: Array<[RegExp, string]> = [
  // em dash / en dash -> hyphen
  [/[\u2014\u2013]/g, "-"],
  // smart double quotes -> straight quotes
  [/[\u201C\u201D]/g, '"'],
  // smart single quotes / typographic apostrophes -> straight
  [/[\u2018\u2019]/g, "'"],
  // ellipsis glyph -> three dots
  [/\u2026/g, "..."],
  // decorative bullet -> hyphen
  [/\u2022/g, "-"],
  // non-breaking / narrow no-break spaces -> regular space
  [/[\u00A0\u202F]/g, " "],
  // zero-width characters (space, joiners, BOM) -> removed
  [/[\u200B\u200C\u200D\uFEFF]/g, ""],
];

export function normalizeRewriteOutput(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
