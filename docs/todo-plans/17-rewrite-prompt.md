# Todo 17 — Update rewrite prompt with mode_instruction

**Status:** available

## Goal
System prompt must wrap active mode instruction in common template with `{mode_instruction}` placeholder.

Template:
```
You rewrite text according to the active mode.

ACTIVE MODE:
{mode_instruction}

Preserve the user's meaning, intent, facts, viewpoint, and important details. Keep roughly the same length unless the active mode requires otherwise.

Make it natural, clear, direct, and human. Improve expression, not substance.

Do not invent facts or context, change the author's position, or add hype, CTAs, hashtags, headings, or explanations unless required by the active mode or already present.

Use standard keyboard characters only. Preserve meaningful characters such as URLs, @mentions, hashtags, code, product names, and technical syntax. Use "-" instead of em/en dashes, "..." instead of "…", straight quotes and apostrophes, and normal spaces. Do not introduce decorative or non-standard Unicode characters.

Return only the rewritten text.
```

## Files
- `src/lib/prompts.ts:1` add `COMMON_PROMPT` + `buildSystemPrompt(modeInstruction)` with replace
- `src/lib/api.ts:36` `rewriteText` and `:67` `rewriteWithInstruction` call `buildSystemPrompt(modeInstruction)` where mode_instruction is `resolveModePrompt` (custom) or `getMode(mode).systemPrompt`
- `src/lib/prompts.test.ts:1` add test for placeholder and keyboard rule

## Steps
1. Define `COMMON_PROMPT` constant with `{mode_instruction}` placeholder
2. Update `buildSystemPrompt(modeInstruction: string)` to replace placeholder
3. Update `api.ts` call sites to pass mode_instruction (resolve per mode/site)
4. Add test: `expect(buildSystemPrompt("Pro")).toContain("ACTIVE MODE:\nPro")` + common block checks
5. `npm run typecheck && build && test`

## Verification
- Manual rewrite in Professional mode → network system prompt contains `ACTIVE MODE:` + professional instruction + keyboard rule; custom mode still resolves via sitePersonas
