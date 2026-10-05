# Todo 15 — Disable Gemini thinking, strip thought

**Status:** available

## Goal
Gemini must return only `content`, never `thought`/`thinking`; disable server thinking.

## Files
- `src/lib/providers/gemini.ts` (or `openai.ts` Gemini branch)
- `src/lib/prompts.ts:1` `buildSystemPrompt`
- `src/lib/api.ts:84` customInstruction
- `src/lib/config.ts:1` already single source, no change

## Steps
1. Extend provider (both shapes):
   ```ts
   if (isGemini) {
     delete payload.thinking; delete payload.thought; delete payload.though; delete payload.reasoning;
     payload.thinking = { type: "disabled" };
     payload.thought = { enabled: false };
     payload.reasoning = { effort: "none" };
     (payload as any).extra_body = { google: { thinking_config: { thinking_level: "none", thinking_budget: 0 } } };
   }
   ```
2. Guard `customPrompt`/`systemPrompt` before send: strip `thought:` prefix / `though` key when `provider==="gemini"`
3. Strip response: `const content = raw.content ?? raw.output_text ?? ""` → `normalizeRewriteOutput(content)`; ignore `raw.thought`/`reasoning`/`thinking` even if `content` empty → `empty` error

## Verification
- Gemini `3.5` rewrite network body has no `thought`/`thinking`, response UI only shows `content`; `npm run typecheck/build` green
