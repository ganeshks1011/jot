# Jot insert bugs — debug handoff (Reddit / Lexical editor)

Snapshot of repo state: `682ad4a`. Self-contained — all referenced code is inlined; no repo access needed.

## 1. Project context

Monorepo `wurkflo/` (npm workspaces): React Router web app at root (backend), Jot Chrome MV3 extension at `apps/jot/` (WXT, React 19, TypeScript strict), shared pure TS at `packages/shared/`. Jot rewrites the user's selected text via `POST /api/ai/rewrite` (SSE stream) and writes the result back into the page.

Insertion is done by an on-demand injected controller, `apps/jot/src/entrypoints/jot-host.ts` (~1000 lines, no persistent content script), talking to the overlay iframe over a `postMessage` bridge (`apps/jot/src/entrypoints/overlay/lib/bridge.ts`). Framework-editor write logic lives in `apps/jot/src/lib/editors/` (`slack.ts` = Slack-specific precedent with fake-deps unit tests; `richText.ts` = universal Lexical/Slate/ProseMirror/Quill/Draft.js/CKEditor path).

Conventions: real editing input only (never `innerHTML` on live fields), every write verified by read-back, diagnostics are lengths/tags only (never message content), no new dependencies.

## 2. Bug 1 — duplicate inserts on Reddit comment edit (main issue)

Rewriting a Reddit comment and pressing Enter pastes ~2–9 copies. Latest failure UI, verbatim:

> Couldn't update the editor. Copy the rewrite instead.
> via ? · composer DIV · before 1579 → after 4887 chars (expected 1210) · 3 attempts

Earlier session: `before 1579 → after 4885 (expected 1314) · 3 attempts · strategy null`. Panel correctly stays open with copy/retry. So: 3 attempts, zero verifies, growth in fragments (never two verbatim copies — the count-based circuit-breaker never trips).

### 2a. Write path (`richText.ts`, simplified current logic)

```ts
for (let attempt = 0; attempt < 3; attempt++) {
  root = resolveFrameworkRoot(deps); // closest('[data-lexical-editor="true"]') from field, else focused
  focus(); if (!focusLanded(root)) continue; // activeElement walk-up check
  // whole-text op:
  selectAll(); await flush(); selectAll(); coverageCheck(); // coverage = sel text === editor text
  execCommand("insertText", text); dispatch input; await flush();
  verifyExact(root, text); // normalized === required (containment does NOT pass)
  if (duplicated(actual, expected)) fail; // expected text present ≥2 times
  if (overgrown(actual, preLen, expectedLen)) fail; // > preLen + expectedLen + 512
  // ... same shape for the line-by-line fallback
  // (select-all + insertText per line + insertParagraph between) ...
}
// on failure with growth: best-effort snapshot restore, then report failure
```

Host (`jot-host.ts` `insert` case): the framework branch awaits this and posts `insert-result` / `insert-failed`; an `insertInFlight` guard serializes overlapping runs (second `insert` mid-write is ignored, `try/finally` reset); the overlay closes on host verdict with a 15s backstop instead of the old blind 700ms timer.

Flush primitive (`liveRichTextDeps`): double-`requestAnimationFrame` raced against a 150ms timeout (backgrounded tabs stall rAF).

### 2b. Leading theory: DOM-vs-model selection race

All gates verify the **DOM selection**, but Lexical executes `execCommand` against its **model selection**, which it derives asynchronously from `selectionchange` events. Sequence select → exec runs while the model still holds the stale collapsed cursor → the write appends at the old cursor instead of replacing; the flush happens *after* exec. Coverage passes (DOM looks right), reads show fragmentary growth, the breaker stays blind (partials ≠ 2 verbatim copies).

Mitigations already landed that did NOT fix it: pre-exec flush + coverage re-check, focus-landing gate, absolute-growth breaker, snapshot restore on failure, run serialization, dropped a double-applying synthetic `beforeinput` (Chrome's `execCommand` already fires a real one).

### 2c. Questions

1. Given guards verifying DOM state all pass yet appends still occur, how can extension code force Lexical's model selection to sync (beyond awaiting rAF/timeout after setting the DOM selection), or should the write go through the clipboard / `insertFromPaste` path instead?
2. What op-level evidence would falsify the model-lag theory? (A lengths-only per-op trace exists in-tree: `{attempt, op: "whole"|"multiline", execReturn, preOpLen, postOpLen, verifyOk}` — e.g. growth with `execReturn:false` points elsewhere.)
3. Is there a known `execCommand("insertText")` length/behavior cliff in Lexical for ~1200-char payloads containing newlines?

## 3. Bug 2 — list tags flattened at insert (confirmed, separate)

The SSE stream provably contains `<ul>/<li>/<strong>` — per-token deltas split tags arbitrarily (`"<p"`, `">"`, `".</"`, `"p"`, `"ul"`, `"li"`, `"strong"`), and the accumulated result reassembles fine. The overlay preview renders real bullets. The posted Reddit comment gets `- ` dash lines.

Cause: the framework verified path drops the `html` payload and inserts `htmlToPlainText()` output (`<li>` → `"- "`, by design). Reference — sanitizer allowlist (`apps/jot/src/lib/richText.ts`):

```ts
const ALLOWED_BARE = new Set(["p", "br", "ul", "ol", "li", "b", "strong", "i", "em", "u"]);
```

Backend prompt rule (`app/core/routes/api.ai.rewrite.ts`, `HTML_PRESERVATION_RULE`) explicitly requires preserving list structure and the `p, br, ul, ol, li, b, strong, i, em, u, a` subset — the model complies; insert is the sole lossy step on framework editors (generic contenteditables use `insertHTML` and keep tags; Slack keeps plain-text pills by design).

Planned fix (not implemented): try `execCommand("insertHTML", sanitizedHtml)` first with item-text-containment verify, fall back to the plain-text verified path.

## 4. Already landed (don't re-suggest)

Flush-aware verify; exactly-one-op-per-strategy; focus + selection-coverage gates; verbatim-duplication + absolute-growth breakers; snapshot restore on failure; host in-flight serialization; verdict-unified close flow. Suite: 287 extension tests green (including model-lag simulations), `tsc` clean, Biome clean on new code.

## 5. Reproduction

Load `apps/jot/.output/chrome-mv3` unpacked (`npm run build:jot` from repo root; needs gitignored `apps/jot/.env` with the `VITE_FIREBASE_*` keys plus Wurkflo sign-in; rebuild after env changes). Open a Reddit comment composer (`shreddit-composer` wrapping `div[contenteditable][data-lexical-editor="true"]`), select comment text, Ctrl/Cmd+Shift+Space, wait for the rewrite, press Enter. Console (Verbose level on): `[jot] rich-write` per-op lines + `[jot] verified insert` summary. Relevant verify commands: `npm run typecheck -w jot`, `npm test -w jot` (vitest), `npm run format:check` (Biome).
