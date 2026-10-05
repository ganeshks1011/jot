# Jot Refactor Progress

> Persistent progress tracker. Updated after every milestone by the architect.
> Current task = first item with status `IN PROGRESS`.

## Baseline (verified 2026-08-30)

- `npm test` → PASS (52 tests, 5 files)
- `npm run build` → PASS
- `npm run typecheck` → **FAIL** (5 errors: `modes.test.ts` x3, `sitePersonas.test.ts` x2) — pre-existing, in newly-added test files
- `npm run lint` → no script configured
- `npm run architecture-check` → no script configured (`scripts/architecture-check.ts` is a placeholder)

## Roadmap / task status

| ID | Task | Status |
|----|------|--------|
| 19 | Fix Rewrite not triggering request | **PENDING** |
| 20 | Deduplicate Wurkflo systemPrompt userPrompt payload | **PENDING** |

## Notes

- Previous partial refactor (pre-session) delivered: vitest config, tests for all
  pure domain modules, `modeResolution.ts` extraction, `storage.ts` wrapper
  re-exports. That work is NOT committed (untracked/staged in working tree).
- The previous `refactor-plan.md` "TASK-001/002" map to our baseline "done";
  TASK-003 (transient errors) = our Task 2.
