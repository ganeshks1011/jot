/**
 * Helper-text selection for the overlay hint line ("helper text").
 * Pure and unit-tested; the overlay maps the returned kind to JSX.
 */

export type FocusZone = "content" | "feedback" | null;

export type HelperKind = "replace" | "tweak" | "invite";

export function selectHelperText(opts: {
  hasOutput: boolean;
  focusZone: FocusZone;
  hasTweakInput: boolean;
}): HelperKind | null {
  if (!opts.hasOutput) return null;
  if (opts.focusZone === "feedback") {
    return opts.hasTweakInput ? "tweak" : "invite";
  }
  return "replace";
}

/** Map a focus target to its overlay zone (covers HeroUI wrappers). */
export function zoneForTarget(target: EventTarget | null): FocusZone {
  if (!(target instanceof Element)) return null;
  if (target.id === "jot-content" || target.closest("#jot-content")) {
    return "content";
  }
  if (target.id === "jot-feedback" || target.closest("#jot-feedback")) {
    return "feedback";
  }
  return null;
}
