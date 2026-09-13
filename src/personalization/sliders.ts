export const SLIDER_LEVELS = {
  casual: {
    1: "Relaxed, conversational, informal. Use everyday language and contractions.",
    2: "Natural and friendly. Sound like a normal conversation, without being sloppy.",
    3: null,
    4: "Polished, clear, and workplace-appropriate without sounding stiff.",
    5: "Formal, precise, polished, and structured. Avoid casual expressions.",
  },
  direct: {
    1: "Get straight to the point. Use clear, firm, unambiguous language with minimal softening.",
    2: "Be straightforward and confident while avoiding unnecessarily blunt language.",
    3: null,
    4: "Use tactful, considerate language while keeping the message clear.",
    5: "Prioritize warmth and sensitivity. Soften potentially harsh or confrontational wording without changing the meaning.",
  },
  length: {
    1: "Use only essential words. Remove nonessential explanation and repetition.",
    2: "Keep it concise while retaining the necessary context and meaning.",
    3: null,
    4: "Add useful context or explanation where it improves clarity, without adding new facts.",
    5: "Provide a thorough version with relevant explanation and context, while staying faithful to the original.",
  },
} as const;

export type SliderDimension = keyof typeof SLIDER_LEVELS;
export type SliderLevel = 1 | 2 | 3 | 4 | 5;

export type SliderLevels = Record<SliderDimension, SliderLevel>;

export function sliderLevelToDirective(dimension: SliderDimension, level: SliderLevel): string | null {
  const v = SLIDER_LEVELS[dimension][level];
  return v ?? null;
}

const SLIDER_LABELS: Record<SliderDimension, Record<SliderLevel, string>> = {
  casual: { 1: "Very Casual", 2: "Casual", 3: "Neutral", 4: "Professional", 5: "Very Professional" },
  direct: { 1: "Very Direct", 2: "Direct", 3: "Balanced", 4: "Gentle", 5: "Very Gentle" },
  length: { 1: "Very Short", 2: "Short", 3: "Balanced", 4: "Detailed", 5: "Very Detailed" },
};

export function sliderLevelToLabel(dimension: SliderDimension, level: SliderLevel): string {
  return SLIDER_LABELS[dimension][level];
}
