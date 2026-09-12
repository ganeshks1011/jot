# Jot Target Architecture

> Single source of truth for the target Clean Architecture.
> Lives alongside `architecture.md` (current/baseline) and `refactor-plan.md`
> (task backlog). Maintained by the architect.

## Layers (logical, over the flat `src/lib/`)

```
UI (entrypoints + components)
  ↓
Application (use cases / orchestration)
  ↓
Domain (pure business rules; no Chrome/React/storage/HTTP/Firebase)
```

```
Infrastructure (storage, net, providers, auth, firebase, theme, bridge, background, jot-host)
  ↓
Application / Domain
```

## Layer responsibilities

### Domain — pure, Node-testable (imports nothing outside domain)
- Shared types (`types.ts`)
- Writing modes + prompts (`modes.ts`, `prompts.ts`)
- Site personas / matching (`sitePersonas.ts`)
- Output normalization (`normalizeOutput.ts`)
- Mode-resolution hierarchy rules (`modeResolution.ts`)
- NEW pure helpers (no chrome/window/document/net/firebase):
  - transient-error classification (extracted from `net.ts` + `api.ts`)
  - mode filter/order logic (extracted from `storage.getEnabledModes` + overlay)
  - shared constants (e.g. single `WURKFLO_ORIGIN` source)
- Business rules are NOT reachable only through infrastructure.

### Application — use cases / orchestration
- `api.ts`: `rewriteText`, `streamWurkfloRewrite`, `listModels` (depends on
  domain + on infrastructure **interfaces**, not concrete `storage`/`net`).
- Wurkflo link orchestration.
- Thin "load data → delegate to domain" facades (not in infrastructure).

### Infrastructure — external system implementations
- `storage.ts` (chrome.storage persistence + thin data-loading facades;
  domain decision rules moved OUT)
- `net.ts`, `providers.ts` (adapter implementations), `auth.ts`, `firebase.ts`,
  `theme.ts`, `bridge.ts`, `background.ts`, `jot-host.ts`

### UI — thin, presentational
- Overlay / options / onboarding / auth-callback components.
- Orchestration lives in hooks/controllers, not god components.
- UI never reaches persistence/http directly.

## Enforced dependency rules
1. Domain depends on nothing outside domain.
2. Application depends on domain abstractions + infra interfaces (not concrete
   chrome.storage / net).
3. Infrastructure depends on application/domain abstractions.
4. UI depends on application/use-case code, never directly on persistence/http.
5. No import cycles.
