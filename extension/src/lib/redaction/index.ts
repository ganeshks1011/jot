/**
 * Moved to `@wurkflo/shared` (shared by the extension and the web app).
 * Re-exported here so existing extension imports keep working.
 */

export type {
  DetectedSpan,
  Detector,
  RedactionResult,
  Replacement,
  RestoreResult,
  SensitiveDataType,
} from "@wurkflo/shared";
export { DETECTOR_TYPES, DETECTORS, redact, redactAll, redactAllWithNames, restorePlaceholders } from "@wurkflo/shared";
