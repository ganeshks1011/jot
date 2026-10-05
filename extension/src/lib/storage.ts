import { browser } from "wxt/browser";
import type { PersonalizationSnapshot } from "./personalization/types";
import { getAdapter, hydrateCustomProviders, isBuiltin } from "./providers";
import type {
  BackendConfig,
  ContextExample,
  CustomProviderMeta,
  PersonalizationContext,
  ProviderId,
  ThemeId,
} from "./types";

const SYNC_KEY = "jot:backend";
const LOCAL_KEY = "jot:apiKey"; // legacy single-key
const LOCAL_KEYS_MAP = "jot:apiKeys"; // per-provider map
const CUSTOM_PROVIDERS_KEY = "jot:customProviders";
const THEME_KEY = "jot:theme";
const CONTEXT_EXAMPLES_KEY = "jot:contextExamples";
const ONBOARDED_KEY = "jot:onboarded";

export const DEFAULT_BACKEND: BackendConfig = {
  provider: "jot-api",
  baseUrl: getAdapter("jot-api")!.defaultBaseUrl,
  model: getAdapter("jot-api")!.defaultModel,
};

async function ensureCustomProvidersHydrated(): Promise<void> {
  const stored = await browser.storage.sync.get(CUSTOM_PROVIDERS_KEY);
  const metas = stored[CUSTOM_PROVIDERS_KEY] as CustomProviderMeta[] | undefined;
  if (Array.isArray(metas)) hydrateCustomProviders(metas);
}

/** Non-secret backend config → chrome.storage.sync. */
export async function getBackendConfig(): Promise<BackendConfig> {
  await ensureCustomProvidersHydrated();
  const stored = await browser.storage.sync.get(SYNC_KEY);
  const cfg = (stored[SYNC_KEY] ?? null) as Partial<BackendConfig> | null;
  // One-time quiet migrations for retired provider ids (see Gemini precedent below):
  // "wurkflo" → "jot-api" (same backend, renamed); "deepseek" → "openai"
  // (DeepSeek remains usable via the OpenAI adapter with a custom base URL).
  let provider = cfg?.provider;
  let migrated = false;
  if (provider === "wurkflo") {
    provider = "jot-api";
    migrated = true;
  }
  if (provider === "deepseek") {
    provider = "openai";
    migrated = true;
    await migrateDeepSeekApiKey();
  }
  const adapter = (provider && getAdapter(provider)) || getAdapter("jot-api")!;
  if (!provider) provider = adapter.id;
  let model = cfg?.model?.trim() || adapter.defaultModel;
  // Strip the native `models/` prefix: the OpenAI-compatible Gemini endpoint
  // expects bare IDs (`gemini-...`). 2.5-flash-lite is recommended again, so
  // it is left in place.
  if (cfg?.provider === "gemini" && model.startsWith("models/")) {
    model = model.slice("models/".length);
    // Persist migration quietly (fire-and-forget)
    void browser.storage.sync.set({
      [SYNC_KEY]: {
        provider: cfg.provider,
        baseUrl: cfg.baseUrl?.trim() || adapter.defaultBaseUrl,
        model,
      },
    });
  }
  const resolved: BackendConfig = {
    provider,
    baseUrl: cfg?.baseUrl?.trim() || adapter.defaultBaseUrl,
    model,
  };
  if (migrated) {
    // Persist migration quietly (fire-and-forget)
    void browser.storage.sync.set({ [SYNC_KEY]: resolved });
  }
  return resolved;
}

/** Move a stored DeepSeek API key to the OpenAI entry (provider removed;
 *  DeepSeek now runs via the OpenAI adapter). Keeps an existing OpenAI key. */
async function migrateDeepSeekApiKey(): Promise<void> {
  const stored = await browser.storage.local.get([LOCAL_KEYS_MAP, LOCAL_KEY]);
  const map = { ...((stored[LOCAL_KEYS_MAP] as Record<string, string> | undefined) ?? {}) };
  if (typeof map.deepseek === "string" && map.deepseek) {
    if (!map.openai) map.openai = map.deepseek;
    delete map.deepseek;
    await browser.storage.local.set({ [LOCAL_KEYS_MAP]: map });
  }
}

export async function saveBackendConfig(cfg: BackendConfig): Promise<void> {
  await browser.storage.sync.set({ [SYNC_KEY]: cfg });
}

/** API key per provider → chrome.storage.local (never sync). */
export async function getApiKey(providerId?: string): Promise<string> {
  const targetProvider = providerId ?? (await getBackendConfig()).provider;
  const stored = await browser.storage.local.get([LOCAL_KEYS_MAP, LOCAL_KEY]);
  const map = stored[LOCAL_KEYS_MAP] as Record<string, string> | undefined;
  if (map && typeof map[targetProvider] === "string") return map[targetProvider];
  // legacy fallback: single key belongs to the active/legacy provider
  const legacy = stored[LOCAL_KEY] as string | undefined;
  if (legacy && targetProvider === DEFAULT_BACKEND.provider) return legacy;
  if (legacy && !map) {
    // if map not yet migrated, legacy key might be the only key. Return it for any provider that has no entry
    // to keep old installs working until they save per-provider
    const cfgProvider = (await browser.storage.sync.get(SYNC_KEY))[SYNC_KEY] as Partial<BackendConfig> | undefined;
    if (cfgProvider?.provider === targetProvider || !cfgProvider?.provider) return legacy;
  }
  return "";
}

export async function saveApiKey(apiKey: string, providerId?: string): Promise<void> {
  const targetProvider = providerId ?? (await getBackendConfig()).provider;
  const stored = await browser.storage.local.get([LOCAL_KEYS_MAP, LOCAL_KEY]);
  const map = { ...((stored[LOCAL_KEYS_MAP] as Record<string, string> | undefined) ?? {}) };
  if (!apiKey) delete map[targetProvider];
  else map[targetProvider] = apiKey;
  await browser.storage.local.set({ [LOCAL_KEYS_MAP]: map });
  // clear legacy single-key once migrated (don't keep two sources)
  if (stored[LOCAL_KEY] != null) await browser.storage.local.remove(LOCAL_KEY);
}

export async function getApiKeysMap(): Promise<Record<string, string>> {
  const stored = await browser.storage.local.get(LOCAL_KEYS_MAP);
  return (stored[LOCAL_KEYS_MAP] as Record<string, string> | undefined) ?? {};
}

// ---------------------------------------------------------------------------
// Custom providers (named registry, persisted in sync)
// ---------------------------------------------------------------------------

export async function getCustomProviders(): Promise<CustomProviderMeta[]> {
  await ensureCustomProvidersHydrated();
  const stored = await browser.storage.sync.get(CUSTOM_PROVIDERS_KEY);
  const raw = stored[CUSTOM_PROVIDERS_KEY] as CustomProviderMeta[] | undefined;
  if (!Array.isArray(raw)) return [];
  // ensure hydration is in sync
  hydrateCustomProviders(raw);
  return raw;
}

export async function saveCustomProviders(list: CustomProviderMeta[]): Promise<void> {
  const sanitized = list
    .filter((m) => m?.id && m.label && m.baseUrl && m.defaultModel)
    .map((m) => ({
      id: m.id.trim(),
      label: m.label.trim(),
      baseUrl: m.baseUrl.trim(),
      defaultModel: m.defaultModel.trim(),
      ...(m.apiKeyUrl?.trim() ? { apiKeyUrl: m.apiKeyUrl.trim() } : {}),
      ...(m.extraHeaders && Object.keys(m.extraHeaders).length ? { extraHeaders: m.extraHeaders } : {}),
    }));
  await browser.storage.sync.set({ [CUSTOM_PROVIDERS_KEY]: sanitized });
  hydrateCustomProviders(sanitized);
}

export async function upsertCustomProvider(meta: CustomProviderMeta): Promise<void> {
  const existing = await getCustomProviders();
  const idx = existing.findIndex((m) => m.id === meta.id);
  const next = [...existing];
  const sanitized: CustomProviderMeta = {
    id: meta.id.trim(),
    label: meta.label.trim(),
    baseUrl: meta.baseUrl.trim(),
    defaultModel: meta.defaultModel.trim(),
    ...(meta.apiKeyUrl?.trim() ? { apiKeyUrl: meta.apiKeyUrl.trim() } : {}),
    ...(meta.extraHeaders && Object.keys(meta.extraHeaders).length ? { extraHeaders: meta.extraHeaders } : {}),
  };
  if (idx >= 0) next[idx] = sanitized;
  else next.push(sanitized);
  await saveCustomProviders(next);
}

/**
 * Delete a custom provider and its stored API key. Built-in ids and
 * unknown ids throw so callers surface the failure instead of silently
 * falling back.
 */
export async function removeCustomProvider(id: string): Promise<void> {
  if (!id || isBuiltin(id)) throw new Error(`Cannot remove provider "${id}"`);
  const existing = await getCustomProviders();
  if (!existing.some((m) => m.id === id)) throw new Error(`Unknown provider "${id}"`);
  await saveCustomProviders(existing.filter((m) => m.id !== id));
  await saveApiKey("", id);
}

export async function getTheme(): Promise<ThemeId> {
  const stored = await browser.storage.sync.get(THEME_KEY);
  const raw = stored[THEME_KEY] as string | undefined;
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return "system";
}

export async function saveTheme(theme: ThemeId): Promise<void> {
  await browser.storage.sync.set({ [THEME_KEY]: theme });
}

export function watchTheme(cb: (theme: ThemeId) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== "sync" || !(THEME_KEY in changes)) return;
    const raw = changes[THEME_KEY].newValue as string | undefined;
    if (raw === "light" || raw === "dark" || raw === "system") cb(raw);
    else cb("system");
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

export async function getContextExamples(): Promise<ContextExample[]> {
  const stored = await browser.storage.sync.get(CONTEXT_EXAMPLES_KEY);
  const raw = stored[CONTEXT_EXAMPLES_KEY] as ContextExample[] | undefined;
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(["default", "email", "text", "social", "work"]);
  return raw
    .filter((e) => e?.context && allowed.has(e.context) && typeof e.text === "string")
    .map((e) => ({ context: e.context as PersonalizationContext, text: e.text }));
}

export async function saveContextExamples(list: ContextExample[]): Promise<void> {
  const allowed = new Set(["default", "email", "text", "social", "work"]);
  const map = new Map<string, string>();
  for (const item of list) {
    if (!item?.context || !allowed.has(item.context)) continue;
    const t = (item.text ?? "").trim();
    if (t) map.set(item.context, t);
    else map.delete(item.context);
  }
  const canonical: ContextExample[] = [...map.entries()].map(([context, text]) => ({
    context: context as PersonalizationContext,
    text,
  }));
  if (canonical.length === 0) await browser.storage.sync.remove(CONTEXT_EXAMPLES_KEY);
  else await browser.storage.sync.set({ [CONTEXT_EXAMPLES_KEY]: canonical });
}

export async function saveContextExample(ctx: PersonalizationContext, text: string): Promise<void> {
  const cur = await getContextExamples();
  const map = new Map(cur.map((e) => [e.context, e.text] as const));
  const trimmed = text.trim();
  if (trimmed) map.set(ctx, trimmed);
  else map.delete(ctx);
  const list: ContextExample[] = [...map.entries()].map(([context, ntext]) => ({ context, text: ntext }));
  await saveContextExamples(list);
}

const REDACTION_KEY = "jot:redactionEnabled";

/**
 * "Protect sensitive information": detect and replace sensitive values on
 * this device before text is sent to AI. Defaults to enabled; stored in
 * chrome.storage.sync (boolean flag only, never any sensitive content).
 */
export async function getRedactionEnabled(): Promise<boolean> {
  const stored = await browser.storage.sync.get(REDACTION_KEY);
  const raw = stored[REDACTION_KEY];
  return raw === undefined ? true : raw === true;
}

export async function saveRedactionEnabled(v: boolean): Promise<void> {
  await browser.storage.sync.set({ [REDACTION_KEY]: v });
}

const REDACT_NAMES_KEY = "jot:redactNamesEnabled";

/**
 * "Also redact person names": local NLP person-name detection layered under
 * the pattern detectors. Defaults to disabled (new behavior, larger
 * lazy-loaded parser); stored in chrome.storage.sync (boolean flag only).
 */
export async function getRedactNamesEnabled(): Promise<boolean> {
  const stored = await browser.storage.sync.get(REDACT_NAMES_KEY);
  return stored[REDACT_NAMES_KEY] === true;
}

export async function saveRedactNamesEnabled(v: boolean): Promise<void> {
  await browser.storage.sync.set({ [REDACT_NAMES_KEY]: v });
}

const ANALYTICS_KEY = "jot:analyticsEnabled";
const INSTALL_ID_KEY = "jot:installId";

/**
 * Anonymous usage-statistics opt-out. Defaults to enabled; stored in
 * chrome.storage.sync (boolean flag only). When disabled, track() emits
 * nothing. Not even lifecycle events.
 */
export async function getAnalyticsEnabled(): Promise<boolean> {
  const stored = await browser.storage.sync.get(ANALYTICS_KEY);
  const raw = stored[ANALYTICS_KEY];
  return raw === undefined ? true : raw === true;
}

export async function saveAnalyticsEnabled(v: boolean): Promise<void> {
  await browser.storage.sync.set({ [ANALYTICS_KEY]: v });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Anonymous per-install id for analytics (GA4 client_id). Random, local-only,
 * reset on reinstall. Never the Firebase UID, never email, never synced.
 */
export async function getInstallId(): Promise<string> {
  const stored = await browser.storage.local.get(INSTALL_ID_KEY);
  const raw = stored[INSTALL_ID_KEY];
  if (typeof raw === "string" && UUID_RE.test(raw)) return raw;
  const id = crypto.randomUUID();
  await browser.storage.local.set({ [INSTALL_ID_KEY]: id });
  return id;
}

export async function getOnboarded(): Promise<boolean> {
  const stored = await browser.storage.sync.get(ONBOARDED_KEY);
  return stored[ONBOARDED_KEY] === true;
}

export async function setOnboarded(v: boolean): Promise<void> {
  await browser.storage.sync.set({ [ONBOARDED_KEY]: v });
}

// ---------------------------------------------------------------------------
// Personalization snapshot (single key; see src/lib/personalization/store.ts
// for load/save/migration). Legacy split keys below stay readable so older
// data migrates losslessly.
// ---------------------------------------------------------------------------

const PERSONALIZATION_KEY = "jot:personalization";

/** Raw snapshot read; null when missing or malformed (triggers migration). */
export async function getPersonalizationSnapshot(): Promise<PersonalizationSnapshot | null> {
  const stored = await browser.storage.sync.get(PERSONALIZATION_KEY);
  const raw = stored[PERSONALIZATION_KEY] as PersonalizationSnapshot | undefined;
  if (!raw || typeof raw !== "object" || !raw.contexts || !Array.isArray(raw.domains)) {
    return null;
  }
  return raw;
}

export async function savePersonalizationSnapshot(snapshot: PersonalizationSnapshot): Promise<void> {
  await browser.storage.sync.set({ [PERSONALIZATION_KEY]: snapshot });
}

export type { ProviderId } from "./types";
