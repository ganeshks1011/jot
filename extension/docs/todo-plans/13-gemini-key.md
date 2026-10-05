# Todo 13 — Save Gemini key on entry, validate

**Status:** available

## Goal
Typing Gemini key then `Load models` must work without first hitting Save; show inline validation on key change per provider.

## Files
- `src/entrypoints/options/App.tsx:62` & `onboarding:78` provider form
- `src/lib/storage.ts:85` `saveApiKey`
- `src/lib/api.ts:498` `listModels`
- New `src/lib/providerValidation.ts` (or extend `customProvider.ts`)

## Steps
1. Add `validateApiKey(provider, key)` pure helper: empty → `Enter your {label} API key`, Gemini `AIza` strict optional → non-empty
2. In both UIs add debounced `useEffect([provider, apiKey])` → `saveApiKey(apiKey.trim(), provider)` (400ms) + immediate flush `await saveApiKey` before `listModels` click; keep `Save` as final sync
3. Wire validation to `Input` error prop + `hint` under field, disable `Load models` when invalid (or show hint, let `listModels` fail friendly)
4. `selectProvider` already `getApiKey(newId)` — after persist, switch back loads saved key

## Verification
- Select Gemini → type `AIza…` → `Load models` without Save → chips populate
- Clear key → inline `Enter your Gemini API key` appears
- Switch provider → per-provider key restored
