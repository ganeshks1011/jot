export {
  type InsertFailureMetrics,
  type InsertOutcome,
  type InsertVerdict,
  isRewriteError,
  type JotAssistantEvent,
  type JotHostAdapter,
  type JotTrackParams,
  type RewriteErrorKind,
  type RewriteErrorShape,
  type RewriteQuota,
  type RewriteRequest,
  type RewriteResult,
  type RewriteUpgrade,
  toRewriteError,
} from "./assistant/adapter";
export { buildKeyedHtml } from "./assistant/keyedHtml";
export { copyDomHtml, copyHtml, copyText, type ClipboardLike, type ContentNodeLike } from "./assistant/clipboard";
export { buildCacheKey, isCacheHit } from "./assistant/generation";
export { describeInsertMetrics, errorMessage } from "./assistant/errorText";
export { selectHelperText, zoneForTarget, type FocusZone, type HelperKind } from "./assistant/helperText";
export {
  JotAssistant,
  type JotAppearance,
  type JotSizeReporter,
  type JotSource,
} from "./assistant/JotAssistant";
export { useJotGeneration } from "./assistant/useJotGeneration";
export { ContentBox, type ContentStatus } from "./components/ContentBox";
export { FeedbackInput } from "./components/FeedbackInput";
export { JotCard } from "./components/JotCard";
export { StyleSliders } from "./components/StyleSliders";
export { ThemePicker } from "./components/ThemePicker";
export type { JotSettingsRepo, RedactionRepo, StyleLevelsRepo, ThemeRepo } from "./repos";
export {
  applyThemeTo,
  isThemeId,
  prefersDarkTheme,
  type ResolvedTheme,
  resolveTheme,
  type ThemeId,
} from "./theme";
export {
  JOT_ACCENT,
  JOT_ACCENT_FOREGROUND,
  JOT_BRAND_GRADIENT,
  JOT_BRAND_GRADIENT_DARK,
  JOT_CARD_SHADOW,
  JOT_FONT_JOT,
  JOT_FONT_SANS,
  JOT_RADIUS,
  JOT_REDACTION_STORAGE_KEY,
  JOT_STYLE_STORAGE_KEY,
  JOT_THEME_STORAGE_KEY,
} from "./tokens";
export { useTheme } from "./useTheme";
