/**
 * Moved to `@wurkflo/shared` (shared by the extension and the web app).
 * Re-exported here so existing extension imports keep working.
 */
export { DETECTOR_TYPES, DETECTORS } from "@wurkflo/shared";
export { redact, redactAll, redactAllWithNames, restorePlaceholders } from "@wurkflo/shared";
export type {
  DetectedSpan,
  Detector,
  RedactionResult,
  Replacement,
  RestoreResult,
  SensitiveDataType,
} from "@wurkflo/shared";
