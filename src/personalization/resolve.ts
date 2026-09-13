import { buildPersonaPrompt, findBuiltinPersona } from "./sitePersonas";
import type { PersonalizationContext } from "./types";
import { getDefaultInstruction, hasDirective } from "./canonical";
import type { SliderDimension, SliderLevels } from "./sliders";
import { sliderLevelToDirective } from "./sliders";
import type { PersonalizationSnapshot, ResolvedStyle } from "./types";

export const CONTEXT_ORDER: PersonalizationContext[] = ["default", "email", "text", "social", "work"];

const SLIDER_DIMENSIONS: SliderDimension[] = ["casual", "direct", "length"];

function normalizeHost(site?: string): string {
  return site?.trim().toLowerCase() ?? "";
}

/**
 * Compile committed slider positions into an instruction. Directives already
 * present in the text are not duplicated (same rule as buildCanonical).
 */
export function compileSliders(text: string, levels: SliderLevels): string {
  let out = text;
  for (const dim of SLIDER_DIMENSIONS) {
    const directive = sliderLevelToDirective(dim, levels[dim]);
    if (directive && !hasDirective(out, directive)) {
      out = `${out}\n\n${directive}`.trim();
    }
  }
  return out;
}

/**
 * Resolve the effective instruction for a site. Precedence:
 * exact-hostname site override → base style → built-in persona →
 * default instruction. Slider levels travel with the winning style;
 * fallbacks have no stored levels and pass through untouched.
 */
export function resolveInstruction(snapshot: PersonalizationSnapshot, site?: string): ResolvedStyle {
  const host = normalizeHost(site);
  if (host) {
    const tag = snapshot.domains.find((d) => d.pattern.trim().toLowerCase() === host);
    if (tag) {
      const style = snapshot.contexts[tag.context];
      if (style && style.prompt.trim()) {
        return {
          instruction: compileSliders(style.prompt.trim(), style.sliders),
          origin: "site",
        };
      }
    }
  }
  const base = snapshot.contexts.default;
  if (base && base.prompt.trim()) {
    return {
      instruction: compileSliders(base.prompt.trim(), base.sliders),
      origin: "base",
    };
  }
  if (host) {
    const builtin = findBuiltinPersona(host);
    if (builtin) {
      return { instruction: buildPersonaPrompt(builtin), origin: "persona" };
    }
  }
  return { instruction: getDefaultInstruction(), origin: "default" };
}
