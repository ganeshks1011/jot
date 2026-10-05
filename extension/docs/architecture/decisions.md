# Jot Architecture Decisions

> Record of architectural decisions with rationale. Maintained by the architect.

## ADR-001 — Logical layers over flat `src/lib/` (not physical folders)

**Status:** Accepted

**Context:** Jot is a working Chrome MV3 extension. The codebase uses a flat
`src/lib/` and WXT/Vite resolution via `@/lib/...`. Physically moving files into
`src/domain/`, `src/application/`, `src/infrastructure/` would touch every import
across all entrypoints and is higher-risk for a working extension.

**Decision:** Enforce **logical** layer boundaries over the existing layout.
Pure domain modules stay in `src/lib/`; dependencies are enforced by an
automated architecture check, not by directory location.

**Consequence:** The architecture check must describe layer membership per-file
or per-module and reject forbidden imports regardless of path.

## ADR-002 — Domain rules must not be reachable only through infrastructure

**Status:** Accepted

**Context:** `storage.ts` (infrastructure) re-exported async wrappers for
`resolveModePrompt`, `resolveDefaultMode`, `getPreferredDefaultMode`,
`hasPersonalizedPromptForSite` and the sitePersonas helpers, so UI/application
reached domain rules through chrome.storage.

**Decision:** The pure implementations in `modeResolution.ts` / `sitePersonas.ts`
are the single source of truth. Infrastructure only provides thin
"load data → delegate" facades (kept during the transition to preserve public API).

**Consequence:** application/UI import domain directly; storage no longer owns
decision rules.

## ADR-003 — Automated architecture enforcement is required, not documentation-only

**Status:** Accepted

**Context:** `scripts/architecture-check.ts` was a placeholder; no
`architecture-check` npm script existed.

**Decision:** Implement `scripts/architecture-check.ts` to detect forbidden
imports across layers, cycles, and UI→persistence leakage, and add
`npm run architecture-check` to package.json so it runs in the standard
verification workflow.
