export type BuiltinProviderId = "jot-api" | "opencode" | "openai" | "anthropic" | "gemini" | "grok";

export type ProviderId = BuiltinProviderId | (string & {});

/** Non-secret backend settings (stored in chrome.storage.sync). */
export interface BackendConfig {
  provider: ProviderId;
  baseUrl: string;
  model: string;
}

export interface CustomProviderMeta {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  apiKeyUrl?: string;
  extraHeaders?: Record<string, string>;
}

/** Per-website prompt override. `pattern` is a hostname/URL pattern. */
export interface SitePrompts {
  pattern: string;
  prompt: string;
}

export type ThemeId = "system" | "light" | "dark";

export type PersonalizationContext = "default" | "email" | "text" | "social" | "work";

export interface ContextPersonalization {
  context: PersonalizationContext;
  prompt: string;
}

export interface ContextDomain {
  context: Exclude<PersonalizationContext, "default">;
  pattern: string;
}

export interface ContextExample {
  context: PersonalizationContext;
  text: string;
}
