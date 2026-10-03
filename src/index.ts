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
  buildPriorOutputBlock,
  buildSystemPrompt,
  buildUserMessage,
  COMMON_PROMPT,
  PLACEHOLDER_GUARD,
} from "./personalization/prompts";
export { CONTEXT_ORDER, compileSliders, resolveInstruction } from "./personalization/resolve";
export {
  type BuiltinSitePersona,
  buildPersonaPrompt,
  findBuiltinPersona,
} from "./personalization/sitePersonas";
export type { SliderDimension, SliderLevel, SliderLevels } from "./personalization/sliders";
export { SLIDER_LEVELS, sliderLevelToDirective, sliderLevelToLabel } from "./personalization/sliders";
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
export { detectNameSpans, ensureNamesLoaded, resetNamesForTests } from "./redaction/names";
export { redact, redactAll, redactAllWithNames, restorePlaceholders } from "./redaction/redact";
export type {
  DetectedSpan,
  Detector,
  RedactionResult,
  Replacement,
  RestoreResult,
  SensitiveDataType,
} from "./redaction/types";
export type {
  Observation,
  ObservationType,
  ResearchFinding,
  ResearchObjective,
  ResearchPlan,
  ResearchQuery,
  ResearchReport,
  ResearchSource,
  ResearchSourceType,
  ResearchStep,
  ResearchStepType,
} from "./research";
export {
  groupObservationsByTag,
  isObservationType,
  isResearchSourceType,
  validateObservationText,
  validateResearchQuestion,
} from "./research";
