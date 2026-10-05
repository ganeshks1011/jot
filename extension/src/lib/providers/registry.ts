import { isLoopbackUrl } from "../net";
import type { CustomProviderMeta } from "../types";
import { AnthropicProvider } from "./anthropic";
import { JotApiProvider, OpenAICompatibleProvider } from "./openai";
import type { ProviderAdapter } from "./types";

export const OPENCODE_ADAPTER = new OpenAICompatibleProvider(
  "opencode",
  "OpenCode Go",
  "https://opencode.ai/zen/v1",
  "deepseek-v4-flash",
  false,
  "https://opencode.ai/auth",
);

export const OPENAI_ADAPTER = new OpenAICompatibleProvider(
  "openai",
  "OpenAI",
  "https://api.openai.com/v1",
  "gpt-4o-mini",
  false,
  "https://platform.openai.com/api-keys",
);

/** Claude via Anthropic's native Messages API (`x-api-key` + versioned headers). */
export const ANTHROPIC_ADAPTER = new AnthropicProvider();

/** Google via its OpenAI-compatible endpoint (Bearer `AIza...`).
 *  Model IDs are bare (`gemini-...`): the OpenAI-compatible endpoint 400s
 *  on the native `models/` prefix. */
export const GEMINI_ADAPTER = new OpenAICompatibleProvider(
  "gemini",
  "Gemini",
  "https://generativelanguage.googleapis.com/v1beta/openai",
  "gemini-3.5-flash-lite",
  false,
  "https://aistudio.google.com/apikey",
);

/** xAI via its OpenAI-compatible endpoint (Bearer `xai-...`). */
export const GROK_ADAPTER = new OpenAICompatibleProvider(
  "grok",
  "Grok",
  "https://api.x.ai/v1",
  "grok-4.3",
  false,
  "https://console.x.ai",
);

/** Local models via Ollama (keyless; `ollama serve` + `ollama pull <model>`). */
export const OLLAMA_ADAPTER = new OpenAICompatibleProvider(
  "ollama",
  "Ollama",
  "http://localhost:11434/v1",
  "qwen2.5",
  false,
);

/** Curated model picks shown as "Recommended" chips in settings UIs.
 *  Keyed by adapter id; unknown/custom providers get no recommendations. */
export const RECOMMENDED_MODELS: Record<string, string[]> = {
  "jot-api": [],
  opencode: ["deepseek-v4-flash"],
  openai: ["gpt-4o-mini"],
  anthropic: ["claude-haiku-4-5"],
  gemini: ["gemini-3.5-flash-lite"],
  grok: ["grok-4.3"],
  ollama: ["qwen2.5"],
};

export function getRecommendedModels(id: string): string[] {
  return RECOMMENDED_MODELS[id] ?? [];
}

/**
 * True for local model servers: the Ollama builtin or any loopback base URL
 * (covers LM Studio and loopback customs). Local providers need no API key
 * and keep requests on the user's machine.
 */
export function isLocalProvider(provider: string, baseUrl: string): boolean {
  if (provider === "ollama") return true;
  return isLoopbackUrl(baseUrl);
}

export const JOT_API_ADAPTER = new JotApiProvider();

const BUILTINS: ProviderAdapter[] = [
  JOT_API_ADAPTER,
  OPENCODE_ADAPTER,
  OPENAI_ADAPTER,
  ANTHROPIC_ADAPTER,
  GEMINI_ADAPTER,
  GROK_ADAPTER,
  OLLAMA_ADAPTER,
];

/** Selectable base-URL presets for the OpenAI adapter (all OpenAI-compatible).
 *  Tapping a preset sets the base URL only; models come from Load models. */
export interface EndpointPreset {
  label: string;
  baseUrl: string;
}

export const OPENAI_ENDPOINT_PRESETS: EndpointPreset[] = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { label: "Ollama (local)", baseUrl: "http://localhost:11434/v1" },
  { label: "LM Studio (local)", baseUrl: "http://localhost:1234/v1" },
];

const BUILTIN_IDS = new Set(BUILTINS.map((a) => a.id));

/** In-memory custom registry. Hydrated from storage via hydrateCustomProviders(). */
const CUSTOMS = new Map<string, ProviderAdapter>();

function metaToAdapter(meta: CustomProviderMeta): ProviderAdapter {
  return new OpenAICompatibleProvider(meta.id, meta.label, meta.baseUrl, meta.defaultModel, false, meta.apiKeyUrl, {
    extraHeaders: meta.extraHeaders,
  });
}

export function slugify(label: string): string {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base || "custom";
}

export function getNextSlug(base: string): string {
  if (!BUILTIN_IDS.has(base) && !CUSTOMS.has(base)) return base;
  let i = 2;
  while (BUILTIN_IDS.has(`${base}-${i}`) || CUSTOMS.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

export function isBuiltin(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

export function getAdapter(id: string): ProviderAdapter | undefined {
  return CUSTOMS.get(id) ?? BUILTINS.find((b) => b.id === id);
}

export function getAllAdapters(): ProviderAdapter[] {
  return [...BUILTINS, ...CUSTOMS.values()];
}

export function getBuiltinAdapters(): ProviderAdapter[] {
  return [...BUILTINS];
}

export function getCustomAdapters(): ProviderAdapter[] {
  return [...CUSTOMS.values()];
}

/**
 * Register a provider at runtime. If `persist` is true the caller is
 * responsible for persisting via storage (upsertCustomProvider).
 * Built-in ids cannot be overwritten.
 */
export function registerProvider(adapter: ProviderAdapter): void {
  if (isBuiltin(adapter.id)) {
    throw new Error(`Cannot overwrite built-in provider "${adapter.id}"`);
  }
  CUSTOMS.set(adapter.id, adapter);
}

/** Hydrate CUSTOMS from a list of metas (e.g. loaded from chrome.storage). */
export function hydrateCustomProviders(metas: CustomProviderMeta[]): void {
  CUSTOMS.clear();
  for (const meta of metas) {
    if (!meta?.id || !meta.label || !meta.baseUrl || !meta.defaultModel) continue;
    // Don't allow shadowing builtins even if storage was corrupted
    if (isBuiltin(meta.id)) continue;
    CUSTOMS.set(meta.id, metaToAdapter(meta));
  }
}

/** Build metas from current CUSTOMS. For persistence. */
export function getCustomMetas(): CustomProviderMeta[] {
  const list: CustomProviderMeta[] = [];
  for (const adapter of CUSTOMS.values()) {
    // Recover extraHeaders from the adapter if it's an OpenAICompatibleProvider
    const extraHeaders =
      adapter instanceof OpenAICompatibleProvider
        ? (adapter as unknown as { opts?: { extraHeaders?: Record<string, string> } }).opts?.extraHeaders
        : undefined;
    list.push({
      id: adapter.id,
      label: adapter.label,
      baseUrl: adapter.defaultBaseUrl,
      defaultModel: adapter.defaultModel,
      apiKeyUrl: adapter.apiKeyUrl,
      ...(extraHeaders ? { extraHeaders } : {}),
    });
  }
  return list;
}

/**
 * Legacy compat: object shaped like the old ADAPTERS Record.
 * Prefer getAdapter()/getAllAdapters() in new code.
 */
export const ADAPTERS: Record<string, ProviderAdapter> = new Proxy({} as Record<string, ProviderAdapter>, {
  get(_target, prop: string) {
    if (typeof prop === "string") return getAdapter(prop);
    return undefined;
  },
  ownKeys() {
    return getAllAdapters().map((a) => a.id);
  },
  getOwnPropertyDescriptor(_target, prop: string) {
    const adapter = getAdapter(prop);
    if (!adapter) return undefined;
    return { configurable: true, enumerable: true, value: adapter, writable: true };
  },
  has(_target, prop: string) {
    return !!getAdapter(prop);
  },
});
