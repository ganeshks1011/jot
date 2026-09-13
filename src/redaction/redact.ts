import { DETECTORS } from "./detectors";
import type { DetectedSpan, RedactionResult, Replacement, RestoreResult, SensitiveDataType } from "./types";

const PLACEHOLDER_PREFIX: Record<SensitiveDataType, string> = {
  email: "EMAIL",
  phone: "PHONE",
  card: "CARD",
  ssn: "SSN",
  url: "URL",
  ip: "IP",
  secret: "SECRET",
  uuid: "UUID",
  mention: "MENTION",
};

const PLACEHOLDER_PATTERN = /\[([A-Z]+)_(\d+)\]/g;

interface RedactionState {
  counters: Record<SensitiveDataType, number>;
  seen: Map<string, string>;
}

function freshState(): RedactionState {
  return {
    counters: {
      email: 0,
      phone: 0,
      card: 0,
      ssn: 0,
      url: 0,
      ip: 0,
      secret: 0,
      uuid: 0,
      mention: 0,
    },
    seen: new Map(),
  };
}

function overlaps(a: DetectedSpan, b: DetectedSpan): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Collect detector spans in priority order, dropping overlaps. */
function collectSpans(text: string): Array<DetectedSpan & { type: SensitiveDataType }> {
  const accepted: Array<DetectedSpan & { type: SensitiveDataType }> = [];
  for (const detector of DETECTORS) {
    for (const s of detector.detect(text)) {
      if (s.end <= s.start) continue;
      if (accepted.some((a) => overlaps(a, s))) continue;
      accepted.push({ ...s, type: detector.type });
    }
  }
  accepted.sort((a, b) => a.start - b.start);
  return accepted;
}

function redactWithState(text: string, state: RedactionState): RedactionResult {
  const spans = collectSpans(text);
  const replacements: Replacement[] = [];
  let out = "";
  let cursor = 0;
  for (const s of spans) {
    const original = text.slice(s.start, s.end);
    const seenKey = `${s.type}::${original}`;
    let placeholder = state.seen.get(seenKey);
    if (!placeholder) {
      state.counters[s.type] += 1;
      placeholder = `[${PLACEHOLDER_PREFIX[s.type]}_${state.counters[s.type]}]`;
      state.seen.set(seenKey, placeholder);
      replacements.push({ placeholder, original, type: s.type });
    } else if (!replacements.some((r) => r.placeholder === placeholder)) {
      replacements.push({ placeholder, original, type: s.type });
    }
    out += text.slice(cursor, s.start) + placeholder;
    cursor = s.end;
  }
  out += text.slice(cursor);
  return { text: out, replacements };
}

/**
 * Replace sensitive values with typed placeholders (`[EMAIL_1]`, ...).
 * Deterministic within one call; identical values share a placeholder.
 */
export function redact(text: string): RedactionResult {
  return redactWithState(text, freshState());
}

/**
 * Redact several texts with shared numbering, so placeholders stay unique
 * across a single rewrite operation (e.g. source + follow-up tweak share
 * one mapping and one restore step).
 */
export function redactAll(texts: string[]): { texts: string[]; replacements: Replacement[] } {
  const state = freshState();
  const results = texts.map((t) => redactWithState(t, state));
  const replacements: Replacement[] = [];
  const seenPlaceholders = new Set<string>();
  for (const r of results) {
    for (const rep of r.replacements) {
      if (!seenPlaceholders.has(rep.placeholder)) {
        seenPlaceholders.add(rep.placeholder);
        replacements.push(rep);
      }
    }
  }
  return { texts: results.map((r) => r.text), replacements };
}

function presentPlaceholders(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER_PATTERN)) {
    if (m[0]) out.add(m[0]);
  }
  return out;
}

/**
 * Restore placeholders after the model responds. Only exact placeholder
 * matches are restored: missing, renamed, recased, or invented placeholders
 * are reported and left untouched. Never guess where a secret belongs.
 */
export function restorePlaceholders(rewritten: string, replacements: Replacement[]): RestoreResult {
  const expected = new Map(replacements.map((r) => [r.placeholder, r.original]));
  const present = presentPlaceholders(rewritten);
  const missing = [...expected.keys()].filter((p) => !present.has(p));
  const unexpected = [...present].filter((p) => !expected.has(p));
  let text = rewritten;
  for (const [placeholder, original] of expected) {
    if (!present.has(placeholder)) continue;
    text = text.split(placeholder).join(original);
  }
  return { text, complete: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}
