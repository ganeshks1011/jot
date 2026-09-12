# Jot Chrome Extension — Deep Technical Architecture

> **Purpose:** Complete technical blueprint of the Jot Chrome MV3 extension, captured
> from the working codebase on 2026-08-30. This document is written to be sufficient,
> in isolation, to re-create the extension faithfully. Treat it as the single source
> of truth for *how the current system is built and wired together*.
>
> **Companion docs:** `architecture.md` (current/target layers), `target.md` (clean-arch
> target), `decisions.md` (ADR log), `refactor-plan.md` (backlog), `progress.md` (live
> status), `docs/PLAN.md` (product-level implementation plan), `docs/STATUS.md`
> (state-of-the-art narrative), `docs/PRIVACY.md` (access policy).

---

## 1. Product Overview

**Jot** is a keyboard-first, privacy-preserving AI writing assistant for Chrome
(Manifest V3). It rewrites text the user has selected or is typing inside any page
(replies, comments, posts, announcements) into one of six style "modes", then inserts
the rewrite back into the original field.

**Core interaction loop:**

1. The user focuses any editable field on a page (textarea, `input[type=text]`
   variants, or `contenteditable`) or selects some plain text.
2. They press the browser-level shortcut (**Ctrl/Cmd+Shift+Space**) or click the Jot
   toolbar icon.
3. Chrome's `activeTab` grants temporary access to the active tab *at that moment*; the
   background service worker injects a small unlisted controller (`jot-host.js`) via
   `chrome.scripting.executeScript`.
4. The controller captures the focused field / selection, creates a
   `chrome-extension://` overlay iframe anchored near the cursor, and bridges to it
   over a validated `postMessage` contract.
5. The overlay automatically rewrites the captured text into the active mode
   (~1–2s), streaming tokens as they arrive for the Wurkflo provider.
6. The user cycles modes with arrow keys (each mode's output is cached per
   source/tweak/site), issues follow-up tweaks ("shorter", "more confident"), and
   presses **Enter** to write the result back into the field.
7. **Escape** closes the overlay, restores focus, and **completely tears down all
   injected code** — nothing remains in the page.

**Privacy model (the defining architectural constraint):**
- **No host permissions** — Jot declares `["storage", "activeTab", "scripting"]` only.
- **No persistent content scripts** — nothing runs on a page until invocation; the
  injected controller is destroyed on close.
- **No `all_urls`** — provider HTTP is relayed through the background service worker
  (which is not CORS-bound), so no site permissions are needed for network access.

---

## 2. Technology Stack & Build Tooling

| Concern | Choice |
|---|---|
| Extension framework | **WXT** (`wxt ^0.21.4`) |
| Build | **Vite** (via WXT) + `@wxt-dev/module-react ^1.2.2` |
| Language | **TypeScript ~5.9.3** (strict) |
| UI framework | **React 19.2** + `react-dom` |
| Component library | **HeroUI v3** (`@heroui/react ^3.2.4`, `@heroui/styles ^3.2.4`) |
| Styling | **Tailwind CSS v4** (`tailwindcss ^4.3.3` + `@tailwindcss/vite`) + `tailwind-variants` |
| Icons | **lucide-react** |
| Backend (managed) | **Firebase** (`firebase ^12.18.0`) — Wurkflo provider auth |
| Testing | **Vitest** (`vitest ^2.1.9`) |
| Package manager | npm |

**Key npm scripts** (`package.json`):

| Script | Command | Purpose |
|---|---|---|
| `dev` | `wxt` | Dev server → `.output/chrome-mv3-dev` |
| `dev:firefox` | `wxt -b firefox` | Firefox dev build |
| `build` | `wxt build` | Production build → `.output/chrome-mv3` |
| `build:firefox` | `wxt build -b firefox` | Firefox build |
| `zip` | `wxt zip` | Packaged `jot-0.1.0-chrome.zip` |
| `typecheck` | `tsc --noEmit` | Strict typecheck |
| `test` | `vitest run` | Unit tests (52 tests, 5 files) |
| `test:page` | `node scripts/serve-test.mjs` | HTTP server for `test-page.html` |
| `postinstall` | `wxt prepare` | Generate `.wxt/` types |

### Source layout

```
src/
├── entrypoints/                 # WXT entrypoints
│   ├── background.ts            # Service worker: relay, SSE, token authority
│   ├── jot-host.ts              # Unlisted on-demand page controller (injected)
│   ├── jot-blocked/index.html   # "Jot can't work on this page" notice
│   ├── overlay/                 # Overlay iframe UI
│   │   ├── App.tsx              # (567 lines) orchestration + rendering
│   │   ├── main.tsx
│   │   ├── index.html
│   │   ├── style.css
│   │   ├── components/
│   │   │   ├── ModeTabs.tsx
│   │   │   ├── ContentBox.tsx
│   │   │   └── FeedbackInput.tsx
│   │   └── lib/bridge.ts        # postMessage contract helpers
│   ├── options/                 # Full settings page (open_in_tab)
│   │   ├── App.tsx              # (803 lines)
│   │   ├── main.tsx / index.html / style.css
│   ├── onboarding/              # First-run flow (6 steps)
│   │   ├── Onboarding.tsx       # (551 lines)
│   │   ├── main.tsx / index.html / style.css
│   └── auth-callback/           # Web→extension auth handoff landing page
│       ├── App.tsx              # (75 lines)
│       ├── main.tsx / index.html / style.css
├── lib/                         # Shared logic (flat, see Layer map in §5)
│   ├── api.ts                   # rewrite orchestration (transport only)
│   ├── auth.ts                  # Wurkflo Firebase session (138 lines)
│   ├── firebase.ts              # Firebase init (37 lines)
│   ├── net.ts                   # background relay client (195 lines)
│   ├── normalizeOutput.ts       # char normalization (pure)
│   ├── personalization/         # user style: resolve/build/store (single mode)
│   ├── providers.ts             # ProviderAdapter + adapters (260 lines)
│   ├── sitePersonas.ts          # built-in site personas (pure)
│   ├── storage.ts               # chrome.storage persistence + facades (268 lines)
│   ├── theme.ts                 # OS theme application
│   └── types.ts                 # shared domain types
├── test/setup.ts                # Vitest setup
└── (entrypoints each import ./style.css)
```

### WXT configuration (`wxt.config.ts`) → built Manifest V3

The manifest is generated by WXT from `wxt.config.ts`:

- `srcDir: "src"`
- `modules: ["@wxt-dev/module-react"]`
- `vite.plugins = [tailwindcss()]`
- Optional `VITE_WURKFLO_ORIGIN` env override is inlined via `define` into
  `import.meta.env.VITE_WURKFLO_ORIGIN` and appended to the `auth-callback.html`
  web-accessible-resource matches.

**Built `manifest.json` (from `.output/chrome-mv3/manifest.json`):**

```json
{
  "manifest_version": 3,
  "name": "Jot",
  "description": "Write it rough. Jot it right. Turn rough thoughts into replies, comments, posts, and announcements.",
  "version": "0.1.0",
  "permissions": ["storage", "activeTab", "scripting"],
  "commands": {
    "toggle-jot": {
      "suggested_key": { "default": "Ctrl+Shift+Space", "mac": "Command+Shift+Space" },
      "description": "Toggle the Jot overlay on the focused field"
    }
  },
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'none'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' https: http: wss:; worker-src 'self'"
  },
  "web_accessible_resources": [
    { "resources": ["overlay.html"], "matches": ["http://*/*", "https://*/*"] },
    { "resources": ["auth-callback.html"], "matches": ["https://wurkflo.app/*"] }
  ],
  "background": { "service_worker": "background.js" },
  "options_ui": { "open_in_tab": true, "page": "options.html" },
  "icons": { "16": "icon/icon16.png", "32": "icon/icon32.png", "48": "icon/icon48.png", "128": "icon/icon128.png" }
}
```

> **Note:** `content_security_policy` allows `connect-src 'self' https: http: wss:`
> — required because provider relays and the Wurkflo SSE stream run through the
> service worker. `style-src`/`font-src` permit Google Fonts.

---

## 3. Clean Architecture Map (current code → layers)

The codebase uses a **flat `src/lib/`** layout with **logical** layer boundaries
(enforced by convention / ADR-001, not physical folders). The mapping below is the
authoritative classification used for architecture checks.

### Dependency direction (enforced)

```
UI (entrypoints + components)
  ↓            ↓
Application (api.ts use cases)
  ↓
Domain (pure: types, personalization/{resolve,prompts,sliders,canonical,types}, sitePersonas, normalizeOutput)
```

```
Infrastructure (storage, net, providers, auth, firebase, theme, bridge,
               background, jot-host, entrypoints)
  ↓
Application / Domain
```

**Forbidden:** Domain → UI/Infrastructure/Chrome/React; Application → UI;
UI → persistence/http directly.

### Classified modules

| Layer | Files | Notes |
|---|---|---|
| **Domain** (pure, Node-testable) | `types.ts`, `personalization/{resolve,prompts,sliders,canonical,types}`, `sitePersonas.ts`, `normalizeOutput.ts` | Import nothing outside domain |
| **Application** (use cases) | `api.ts`, `personalization/{index,store}` | `rewriteText`, `streamWurkfloRewrite`, `listModels`, prompt builders + snapshot store |
| **Infrastructure** | `storage.ts`, `net.ts`, `providers.ts`, `auth.ts`, `firebase.ts`, `theme.ts`, `bridge.ts`, `background.ts`, `jot-host.ts` | External-system implementations |
| **UI** | `overlay/**`, `options/**`, `onboarding/**`, `auth-callback/**` | Presentational + orchestration (see god-component findings) |

> **Known deviations tracked in the refactor plan:**
> 1. `storage.ts` (infra) hosts the personalization snapshot accessors alongside
>    unrelated persistence (kept to preserve public API).
> 2. `overlay/App.tsx` and `options/App.tsx` are god components carrying orchestration
>    (planned extraction to hooks/controllers — refactor Tasks 5, 6).
> 3. `scripts/architecture-check.ts` is a placeholder (Task 4).

---

## 4. Runtime Execution Flow

### 4.1 Invocation (all paths)

```
User presses Ctrl/Cmd+Shift+Space  OR  clicks toolbar icon
        │
        ▼
background.ts → commands.onCommand / action.onClicked
        │  activateJot()
        ▼
browser.tabs.query({active, currentWindow})
        │
        ▼
browser.tabs.sendMessage(tabId, {type:"TOGGLE_OVERLAY"})
   ─── if a live controller replies → it toggles itself closed/open ───
   ─── if no receiver (never injected / torn down) → fall through ───
        │
        ▼
browser.scripting.executeScript({ target:{tabId}, files:["jot-host.js"] })
        │
        ├── on success → jot-host.ts runs, opens overlay
        └── on failure (blocked page: chrome://, Web Store) →
              openBlockedNotice(): focus-or-create a 400×200 popup
              pointing at jot-blocked.html
```

**Install handling** (`runtime.onInstalled`): on `reason === "install"`, set
`chrome.storage.sync { "jot:onboarded": false }` and open `onboarding.html` in a tab.

### 4.2 Host controller lifecycle (`jot-host.ts`)

Injected as an **unlisted script** (`defineUnlistedScript`). On execution:

1. If `window.__jotHost` already exists → call `toggle()` and stop (prevents stacking).
2. Otherwise create a `HostController` and store it on `window.__jotHost`.

**`captureSelection()`** (called at open time; resolves target once, no persistent
focus tracking):

- `document.activeElement`; if it is a supported editable, use it as `activeField`:
  - `contenteditable`: use `window.getSelection()` range if there is one within the
    field; else select all content (`range.selectNodeContents`).
  - `HTMLTextAreaElement` or text-like `HTMLInputElement` (`type ∈ [text, search, url,
    email, tel]`): use `selectionStart..selectionEnd`; if collapsed, use the whole value.
- No editable → fall back to a plain page `window.getSelection()` if non-collapsed and
  non-empty.

Captured state: `capturedText`, `capturedStart/End`, `capturedRange` (a cloned `Range`).

**Overlay iframe creation / positioning:**

- Creates `<iframe src="overlay.html">`, `position:fixed`, height `0`
  initially, transparent background, hidden, `z-index:2147483647`, `aria-label="Jot
  assistant"`, transition `height/opacity 120ms`.
- **Geometry** (pure, tested: `src/lib/overlayGeometry.ts`): the card matches the
  composer's exact width; the frame adds `IFRAME_MARGIN=12` per side. The card is
  placed below the field if it fits, else above (`placement` sent with init so the
  overlay draws its connector on the composer-facing edge); horizontal position
  clamped to viewport (`OVERLAY_PADDING=8`). With no anchored field, it floats
  near top-center of the viewport (`innerHeight * 0.2`, 672px card).
- The iframe is offset by `-IFRAME_MARGIN` on each axis to counter the overlay
  document's 12px padding (room for shadow/glow).
- Repositions on `scroll` (capture), `resize`, and composer resize via a
  `ResizeObserver` on the active field (disconnected on close).
- **Composer mirroring:** init carries sampled `composerBg`/`composerFg`
  (computed colors only) plus `placement`; the active composer gets a soft
  purple→red glow while open, with prior inline styles restored on close.

**`openPanel()`:** ensure iframe → `captureSelection` → show → `attachReposition` →
`positionIframe(420)` → send init. Init is sent either after the iframe `load` event
(+60ms) or immediately if already loaded; a 600ms safety timer covers cached documents.
The overlay's own `{type:"ready"}` re-sends init (closing the mount race).

**`closePanel()` → `destroy()`:** focus the launching field, clear the pending timer,
detach listeners, remove iframe, null all state, `delete window.__jotHost`.

**Insertion (`insertText`, returns verified `boolean`):**
- textarea/input: focus, `setRangeText(text, start, end, "end")`, dispatch synthetic
  `input` and `change` events (bubbles).
- contenteditable / plain selection: restore `capturedRange` via Selection, prefer
  `document.execCommand("insertText")`, fall back to manual Range `deleteContents` +
  `insertNode(textNode)` + collapse.
- Slack (`src/lib/editors/slack.ts`, isolated): re-resolve the live composer
  (`activeField` if still connected, else focused editable — no global
  selectors; focus re-read per attempt, never snapshotted), climb to the
  outermost editable ancestor (focus may sit on a nested mention pill),
  select-all + `execCommand("insertText")` + bubbled `input` with a
  `beforeinput` fallback, then read back and compare (zero-width tolerant,
  contains accepted); retries, then report failure. Never assigns DOM text
  properties. Mention pills (`ts-mention[data-id][data-label]`, Quill
  composer) take the entity path in `jot-host.ts`: pills captured at
  invocation, mentions validated (each exactly once, none invented), block
  rebuilt with cloned pills re-anchored at placeholder positions, verified by
  text plus pill-id order; single-block drafts only, otherwise fail safe.

### 4.3 Overlay bridge (`overlay/lib/bridge.ts`)

The bridge is the **only** communication path between the injected controller and the
overlay iframe.

- `isEmbedded()` = `window.parent !== window`.
- `postToParent(msg)` posts `{type,height,text}` to `window.parent` with target
  origin `"*"` (the parent validates).
- Outgoing messages: `ready`, `resize{height}`, `insert{text}`, `close`.
- Incoming (host → overlay): `insert-failed{text}` — verified write-back failed;
  the panel stays open with Copy-to-clipboard + Retry instead of closing.
- Incoming (host → overlay): `metrics{placement, maxPanelHeight}` — refreshed
  placement + panel height budget after viewport resize; `init` carries the
  same `maxPanelHeight` on open.
- `postResize()` posts `{type:"resize", height: documentElement.scrollHeight}`.
- `onInit(cb)` registers a `message` listener; accepts `{type:"init", ...}` **only when
  the event source is `window.parent`**.

**Security on the host side** (`handleOverlayMessage`): validates `event.origin ===
"chrome-extension://" + browser.runtime.id` (derived, not parsed). **Do NOT compare
`event.source === iframe.contentWindow`** — cross-origin WindowProxy wrappers are not
strictly equal in the isolated world. Ignores self-posted messages
(`event.source === window`).

**Message contract summary:**

| Direction | Type | Payload |
|---|---|---|
| Host → overlay | `init` | `{text, fieldType: "textarea"|"input"|"contenteditable"|"selection"|null, site: hostname}` |
| Overlay → host | `ready` | — |
| Overlay → host | `resize` | `{height}` (host clamps to `min(h, innerHeight-24)`, min 160) |
| Overlay → host | `insert` | `{text}` (host inserts then closes) |
| Overlay → host | `close` | — |
| Background → host (runtime msg) | `TOGGLE_OVERLAY` | — (host toggles) |

### 4.4 Overlay application flow (`overlay/App.tsx`)

State machine: `idle → generating → output → tweaking`.

**State/refs:** `source`, `output`, `status`, `inputText`
(follow-up), `inserted`, `error`, `failedText`. Refs: `busyRef`, `pendingRef`,
`siteRef`, `lastKeyRef`/`lastOutputRef` (single-result cache), `abortRef`.

**Init (`onInit`):**
1. Record `site` into `siteRef`; set `source`; clear the result cache.
2. If no text → set `idle`, focus feedback, return.
3. Else `runGenerate(text)` (single user style — no mode selection).
   - If a generation is already in-flight (duplicate init), queue `pending` and
     abort the current — the `finally` picks up pending.

**`runGenerate(text, followUp?)`:**
1. Guard `busyRef`; serve the single-result cache on key hit; else set status
   `generating`, clear error/output.
2. Create `AbortController`, store in `abortRef`.
3. Call `rewriteText(text, siteRef.current, followUp, {signal, onChunk})`.
   The `onChunk` deltas are appended to a local `streamed` buffer and rendered live;
   the resolved value is authoritative for caching.
4. On success: set output, store `lastKeyRef`/`lastOutputRef`.
5. On AbortError → return null quietly. On `ProviderError` → `setError`, clear output.
6. `finally`: clear `busyRef`, set status `output`; if a `pending` rewrite was queued,
   run it (final selection wins).

**`generate(followUp?)`:** if busy, queue pending; else `runGenerate(source,
followUp)`.

**Keyboard contract** (capture-phase on `window`):
- **Escape** → `close()` (abort in-flight, post `close`).
- **Tab/Shift+Tab** → focus trap cycling through: settings button, close button,
  error action buttons (if any) or content box, feedback input.
- **ArrowUp/Down** → move between the two sections (content → feedback; error
  actions occupy the content slot while an error is shown).
- **ArrowLeft/Right** → cycle error action buttons (Open settings ↔ Retry).
- **Enter**:
  - on `#jot-content` → insert current `output` back into the source
    (`insertText`).
  - on `#jot-feedback` → `runGenerate(source, inputText)` (no apply).

**Resize reporting:** a `ResizeObserver` on the root card plus timeouts at 100ms/450ms;
also `postResize()` on `[status, output, inserted, error]` change. Ctrl/Cmd+Shift+Space
closes via the background → host toggle (even while the iframe has focus).

**Error mapping (`errorMessage`):**

| `ProviderError.kind` | User-facing message |
|---|---|
| `no-key` | "Add your API key in Jot's extension settings to start rewriting." |
| `auth` | `err.message` or "The provider rejected the request - check your settings." |
| `rate-limit` | "Rate limited - try again in a moment." |
| `network` | "Could not reach the model server." |
| `empty` | "The model returned an empty response." |
| `quota` | `err.message` or "You've used all Jot completions this month." |

Quota errors render a distinct card with usage (`used / limit · period`), an optional
"Upgrade to {name}" button (only when `upgrade.available && upgrade.redirectUri`), and
no Retry. Non-quota errors render "Open settings" + "Retry". Upgrade URL is
`WURKFLO_ORIGIN + safeUri` where `safeUri` must be relative (`startsWith("/")`) else
defaults to `/jot/upgrade` — arbitrary URLs are never trusted.

---

## 5. Module-by-Module Specification

### 5.1 `src/lib/types.ts` (Domain)

```ts
export type ProviderId =
  | "jot-api" | "opencode" | "openai" | "anthropic" | "gemini";

export interface BackendConfig {
  provider: ProviderId;
  baseUrl: string;
  model: string;
}

export interface SitePrompts {
  pattern: string;   // hostname/URL pattern
  prompt: string;
}
```

### 5.2 `src/lib/personalization/` (single user style; no modes)

Writing modes were removed: one style resolves per site and both transports
receive the finished `{ system, user }` pair opaquely.

- **`types.ts`**: `ContextStyle` (`prompt` + `sliders`), `PersonalizationSnapshot`
  (`{ contexts, domains }`), `TeachState`, `ResolvedStyle`.
- **`resolve.ts`**: `resolveInstruction(snapshot, site?)` precedence —
  exact-hostname site override → base style → built-in persona → default
  instruction. `compileSliders` appends committed slider directives not
  already present. No legacy keys are read or written.
- **`store.ts`**: `jot:personalization` snapshot (sole persistence),
  Teach state load/save/flush. Split legacy keys
  (`jot:contextPrompts`, `jot:contextDomains`, `jot:customModePrompt`,
  `jot:sitePrompts`) are fully retired — neither read nor written.
- **`prompts.ts`**: `COMMON_PROMPT` (`ACTIVE MODE:` + `{mode_instruction}`),
  `buildSystemPrompt()`, `buildUserMessage()` (delimited blocks, fixed order),
  `buildFeedbackBlock()`, `PLACEHOLDER_GUARD`. Must stay in sync with the backend
  `app/core/utils/rewritePrompts.ts`.
- **`sliders.ts` / `canonical.ts`**: slider levels/directives/labels; freeform
  merge + default instruction.
- **`index.ts`**: `buildDirectPrompts()` (`{system, user}`),
  `buildApiPrompts()` (`{systemPrompt, input}`, tweak folded into system),
  `buildPreviewPrompts()` (explicit-instruction bypass).

### 5.3 `src/lib/sitePersonas.ts` (Domain)

- **`BuiltinSitePersona`**: `{id:"facebook"|"x"|"reddit"|"linkedin", label, hostnames[],
  prompt}`.
- **`GLOBAL_CHARACTER_RULE`**: keyboard-only character constraint appended to every
  built-in persona prompt.
- **`BUILTIN_SITE_PERSONAS`** (single source of truth, never written to storage):
  - facebook → `facebook.com`
  - x → `x.com`, `twitter.com`
  - reddit → `reddit.com`
  - linkedin → `linkedin.com`
- **`matchesSite(pattern, hostname)`**: trims, lowercases, strips `http(s)://`. `*.
  example.com` matches apex + subdomains; bare `example.com` matches itself +
  subdomains but not `notexample.com` / `example.com.evil.com`.
- **`findBuiltinPersona(site?)`**: first persona whose hostname matches, else null.
- **`buildPersonaPrompt(persona)`**: `persona.prompt + "\n\n" + GLOBAL_CHARACTER_RULE`.

### 5.4 `src/lib/normalizeOutput.ts` (Domain)

`normalizeRewriteOutput(text)` applies a fixed replacement table **only** for the exact
prohibited characters (leaves all other non-ASCII untouched):

| Pattern | Replaced by |
|---|---|
| em/en dash `\u2014\u2013` | `-` |
| smart double quotes `\u201C\u201D` | `"` |
| smart single/apostrophes `\u2018\u2019` | `'` |
| ellipsis `\u2026` | `...` |
| bullet `\u2022` | `-` |
| NBSP `\u00A0`, narrow NBSP `\u202F` | ` ` |
| zero-width `\u200B\u200C\u200D\uFEFF` | removed |

Safe per streamed delta because every target is a single UTF-16 code unit.

### 5.5 `src/lib/providers.ts` (Infrastructure)

```ts
export type ProviderErrorKind = "no-key"|"auth"|"rate-limit"|"network"|"empty"|"quota";

export interface ProviderAdapter {
  id: ProviderId; label: string;
  defaultBaseUrl: string; defaultModel: string;
  tiersEnforcedServerSide: boolean;   // wurkflo true; direct providers false
  rewrite(config, apiKey, system, user): Promise<string>;
  listModels(config, apiKey): Promise<string[]>;
}
```

- **`ProviderError`**: carries `kind`, optional `quota`/`upgrade`/`status`.
- **`chatCompletions()`** (shared by all OpenAI-compatible adapters):
  - Throws `ProviderError("no-key")` / `("network")` for missing key/base URL.
  - `POST {baseUrl}/chat/completions` via `relayFetch`, `Authorization: Bearer`,
    `{model, messages:[system,user], temperature:0.7, max_tokens:1024}`.
  - Maps status: 401/403 → `auth` (surfaces server `error.message` if present, e.g.
    opencode "Insufficient balance"); 429 → `rate-limit`; other !ok → `network`.
  - Parses `choices[0].message.content`; empty → `error("empty")`.
- **`listModels(config, apiKey)`**: `GET {baseUrl}/models`, handles both
  `{data:[{id}]}` and flat-POST shape; returns a unique `string[]`.
- **`makeAdapter(...)`** factory. Prebuilt adapters:

| Adapter const | id | Default base URL | Default model |
|---|---|---|---|
| `JOT_API_ADAPTER` | jot-api | `https://wurkflo.app` | `deepseek-chat` |
| `OPENCODE_ADAPTER` | opencode | `https://opencode.ai/zen/v1` | `deepseek-v4-flash` |
| `OPENAI_ADAPTER` | openai | `https://api.openai.com/v1` | `gpt-4o-mini` |
| `ANTHROPIC_ADAPTER` | anthropic | `https://api.anthropic.com/v1` | `claude-sonnet-4-5` |
| `GEMINI_ADAPTER` | gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` |

- **`JOT_API_ADAPTER`** overrides `rewrite` (throws `network`) and `listModels` (returns
  `["deepseek-chat"]`) — it exists only for settings metadata; real Jot rewrite API requests go
  through `streamWurkfloRewrite` in `api.ts`.
- **`ADAPTERS`**: `Record<ProviderId, ProviderAdapter>` exporting all five.
- **`OPENAI_ENDPOINT_PRESETS`**: selectable base URLs for the OpenAI adapter
  (OpenAI, DeepSeek, Ollama, LM Studio). Tapping a preset sets the base URL only;
  models load live via `GET {baseUrl}/models`.

### 5.8 `src/lib/net.ts` (Infrastructure)

Extension pages are CORS-bound (no host permissions); the **background service worker is
not**. All provider HTTP goes through the worker.

- **`relayFetch({url, method, headers, body})`** → `{ok,status,text}`:
  - Sends `runtime.sendMessage({type:"jot:http", ...req})`.
  - Validates the response shape; retries once (350ms) on transient errors matched by
    `isTransientRelayMsg` (`relay-failed|stream-failed|network-error|Failed to fetch|
    Receiving end does not exist|Could not establish connection|Extension context
    invalidated|Could not reach`).
- **`relayStream(req, {onChunk, onRemaining?}, signal?)`** → `Promise<void>`:
  - Opens a `runtime.connect({name:"jot:sse"})` Port, posts `{type:"start", ...req}`.
  - Handles port messages: `headers`→`onRemaining`; `chunk`→`onChunk(raw)`;
    `done`→resolve; `http-error`→reject with `status`/`body`; `error`→reject.
  - `onDisconnect`: if not settled — resolve if `done` was seen; if no chunk was seen,
    reject `relay-failed` (or `stream-failed`); if a mid-stream disconnect happened
    after some data, resolve (caller decides).
  - `signal` abort → disconnect port, reject `AbortError`.

### 5.6 `src/lib/storage.ts` (Infrastructure)

**Storage keys** (constants defined here):

| Key | Area | Value |
|---|---|---|
| `jot:backend` | sync | `BackendConfig` |
| `jot:apiKey` | local | `string` (secret — never sync) |
| `jot:personalization` | sync | `PersonalizationSnapshot` (`{contexts, domains}`) |
| `jot:contextExamples` | sync | `ContextExample[]` (Teach playground) |
| `jot:onboarded` | sync | `boolean` |
| `jot:wurkfloUser` | local | `{uid, email}` snapshot (or removed on sign-out) |
| `jot:wurkfloRemaining` | local | `number` (cached `X-Jot-Remaining`) |
| `jot:wurkfloLinkCode` | local | `string` (single-use code parked by auth-callback) |

**Functions:**

- Backend config: `getBackendConfig()` (resolves provider→adapter, falls back to
  `jot-api` defaults, quietly migrates retired `wurkflo`/`deepseek` ids),
  `saveBackendConfig(cfg)`, `getApiKey/saveApiKey`.
- Personalization snapshot: `get/savePersonalizationSnapshot()` (sole style
  persistence; legacy split keys retired).
- Teach examples: `get/saveContextExamples()`, `saveContextExample()`.
- Onboarding: `getOnboarded` / `setOnboarded`.
- Wurkflo mirror: `WurkfloUserSnapshot`; `getWurkfloUser`, `watchWurkfloUser(cb)`,
  `get/setWurkfloRemaining`.
- Link handshake: `set/getPendingLinkCode`, `clearPendingLinkCode`,
  `watchPendingLinkCode(cb)`.
- Re-exports `type ProviderId`.

### 5.7 `src/lib/firebase.ts` (Infrastructure)

- Reads Firebase config from `import.meta.env.VITE_FIREBASE_*` (6 vars) — these come
  from `.env` at build time.
- `getFirebaseAuth()`: lazy singleton; uses `initializeAuth` with
  `indexedDBLocalPersistence` (web-extension variant) so the session survives
  service-worker restarts. Imported by the options page **and** the background worker —
  never by the overlay iframe (partitioned storage).

### 5.8 `src/lib/auth.ts` (Infrastructure)

Wurkflo account session.

- `WURKFLO_USER_KEY = "jot:wurkfloUser"`.
- **`WURKFLO_ORIGIN`**: `import.meta.env.VITE_WURKFLO_ORIGIN || "https://wurkflo.app"`.
- `extensionAuthUrl(extensionId)` → `${WURKFLO_ORIGIN}/extension/auth?ext=<id>`.
- `LINK_EXCHANGE_URL` → `${WURKFLO_ORIGIN}/api/auth/link/exchange`.
- `mirrorUser(user|null)` → writes/removes `{uid,email}` in `chrome.storage.local`.
- `signOutWurkflo()` → `signOut(getFirebaseAuth())` + `mirrorUser(null)`.
- `watchWurkfloAuth()` → `onAuthStateChanged` → mirror; returns unsubscribe.
- **`getWurkfloToken()`**: tries the local `auth.currentUser` first (options page
  context; waits up to 2.5s for `authStateReady`), else asks the **background worker**
  (`runtime.sendMessage({type:"jot:wurkflo-token"})`) — because the overlay iframe's
  storage is partitioned. Returns a fresh ID token or throws.
- **`completeWurkfloLink(code)`**: `POST ${LINK_EXCHANGE_URL}` with `{code}` via
  `relayFetch` (background relayed) → expect `{success, customToken}`;
  `signInWithCustomToken`; `mirrorUser`; returns `{uid,email}`.

### 5.9 `src/lib/api.ts` (Application)

**`rewriteText(source, site?, followUp?, handlers?)`**:
1. `getBackendConfig()`, local redaction.
2. Prompts come opaquely from `personalization` (`buildDirectPrompts` /
   `buildApiPrompts`).
3. If `provider === "jot-api"` → `streamWurkfloRewrite(...)`.
4. Else: `getApiKey()`, `adapter.rewrite(config, apiKey, system, user)`, then
   `normalizeRewriteOutput`, emit `onChunk` once with the full text, return it.

**`streamWurkfloRewrite(...)`** (jot-api path):
- Dynamically imports `./auth` and `./storage` (keeps Firebase SDK out of non-Wurkflo
  bundles).
- Requires a Wurkflo user (`getWurkfloUser()`), else `ProviderError("auth")`.
- Fetches a token with retry (2 tries, 500ms) on transient patterns.
- Builds payload: `{systemPrompt, input}` only.
- Opens `relayStream` to `${WURKFLO_ORIGIN}/api/ai/rewrite` (Bearer token). Parses SSE:
  newline-delimited `data:` frames; `[DONE]` ends; each JSON `{content?, error?}`
  normalized per chunk and streamed via `onChunk`; `onRemaining` → `setWurkfloRemaining`.
- 402 (quota): parses `{error, message, quota{used,limit,remaining,period},
  upgrade{available,planId,name,message,redirectUri}}` → `ProviderError("quota")`.
  401 → `auth`; 429 → `rate-limit`; other → `network`.
- Retries transient relay errors once (500ms). Aborts propagate `AbortError`. Empty
  result → `ProviderError("empty")`.

**`listModels()`**: reads config+key, delegates to `ADAPTERS[config.provider]`.

### 5.10 `src/entrypoints/background.ts` (Infrastructure / entrypoint)

- `openBlockedNotice()`: reuse-or-create a 400×200 popup opening `jot-blocked.html`.
- `activateJot()`: the invocation flow from §4.1.
- On install: set `jot:onboarded=false`, open onboarding.
- Commands/action → `activateJot()`.
- **HTTP relay** (`onMessage` type `"jot:http"`): `fetch` the URL, return
  `{ok,status,text}` or `{ok:false,error}`.
- **Token authority** (`type "jot:wurkflo-token"`): dynamic-import `@/lib/firebase`,
  wait for `authStateReady` (3s race; +500ms recheck), then `getIdToken()` →
  `{ok:true,token}` or `{ok:false,error:"not-signed-in"}`.
- **SSE relay** (`onConnect` name `"jot:sse"`): on `start`, `fetch` the URL, relay
  `headers` (with remaining, if `X-Jot-Remaining` is finite), stream decoded chunks as
  `{type:"chunk",text}`, then `done`; `http-error` carries `status`/`body`/`remaining`;
  reader cancelled on port disconnect.

### 5.11 `src/lib/theme.ts` (Infrastructure)

`applySystemTheme()` reads `matchMedia("(prefers-color-scheme: dark)")` and sets
`documentElement.dataset.theme` + toggles `.dark` class. `watchSystemTheme()` applies +
subscribes + returns unsubscribe. Called by every `main.tsx` before React render.

---

## 6. Settings & UI Entrypoints

### 6.1 Options page (`options/App.tsx`, 803 lines)

Opens in its own tab (`options_ui.open_in_tab`). Three tabs: **Provider & API**, **Modes
& Prompts**, **Settings**.

**Provider & API:**
- Provider `Select` (jot-api/opencode/openai/anthropic/gemini). Selecting a
  provider calls `selectProvider(id)` → sets base URL + default model from `ADAPTERS`,
  clears model chips.
- **Jot rewrite API branch:** sign-in card. When signed in (`wurkfloUser`): email + remaining
  ("{n} of 100 free requests left this month") + Sign out. When not: "Connect to
  Wurkflo" button → `handleWurkfloConnect` → `browser.tabs.create(extensionAuthUrl(id))`.
  Link completion driven by a `watchPendingLinkCode` effect → `completeWurkfloLink`.
  Errors mapped: `/expired|already used|not valid/` → "The connection request expired..."
- **BYO branch:** Base URL input (+ endpoint preset chips for OpenAI: OpenAI, DeepSeek,
  Ollama, LM Studio — preset sets the URL, models load live), Model input + "Load models"
  button (→ `listModels()`, renders up to 24 clickable chips, free-text fallback), masked
  API key input with show/hide toggle (eye icon), "Get a {provider} API key" external link,
  and a local-only storage note.
- `API_KEY_URLS` map per provider (opencode auth, openai platform,
  anthropic console, gemini aistudio, wurkflo.app).

**Teach Jot tab:**
- **Teach Jot section** (shared `src/components/TeachJotSection.tsx` with
  onboarding step 2): context tabs, per-context prompts, domain editor,
  example playground, sliders, freeform, advanced editor — instant-save,
  outside the dirty/snapshot flow.

**Settings tab:** keyboard-shortcut hint + link to `chrome://extensions/shortcuts`, and
a privacy blurb.

**State management:**
- `baselineRef` + `buildSnapshot()` (JSON of trimmed provider/baseUrl/model/apiKey,
  sorted modes) → `dirty` detection; `beforeunload` guard while dirty.
- `save()`: `saveBackendConfig` (trim; defaults from adapter), `saveApiKey`,
  `saveEnabledModes` (all modes if empty); resets baseline, clears dirty, shows saved state 2s.

### 6.2 Onboarding (`onboarding/Onboarding.tsx`, 551 lines)

5 steps: (0) intro, (1) provider, (2) personalization, (3) shortcut, (4)
done. Progress bar. Re-uses the same provider/API key/load-models machinery and the
Wurkflo link handshake as options. Step 2 renders the shared `TeachJotSection`
with a `flush()` on Save & continue. On finish → `setOnboarded(true)`, open
`PLAYGROUND_URL = "https://wurkflo.app/jot/playground"`, `window.close()`.

### 6.3 Auth callback (`auth-callback/App.tsx`, 75 lines)

- Reads `window.location.hash` matching `/^#code=([a-f0-9]{32})$/` (fragment, never
  query, so it avoids network logs). Immediately `history.replaceState` strips the code.
- Valid code → `setPendingLinkCode(code)` → parked for options/onboarding to consume,
  then auto-close after 2.5s. Invalid → error screen.

### 6.4 `jot-blocked/index.html`

Standalone HTML (inline CSS, System font, light/dark color-scheme) — indigo→violet
sparkle mark + "Jot can't work on this page." Simple, no React.

---

## 7. Styling & Design System

Each React entrypoint has its own `style.css` that imports **only the HeroUI v3
components it uses** (`@heroui/styles/components/*.css`), keeping built CSS small.

Shared tokens (`@layer base`):
- Fonts: `--font-sans: "Instrument Sans", system-ui,...`; `--font-jot: "Poppins",...`.
- Accent: `--accent: oklch(0.6204 0.195 253.83)` (indigo→violet identity) with
  `--accent-foreground`, `--accent-hover`, `--accent-soft`,
  `--accent-soft-foreground`, `--accent-soft-hover` via `color-mix`.
- `--field-border-width: 1px`; `--radius: 0.375rem` (overlay) / `0.5rem` (options/onboarding).
- Light-first with `[data-theme="dark"]` variants following the OS (via `theme.ts`).

**Overlay document specifics:** `html, body { padding: 12px; background: transparent;
scrollbar-width: none }` — the 12px padding (matching `IFRAME_MARGIN` in `jot-host.ts`)
is what lets the card's box-shadow render inside the iframe; the host offsets its
position by the same amount. The document scrollbar is hidden to avoid flashing while
the host sizes the iframe.

**Overlay card:** full-width `rounded-[8px] border bg-surface/80` with the
purple→red brand glow (`--brand-glow-from/to`, `--brand-gradient`), a connector
diamond on the composer-facing edge, and a header (icon + title, Inserted chip
only on success, settings + close buttons). Content is result-only (no source
preview): `ContentBox` in the sampled composer text color at 15px, auto-growing
with content up to a host-provided budget (`--jot-content-max`, `38vh`
fallback), scrolling independently past it; footer (`FeedbackInput`) mirrors
the composer treatment. Single implicit mode per open (per-site > global > casual);
no mode switching in the overlay.

**ContentBox** (`components/ContentBox.tsx`): `idle` → plain hint line;
`generating` with no output → animated Skeleton; `generating` with output → live
borderless read-only `TextArea` (`id="jot-content"`); `output` → read-only `TextArea`
showing the result. Enter inserts.

**FeedbackInput** (`components/FeedbackInput.tsx`): `Input` (`id="jot-feedback"`) +
absolute-positioned submit `Button` (ArrowUp icon, or Spinner while pending). Enter
submits; Shift+Enter not intercepted. Disabled while generating. State-dependent
placeholder (idle invite vs post-output refinement hint).

---

## 8. Wurkflo Backend API Contract

The extension talks to the Wurkflo backend (`https://wurkflo.app` by default;
`VITE_WURKFLO_ORIGIN` overrides for local QA). The backend is a React Router framework
app (separate repo) with Firebase auth + Firestore + SSE.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/extension/auth?ext=<extensionId>` | — (web UI) | Auth handoff entry; user signs in, accepts TOS, gets redirected |
| POST | `/api/auth/link/start` | — | (server: mints single-use code, validates `acceptedTosVersion`) |
| POST | `/api/auth/link/exchange` | — (body `{code}`) | Exchanges single-use code → `{success, customToken}` |
| POST | `/api/ai/rewrite` | `Authorization: Bearer <firebaseIdToken>` | SSE stream of the rewrite |

**SSE `POST /api/ai/rewrite` request body:**

```json
{
  "systemPrompt": "<COMMON_PROMPT with mode instruction>",
  "input": "<source text>"
}
```

Prompts are composed client-side (`buildApiPrompts` in
`src/lib/personalization/`): the tweak is folded into the system prompt (the
backend takes raw input only). The single user style resolves per site; no
mode aliases are sent.

**SSE response:** `data:` frames with JSON `{content}` deltas; `data: [DONE]` terminates;
`{error}` frames signal failure. Response header **`X-Jot-Remaining`** carries the
monthly remaining quota, cached by the extension. HTTP 402 quota body shape:
`{error:"JOT_QUOTA_EXCEEDED", message, quota:{used,limit,remaining,period},
upgrade:{available,planId,name,message,redirectUri}}`.

**Other notes:** link codes live at `link_codes/{code}` — single-use, 5-minute TTL,
consumed atomically; server enforces TOS version bumps; prompts built server-side with
byte-stable system prompts for prefix caching; quota enforced in a Firestore
transaction (100 free requests/month).

---

## 9. Data Models & Constants Summary

### Chrome storage keys (authoritative)
| Key (area) | Type | Owned by |
|---|---|---|
| `jot:backend` (sync) | `BackendConfig` | storage.ts |
| `jot:apiKey` (local) | `string` | storage.ts |
| `jot:personalization` (sync) | `PersonalizationSnapshot` | personalization/store.ts |
| `jot:contextExamples` (sync) | `ContextExample[]` | storage.ts |
| `jot:onboarded` (sync) | `boolean` | storage.ts / background |
| `jot:wurkfloUser` (local) | `{uid,email}` | auth.ts / storage |
| `jot:wurkfloRemaining` (local) | `number` | api.ts / storage |
| `jot:wurkfloLinkCode` (local) | `string` | auth-callback / storage |

### Chaos of environment variables (build-time)
| Env var | Used by | Default |
|---|---|---|
| `VITE_WURKFLO_ORIGIN` | auth.ts, api.ts, overlay/App.tsx, wxt.config (WAR) | `https://wurkflo.app` |
| `VITE_FIREBASE_API_KEY/AUTH_DOMAIN/PROJECT_ID/STORAGE_BUCKET/MESSAGING_SENDER_ID/APP_ID` | firebase.ts | from `.env` |

---

## 10. Testing Strategy

Vitest, `environment: "node"`, alias `@ → ./src`, setup `src/test/setup.ts` (empty).
Currently **52 tests / 5 files**, all on pure domain modules:

| File | What it covers |
|---|---|
| `personalization/prompts.test.ts` | `buildSystemPrompt`, `buildUserMessage` block ordering/trimming |
| `personalization/sliders.test.ts` | slider directives and labels |
| `personalization/resolve.test.ts` | site/base/persona/default precedence, slider compilation |
| `personalization/build.test.ts` | direct/api/preview builders, write isolation |
| `normalizeOutput.test.ts` | character replacement table + pass-through of legit Unicode |
| `sitePersonas.test.ts` | `matchesSite`, `findBuiltinPersona`, `buildPersonaPrompt` |

The refactor plan calls for extracting more pure logic (transient-error classification,
mode filter/order) and adding architecture enforcement tests.

---

## 11. Re-Creation Roadmap

To rebuild Jot from scratch using this document:

1. **Scaffold:** `wxt@0.21` project with React module +
   `@heroui/react`/`@heroui/styles` + `tailwindcss` + `lucide-react` + `firebase`, matching
   `package.json` scripts and `wxt.config.ts` (manifest §2).
2. **Domain layer (§5.2–5.4):** port `types.ts`, `personalization/`,
   `sitePersonas.ts`, `normalizeOutput.ts` + their Vitest tests.
3. **Infrastructure (§5.5–5.8, §5.10–5.11):** `providers.ts`, `net.ts`, `storage.ts`,
   `firebase.ts`, `auth.ts`, `theme.ts`.
4. **Application (§5.9):** `api.ts` (rewrite + SSE orchestration).
5. **Background/entrypoints (§4, §5.10):** `background.ts`, `jot-host.ts`,
   `jot-blocked/index.html`. Wire the invocation flow + relay + token authority + SSE port.
6. **Overlay UI (§4.4, §6/§7):** `overlay/` with `bridge.ts`, `App.tsx`,
   `components/*`, styling.
7. **Settings UI (§6.1–6.3):** `options/`, `onboarding/`, `auth-callback/` + styles.
8. **Assets:** icons 16/32/48/128 (indigo→violet sparkles), `test-page.html`,
   `scripts/serve-test.mjs`, `.env` with Firebase vars.
9. **Verify:** `npm test`, `npm run typecheck`, `npm run build`, manual QA on
   `test-page.html` (textarea/input/contenteditable) per `docs/PLAN.md §9`.

---

## 12. Known Issues & Refactor Debt (for the re-creation, decide whether to carry forward)

1. **God components:** `overlay/App.tsx` (567), `options/App.tsx` (803),
   `onboarding/Onboarding.tsx` (551). Consider extracting hooks/controllers.
2. **Duplicate transient-error regex** lists in `net.ts`/`api.ts` (3 copies).
3. **Duplicate `WURKFLO_ORIGIN`** in `auth.ts` and `overlay/App.tsx`.
4. **Duplicated mode filter/order** in `storage.getEnabledModes` and `overlay/App.tsx`.
5. **`storage.ts` layer violation:** infrastructure re-exports/owns domain decision
   facades (ADO-002; kept for API transition).
6. **`postinstall` requires network** (wxt prepare); `.env` is gitignored.
7. **`scripts/architecture-check.ts`** is a placeholder; no `npm run architecture-check`.
8. **Typecheck had pre-existing errors** in the test files (progress.md Task 0).
9. **Overlay placement heuristics** untested on multi-monitor/scaled displays.
10. **Google sign-in popup path removed** in favor of the web handoff (intentional).

---

*Maintained by the architect. See `decisions.md` for ADRs and `progress.md` for the
refactor status. If this document disagrees with code, the code is authoritative unless
a decision records otherwise.*
