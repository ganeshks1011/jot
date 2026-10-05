# Todo 18 — Make slider draggable, small, fluid

**Status:** available

## Goal
Sliders must drag smoothly (thumb follows pointer), be smaller, UI fluid, onChange not slow.

## Files
- `src/entrypoints/onboarding/Onboarding.tsx:1090` Slider row (3× Slider 1-5)
- `src/entrypoints/onboarding/style.css:10` add `--slider-track-height: 4px; --slider-thumb-size: 14px`
- `src/lib/personalization.ts:15` SLIDER_LEVELS already 1-5, no change

## Steps
1. Style: `gap-4 → gap-3`, track `h-2 → 4px`, thumb `14px`, `min-w-28` Output to avoid shift, `touch-action: pan-y`
2. Split `onChange` (local `setSliders` only, 60fps) vs `onChangeEnd` (commit `buildCanonical` + `persistPromptForCtx` + `remember`)
3. Memoize SliderGroup or make `handleSliderCommit` not setSliders again
4. Verify `isDisabled={generating}` still blocks but not during drag

## Verification
- Drag thumb follows pointer (mouse/touch), track click jumps, ArrowLeft/Right steps 1-5, Tab focus ring, label live, `Rewrite` explicit still
