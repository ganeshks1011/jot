# Jot — current state (August 2026)

**What it is:** a Chrome MV3 extension — a keyboard-first AI writing assistant that rewrites text *in place* on any web page (Gmail, Slack, LinkedIn, forms) via a Raycast-style overlay.

**Status:** working end-to-end prototype; OpenAI-compatible BYO-key verified live, and the Jot rewrite API managed backend (Firebase auth + SSE streaming + server-side quota) verified live against a local backend.

## User flow

1. Focus any editable field on a page (or select some text).
2. Hit `Ctrl/Cmd+Shift+Space` (browser-level; changeable at `chrome://extensions/shortcuts`) or click the Jot toolbar icon.
3. A small overlay appears anchored near the field; the captured text is rewritten automatically into the active mode (~1–2s).
4. Arrow keys switch modes — Personalized / Casual / Pro / Announce / Post / Chat — each result is **cached**, so switching back is instant with no refetch.
5. Type a tweak ("shorter", "more confident") + Enter (or the send button) → refetches with that instruction applied.
6. Enter on the result writes it back into the field. Escape closes, restores focus, and removes Jot from the page entirely.

## What's implemented

- **Trigger:** fully on-demand - the global browser shortcut or the toolbar click grants activeTab access at that moment; a tiny controller is injected via `chrome.scripting.executeScript`, does its job, and tears itself down. No sparkle button, no persistent content script, nothing runs between invocations
- **Modes:** 6 style presets (personalized, casual, professional, announcement, post, chat) with system prompts, per-site custom prompts, and enable/disable per mode
- **Streaming:** Jot rewrite API renders tokens as they arrive (SSE); BYO-key providers insert the full result in one chunk
- **Wurkflo account link:** web-based handoff — the options page opens `wurkflo.app/extension/auth?ext=<id>`; after sign-in + TOS consent the web app redirects to the extension's `auth-callback.html#code=<single-use code>`, which parks it for the options page to exchange for a Firebase custom token (`signInWithCustomToken` → durable session). No raw JWTs ever travel in URLs.
- **Server-enforced TOS:** `/api/auth/link/start` rejects missing/mismatched `acceptedTosVersion` and records acceptance on `users/{uid}`; version bumps force re-consent
- **Background token authority:** the service worker owns the persisted Firebase session; the partitioned overlay iframe requests fresh ID tokens from it via `runtime.sendMessage` — no Firebase auth state inside the iframe
- **Quota badge:** `X-Jot-Remaining` from each rewrite is cached and shown as "N of 100 free requests left this month"
- **Smart apply:** rewrites are inserted back into the source field (textarea/input/contenteditable); focus restored on close
- **ASCII output rules:** every request enforces keyboard-only characters in model output and shipped UI copy
- **Settings page:** provider choice (Jot rewrite API managed, or OpenAI-compatible direct with selectable endpoint presets), base URL/model/API key for BYO keys (`chrome.storage.local` only, masked), live model list
- **Provider abstraction:** one `ProviderAdapter` interface; all HTTP relayed through the background service worker (`src/lib/net.ts`) since extension pages are CORS-bound without host permissions; Jot rewrite API streams via a dedicated Port
- **Theming:** follows OS light/dark via HeroUI v3 oklch tokens; all styles bundled, no CDN/webfonts

## Architecture

WXT-generated MV3 manifest with `storage` + `activeTab` + `scripting` only — no host permissions, no persistent content scripts. React 19 + TypeScript (strict) + Tailwind CSS v4 + HeroUI v3. On invocation (chrome.commands shortcut / action click), the background worker injects a small unlisted controller (`jot-host.ts`) into the active tab via `chrome.scripting.executeScript`; it captures the focused field or selection, anchors the `chrome-extension://` overlay iframe, and tears itself down on close. UI talks to it over a validated postMessage bridge (origin-checked against `chrome.runtime.id`). Provider HTTP is relayed through the service worker, which is not CORS-bound. The backend (`wurkflo.app`, React Router framework mode) exposes `POST /api/ai/rewrite` — bearer-token auth, Firestore transaction quota (100 free/month), DeepSeek chat streamed as SSE with byte-stable system prompts for prefix caching. Link codes live at `link_codes/{code}`: single-use, 5-minute TTL, consumed atomically. `VITE_WURKFLO_ORIGIN` overrides the backend origin for local QA builds (also allow-listed in `web_accessible_resources` at build time).

## Verified this iteration

Full link handshake headlessly (login → consent gate → code mint/exchange → custom token sign-in, replay + expiry + wrong-TOS rejected), streaming rewrite through the local backend into the overlay (200, SSE render), insert-back + focus restore, quota badge updates, background token refresh from the iframe context, CORS preflights, typecheck + build green in both repos.

## Known limits / feedback welcome

- No canvas-based editors (Google Docs, Figma) by design — no DOM text nodes
- One model at a time (no per-mode model routing)
- Overlay placement heuristics untested on multi-monitor/scaled displays
- Google sign-in popup path was removed in favor of the web handoff (works headless-testably and provides a TOS surface); re-add only if needed
