import type { ProviderErrorKind } from "../providers/types";

/**
 * Closed analytics vocabulary. New events MUST be added here (and mirrored
 * in the backend allowlist). Never sent ad hoc. No event may carry user
 * content: only coarse metadata. See docs/PRIVACY.md.
 */
export const ANALYTICS_EVENTS = [
  "extension_installed",
  "extension_updated",
  "jot_opened",
  "shortcut_used",
  "context_menu_used",
  "rewrite_started",
  "rewrite_completed",
  "rewrite_failed",
  "rewrite_applied",
  "rewrite_copied",
  "refinement_started",
  "refinement_completed",
  "page_view",
  "extension_error",
  "onboarding_step_viewed",
  "onboarding_completed",
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

/** Known provider ids; custom slugs collapse to "custom" (user input). */
export type ProviderLabel = "jot-api" | "opencode" | "openai" | "anthropic" | "gemini" | "custom" | "unknown";

/** Onboarding funnel steps (0-4): welcome, provider, personalization, shortcut, done. */
export type OnboardingStepName = "welcome" | "provider" | "personalization" | "shortcut" | "done";

/** Coarse site labels only. Never raw hostnames (subdomains can identify). */
export type SiteLabel = "gmail" | "outlook" | "yahoo" | "slack" | "linkedin" | "x" | "facebook" | "reddit" | "other";

export type EditorType = "textarea" | "input" | "richtext" | "selection" | "unknown";

export type InvocationMethod = "shortcut" | "context_menu" | "action" | "unknown";

export type AnalyticsErrorType = ProviderErrorKind | "unknown";

export interface AnalyticsParams {
  site?: SiteLabel;
  editor_type?: EditorType;
  invocation_method?: InvocationMethod;
  success?: boolean;
  error_type?: AnalyticsErrorType;
  duration_ms?: number;
  confirmed?: boolean;
  /** page_view only: chrome-extension page title/location (no user content). */
  page_title?: string;
  page_location?: string;
  /** Active provider (allowlisted) and model (truncated config, not content). */
  provider?: ProviderLabel;
  model?: string;
  /** Onboarding funnel position. */
  step?: number;
  step_name?: OnboardingStepName;
}

export interface AnalyticsEnvelope {
  event: AnalyticsEventName;
  params: AnalyticsParams;
  /** Anonymous per-install id (NOT the user account). */
  installId: string;
  ts: number;
}
