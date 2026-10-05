import { type LexicalTextNode, normalizeRewriteOutput } from "@wurkflo/shared";
import { buildDirectPrompts } from "./personalization";
import { getAdapter, ProviderError } from "./providers";
import { type Replacement, redactAll, redactAllWithNames, restorePlaceholders } from "./redaction";
import { sanitizeRichHtml } from "./richText";
import {
  getApiKey,
  getBackendConfig,
  getRedactionEnabled,
  getRedactNamesEnabled,
} from "./storage";
import type { ProviderId } from "./types";

export { ProviderError };

export interface RewriteHandlers {
  /** Streaming callback - fires per SSE content delta (direct providers) or
   *  once with the full text (codevu backend). */
  onChunk?: (delta: string) => void;
  /** Aborts an in-flight request/stream. */
  signal?: AbortSignal;
}

/**
 * Rewrite orchestration. Runs in the overlay iframe (chrome-extension://
 * origin) under the extension's own CSP.
 *
 * Prompts come opaquely from personalization; this layer only routes them:
 * - "jot-api": plain-JSON rewrite through the codevu backend (lib/codevu.ts);
 *   quota enforced there (100 free requests/month, no sign-in).
 * - everything else: direct OpenAI-compatible call with the user's API key;
 *   client-side tier counters apply.
 */
/** Fold a "refine" follow-up into the request so "refine, don't restart" works. */
function withRefinement(source: string, followUp?: string): string {
  const request = followUp?.trim();
  return request ? `${source}\n\nRefinement request: ${request}` : source;
}

export async function rewriteText(
  source: string,
  site?: string,
  followUp?: string,
  handlers?: RewriteHandlers,
  rich?: { html?: string | null },
  priorOutput?: string | null,
): Promise<string> {
  const config = await getBackendConfig();
  // Redact locally before anything leaves the browser; the mapping stays in
  // this closure for the duration of the call and is never persisted.
  const red = await applyRedaction(source, followUp, rich?.html, priorOutput);

  if (config.provider === "jot-api") {
    const { rewriteViaCodevu } = await import("./codevu");
    const out = await rewriteViaCodevu(
      withRefinement(red.source, red.followUp),
      "",
      handlers?.onChunk,
    );
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
    priorOutput: red.priorOutput,
  });
  const text = await adapter.rewrite(config, apiKey, system, user);
  const normalized = normalizeRewriteOutput(text);
  handlers?.onChunk?.(normalized);
  return restoreRedaction(sanitizeIfHtml(normalized), red.replacements);
}

/**
 * Rewrite using an explicit instruction (for onboarding preview). Bypasses
 * storage resolution and uses the given instruction directly. Honors the
 * user's configured provider (built-in codevu backend vs direct) and uses
 * the same backend.
 */
export async function rewriteWithInstruction(
  source: string,
  instruction: string,
  site?: string,
  handlers?: RewriteHandlers,
): Promise<string> {
  const config = await getBackendConfig();
  const red = await applyRedaction(source);
  if (config.provider === "jot-api") {
    // The codevu backend takes one style string; fold the full
    // instruction in as an explicit style request on the text.
    const { rewriteViaCodevu } = await import("./codevu");
    const input = red.source + `\n\nStyle instructions: ${instruction}`;
    const out = await rewriteViaCodevu(input, "", handlers?.onChunk);
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
  priorOutput?: string;
  replacements: Replacement[];
  redacted: boolean;
}

/**
 * Pattern redaction, optionally layered with local person-name detection
 * (lazy-loaded NLP, default off). Single choke point so both rewrite paths
 * share numbering and restore semantics.
 */
async function redactTexts(texts: string[]): Promise<{ texts: string[]; replacements: Replacement[] }> {
  if (await getRedactNamesEnabled().catch(() => false)) {
    return redactAllWithNames(texts);
  }
  return redactAll(texts);
}

/**
 * Single choke point: sensitive values are replaced locally before any
 * prompt construction or network call. Source, tweak, prior output, and
 * the HTML fragment share one numbering so placeholders stay unique
 * within the operation.
 */
async function applyRedaction(
  source: string,
  followUp?: string,
  html?: string | null,
  priorOutput?: string | null,
): Promise<AppliedRedaction> {
  const cleanHtml = html?.trim() ? html : null;
  const cleanPrior = priorOutput?.trim() ? priorOutput : undefined;
  const passthrough: AppliedRedaction = {
    source,
    followUp,
    html: cleanHtml,
    priorOutput: cleanPrior,
    replacements: [],
    redacted: false,
  };
  if (!(await getRedactionEnabled())) return passthrough;
  const texts: string[] = [source];
  if (followUp?.trim()) texts.push(followUp);
  if (cleanHtml) texts.push(cleanHtml);
  if (cleanPrior) texts.push(cleanPrior);
  if (texts.length === 1) {
    const single = await redactTexts([source]);
    if (single.replacements.length === 0) return passthrough;
    return {
      source: single.texts[0] ?? source,
      followUp,
      html: cleanHtml,
      replacements: single.replacements,
      redacted: true,
    };
  }
  const { texts: out, replacements } = await redactTexts(texts);
  if (replacements.length === 0) return passthrough;
  let i = 0;
  const redSource = out[i++] ?? source;
  const redFollowUp = followUp?.trim() ? out[i++] : followUp;
  const redHtml = cleanHtml ? (out[i++] ?? cleanHtml) : null;
  const redPrior = cleanPrior ? (out[i++] ?? cleanPrior) : undefined;
  return {
    source: redSource,
    followUp: redFollowUp,
    html: redHtml,
    priorOutput: redPrior,
    replacements,
    redacted: true,
  };
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
// Lexical keyed rewrite (per-node, structure-preserving)
// ---------------------------------------------------------------------------

export interface LexicalRewriteOptions {
  source?: string;
  site?: string;
  followUp?: string;
  priorOutput?: string | null;
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
 * Rewrite Lexical text nodes by id through the built-in backend and return
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
    throw new ProviderError("network", "Keyed rewrite needs the built-in backend");
  }
  const followUp = opts?.followUp?.trim() ? opts.followUp : undefined;
  const texts = nodes.map((n) => n.text);
  if (followUp) texts.push(followUp);
  let sentNodes = nodes;
  let sentFollowUp = followUp;
  let replacements: Replacement[] = [];
  if (await getRedactionEnabled()) {
    const redacted = await redactTexts(texts);
    if (redacted.replacements.length > 0) {
      replacements = redacted.replacements;
      sentNodes = nodes.map((n, i) => ({ id: n.id, text: redacted.texts[i] ?? n.text, block: n.block }));
      if (followUp) sentFollowUp = redacted.texts[nodes.length];
    }
  }
  const { rewriteViaCodevu } = await import("./codevu");
  const out: Record<string, string> = {};
  for (const node of sentNodes) {
    const text = withRefinement(node.text, sentFollowUp);
    const rewrite = await rewriteViaCodevu(text, "", opts?.handlers?.onChunk);
    out[node.id] = replacements.length === 0
      ? rewrite
      : restoreRedaction(rewrite, replacements);
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
