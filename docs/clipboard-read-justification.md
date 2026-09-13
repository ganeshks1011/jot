# `clipboardRead` Permission Justification — Jot Chrome Extension

Use this document when answering Chrome Web Store review questions or presenting
why Jot declares the `clipboardRead` permission.

## Short version (paste into the store justification field)

> Jot rewrites the user's selected text and inserts the result back into the
> page field. For framework-driven rich editors (Lexical, Slate,
> ProseMirror/TipTap, Quill, Draft.js, CKEditor) the only reliable insert is a
> single `document.execCommand("paste")` of the rewrite the extension just
> wrote to the clipboard; Chrome requires the `clipboardRead` permission for
> that paste command. It is used only at the moment the user presses Enter to
> insert, only into the field they invoked Jot on, and the pasted content is
> always Jot's own just-generated rewrite — never harvested clipboard data.

## What the permission does

- Enables the host controller's one-shot framework-editor insert:
  `pasteClipboardOnce()` (`src/lib/editors/richText.ts`) calls
  `document.execCommand("paste")`, invoked only from the framework-editor
  branch (`src/entrypoints/jot-host.ts`).
- Before that call, the overlay primes the clipboard with its own rewrite
  output (`primeClipboardForInsert`, `src/entrypoints/overlay/App.tsx`), so
  the paste can never act on another app's content.
- A refused paste is atomic at the selection and leaves the editor untouched;
  the user recovers with the Copy button, which holds the same content.

## Why there is no alternative

- Plain inputs use `setRangeText`; contenteditables use
  `insertHTML`/`insertText` plus a DOM `Range` fallback — no clipboard
  involved. Framework editors ignore synthetic DOM writes because their
  document model desyncs; the single trusted paste is the only insert they
  honor atomically.
- Making the permission optional was rejected: runtime permission prompts on
  framework sites are unacceptable UX, so it is a required install permission.

## Scope limits (proof of minimal use)

- No `navigator.clipboard.readText()` / `read()` calls exist anywhere in the
  codebase — the permission is never used for async clipboard reads.
- No `host_permissions`, no `<all_urls>`, no persistent content scripts. Page
  access is `activeTab`-gated to the tab the user explicitly invoked Jot on
  (shortcut or toolbar click), and the injected controller tears down when the
  overlay closes (see the manifest comment in `wxt.config.ts`).
- The paste fires at most once per user-confirmed insert, into the captured
  field/selection only. Overlay writes rely on the iframe's
  `allow="clipboard-write"` delegation plus the `execCommand("copy")`
  fallback — no `clipboardWrite` manifest permission is declared.

## What breaks without it

Removing `clipboardRead` makes `execCommand("paste")` return false / refuse,
so rewrite insertion silently stops working in framework editors (Lexical,
Slate, ProseMirror, Quill, Draft.js, CKEditor) while plain fields keep
working — a confusing partial outage. That is why the permission is required
rather than optional.

## Current manifest (verified)

```json
"permissions": ["storage", "activeTab", "scripting", "contextMenus", "clipboardRead"]
```
