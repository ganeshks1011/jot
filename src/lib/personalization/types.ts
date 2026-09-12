import type { ContextDomain, PersonalizationContext } from "../types";
import type { SliderLevels } from "./sliders";

export type { SliderLevels };

/** One style: instruction text plus committed slider positions. */
export interface ContextStyle {
  prompt: string;
  sliders: SliderLevels;
}

/**
 * Whole user style, persisted as a single snapshot. `contexts` mirrors the
 * Teach UI model 1:1; `domains` tags hostnames to non-default contexts.
 */
export interface PersonalizationSnapshot {
  contexts: Record<PersonalizationContext, ContextStyle>;
  domains: ContextDomain[];
}

/** Draft state edited in Teach UI (prompts, sliders, domains, examples). */
export interface TeachState {
  prompts: Record<PersonalizationContext, string>;
  sliders: Record<PersonalizationContext, SliderLevels>;
  domains: ContextDomain[];
  examples: Record<PersonalizationContext, string>;
}

export type ResolvedOrigin = "site" | "base" | "persona" | "default";

export interface ResolvedStyle {
  instruction: string;
  origin: ResolvedOrigin;
}
