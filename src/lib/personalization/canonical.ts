/**
 * Canonicalizes a personalization by merging a base instruction
 * with an adjustment. Used for freeform Teach input; slider positions are
 * stored separately and compiled at rewrite time (see resolve.ts).
 *
 * The function is additive: applying "Less direct" after "More professional"
 * keeps both directives without duplication.
 */

const DIRECTIVES: Record<string, string> = {
  "more natural":
    "Write in a natural, conversational tone. Use everyday language, contractions, and a personable touch. Avoid over-polished or corporate phrasing.",
  "more professional":
    "Write in a polished, professional, and precise tone appropriate for workplace communication. Keep it clear and concise without being overly formal or buzzwordy.",
  "less direct":
    "Soften directness slightly. Prefer gentle phrasing and light hedging where appropriate, without being vague.",
  shorter: "Prefer concise, shorter outputs. Remove filler and keep to the essential point while preserving meaning.",
};

const DEFAULT_INSTRUCTION =
  "Write clearly, naturally, and concisely. Preserve the user's meaning and intent. Avoid unnecessary formality and corporate language.";

export function getDefaultInstruction(): string {
  return DEFAULT_INSTRUCTION;
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

function contains(hay: string, needle: string): boolean {
  return normalize(hay).includes(normalize(needle).slice(0, 24));
}

/** True when the directive text is already present (dedup rule shared with buildCanonical). */
export function hasDirective(text: string, directive: string): boolean {
  return contains(text, directive);
}

export function buildCanonical(current: string, adjustment: string): string {
  const trimAdj = adjustment.trim();
  if (!trimAdj) return (current.trim() || DEFAULT_INSTRUCTION).trim();

  const key = trimAdj.toLowerCase();
  const directive = DIRECTIVES[key];

  // Freeform (no preset mapping). Treat as directive, dedup by prefix.
  const toAdd = directive ?? trimAdj;
  const base = (current.trim() || DEFAULT_INSTRUCTION).trim();

  if (contains(base, toAdd)) return base;

  // Keep short canonical: base + newline + directive
  return `${base}\n\n${toAdd}`.trim();
}

export function getDirectiveForLabel(label: string): string | null {
  return DIRECTIVES[label.trim().toLowerCase()] ?? null;
}
