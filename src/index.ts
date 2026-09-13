export {
  applyLexicalRewrites,
  extractLexicalTextNodes,
  type LexicalTextNode,
  lexicalTextLength,
} from "./lexicalNodes";
export { normalizeRewriteOutput } from "./normalizeOutput";
export {
  buildCanonical,
  getDefaultInstruction,
  getDirectiveForLabel,
  hasDirective,
} from "./personalization/canonical";
export {
  BASE_PROMPT,
  buildFeedbackBlock,
  buildSystemPrompt,
  buildUserMessage,
  COMMON_PROMPT,
  PLACEHOLDER_GUARD,
} from "./personalization/prompts";
export { CONTEXT_ORDER } from "./personalization/resolve";
export { compileSliders, resolveInstruction } from "./personalization/resolve";
export {
  buildPersonaPrompt,
  type BuiltinSitePersona,
  findBuiltinPersona,
} from "./personalization/sitePersonas";
export { SLIDER_LEVELS, sliderLevelToDirective, sliderLevelToLabel } from "./personalization/sliders";
export type { SliderDimension, SliderLevel, SliderLevels } from "./personalization/sliders";
export type {
  ContextDomain,
  ContextStyle,
  PersonalizationContext,
  PersonalizationSnapshot,
  ResolvedOrigin,
  ResolvedStyle,
  TeachState,
} from "./personalization/types";
export { DETECTOR_TYPES, DETECTORS, detectMentionLabels } from "./redaction/detectors";
export { redact, redactAll, restorePlaceholders } from "./redaction/redact";
export type {
  DetectedSpan,
  Detector,
  RedactionResult,
  Replacement,
  RestoreResult,
  SensitiveDataType,
} from "./redaction/types";
