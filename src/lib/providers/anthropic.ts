import { type RelayHttpResponse, relayFetch } from "../net";
import { isTransientRelayError } from "../transientErrors";
import type { BackendConfig } from "../types";
import { isRetiredModel } from "./openai";
import { type ProviderAdapter, ProviderError } from "./types";

/** Pinned Messages API version per https://docs.anthropic.com/en/api/versioning. */
const ANTHROPIC_VERSION = "2023-06-01";

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

interface AnthropicErrorBody {
  error?: { message?: unknown };
  message?: unknown;
}

interface AnthropicMessagesBody {
  content?: unknown;
}

interface AnthropicModelsBody {
  data?: unknown;
}

/** Strip trailing slashes and a legacy `/v1` suffix so stored configs keep working. */
function resolveOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function messagesUrl(baseUrl: string): string {
  return `${resolveOrigin(baseUrl)}/v1/messages`;
}

function modelsUrl(baseUrl: string): string {
  return `${resolveOrigin(baseUrl)}/v1/models`;
}

function buildRewriteHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
    // Opts the request into Anthropic's browser CORS policy. Harmless via
    // the background relay; required for direct browser fetch fallback.
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

function buildListHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

function errorMessage(text: string): string {
  const parsed = safeJsonParse<AnthropicErrorBody>(text);
  const nested = parsed?.error?.message;
  const flat = parsed?.message;
  const message = (typeof nested === "string" && nested) || (typeof flat === "string" && flat) || text.trim();
  return message.slice(0, 500);
}

function throwForStatus(res: RelayHttpResponse, fallback: string): never {
  if (res.status === 401 || res.status === 403) {
    const message = errorMessage(res.text);
    throw new ProviderError("auth", message ? `Auth error: ${message}` : "Invalid API key");
  }
  if (res.status === 429) {
    throw new ProviderError("rate-limit", "Rate limited - try again in a moment");
  }
  const message = errorMessage(res.text);
  if (message) throw new ProviderError("network", message);
  throw new ProviderError("network", `${fallback} (${res.status})`);
}

/**
 * Direct browser fetch with the same native shape as the relay request.
 * Anthropic explicitly allows browser callers presenting
 * `anthropic-dangerous-direct-browser-access: true`, so this is the
 * fallback when the background relay is unreachable (cold SW race).
 */
async function directFetch(req: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<RelayHttpResponse> {
  const res = await fetch(req.url, {
    method: req.method ?? "GET",
    headers: req.headers,
    body: req.body,
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

async function postMessages(req: {
  url: string;
  headers: Record<string, string>;
  body: string;
}): Promise<RelayHttpResponse> {
  try {
    return await relayFetch({ url: req.url, method: "POST", headers: req.headers, body: req.body });
  } catch (err) {
    if (!isTransientRelayError(err)) throw err;
    try {
      return await directFetch({ url: req.url, method: "POST", headers: req.headers, body: req.body });
    } catch {
      throw new ProviderError("network", "Could not reach the model server");
    }
  }
}

async function getModels(req: { url: string; headers: Record<string, string> }): Promise<RelayHttpResponse> {
  try {
    return await relayFetch({ url: req.url, headers: req.headers });
  } catch (err) {
    if (!isTransientRelayError(err)) throw err;
    try {
      return await directFetch({ url: req.url, method: "GET", headers: req.headers });
    } catch {
      throw new ProviderError("network", "Could not reach the model server");
    }
  }
}

function extractText(resText: string): string {
  const data = safeJsonParse<AnthropicMessagesBody>(resText);
  const blocks = data?.content;
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("").trim();
}

/** Claude via Anthropic's native Messages API (`x-api-key` + versioned headers). */
export class AnthropicProvider implements ProviderAdapter {
  readonly id = "anthropic";
  readonly label = "Claude";
  readonly defaultBaseUrl = "https://api.anthropic.com";
  readonly defaultModel = "claude-sonnet-4-5";
  readonly tiersEnforcedServerSide = false;
  readonly apiKeyUrl = "https://console.anthropic.com/settings/keys";

  async rewrite(config: BackendConfig, apiKey: string, system: string, user: string): Promise<string> {
    if (!apiKey) throw new ProviderError("no-key", "No API key configured");
    if (!config.baseUrl) throw new ProviderError("network", "Base URL is not configured");

    const url = messagesUrl(config.baseUrl);
    const headers = buildRewriteHeaders(apiKey);
    const body = JSON.stringify({
      model: config.model,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
      temperature: 0.7,
    });

    let res: RelayHttpResponse;
    try {
      res = await postMessages({ url, headers, body });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("network", "Could not reach the model server");
    }
    if (!res.ok) throwForStatus(res, "Model request failed");

    const content = extractText(res.text);
    if (!content) throw new ProviderError("empty", "Empty model response");
    return content;
  }

  async listModels(config: BackendConfig, apiKey: string): Promise<string[]> {
    if (!apiKey) throw new ProviderError("no-key", "No API key configured");
    if (!config.baseUrl) throw new ProviderError("network", "Base URL is not configured");

    const url = modelsUrl(config.baseUrl);
    const headers = buildListHeaders(apiKey);

    let res: RelayHttpResponse;
    try {
      res = await getModels({ url, headers });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("network", "Could not reach the model server");
    }
    if (!res.ok) throwForStatus(res, "Could not load models");

    const raw = safeJsonParse<AnthropicModelsBody>(res.text);
    const models = new Set<string>();
    if (raw && typeof raw === "object" && Array.isArray(raw.data)) {
      for (const item of raw.data) {
        const id = typeof item === "string" ? item : (item as { id?: unknown } | null)?.id;
        if (typeof id === "string" && id) models.add(id);
      }
    }
    return [...models].filter((id) => !isRetiredModel(id));
  }
}
