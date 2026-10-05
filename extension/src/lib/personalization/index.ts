/**
 * Personalization: everything about WHAT to say. Owns the user style
 * (snapshot store), prompt construction, and resolution. Providers (and
 * api.ts transport) only ever receive the finished { system, user } pair
 * and never inspect prompt content.
 */
import { buildFeedbackBlock, buildSystemPrompt, buildUserMessage } from "./prompts";
import { resolveInstruction } from "./resolve";

export interface BuildOptions {
  source: string;
  followUp?: string;
  site?: string;
  preservePlaceholders?: boolean;
  /** Sanitized HTML fragment when the capture carried formatting. */
  sourceHtml?: string | null;
  /** Latest output when tweaking, so the tweak is inferred against both
   *  the original input and the previous rewrite. */
  priorOutput?: string | null;
}

async function resolveForSite(site?: string): Promise<string> {
  // Dynamic import keeps the store (and its storage dependency graph) out
  // of bundles that only need the pure builders.
  const { loadSnapshot } = await import("./store");
  const { resolveInstruction } = await import("./resolve");
  const snapshot = await loadSnapshot();
  return resolveInstruction(snapshot, site).instruction;
}

/** Prompts for direct providers: instruction in system, data in user. */
export async function buildDirectPrompts(opts: BuildOptions): Promise<{ system: string; user: string }> {
  const instruction = await resolveForSite(opts.site);
  return {
    system: buildSystemPrompt(instruction, {
      preservePlaceholders: opts.preservePlaceholders,
    }),
    user: buildUserMessage({
      input: opts.source,
      feedback: opts.followUp,
      inputHtml: opts.sourceHtml,
      priorOutput: opts.priorOutput,
    }),
  };
}

/**
 * Prompts for the Jot rewrite API (systemPrompt + raw input only): the tweak
 * is folded into the system prompt because the backend takes raw input,
 * while the previous rewrite rides as a top-level wire field the backend
 * appends to the user message. When the capture carried formatting, the
 * sanitized HTML fragment is the input so the model can preserve tags it
 * otherwise could not see. The priorOutput key is omitted when absent so
 * first-run payloads stay byte-identical to previous extension versions.
 */
export async function buildApiPrompts(opts: BuildOptions): Promise<{
  systemPrompt: string;
  input: string;
  priorOutput?: string;
}> {
  const instruction = await resolveForSite(opts.site);
  const feedbackBlock = buildFeedbackBlock(opts.followUp);
  const system = buildSystemPrompt(feedbackBlock ? `${instruction}\n\n${feedbackBlock}` : instruction, {
    preservePlaceholders: opts.preservePlaceholders,
  });
  const html = opts.sourceHtml?.trim();
  const prior = opts.priorOutput?.trim() ? opts.priorOutput.trim() : undefined;
  return { systemPrompt: system, input: html ? html : opts.source, ...(prior ? { priorOutput: prior } : {}) };
}

/**
 * Explicit-instruction bypass (onboarding preview): no style resolution,
 * caller-supplied instruction only.
 */
export async function buildPreviewPrompts(
  instruction: string,
  source: string,
  preservePlaceholders?: boolean,
): Promise<{ system: string; user: string }> {
  const clean = instruction.trim() || "Rewrite the text in a clear, natural, and helpful way.";
  return {
    system: buildSystemPrompt(clean, { preservePlaceholders }),
    user: buildUserMessage({ input: source }),
  };
}

export {
  buildCanonical,
  getDefaultInstruction,
  getDirectiveForLabel,
  hasDirective,
} from "./canonical";
export {
  BASE_PROMPT,
  buildFeedbackBlock,
  buildSystemPrompt,
  buildUserMessage,
  COMMON_PROMPT,
  PLACEHOLDER_GUARD,
} from "./prompts";
export { CONTEXT_ORDER } from "./resolve";
export type { SliderDimension, SliderLevel } from "./sliders";
export {
  SLIDER_LEVELS,
  sliderLevelToDirective,
  sliderLevelToLabel,
} from "./sliders";
export {
  flushTeachState,
  loadTeachState,
  saveDomains,
  saveExample,
  savePrompt,
  saveSliders,
} from "./store";
export type {
  ContextStyle,
  PersonalizationSnapshot,
  ResolvedOrigin,
  ResolvedStyle,
  SliderLevels,
  TeachState,
} from "./types";
