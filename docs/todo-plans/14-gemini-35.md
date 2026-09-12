# Todo 14 — Handle Gemini 3.5 migration and errors

**Status:** available

## Goal
Do not allow `2.5-flash-lite` (retired), show provider error verbatim, auto-migrate to `3.5`.

## Files
- `src/lib/providers.ts:1` Gemini `defaultModel`
- `src/lib/providers/openai.ts` / `gemini.ts` `listModels`/`rewrite`
- `src/lib/storage.ts:49` `getBackendConfig` migration
- `src/lib/api.ts:498` error passthrough
- `src/entrypoints/options/App.tsx:233/825` & `onboarding:510/737` chips

## Steps
1. Update default `models/gemini-2.5-flash-lite` → `models/gemini-3.5-flash-lite`
2. `storage.getBackendConfig` if `cfg.model` matches retired regex → rewrite to 3.5 + `saveBackendConfig` once
3. Adapter `listModels` filter out retired ids (drop `2.5`), keep `3.5`; `validateModel` helper blocks free-text `2.5` with hint `Retired, use 3.5`
4. Provider `listModels`/`rewrite` keep full `error.message` from `{error:{message}}` (not slice) → `ProviderError` → `options`/`onboarding` `hint` `role="alert"` shows verbatim (`…is no longer available… use 3.5… Interactions API`)
5. Chips: `isDisabled` + tooltip for retired, auto-migrate select `2.5 → 3.5` with toast

## Verification
- `Load models` shows `3.5`, no `2.5`; typing `2.5` → inline retired hint, Save blocked
- Rewrite with stale `2.5` shows exact provider body in alert, next load migrates to `3.5`
