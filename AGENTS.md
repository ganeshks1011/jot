# AGENTS.md

Guidance for AI agents working in this repository (Jot — Chrome MV3 extension).

## Stack
WXT · Vite · React 19 · TypeScript (strict) · Tailwind CSS v4 · HeroUI v3 (`@heroui/react` + `@heroui/styles`) · lucide-react.

## Commands

```bash
npm install          # install dependencies
npm run dev          # wxt dev (HMR per entrypoint)
npm run build        # wxt build → .output/chrome-mv3 (load unpacked)
npm run zip          # build + package .zip for the Chrome Web Store
npm run typecheck    # tsc --noEmit (strict)
```

Style is repo-wide: Biome config lives at the monorepo root — run `npm run format` / `npm run format:check` from the root, not here. TypeScript `strict:true`; path alias `@/*` is extension-local (`~/*` is web-only, `@wurkflo/shared` is cross-workspace).

## Structure
- `src/entrypoints/` — `background.ts`, `jot-host.ts` (unlisted script, injected on demand), `overlay/`, `options/`, `auth-callback/`, `jot-blocked/`. WXT generates the manifest from `wxt.config.ts`; do not hand-edit a `manifest.json`.
- `src/lib/` — framework-agnostic logic (types, styles, prompts, providers, api, storage, net). Shared by overlay, options, and background.
- `src/components/` & `src/hooks/` — React UI used by popup/options.

## Conventions
- **HeroUI v3 (not v2):** no `HeroUIProvider`, no `framer-motion`. Compound components (`Tabs.Tab`, `Card.Body`), `onPress` not `onClick`, semantic variants (`primary`/`secondary`/`tertiary`), `@import "tailwindcss"` before `@import "@heroui/styles"`. Use the v3 docs (https://heroui.com/docs/react) — v2 APIs do not apply.
- **Follow the system theme:** light-first with `dark:` variants; apply the HeroUI theme via `data-theme`/`.dark` on the document root from `matchMedia('(prefers-color-scheme: dark)')`. Never hard-code dark-only surfaces. CSS is inlined at build — no external/CDN runtime deps, no webfonts.
- **Keyboard-first overlay:** global `keydown` contract (arrows/Enter/Escape/Tab) verified against React Aria defaults; keep HeroUI `data-focus-visible` rings (never override them away). New interactive elements must participate.
- **Provider abstraction:** all LLM access goes through `ProviderAdapter` implementations in `src/lib/providers.ts`. Add a provider = add an adapter; never special-case fetches in UI code.
- **API keys:** store in `chrome.storage.local`, never `chrome.storage.sync`. Mask in UI; never log.
- **All settings live in the options page** (`src/entrypoints/options/`), opened in its own tab (`options_ui.open_in_tab`). The overlay UI contains no settings — its gear / "Open settings" actions call `browser.runtime.openOptionsPage()`.
- **No persistent website access:** the manifest has `activeTab` + `scripting` only — no `host_permissions`, no `<all_urls>`, no URL-matched content scripts, and never add them as a workaround. Page code (`jot-host.ts`) is injected via `chrome.scripting.executeScript` only after explicit user invocation (commands shortcut / action click), and tears itself down when the overlay closes.
- **Overlay ↔ injected host controller:** communicate only via the `postMessage` contract in `src/entrypoints/overlay/lib/bridge.ts`. The overlay posts `ready` on mount (the host controller re-sends `init`), then `resize`/`insert`/`close`. The controller validates `event.origin` against `chrome.runtime.id` — never `event.source === iframe.contentWindow` (unreliable across isolated-world WindowProxy wrappers). Only the controller touches the host DOM.
- **All provider HTTP goes through the background relay** (`src/lib/net.ts` → `background.ts`). Extension pages are CORS-bound without host permissions; service-worker fetches are not. Never `fetch()` provider endpoints directly from the overlay/options.
- **Extension pages have `script-src 'self'` (no `'unsafe-inline'`):** no inline `<script>` in entrypoint HTML; theme/etc. is applied from bundled modules before render.
- **No `use_dynamic_url` on web-accessible resources** — it corrupts `chrome.runtime.getURL()` and breaks origin validation.
- **No new dependencies without review** — keep bundle small (extension popup budgets are tight).

## Verify before finishing
Run `npm run typecheck` and `npm run build`; confirm `.output/chrome-mv3` loads as an unpacked extension and the QA checklist in `docs/PLAN.md` passes.


# Clean Code Principles

These principles apply to every implementation and refactor.

## Core principles

1. Follow existing project conventions.
2. Prefer the simplest solution that correctly solves the problem.
3. Leave modified code cleaner than you found it.
4. Find and fix root causes rather than masking symptoms.
5. Do not introduce abstractions without a concrete need.

## Design

- Keep configurable values at the appropriate configuration boundary.
- Do not scatter configuration throughout implementation code.
- Prefer composition and existing project patterns over complex branching.
- Use polymorphism/strategy patterns when they genuinely simplify behavior that varies by type.
- Do not introduce polymorphism merely to eliminate a small conditional.
- Keep asynchronous/concurrent behavior isolated from normal business logic.
- Prevent over-configurability.
- Use dependency injection where dependencies are external, replaceable, or architectural boundaries require it.
- Follow the Law of Demeter: depend only on what a module directly needs.
- Do not reach through multiple layers of objects to access internal state.

## Understandability

- Be consistent with existing code.
- Use explanatory variables when an expression would otherwise obscure intent.
- Encapsulate boundary conditions in one place.
- Prefer domain/value types when primitive values have meaningful domain behavior or validation.
- Do not create value objects solely to satisfy a rule.
- Avoid hidden logical dependencies between functions.
- Prefer positive, readable conditions over deeply nested or confusing negative conditions.

## Naming

Names must communicate intent.

- Use descriptive, unambiguous names.
- Use meaningful distinctions.
- Use pronounceable names.
- Use searchable names.
- Replace unexplained magic numbers with named constants.
- Do not encode type information into names.
- Avoid generic names such as:
  - data
  - thing
  - manager
  - helper
  - processor
  - temp
  - misc
unless the name genuinely represents that concept.

## Functions

Functions should:

- be small enough to understand easily
- do one coherent thing
- have descriptive names
- minimize arguments
- avoid unnecessary side effects
- avoid boolean/flag arguments when separate operations would be clearer

Do not split functions mechanically just to make them shorter.

A 20-line function performing one coherent operation can be cleaner than five poorly named 4-line functions.

## Source structure

Organize source so that a developer can understand it by reading downward.

- Keep related code close together.
- Keep dependent functions close to the functions that use them.
- Keep similar operations together.
- Declare variables close to where they are used.
- Keep abstractions and their implementations logically organized.
- Use whitespace to separate unrelated concepts.
- Avoid unnecessary horizontal alignment.
- Keep lines reasonably short.
- Avoid deeply nested control flow.
- Keep files focused on a coherent responsibility.

## Objects and data

- Hide internal implementation details.
- Expose behavior rather than internal structure where appropriate.
- Avoid objects that combine unrelated responsibilities.
- Avoid hybrid structures that inconsistently mix data and behavior.
- Keep objects focused.
- Keep instance/state fields to what the object actually needs.
- Do not make base abstractions depend on implementation details of their derivatives.
- Prefer explicit behavior over passing callbacks/flags simply to select unrelated behavior.

## Comments

Prefer code that explains itself.

Comments should explain:

- why something exists
- why an unusual implementation is necessary
- important constraints
- consequences of changing something
- external behavior that isn't obvious from the code

Do not use comments to explain obvious code.

Never leave commented-out implementations in the codebase.

## Tests

Tests are production code.

Tests must be:

- readable
- fast
- deterministic
- independent
- repeatable
- focused on observable behavior

Prefer one clear behavioral assertion per test when practical.

Do not sacrifice useful coverage simply to enforce an artificial assertion count.

Tests should communicate the expected behavior of the system.

## Code smells

Before completing a change, look for:

### Rigidity
A small change requires modifications across many unrelated places.

### Fragility
A change breaks unrelated functionality.

### Immobility
Useful code cannot be reused because it is unnecessarily coupled to its current context.

### Needless complexity
The implementation is more complicated than the problem requires.

### Needless repetition
The same business logic is implemented in multiple places.

### Opacity
The intent of the implementation is difficult to understand.

If a smell is introduced by the current change, fix it before completion when the fix is local and justified.

## Clean-code review

Before reporting completion, inspect the diff and ask:

1. Is this the simplest correct implementation?
2. Did I introduce an unnecessary abstraction?
3. Does each function have one coherent responsibility?
4. Are names understandable without additional context?
5. Are dependencies flowing through the correct architectural boundaries?
6. Did I duplicate existing behavior?
7. Did I introduce unnecessary state?
8. Are errors handled at the correct boundary?
9. Are tests readable and deterministic?
10. Did this change introduce rigidity, fragility, immobility, needless complexity, repetition, or opacity?

If yes, improve the implementation before completing the task.

