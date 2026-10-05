# Todo 19 — Fix Rewrite not triggering request

**Status:** available

## Goal
Sometimes `Rewrite` shows no glimmer and no network (silent cache hit).

## Root
- `Onboarding.tsx:253` `triggerPreview` `if (cached) return` without fetch, `buildCacheKey` raw `example` trailing Space vs trimmed, `hasFetchedInitialRef` effect `305` does `setJotResult("")` not fetch, `handleRewrite` `saveContextExample` await before `triggerPreview` stale closure, `isProviderReady` debounce 400ms, slider level 3 no-op hit.

## Files
- `src/entrypoints/onboarding/Onboarding.tsx:226,244,253,282,305,415`
- `src/lib/storage.ts:85` saveApiKey debounce
- `src/lib/transientErrors.ts:1` already pure

## Steps
1. Normalize `buildCacheKey` to `trim()` example/instruction (or make explicit) — decide raw vs trimmed
2. Change `triggerPreview` to `force?:boolean` and `handleRewrite` calls `force:true` (bypass cache, always fetch), `hasFetchedInitialRef` effect calls `force:false` (respect cache)
3. In `hasFetchedInitialRef` effect, when `!hit` keep previous `jotResult` or auto-fetch with glimmer? Keep `setJotResult("")` + require explicit `Rewrite` (spec) but ensure `handleRewrite` always forces
4. Add `await saveApiKey` flush in `handleRewrite` before `triggerPreview` if apiKey just typed
5. Log `buildCacheKey` vs cache hit/miss and `isProviderReady` in dev to verify

## Verification
- Edit Example trailing Space at end → `Rewrite` → glimmer + network (not hit), `hasFetchedInitialRef` miss shows placeholder until explicit `Rewrite`
