# Todo 16 — Replace chips with 3 five-level sliders

**Status:** available — `project.md:16`

## Goal
Replace chips with 3 bipolar 5-level sliders (1-5, default 3 Neutral/Balanced), explicit Rewrite.

## Levels
**1. Casual → Professional**
| Level | Label | Prompt behavior |
|-------|-------|-----------------|
| 1 | Very Casual | Relaxed, conversational, informal. Use everyday language and contractions. |
| 2 | Casual | Natural and friendly. Sound like a normal conversation, without being sloppy. |
| 3 | Neutral | Balanced and natural. Neither noticeably casual nor formal. |
| 4 | Professional | Polished, clear, and workplace-appropriate without sounding stiff. |
| 5 | Very Professional | Formal, precise, polished, and structured. Avoid casual expressions. |
**2. Direct → Gentle**
| Level | Label | Prompt behavior |
|-------|-------|-----------------|
| 1 | Very Direct | Get straight to the point. Use clear, firm, unambiguous language with minimal softening. |
| 2 | Direct | Be straightforward and confident while avoiding unnecessarily blunt language. |
| 3 | Balanced | Combine clarity with consideration. Neither overly blunt nor overly softened. |
| 4 | Gentle | Use tactful, considerate language while keeping the message clear. |
| 5 | Very Gentle | Prioritize warmth and sensitivity. Soften potentially harsh or confrontational wording without changing the meaning. |
**3. Short → Detailed**
| Level | Label | Prompt behavior |
|-------|-------|-----------------|
| 1 | Very Short | Use only essential words. Remove nonessential explanation and repetition. |
| 2 | Short | Keep it concise while retaining the necessary context and meaning. |
| 3 | Balanced | Use enough detail for clarity without unnecessarily expanding the message. |
| 4 | Detailed | Add useful context or explanation where it improves clarity, without adding new facts. |
| 5 | Very Detailed | Provide a thorough version with relevant explanation and context, while staying faithful to the original. |

## Files
- `src/entrypoints/onboarding/Onboarding.tsx:401` `handleStyleAdjustment` + `1033` chip row
- `src/entrypoints/onboarding/style.css:10` add `@import "@heroui/styles/components/slider.css"`
- `src/lib/personalization.ts:1` add `sliderLevelToDirective(dimension, level 1-5)` pure helper (level 3 → null no-op)

## Steps
1. Replace chip row with 3× `Slider` (`@heroui/react/slider`, `minValue 1 maxValue 5 step 1 defaultValue 3`, `showSteps`, `Slider.Output` label, `aria-label`)
2. State `sliders: Record<ctx,{casual:1-5,direct:1-5,length:1-5}>` init 3 per ctx, persisted to `jot:contextSliders`, synced like `advancedText`
3. `onChangeEnd` → `directive = sliderLevelToDirective(dim, level)` (all natural wording from table, level 3 null) → `buildCanonical(base, directive)` → `persistPromptForCtx` + `remember`; **does not** auto-Rewrite
4. `Rewrite` explicit remains (`buildCacheKey` + glimmer only on miss, first landing `hasFetchedInitialRef`)

## Verification
- Step 3/6 shows 3 sliders 1-5 keyboard-accessible (`Tab`/`ArrowLeft/Right`), labels `Very Casual`…`Very Professional` etc., drag 1→5 → remember toast, `Rewrite` → glimmer only in `Jot's rewrite`, cache hit instant, level 3 no-op
