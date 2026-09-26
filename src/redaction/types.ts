/**
 * Client-side sensitive-data redaction (privacy layer, not a security
 * boundary). Detection is deterministic pattern matching. It minimizes
 * accidental transmission of obvious secrets but cannot guarantee every
 * sensitive value is caught. Real-name NER is NOT attempted; only explicit
 * `@mention` handles are detected (the Detector interface allows adding a
 * local NER detector later).
 *
 * The replacement mapping must stay in ephemeral memory for the duration of
 * one rewrite and never leave the browser: never in API payloads, prompts,
 * logs, analytics, error reports, or persisted storage.
 */

export type SensitiveDataType =
  | "email"
  | "phone"
  | "card"
  | "ssn"
  | "url"
  | "ip"
  | "secret"
  | "uuid"
  | "mention"
  | "iban"
  | "passport"
  | "name";

export interface Replacement {
  placeholder: string;
  original: string;
  type: SensitiveDataType;
}

export interface RedactionResult {
  text: string;
  replacements: Replacement[];
}

export interface RestoreResult {
  /** Rewritten text with every exactly-matched placeholder restored. */
  text: string;
  /** True when every expected placeholder was present and none unexpected. */
  complete: boolean;
  /** Expected placeholders absent from the model output (left unrestored). */
  missing: string[];
  /** Placeholders in the output with no mapping (left untouched). */
  unexpected: string[];
}

/** A matched span of sensitive text. `value` is the exact matched slice. */
export interface DetectedSpan {
  start: number;
  end: number;
  value: string;
}

/**
 * One detector for a single sensitive-data type. Detectors run in registry
 * order; earlier detectors win overlapping spans. Add new detectors here.
 * No other code changes needed.
 */
export interface Detector {
  type: SensitiveDataType;
  detect(text: string): DetectedSpan[];
}
