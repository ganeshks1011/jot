import { browser } from "wxt/browser";
import { getAnalyticsEnabled, getInstallId } from "../storage";
import type {
  AnalyticsErrorType,
  EditorType,
  InvocationMethod,
  OnboardingStepName,
  ProviderLabel,
  SiteLabel,
} from "./types";
import { ANALYTICS_EVENTS, type AnalyticsEventName, type AnalyticsParams } from "./types";

export { type ProviderMeta, resolveProviderMeta } from "./provider";
export { DEFAULT_ENGAGEMENT_TIME_MSEC, getOrCreateSessionId } from "./session";
export { editorTypeFor, siteLabelFor } from "./site";
export { ANALYTICS_EVENTS } from "./types";
export type {
  AnalyticsErrorType,
  AnalyticsEventName,
  AnalyticsParams,
  EditorType,
  InvocationMethod,
  OnboardingStepName,
  ProviderLabel,
  SiteLabel,
};

const MAX_STRING = 128;

function isSiteLabel(v: unknown): v is SiteLabel {
  return (
    typeof v === "string" &&
    ["gmail", "outlook", "yahoo", "slack", "linkedin", "x", "facebook", "reddit", "other"].includes(v)
  );
}

function isEditorType(v: unknown): v is EditorType {
  return typeof v === "string" && ["textarea", "input", "richtext", "selection", "unknown"].includes(v);
}

function isInvocationMethod(v: unknown): v is InvocationMethod {
  return typeof v === "string" && ["shortcut", "context_menu", "action", "unknown"].includes(v);
}

function isErrorType(v: unknown): v is AnalyticsErrorType {
  return typeof v === "string" && ["no-key", "auth", "rate-limit", "network", "empty", "quota", "unknown"].includes(v);
}

const KNOWN_PROVIDERS: ProviderLabel[] = ["jot-api", "opencode", "openai", "anthropic", "gemini", "grok", "ollama"];

function isProviderLabel(v: unknown): v is ProviderLabel {
  return typeof v === "string" && (KNOWN_PROVIDERS as string[]).includes(v);
}

const STEP_NAMES: OnboardingStepName[] = ["welcome", "provider", "personalization", "shortcut", "done"];

function isStepName(v: unknown): v is OnboardingStepName {
  return typeof v === "string" && (STEP_NAMES as string[]).includes(v);
}

/**
 * Defense-in-depth allowlist: only known scalar fields survive, strings are
 * truncated, and anything else is dropped. The type system is the first
 * gate; this is the runtime gate for plain-JS callers and message passing.
 */
export function sanitizeParams(params?: AnalyticsParams | null): AnalyticsParams {
  if (!params || typeof params !== "object") return {};
  const out: AnalyticsParams = {};
  if (isSiteLabel(params.site)) out.site = params.site;
  if (isEditorType(params.editor_type)) out.editor_type = params.editor_type;
  if (isInvocationMethod(params.invocation_method)) out.invocation_method = params.invocation_method;
  if (typeof params.success === "boolean") out.success = params.success;
  if (isErrorType(params.error_type)) out.error_type = params.error_type;
  if (typeof params.duration_ms === "number" && Number.isFinite(params.duration_ms)) {
    out.duration_ms = Math.max(0, Math.min(3_600_000, Math.round(params.duration_ms)));
  }
  if (typeof params.confirmed === "boolean") out.confirmed = params.confirmed;
  if (typeof params.page_title === "string" && params.page_title.trim()) {
    out.page_title = params.page_title.trim().slice(0, MAX_STRING);
  }
  if (typeof params.page_location === "string" && params.page_location.trim()) {
    out.page_location = params.page_location.trim().slice(0, MAX_STRING);
  }
  if (typeof params.provider === "string" && params.provider.trim()) {
    out.provider = isProviderLabel(params.provider) ? params.provider : "custom";
  }
  // Model names are user-controlled free text (custom provider field); only
  // report them for known built-in providers so a pasted secret can't ride
  // along to analytics.
  if (out.provider && out.provider !== "custom" && typeof params.model === "string" && params.model.trim()) {
    out.model = params.model.trim().slice(0, MAX_STRING);
  }
  if (typeof params.step === "number" && Number.isInteger(params.step) && params.step >= 0 && params.step <= 10) {
    out.step = params.step;
  }
  if (isStepName(params.step_name)) out.step_name = params.step_name;
  return out;
}

export function isAnalyticsEvent(value: unknown): value is AnalyticsEventName {
  return typeof value === "string" && (ANALYTICS_EVENTS as readonly string[]).includes(value);
}

/**
 * Fire-and-forget usage event. Gated on the opt-out setting; resolves to the
 * background service worker, which proxies to the backend (the GA4 secret
 * never touches client code). Never throws, never blocks the caller.
 */
export async function track(event: AnalyticsEventName, params?: AnalyticsParams): Promise<void> {
  try {
    if (!isAnalyticsEvent(event)) return;
    if (!(await getAnalyticsEnabled())) return;
    const installId = await getInstallId();
    await browser.runtime.sendMessage({
      type: "jot:analytics",
      event,
      params: sanitizeParams(params),
      installId,
      ts: Date.now(),
    });
  } catch {
    // Analytics must never break user flows.
  }
}
