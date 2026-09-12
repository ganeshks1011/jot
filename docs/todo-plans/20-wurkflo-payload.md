# Todo 20 — Deduplicate Wurkflo systemPrompt userPrompt payload

**Status:** available

## Goal
Payload currently 7 keys: `mode,input,text,personalization,customPrompt,instruction` with `input`==`text` and `personalization`==`customPrompt`==`instruction` (3× ~800 chars). Should be only `systemPrompt` (common + mode_instruction) and `userPrompt` (input).

## Files
- `src/lib/api.ts:92` `streamWurkfloWithInstruction` and `228` `streamWurkfloRewrite`
- `src/lib/prompts.ts:15` `COMMON_PROMPT` already with `{mode_instruction}`

## Steps
1. Build `systemPrompt = buildSystemPrompt(instruction)` (COMMON_PROMPT replace) and `userPrompt = buildUserMessage({input: source})` (or with feedback)
2. Payload: `{ mode, systemPrompt, userPrompt, websitePersonality? }` — drop `input`/`text`/`personalization` triplicate (keep `text` alias one release if backend needs backward compat, then remove)
3. Keep `mode` for routing or drop if backend infers from systemPrompt — confirm
4. Verify `X-Jot-Remaining` still parsed, `normalizeRewriteOutput` still only on `content`

## Verification
- Step 3/6 Rewrite → DevTools POST shows 3 keys (`mode,systemPrompt,userPrompt`) not 7, no triplicate, rewrite succeeds
