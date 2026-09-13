import { type LexicalTextNode, normalizeRewriteOutput } from "@wurkflo/shared";
import { WURKFLO_ORIGIN } from "./config";
import { relayStream } from "./net";
import { buildApiPrompts, buildDirectPrompts, buildPreviewPrompts } from "./personalization";
import { getAdapter, ProviderError } from "./providers";
import { type Replacement, redact, redactAll, restorePlaceholders } from "./redaction";
import { buildResponseKey, cachedResponseFor, storeResponse } from "./responseCache";
import { sanitizeRichHtml } from "./richText";
import { getApiKey, getBackendConfig, getRedactionEnabled, setWurkfloRemaining } from "./storage";
import { isTransientRelayError, isTransientTokenError } from "./transientErrors";
import type { ProviderId } from "./types";

export { ProviderError };

export interface RewriteHandlers {
  /** Streaming callback - fires per SSE content delta (wurkflo) or once with
   *  the full text (direct providers). */
  onChunk?: (delta: string) => void;
  /** Aborts an in-flight request/stream. */
  signal?: AbortSignal;
}

/**
 * Rewrite orchestration. Runs in the overlay iframe (chrome-extension://
 * origin) under the extension's own CSP.
 *
 * Prompts come opaquely from personalization; this layer only routes them:
 * - "jot-api": authenticated SSE stream from the React Router backend; quota
 *   enforced there (100 free requests/month).
 * - everything else: direct OpenAI-compatible call with the user's API key;
 *   client-side tier counters apply.
 */
export async function rewriteText(
  source: string,
  site?: string,
  followUp?: string,
  handlers?: RewriteHandlers,
  rich?: { html?: string | null },
): Promise<string> {
  const config = await getBackendConfig();
  // Redact locally before anything leaves the browser; the mapping stays in
  // this closure for the duration of the call and is never persisted.
  const red = await applyRedaction(source, followUp, rich?.html);

  if (config.provider === "jot-api") {
    const out = await streamWurkfloRewrite(red.source, site, red.followUp, handlers, red.redacted, red.html);
    return restoreRedaction(sanitizeIfHtml(out), red.replacements);
  }

  const apiKey = await getApiKey(config.provider);
  const adapter = getAdapter(config.provider);
  if (!adapter) throw new ProviderError("network", `Unknown provider "${config.provider}"`);
  const { system, user } = await buildDirectPrompts({
    source: red.source,
    followUp: red.followUp,
    site,
    preservePlaceholders: red.redacted,
    sourceHtml: red.html,
  });
  const text = await adapter.rewrite(config, apiKey, system, user);
  const normalized = normalizeRewriteOutput(text);
  handlers?.onChunk?.(normalized);
  return restoreRedaction(sanitizeIfHtml(normalized), red.replacements);
}

/**
 * Rewrite using an explicit instruction (for onboarding preview). Bypasses
 * storage resolution and uses the given instruction directly. Honors the
 * user's configured provider (Wurkflo vs direct) and uses the same backend.
 */
export async function rewriteWithInstruction(
  source: string,
  instruction: string,
  site?: string,
  handlers?: RewriteHandlers,
): Promise<string> {
  const config = await getBackendConfig();
  const red = await applyRedaction(source);
  const { system, user } = await buildPreviewPrompts(instruction, red.source, red.redacted);
  if (config.provider === "jot-api") {
    const out = await streamWurkfloWithInstruction(system, red.source, handlers);
    return restoreRedaction(out, red.replacements);
  }
  const apiKey = await getApiKey(config.provider);
  const adapter = getAdapter(config.provider);
  if (!adapter) throw new ProviderError("network", `Unknown provider "${config.provider}"`);
  const text = await adapter.rewrite(config, apiKey, system, user);
  const normalized = normalizeRewriteOutput(text);
  handlers?.onChunk?.(normalized);
  return restoreRedaction(normalized, red.replacements);
}

interface AppliedRedaction {
  source: string;
  followUp?: string;
  html?: string | null;
  replacements: Replacement[];
  redacted: boolean;
}

/**
 * Single choke point: sensitive values are replaced locally before any
 * prompt construction or network call. Source, tweak, and the HTML fragment
 * share one numbering so placeholders stay unique within the operation.
 */
async function applyRedaction(source: string, followUp?: string, html?: string | null): Promise<AppliedRedaction> {
  const cleanHtml = html?.trim() ? html : null;
  const passthrough: AppliedRedaction = {
    source,
    followUp,
    html: cleanHtml,
    replacements: [],
    redacted: false,
  };
  if (!(await getRedactionEnabled())) return passthrough;
  const texts: string[] = [source];
  if (followUp?.trim()) texts.push(followUp);
  if (cleanHtml) texts.push(cleanHtml);
  if (texts.length === 1) {
    const r = redact(source);
    if (r.replacements.length === 0) return passthrough;
    return { source: r.text, followUp, html: cleanHtml, replacements: r.replacements, redacted: true };
  }
  const { texts: out, replacements } = redactAll(texts);
  if (replacements.length === 0) return passthrough;
  let i = 0;
  const redSource = out[i++] ?? source;
  const redFollowUp = followUp?.trim() ? out[i++] : followUp;
  const redHtml = cleanHtml ? (out[i++] ?? cleanHtml) : null;
  return { source: redSource, followUp: redFollowUp, html: redHtml, replacements, redacted: true };
}

/** Strip non-allowlist markup from model output containing tags. */
function sanitizeIfHtml(output: string): string {
  if (!/<[a-zA-Z]/.test(output)) return output;
  return sanitizeRichHtml(output);
}

/** Restore exact placeholder matches locally. Missing or invented
 *  placeholders are left as-is. Never guess where a secret belongs. */
function restoreRedaction(output: string, replacements: Replacement[]): string {
  if (replacements.length === 0) return output;
  return restorePlaceholders(output, replacements).text;
}

// ---------------------------------------------------------------------------
// Wurkflo system-prompt hash cache (jot-api only)
// ---------------------------------------------------------------------------
//
// The backend stores each systemPrompt content-addressed at
// `users/{uid}/jotPrompts/{hash}` and returns the hash in the
// `X-Jot-Prompt-Hash` header plus a final `{"systemPromptHash"}` SSE frame.
// Later requests for the same prompt send only the hash. Unknown/stale
// hashes get a single retry with the full prompt (backend never consumes
// quota for `invalid_system_prompt_hash`).
const promptHashCache = new Map<string, string>();
const MAX_CACHED_PROMPTS = 20;

/**
 * Payload for POST /api/ai/rewrite. `html: true` rides along only when the
 * input is a formatting-bearing fragment so the backend appends its
 * lowest-priority preservation rule; plain payloads stay byte-identical to
 * previous extension versions (older backends ignore the absent field,
 * current backends take the plain path). `nodes` carries Lexical index-path
 * entries for the keyed rewrite and implies its own backend rule.
 */
function buildWurkfloPayload(
  systemPrompt: string,
  input: string,
  html?: boolean,
  nodes?: LexicalTextNode[],
): Record<string, unknown> {
  const hash = promptHashCache.get(systemPrompt);
  const base = hash ? { systemPromptHash: hash, input } : { systemPrompt, input };
  const withHtml = html ? { ...base, html: true } : base;
  return nodes && nodes.length > 0 ? { ...withHtml, nodes } : withHtml;
}

function rememberPromptHash(systemPrompt: string, hash: string): void {
  if (!hash) return;
  if (!promptHashCache.has(systemPrompt) && promptHashCache.size >= MAX_CACHED_PROMPTS) {
    const oldest = promptHashCache.keys().next();
    if (!oldest.done) promptHashCache.delete(oldest.value);
  }
  promptHashCache.set(systemPrompt, hash);
}

function dropPromptHash(systemPrompt: string): void {
  promptHashCache.delete(systemPrompt);
}

function isInvalidPromptHashError(body: string | undefined): boolean {
  if (!body) return false;
  try {
    const parsed = JSON.parse(body) as {
      error?: string | { code?: string };
    };
    const code = typeof parsed.error === "string" ? parsed.error : parsed.error?.code;
    return code === "invalid_system_prompt_hash";
  } catch {
    return body.includes("invalid_system_prompt_hash");
  }
}

async function streamWurkfloWithInstruction(
  systemPrompt: string,
  input: string,
  handlers?: RewriteHandlers,
): Promise<string> {
  const [{ getWurkfloToken }, { getWurkfloUser }] = await Promise.all([import("./auth"), import("./storage")]);
  const user = await getWurkfloUser();
  if (!user) throw new ProviderError("auth", "Sign in with Wurkflo to continue");
  const getTokenWithRetry = async (): Promise<string> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await getWurkfloToken();
      } catch (err) {
        if (attempt === 0 && isTransientTokenError(err)) {
          await new Promise<void>((r) => setTimeout(r, 500));
          continue;
        }
        throw err;
      }
    }
    throw new Error("not-signed-in");
  };
  const token = await getTokenWithRetry();
  let payload = buildWurkfloPayload(systemPrompt, input);
  let buffer = "";
  let result = "";
  let done = false;
  let failure: ProviderError | null = null;
  const consumeFrame = (raw: string): void => {
    buffer += raw;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        done = true;
        return;
      }
      try {
        const parsed = JSON.parse(data) as { content?: string; error?: string; systemPromptHash?: string };
        if (typeof parsed.systemPromptHash === "string" && parsed.systemPromptHash) {
          rememberPromptHash(systemPrompt, parsed.systemPromptHash);
        }
        if (parsed.error) {
          failure = new ProviderError("network", parsed.error);
          return;
        }
        if (parsed.content) {
          const delta = normalizeRewriteOutput(parsed.content);
          if (delta) {
            result += delta;
            handlers?.onChunk?.(delta);
          }
        }
      } catch (err) {
        if (err instanceof ProviderError) throw err;
      }
    }
  };
  const parseQuotaBody = (
    raw: string | undefined,
  ): { message?: string; quota?: unknown; upgrade?: unknown; error?: string } | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.error === "string")
        return parsed as { message?: string; quota?: unknown; upgrade?: unknown; error?: string };
      if (parsed.error && typeof parsed.error === "object") {
        const nested = parsed.error as Record<string, unknown>;
        if (typeof nested.message === "string")
          return { message: nested.message as string, error: nested.message as string };
      }
      return parsed as { message?: string; quota?: unknown; upgrade?: unknown; error?: string };
    } catch {
      return null;
    }
  };
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (handlers?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      await relayStream(
        {
          url: `${WURKFLO_ORIGIN.replace(/\/+$/, "")}/api/ai/rewrite`,
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        },
        {
          onRemaining: (n) => void setWurkfloRemaining(n),
          onPromptHash: (hash) => rememberPromptHash(systemPrompt, hash),
          onChunk: (raw) => {
            if (failure || done) return;
            consumeFrame(raw);
          },
        },
        handlers?.signal,
      );
      lastError = null;
      break;
    } catch (err) {
      const e = err as Error & { status?: number; body?: string };
      if ((err as Error)?.name === "AbortError") throw err;
      if (e.status === 400 && attempt === 0 && !handlers?.signal?.aborted && isInvalidPromptHashError(e.body)) {
        // Stale cached hash. Drop it and retry once with the full prompt.
        dropPromptHash(systemPrompt);
        payload = { systemPrompt, input };
        failure = null;
        continue;
      }
      if (e.status != null && !failure) {
        const parsed = parseQuotaBody(e.body);
        const rawMessage =
          (parsed as { message?: string } | null)?.message ??
          (() => {
            try {
              const p = JSON.parse(e.body ?? "") as { error?: { message?: string } } | null;
              return p?.error?.message;
            } catch {
              return undefined;
            }
          })() ??
          (e.body?.trim() ? e.body.trim().slice(0, 200) : undefined) ??
          `Request failed (${e.status})`;
        if (e.status === 401) throw new ProviderError("auth", rawMessage, { status: 401 });
        if (e.status === 429) throw new ProviderError("rate-limit", rawMessage, { status: 429 });
        if (e.status === 402) {
          const quota = (parsed as { quota?: unknown } | null)?.quota as
            | { used?: number; limit?: number; remaining?: number; period?: string }
            | undefined;
          const upgrade = (parsed as { upgrade?: unknown } | null)?.upgrade as
            | {
                available?: boolean;
                planId?: string | null;
                name?: string | null;
                message?: string | null;
                redirectUri?: string | null;
              }
            | undefined;
          const quotaInfo =
            quota && typeof quota.used === "number" && typeof quota.limit === "number"
              ? {
                  used: quota.used,
                  limit: quota.limit,
                  remaining: typeof quota.remaining === "number" ? quota.remaining : 0,
                  period: typeof quota.period === "string" ? quota.period : "",
                }
              : null;
          const upgradeInfo = upgrade
            ? {
                available: upgrade.available === true,
                planId: typeof upgrade.planId === "string" ? upgrade.planId : null,
                name: typeof upgrade.name === "string" ? upgrade.name : null,
                message: typeof upgrade.message === "string" ? upgrade.message : null,
                redirectUri: typeof upgrade.redirectUri === "string" ? upgrade.redirectUri : null,
              }
            : null;
          if (quotaInfo) void setWurkfloRemaining(quotaInfo.remaining);
          const fallbackMsg = quotaInfo?.limit
            ? `You've used all ${quotaInfo.limit} Jot completions this month.`
            : "You've used all Jot completions this month.";
          const msg = rawMessage || fallbackMsg;
          throw new ProviderError("quota", msg, { quota: quotaInfo, upgrade: upgradeInfo, status: 402 });
        }
        throw new ProviderError("network", rawMessage, { status: e.status });
      }
      if (failure) throw failure;
      if (attempt === 0 && isTransientRelayError(err) && !handlers?.signal?.aborted) {
        lastError = err;
        await new Promise<void>((r) => setTimeout(r, 500));
        failure = null;
        continue;
      }
      lastError = err;
      break;
    }
  }
  if (lastError) {
    if (failure) throw failure;
    if (isTransientRelayError(lastError)) throw new ProviderError("network", "Could not reach the Wurkflo backend");
    throw lastError instanceof ProviderError
      ? lastError
      : new ProviderError("network", "Could not reach the Wurkflo backend");
  }
  if (failure) throw failure;
  if (!result.trim()) throw new ProviderError("empty", "Empty model response");
  return result;
}

// ---------------------------------------------------------------------------
// Wurkflo streaming path
// ---------------------------------------------------------------------------

async function streamWurkfloRewrite(
  source: string,
  site?: string,
  followUp?: string,
  handlers?: RewriteHandlers,
  preservePlaceholders?: boolean,
  sourceHtml?: string | null,
  nodes?: LexicalTextNode[] | null,
): Promise<string> {
  // Dynamic import keeps the Firebase SDK out of bundles that never use it.
  const [{ getWurkfloToken }, { getWurkfloUser }] = await Promise.all([import("./auth"), import("./storage")]);
  const user = await getWurkfloUser();
  if (!user) {
    throw new ProviderError("auth", "Sign in with Wurkflo to continue");
  }

  // Auth token fetch is part of the retryable scope. Cold SW starts need one
  // extra attempt after the background's IndexedDB restore.
  const getTokenWithRetry = async (): Promise<string> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await getWurkfloToken();
      } catch (err) {
        if (attempt === 0 && isTransientTokenError(err)) {
          await new Promise<void>((r) => setTimeout(r, 500));
          continue;
        }
        throw err;
      }
    }
    throw new Error("not-signed-in");
  };
  const token = await getTokenWithRetry();

  const { systemPrompt, input } = await buildApiPrompts({
    source,
    followUp,
    site,
    preservePlaceholders,
    sourceHtml,
  });
  // Cross-open response cache: identical text + resolved system prompt
  // reuses the last output without a request (no quota consumed). Keyed
  // node lists ride in the key so Lexical flows share the mechanism.
  const isHtml = !!sourceHtml?.trim();
  const keyed = nodes && nodes.length > 0 ? nodes : null;
  const responseKey = await buildResponseKey({
    provider: "jot-api",
    model: (await getBackendConfig()).model ?? "",
    systemPrompt,
    source,
    followUp,
    html: sourceHtml,
    nodes: keyed ? JSON.stringify(keyed.map((n) => [n.id, n.text])) : undefined,
  });
  const cachedHit = await cachedResponseFor(responseKey);
  if (cachedHit != null) {
    // Surface through the streaming preview like a live response (keyed
    // callers pass no onChunk, so nothing renders mid-flight there).
    if (!keyed) handlers?.onChunk?.(cachedHit);
    return cachedHit;
  }
  // Flag HTML inputs so the backend appends its preservation rule; plain
  // inputs omit the field entirely (previous-frontend payload shape).
  // Keyed node lists ride along for the backend's keyed rewrite rule.
  let payload = buildWurkfloPayload(systemPrompt, input, isHtml, keyed ?? undefined);

  // The SSE stream is relayed through the background service worker (no host
  // permissions, so extension pages are CORS-bound). Chunks arrive as raw
  // decoded text; SSE frames are parsed here exactly as before.
  let buffer = "";
  let result = "";
  let done = false;
  let failure: ProviderError | null = null;

  const consumeFrame = (raw: string): void => {
    buffer += raw;
    // SSE frames are newline-delimited; keep any trailing partial line in the
    // buffer until its remainder arrives in a later chunk.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        done = true;
        return;
      }
      try {
        const parsed = JSON.parse(data) as { content?: string; error?: string; systemPromptHash?: string };
        if (typeof parsed.systemPromptHash === "string" && parsed.systemPromptHash) {
          rememberPromptHash(systemPrompt, parsed.systemPromptHash);
        }
        if (parsed.error) {
          failure = new ProviderError("network", parsed.error);
          return;
        }
        if (parsed.content) {
          const delta = normalizeRewriteOutput(parsed.content);
          if (delta) {
            result += delta;
            // Keyed responses accumulate JSON, not display text: never
            // forward fragments to the streaming preview.
            if (!keyed) handlers?.onChunk?.(delta);
          }
        }
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        // Incomplete/foreign frame - skip.
      }
    }
  };

  // Helper to extract quota/upgrade payload from 402 bodies.
  const parseQuotaBody = (
    raw: string | undefined,
  ): { message?: string; quota?: unknown; upgrade?: unknown; error?: string } | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Top-level shape: { error: "JOT_QUOTA_EXCEEDED", message, quota, upgrade }
      if (typeof parsed.error === "string") {
        return parsed as { message?: string; quota?: unknown; upgrade?: unknown; error?: string };
      }
      // Some backends nest under { error: { message } }
      if (parsed.error && typeof parsed.error === "object") {
        const nested = parsed.error as Record<string, unknown>;
        if (typeof nested.message === "string") {
          return { message: nested.message as string, error: nested.message as string };
        }
      }
      return parsed as { message?: string; quota?: unknown; upgrade?: unknown; error?: string };
    } catch {
      return null;
    }
  };

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (handlers?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    // Reset per-attempt state but keep result/buffer for successful chunks.
    // On retry failure is cleared only if it was a transient network error.
    try {
      await relayStream(
        {
          url: `${WURKFLO_ORIGIN.replace(/\/+$/, "")}/api/ai/rewrite`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        },
        {
          onRemaining: (n) => void setWurkfloRemaining(n),
          onPromptHash: (hash) => rememberPromptHash(systemPrompt, hash),
          onChunk: (raw) => {
            if (failure || done) return;
            consumeFrame(raw);
          },
        },
        handlers?.signal,
      );
      lastError = null;
      break;
    } catch (err) {
      const e = err as Error & { status?: number; body?: string };
      if ((err as Error)?.name === "AbortError") throw err;
      if (e.status === 400 && attempt === 0 && !handlers?.signal?.aborted && isInvalidPromptHashError(e.body)) {
        // Stale cached hash. Drop it and retry once with the full prompt.
        dropPromptHash(systemPrompt);
        payload = buildWurkfloPayload(systemPrompt, input, isHtml, keyed ?? undefined);
        failure = null;
        continue;
      }
      if (e.status != null && !failure) {
        const parsed = parseQuotaBody(e.body);
        const rawMessage =
          (parsed as { message?: string } | null)?.message ??
          (() => {
            try {
              const p = JSON.parse(e.body ?? "") as { error?: { message?: string } } | null;
              return p?.error?.message;
            } catch {
              return undefined;
            }
          })() ??
          (e.body?.trim() ? e.body.trim().slice(0, 200) : undefined) ??
          `Request failed (${e.status})`;

        if (e.status === 401) throw new ProviderError("auth", rawMessage, { status: 401 });
        if (e.status === 429) throw new ProviderError("rate-limit", rawMessage, { status: 429 });
        if (e.status === 402) {
          // Quota exceeded. Surface upgrade path verbatim from backend.
          const quota = (parsed as { quota?: unknown } | null)?.quota as
            | { used?: number; limit?: number; remaining?: number; period?: string }
            | undefined;
          const upgrade = (parsed as { upgrade?: unknown } | null)?.upgrade as
            | {
                available?: boolean;
                planId?: string | null;
                name?: string | null;
                message?: string | null;
                redirectUri?: string | null;
              }
            | undefined;
          const quotaInfo =
            quota && typeof quota.used === "number" && typeof quota.limit === "number"
              ? {
                  used: quota.used,
                  limit: quota.limit,
                  remaining: typeof quota.remaining === "number" ? quota.remaining : 0,
                  period: typeof quota.period === "string" ? quota.period : "",
                }
              : null;
          const upgradeInfo = upgrade
            ? {
                available: upgrade.available === true,
                planId: typeof upgrade.planId === "string" ? upgrade.planId : null,
                name: typeof upgrade.name === "string" ? upgrade.name : null,
                message: typeof upgrade.message === "string" ? upgrade.message : null,
                redirectUri: typeof upgrade.redirectUri === "string" ? upgrade.redirectUri : null,
              }
            : null;
          // Cache remaining as 0 on quota hit for options page badge.
          if (quotaInfo) void setWurkfloRemaining(quotaInfo.remaining);
          const fallbackMsg = quotaInfo?.limit
            ? `You've used all ${quotaInfo.limit} Jot completions this month.`
            : "You've used all Jot completions this month.";
          const msg = rawMessage || fallbackMsg;
          throw new ProviderError("quota", msg, {
            quota: quotaInfo,
            upgrade: upgradeInfo,
            status: 402,
          });
        }
        throw new ProviderError("network", rawMessage, { status: e.status });
      }
      if (failure) throw failure;
      // Transient transport errors (cold SW wake). Retry once.
      if (attempt === 0 && isTransientRelayError(err) && !handlers?.signal?.aborted) {
        lastError = err;
        // Small delay lets the SW fully wake and IndexedDB settle.
        await new Promise<void>((r) => setTimeout(r, 500));
        // Clear failure so consumeFrame can re-parse on retry.
        failure = null;
        continue;
      }
      lastError = err;
      break;
    }
  }
  if (lastError) {
    if (failure) throw failure;
    if (isTransientRelayError(lastError)) {
      throw new ProviderError("network", "Could not reach the Wurkflo backend");
    }
    throw lastError instanceof ProviderError
      ? lastError
      : new ProviderError("network", "Could not reach the Wurkflo backend");
  }
  if (failure) throw failure;

  if (!result.trim()) {
    throw new ProviderError("empty", "Empty model response");
  }
  // Cache only clean successes: failures and empties must refetch.
  await storeResponse(responseKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// Lexical keyed rewrite (structure-preserving, via the Wurkflo backend)
// ---------------------------------------------------------------------------

export interface LexicalRewriteOptions {
  source?: string;
  site?: string;
  followUp?: string;
  handlers?: RewriteHandlers;
}

/**
 * Parse an accumulated keyed-rewrite response into an id->text map.
 * Returns null when the payload is not usable: unparseable JSON, missing
 * `rewrites` object, or any expected id absent or blank. Extra ids are
 * ignored. Pure and unit-tested; the stream may wrap the JSON in stray
 * prose, so the outermost object is sliced out first.
 */
export function parseKeyedRewrites(raw: string, expectedIds: string[]): Record<string, string> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rewrites = (parsed as Record<string, unknown>).rewrites;
  if (!rewrites || typeof rewrites !== "object" || Array.isArray(rewrites)) return null;
  const record = rewrites as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const id of expectedIds) {
    const value = record[id];
    if (typeof value !== "string" || !value.trim()) return null;
    out[id] = value;
  }
  return out;
}

/**
 * Rewrite Lexical text nodes by id through the Wurkflo backend and return
 * the id->rewritten-text map. Only the jot-api provider supports the keyed
 * contract; anything else throws so callers fall back to the string flow.
 * Sensitive spans are redacted locally with shared numbering and restored
 * per mapped value before returning.
 */
export async function rewriteLexicalNodes(
  nodes: LexicalTextNode[],
  opts?: LexicalRewriteOptions,
): Promise<Record<string, string>> {
  if (nodes.length === 0) throw new ProviderError("empty", "Nothing to rewrite");
  const config = await getBackendConfig();
  if (config.provider !== "jot-api") {
    throw new ProviderError("network", "Keyed rewrite needs the Wurkflo backend");
  }
  const followUp = opts?.followUp?.trim() ? opts.followUp : undefined;
  const texts = nodes.map((n) => n.text);
  if (followUp) texts.push(followUp);
  let sentNodes = nodes;
  let sentFollowUp = followUp;
  let replacements: Replacement[] = [];
  if (await getRedactionEnabled()) {
    const redacted = redactAll(texts);
    if (redacted.replacements.length > 0) {
      replacements = redacted.replacements;
      sentNodes = nodes.map((n, i) => ({ id: n.id, text: redacted.texts[i] ?? n.text, block: n.block }));
      if (followUp) sentFollowUp = redacted.texts[nodes.length];
    }
  }
  const source = opts?.source?.trim() ? opts.source : nodes.map((n) => n.text).join("\n");
  const raw = await streamWurkfloRewrite(
    source,
    opts?.site,
    sentFollowUp,
    opts?.handlers,
    replacements.length > 0,
    undefined,
    sentNodes,
  );
  const map = parseKeyedRewrites(
    raw,
    nodes.map((n) => n.id),
  );
  if (!map) throw new ProviderError("empty", "The model returned an unusable keyed rewrite");
  if (replacements.length === 0) return map;
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(map)) {
    out[id] = restoreRedaction(value, replacements);
  }
  return out;
}

/**
 * Fetch the model list (settings "Load models").
 * Uses the persisted backend config, overlaid with any caller-supplied
 * on-screen values. So "Load models" queries the selected endpoint/URL
 * even before the user hits Save. An empty override baseUrl falls back to
 * the stored value, then the adapter default.
 */
export async function listModels(override?: {
  provider?: ProviderId;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}): Promise<string[]> {
  const stored = await getBackendConfig();
  const provider = override?.provider ?? stored.provider;
  const adapter = getAdapter(provider) ?? getAdapter(stored.provider);
  if (!adapter) throw new ProviderError("network", `Unknown provider "${provider}"`);
  const baseUrl = override?.baseUrl?.trim() || stored.baseUrl?.trim() || adapter.defaultBaseUrl;
  const model = override?.model?.trim() || stored.model?.trim() || adapter.defaultModel;
  const apiKey = override?.apiKey?.trim() || (await getApiKey(provider));
  return adapter.listModels({ provider, baseUrl, model }, apiKey);
}
