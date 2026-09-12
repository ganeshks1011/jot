import { relayFetch } from "../net";
import type { BackendConfig } from "../types";
import { type ProviderAdapter, ProviderError } from "./types";

/** Models the UI refuses to save. Empty: 2.5-flash-lite is recommended again. */
const RETIRED_MODELS = new Set<string>([]);

export function isRetiredModel(id: string): boolean {
  return RETIRED_MODELS.has(id);
}

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

interface ChoicesBody {
  choices?: { message?: { content?: string } }[];
}

export interface OpenAIOptions {
  chatCompletionsPath?: string;
  modelsPath?: string;
  extraHeaders?: Record<string, string>;
  /** Override how auth headers are built. Return empty to omit auth (e.g. Ollama). */
  buildHeaders?: (apiKey: string) => Record<string, string>;
}

export class OpenAICompatibleProvider implements ProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly defaultBaseUrl: string;
  readonly defaultModel: string;
  readonly tiersEnforcedServerSide: boolean;
  readonly apiKeyUrl?: string;
  protected readonly opts: OpenAIOptions;

  constructor(
    id: string,
    label: string,
    defaultBaseUrl: string,
    defaultModel: string,
    tiersEnforcedServerSide = false,
    apiKeyUrl?: string,
    opts: OpenAIOptions = {},
  ) {
    this.id = id;
    this.label = label;
    this.defaultBaseUrl = defaultBaseUrl;
    this.defaultModel = defaultModel;
    this.tiersEnforcedServerSide = tiersEnforcedServerSide;
    this.apiKeyUrl = apiKeyUrl;
    this.opts = opts;
  }

  async rewrite(config: BackendConfig, apiKey: string, system: string, user: string): Promise<string> {
    if (!apiKey) throw new ProviderError("no-key", "No API key configured");
    if (!config.baseUrl) throw new ProviderError("network", "Base URL is not configured");

    const path = this.opts.chatCompletionsPath ?? "/chat/completions";
    const url = `${config.baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;

    const headers = this.buildHeaders(apiKey);

    // Thinking is provider-specific: disable it for OpenAI and Gemini
    // only. Other OpenAI-compatible endpoints (Anthropic, Ollama, customs)
    // and the Jot API must not receive these flags.
    const isGemini =
      config.provider === "gemini" || config.baseUrl.toLowerCase().includes("generativelanguage.googleapis.com");
    const isOpenAI = config.provider === "openai" || config.baseUrl.toLowerCase().includes("api.openai.com");
    const payload: Record<string, unknown> = {
      model: config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.7,
      max_tokens: 1024,
    };
    if (isGemini) {
      // Per https://ai.google.dev/gemini-api/docs/openai the endpoint
      // strictly validates fields (400s on top-level thinking/thought and
      // on thinking_summaries). Thinking-disable differs by generation:
      // - 2.5 (except Pro): reasoning_effort "none" disables thinking.
      // - 2.5 Pro / 3.x: reasoning cannot be turned off; suppress thought
      //   summaries instead. reasoning_effort and thinking_level/budget are
      //   mutually exclusive, so exactly one shape is ever sent.
      const isGemini25 = /gemini-2\.5/i.test(config.model) && !/pro/i.test(config.model);
      if (isGemini25) {
        payload.reasoning_effort = "none";
      } else {
        payload.extra_body = {
          google: { thinking_config: { include_thoughts: false } },
        };
      }
    }
    if (isOpenAI) {
      payload.reasoning_effort = "none";
    }

    let res: Awaited<ReturnType<typeof relayFetch>>;
    try {
      res = await relayFetch({
        url,
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch {
      throw new ProviderError("network", "Could not reach the model server");
    }

    if (res.status === 401 || res.status === 403) {
      const parsed = (() => {
        try {
          return JSON.parse(res.text) as { error?: { message?: string } };
        } catch {
          return null;
        }
      })();
      const message = parsed?.error?.message || (res.text.trim() && res.text.trim().slice(0, 500)) || "";
      throw new ProviderError("auth", message ? `Auth error: ${message}` : "Invalid API key");
    }
    if (res.status === 429) {
      throw new ProviderError("rate-limit", "Rate limited - try again in a moment");
    }
    if (!res.ok) {
      const parsed = (() => {
        try {
          return JSON.parse(res.text) as { error?: { message?: string } };
        } catch {
          return null;
        }
      })();
      const message = parsed?.error?.message || res.text.trim();
      if (message) throw new ProviderError("network", message.slice(0, 500));
      throw new ProviderError("network", `Model request failed (${res.status})`);
    }

    const data = safeJsonParse<ChoicesBody>(res.text);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new ProviderError("empty", "Empty model response");
    }
    return content.trim();
  }

  async listModels(config: BackendConfig, apiKey: string): Promise<string[]> {
    if (!apiKey) throw new ProviderError("no-key", "No API key configured");
    const path = this.opts.modelsPath ?? "/models";
    const url = `${config.baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;

    const headers = this.buildHeaders(apiKey);
    // listModels is GET; remove content-type if present from rewrite headers
    const listHeaders: Record<string, string> = { ...headers };
    // For list we only need auth headers; strip content-type if set.
    if (!this.opts.buildHeaders) {
      // default rewrite adds content-type; for GET it's unnecessary but harmless.
      // Keep as-is for compatibility.
    }

    let res: Awaited<ReturnType<typeof relayFetch>>;
    try {
      res = await relayFetch({ url, headers: listHeaders });
    } catch {
      throw new ProviderError("network", "Could not reach the model server");
    }
    if (!res.ok) {
      const parsed = (() => {
        try {
          return JSON.parse(res.text) as { error?: { message?: string } };
        } catch {
          return null;
        }
      })();
      const message = parsed?.error?.message || res.text.trim();
      if (message) throw new ProviderError("network", message.slice(0, 500));
      throw new ProviderError("network", `Could not load models (${res.status})`);
    }

    const raw = safeJsonParse<unknown>(res.text);
    const models = new Set<string>();
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const id = typeof item === "string" ? item : (item as { id?: unknown })?.id;
        if (typeof id === "string") models.add(id);
      }
    } else if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      if (Array.isArray(obj.data)) {
        for (const item of obj.data as unknown[]) {
          const id = typeof item === "string" ? item : (item as { id?: unknown })?.id;
          if (typeof id === "string") models.add(id);
        }
      } else {
        for (const key of Object.keys(obj)) {
          if (key !== "object" && key !== "data") models.add(key);
        }
      }
    }
    return [...models].filter((id) => !isRetiredModel(id));
  }

  protected buildHeaders(apiKey: string): Record<string, string> {
    if (this.opts.buildHeaders) {
      const custom = this.opts.buildHeaders(apiKey);
      const merged: Record<string, string> = { ...custom };
      if (this.opts.extraHeaders) {
        for (const [k, v] of Object.entries(this.opts.extraHeaders)) merged[k] = v;
      }
      // Ensure Content-Type for POST callers that don't override it
      if (!merged["Content-Type"]) merged["Content-Type"] = "application/json";
      return merged;
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
    if (this.opts.extraHeaders) {
      for (const [k, v] of Object.entries(this.opts.extraHeaders)) headers[k] = v;
    }
    return headers;
  }
}

export function createOpenAIProvider(opts: {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  apiKeyUrl?: string;
  extraHeaders?: Record<string, string>;
  chatCompletionsPath?: string;
  modelsPath?: string;
  buildHeaders?: (apiKey: string) => Record<string, string>;
  tiersEnforcedServerSide?: boolean;
}): ProviderAdapter {
  return new OpenAICompatibleProvider(
    opts.id,
    opts.label,
    opts.baseUrl,
    opts.model,
    opts.tiersEnforcedServerSide ?? false,
    opts.apiKeyUrl,
    {
      extraHeaders: opts.extraHeaders,
      chatCompletionsPath: opts.chatCompletionsPath,
      modelsPath: opts.modelsPath,
      buildHeaders: opts.buildHeaders,
    },
  );
}

/**
 * Jot rewrite API (Wurkflo backend). Non-OpenAI, streaming SSE path lives
 * in api.ts. Exists for settings metadata only.
 */
export class JotApiProvider implements ProviderAdapter {
  readonly id = "jot-api";
  readonly label = "Jot rewrite API";
  readonly defaultBaseUrl = "https://wurkflo.app";
  readonly defaultModel = "deepseek-chat";
  readonly tiersEnforcedServerSide = true;
  readonly apiKeyUrl = "https://wurkflo.app";

  async rewrite(): Promise<string> {
    throw new ProviderError("network", "Jot rewrite API requests are routed through its streaming API");
  }

  async listModels(): Promise<string[]> {
    return ["deepseek-chat"];
  }
}
