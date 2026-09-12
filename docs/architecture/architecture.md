# Jot Architecture

> Current and target architecture for the Jot Chrome MV3 extension.
> Maintained by the architect. Implementers/fixers must NOT edit this file.

## Status

Analyzed. Current: flat `src/lib/` with mixed responsibilities. Target: layered
Clean Architecture (Domain / Application / Infrastructure / UI) with enforced
dependency direction.

## Dependency Direction

Allowed (per `.opencode/rules/architecture.md`):

```
UI (entrypoints + components)
  ↓
Application (use cases / orchestration)
  ↓
Domain (pure business rules; no Chrome/React/storage/HTTP)
```

```
Infrastructure (storage, net, providers, auth, firebase, theme)
  ↓
Application / Domain
```

Forbidden:
- Domain → UI / Infrastructure / Chrome APIs / React
- Application → UI
- UI → persistence/http directly (must go through application/use-case code)

## Current Architecture (baseline)

### Domain (pure TS, Node-testable — no chrome/React/window/document)
- `src/lib/types.ts` — shared types (`ProviderId`, `BackendConfig`, `SitePrompts`)
- `src/lib/modes.ts` — `WritingMode` definitions, `MODE_ORDER`, `getMode()`
- `src/lib/prompts.ts` — `BASE_PROMPT`, `buildSystemPrompt()`, `buildUserMessage()`
- `src/lib/sitePersonas.ts` — `BUILTIN_SITE_PERSONAS`, `matchesSite()`,
  `findBuiltinPersona()`, `buildPersonaPrompt()`
- `src/lib/normalizeOutput.ts` — `normalizeRewriteOutput()`

### Application / Use Cases (orchestration; may depend on domain + storage)
- `src/lib/api.ts` — `rewriteText()` (config load → prompt resolution → adapter
  call → normalization), `streamWurkfloRewrite()` (SSE parse, retry,
  quota/upgrade mapping), `listModels()`

### Infrastructure (Chrome APIs / HTTP / Firebase)
- `src/lib/storage.ts` — chrome.storage persistence AND embedded business rules.
  **Violates structure:** contains `resolveModePrompt`, `resolveDefaultMode`,
  `getPreferredDefaultMode`, `hasPersonalizedPromptForSite` — domain decision
  rules coupled to `browser.storage`. Also re-exports sitePersonas helpers.
- `src/lib/net.ts` — `relayFetch()` / `relayStream()` through the background SW
- `src/lib/providers.ts` — `ProviderAdapter` implementations, `ProviderError`
- `src/lib/auth.ts` — Firebase session, token fetch, link exchange, storage mirror
- `src/lib/firebase.ts` — Firebase app/auth init
- `src/lib/theme.ts` — OS theme application
- `src/lib/bridge.ts` (overlay/lib) — postMessage contract

### Entrypoints / UI
- `src/entrypoints/background.ts` — SW: HTTP relay, SSE relay, token authority
- `src/entrypoints/jot-host.ts` — injected on-demand DOM controller (408 lines)
- `src/entrypoints/overlay/App.tsx` — god component (567 lines): generation
  orchestration, per-mode caching, mode-switch logic, keyboard contract, error
  mapping, iframe bridge, resize reporting
- `src/entrypoints/overlay/components/*` — thin presentational components (fine)
- `src/entrypoints/options/App.tsx` — god component (803 lines): form state,
  save/dirty tracking, link-handshake orchestration, persona edit rules
- `src/entrypoints/onboarding/Onboarding.tsx` (551 lines)
- `src/entrypoints/auth-callback/App.tsx` (75 lines)

### Key Findings
1. Business rules embedded in infrastructure (`storage.ts`).
2. God UI components carry orchestration logic (overlay, options).
3. No tests / no test runner; pure domain modules are untested.
4. Duplicated transient-error regex lists (`net.ts`, `api.ts`).
5. `WURKFLO_ORIGIN` duplicated (`auth.ts`, `overlay/App.tsx`).
6. Mode-filtering/ordering logic duplicated (`storage.getEnabledModes`, overlay).
7. `scripts/architecture-check.ts` is a placeholder.

## Target Architecture

### Domain (pure, Node-testable)
- Existing pure modules (types, modes, prompts, sitePersonas, normalizeOutput).
- NEW pure rules extracted from infrastructure, e.g.
  `src/lib/modeResolution.ts` (custom-mode prompt hierarchy + default-mode rules).
- Everything imports nothing outside domain.

### Application (use cases)
- `api.ts` (rewrite orchestration), Wurkflo link orchestration.
- Thin "load data → delegate to domain" facades live here, not in infrastructure.

### Infrastructure
- `storage.ts` becomes pure persistence + data-loading facades (API surface
  preserved during the transition).
- `net.ts`, `providers.ts`, `auth.ts`, `firebase.ts`, `theme.ts`, `background.ts`,
  `jot-host.ts`, `bridge.ts`.

### UI
- Thin, presentational. Orchestration extracted to hooks/controllers where the
  component grows beyond presentation.

### Tooling / tests
- Vitest unit tests for every pure domain module.
- `scripts/architecture-check.ts` enforces boundaries (forbidden imports,
  cycles, UI→storage) once boundaries are stable.
