# Jot Refactor Plan

> Prioritized roadmap toward the target architecture.
> See `target.md` for the target, `decisions.md` for decisions, and
> `progress.md` for live status. One task at a time; each independently
> verifiable; no big-bang rewrites.

## Priority ordering

De-risk first: clean baseline → pure-logic extractions (low risk, fully
testable) → enforcement tooling → riskier UI orchestration extraction.

1. **Task 0 — Restore clean baseline** — fix typecheck errors in
   `modes.test.ts` + `sitePersonas.test.ts` so `npm run typecheck` is green.
   *Prerequisite: no task can be verified while typecheck is red.*
2. **Task 1 — Purify `storage.ts`** — domain decision rules reachable via
   `modeResolution`/`sitePersonas` directly; storage keeps only persistence +
   thin "load data → delegate" facades (public API preserved for transition).
3. **Task 2 — Deduplicate transient-error classification** — extract one pure
   helper (`isTransientRelayError` etc.) from `net.ts`/`api.ts`; add tests.
4. **Task 3 — Consolidate constants/helpers** — single `WURKFLO_ORIGIN` source;
   single mode filter/order helper; use across `auth.ts`, `overlay`,
   `options`, `onboarding`.
5. **Task 4 — Add architecture enforcement** — implement
   `scripts/architecture-check.ts` (forbidden imports / layer boundaries /
   cycles / UI→persistence) + add `npm run architecture-check` to package.json.
   *Provide the automated guardrail early so later tasks are validated live.*
6. **Task 5 — Extract overlay orchestration** — pull generation / caching /
   mode-switch out of `overlay/App.tsx` into a hook/controller; unit-test
   cache-key + default-mode behavior (behavior-preserving).
7. **Task 6 — Extract options/onboarding shared logic** — factor persona-edit
   rules, save/dirty snapshot, provider-form + link-handshake orchestration
   into pure/application functions; deduplicate between options and onboarding.

## Rules

- Preserve behavior.
- Keep each task independently verifiable.
- Avoid big-bang rewrites.
- Verification per task uses the project's actual commands
  (`npm test`, `npm run typecheck`, `npm run build`, and `npm run architecture-check`
  once Task 4 adds it).
