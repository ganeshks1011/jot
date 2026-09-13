# Jot

Contextual AI writing assistant for Chrome (Manifest V3) — rewrite and format selected text inside any page, keyboard-first, with a Raycast/Spotlight-style interface.

> **Naming:** the extension is **Jot**; the sibling backend service is **wurkflo** (the `wurkflo` provider routes to that backend).

## What it does

- Rewrites selected text in short-form editable fields (Gmail, Slack, LinkedIn, Twitter, web forms) into a chosen style: Personalized (your own prompt), Casual, Pro, Announce, Post, or Chat.
- Keyboard-first overlay: navigate and fire actions with arrows, Enter, Escape, Tab — no mouse required.
- Press **Ctrl/Cmd+Shift+Space** (or click the toolbar icon) while focused on a text field — or with text selected — and the overlay opens as a `chrome-extension://` iframe anchored near your cursor.
- Iterative tweaks ("make it shorter") in a follow-up input, then commit back into the page.

## Privacy model (activeTab)

Jot has **no host permissions** and **no persistent content scripts**. It runs nowhere until you invoke it:

1. You press the shortcut or click the toolbar icon → Chrome's `activeTab` grants temporary access to that tab only.
2. Jot injects a small controller via `chrome.scripting.executeScript` that reads the focused field / selection and shows the overlay.
3. Closing the overlay tears the controller down completely — nothing stays injected.

See [docs/PRIVACY.md](docs/PRIVACY.md).

## Stack

WXT · Vite · React 19 · TypeScript · Tailwind CSS v4 · HeroUI v3 (`@heroui/react` + `@heroui/styles`) · lucide-react. All styles are inlined at build time — no external/CDN runtime dependencies.

## Providers

- **Jot rewrite API (default):** managed backend with Firebase auth + SSE streaming + server-side quota.
- **OpenAI-compatible (BYOG):** any endpoint — base URL + API key + model (list loaded live from `GET {baseUrl}/models`, selectable chips, free-text fallback). Works with OpenCode Go (`https://opencode.ai/zen/v1`), OpenAI, **Gemini** (`https://generativelanguage.googleapis.com/v1beta/openai`), **Grok** (`https://api.x.ai/v1`, recommended model: `grok-4.3`), DeepSeek (`https://api.deepseek.com/v1`, selectable endpoint preset), Ollama, LM Studio. Each provider has a "Get API key" link in settings.
- **Claude (native):** Anthropic Messages API (`POST /v1/messages` with `x-api-key` + `anthropic-version`), browser-triggerable via `anthropic-dangerous-direct-browser-access`. Recommended model: `claude-haiku-4-5`.

All provider requests are relayed through the background service worker (`src/lib/net.ts`) — extension pages are CORS-bound without host permissions; service-worker fetches are not. Claude additionally falls back to a direct browser `fetch` (same native headers) when the relay is unreachable (cold service-worker race). Note for **localhost providers** (Ollama, LM Studio): Chrome's Private Network Access requires the local server to answer CORS/`Access-Control-Allow-Private-Network` preflights (Ollama's `OLLAMA_ORIGINS=chrome-extension://*` covers it).

## Getting started

```bash
npm install
npm run dev      # wxt dev server
npm run build    # → .output/chrome-mv3
```

Load `.output/chrome-mv3` as an unpacked extension via `chrome://extensions`.

## Testing

A trigger page (`test-page.html`, served by the dev/test servers) exercises all three supported field types (`textarea`, `input[type=text]`, `contenteditable`).

**Dev mode:**
```bash
npm run dev                 # serves http://localhost:3000
# load .output/chrome-mv3-dev as an unpacked extension
```
Then open **`http://localhost:3000/test-page.html`**.

**Built mode (standalone HTTP server):**
```bash
npm run build               # → .output/chrome-mv3
npm run test:page           # serves http://localhost:5173
```
Then open **`http://localhost:5173/test-page.html`**.

On the test page: click into a field (or select some text) and press **Ctrl/Cmd+Shift+Space** to open the overlay, cycle styles with ←/→, press **Enter** to rewrite, type a tweak and press **Enter**, then press **Enter** on the content box to insert it back into the field. Pressing the shortcut again closes the overlay. Pages must be served over HTTP — `file://` needs Chrome's "Allow access to file URLs" toggle, and Chrome blocks scripting entirely on `chrome://` pages (Jot shows a short notice window instead).

## Docs

- [`project.md`](project.md) — project todos (tracker, source of truth).
- [`docs/PLAN.md`](docs/PLAN.md) — full architecture, provider abstraction, postMessage contract, keyboard contract, design system, QA checklist.
- [`docs/PRIVACY.md`](docs/PRIVACY.md) — website/page access policy.
- [`AGENTS.md`](AGENTS.md) — conventions and verify commands for AI agents / contributors.

## Notes

- API keys are stored in `chrome.storage.local` (never synced to Google's servers) and masked in the UI.
- Free tier (100 requests/month on wurkflo) is enforced server-side by the wurkflo backend.
- The global browser-level shortcut is changed via `chrome://extensions/shortcuts`.
