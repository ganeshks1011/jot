/**
 * Framework-aware write-back for model-driven rich-text editors
 * (Lexical, Slate, ProseMirror/TipTap, Quill, Draft.js, CKEditor).
 *
 * These editors keep an internal model and reconcile the DOM against it, so
 * the generic range-surgery path is silently reverted. They all honor real
 * editing input (`execCommand("insertText")` on a live selection, which
 * Chrome surfaces as `beforeinput`), so this module does exactly that and
 * verifies every write by reading back.
 *
 * Two failure modes shape this module (both seen live on Reddit):
 * - Frameworks flush model updates asynchronously: a synchronous read-back
 *   races the flush, reports "unchanged", and triggers retries that pile
 *   duplicate copies into the editor. Every verify therefore awaits a
 *   frame flush first.
 * - `execCommand` already fires a real `beforeinput`; dispatching an extra
 *   synthetic one double-applies the text. There is exactly one write op
 *   per strategy (whole-text, then line-by-line), never stacked.
 *
 * Rules for this module:
 * - Never assign innerHTML / innerText / textContent / value (reads only).
 * - Framework markers are data for *root resolution only* — one code path
 *   for all frameworks, never per-framework branches.
 * - Re-resolve the live root on every attempt; never trust a range cloned
 *   at capture time (frameworks re-render while the overlay is open). The
 *   trace records root identity so a re-attached subtree is visible.
 * - No op runs without verified focus and model-mapped selection coverage:
 *   select, wait for one `selectionchange` (timeout ceiling), re-check.
 * - Every retry starts from identical state: a diverged composer is
 *   restored from snapshot first, and a restore that cannot verify aborts
 *   the run instead of stacking another attempt on corrupted state.
 * - Two circuit-breakers (verbatim duplication, absolute growth) and a
 *   best-effort snapshot restore bound every failure mode.
 */

import {
  type EditableElement,
  isEditableTarget,
  liveSlackDeps,
  normalizeComposerMultiline,
  normalizeComposerText,
  readComposerText,
  type SlackDeps,
  type SlackReplaceResult,
  type SlackWriteDiagnostics,
} from "./slack";

/** Framework markers: editor-root selectors. Data only — adding an editor
 *  is adding one line here, never a new branch. Exported so tests pin each
 *  selector. */
export const FRAMEWORK_MARKERS = [
  { id: "lexical", selector: '[data-lexical-editor="true"]' },
  { id: "slate", selector: '[data-slate-editor="true"]' },
  { id: "prosemirror", selector: ".ProseMirror" },
  { id: "quill", selector: ".ql-editor" },
  { id: "draft", selector: ".public-DraftEditor-content" },
  { id: "ckeditor", selector: ".ck-editor__editable" },
] as const;

export interface RichTextSelection {
  selectAllChildren: (node: unknown) => void;
  /** Live selection text for coverage checks; absent when unprovidable. */
  selectionText?: () => string | null;
}

export interface RichTextDeps extends SlackDeps {
  getSelection: () => RichTextSelection | null;
  /** Resolves after the framework flushes a write to the DOM. */
  waitForFlush: () => Promise<void>;
  /**
   * Resolves after the framework maps the current DOM selection into its
   * model (one `selectionchange` event, timeout ceiling). Absent callers
   * fall back to `waitForFlush`.
   */
  awaitSelectionSynced?: () => Promise<void>;
  /** `closest` bound to the captured field (null when unavailable). */
  closestFromField: ((selector: string) => EditableElement | null) | null;
  /** `closest` bound to the currently focused element (null when unavailable). */
  closestFromFocused: ((selector: string) => EditableElement | null) | null;
}

export interface FrameworkRoot {
  root: EditableElement;
  framework: string;
}

/**
 * Resolve the live framework editor root: captured field first, then the
 * focused element. Returns null when no framework marker matches, in which
 * case callers keep the existing generic path byte-identical.
 */
export function resolveFrameworkRoot(deps: RichTextDeps): FrameworkRoot | null {
  for (const marker of FRAMEWORK_MARKERS) {
    const fromField = deps.closestFromField?.(marker.selector);
    if (fromField?.isConnected && isEditableTarget(fromField)) {
      return { root: fromField, framework: marker.id };
    }
    const fromFocused = deps.closestFromFocused?.(marker.selector);
    if (fromFocused?.isConnected && isEditableTarget(fromFocused)) {
      return { root: fromFocused, framework: marker.id };
    }
  }
  return null;
}

/**
 * True when focus actually landed in the resolved root. Focusing a detached
 * node is a silent no-op, and writing then appends at the live cursor
 * instead of replacing — the Reddit duplication signature. Unverifiable
 * (null active element) proceeds, matching historical behavior.
 */
function focusLanded(root: EditableElement, deps: RichTextDeps): boolean {
  const active = deps.activeElement;
  if (!active) return true;
  let el: EditableElement | null | undefined = active;
  for (let i = 0; i < 25 && el; i++) {
    if (el === root) return true;
    el = el.parentElement ?? null;
  }
  return false;
}

/**
 * Select-all with coverage proof: the live selection must cover the whole
 * editor text before any `execCommand` runs. A collapsed or partial
 * selection would append instead of replace, so the op is skipped.
 * Unprovidable selection text (or an empty editor) proceeds.
 *
 * Comparison is structure-insensitive (all whitespace collapsed): selection
 * text and `innerText` disagree on break placement around list and block
 * markup, which must not block writes on rich content. Word content still
 * has to match in full — a partial selection never verifies.
 */
function selectAllVerified(root: EditableElement, deps: RichTextDeps): boolean {
  const sel = deps.getSelection();
  if (!sel) return false;
  try {
    sel.selectAllChildren(root);
  } catch {
    return false;
  }
  const covered = sel.selectionText?.();
  if (covered == null) return true;
  const editorText = normalizeComposerText(readComposerText(root));
  if (!editorText) return true;
  return normalizeComposerText(covered) === editorText;
}

/**
 * Duplication signature: the expected text already present twice or more.
 * Fails closed immediately instead of stacking further copies.
 */
function isDuplicated(actual: string, expected: string): boolean {
  if (!expected) return false;
  let count = 0;
  let from = 0;
  while (from <= actual.length) {
    const at = actual.indexOf(expected, from);
    if (at === -1) return false;
    count += 1;
    if (count >= 2) return true;
    from = at + expected.length;
  }
  return false;
}

/**
 * Absolute-growth circuit-breaker slack (chars). Complements the verbatim
 * count above: fragment stacks never form two exact copies but still bloat.
 * Legit overshoot (trailing blocks, formatting wrappers) stays far below.
 */
const GROWTH_SLACK = 512;

function isOvergrown(actualLen: number, preLen: number, expectedLen: number): boolean {
  return preLen >= 0 && actualLen > preLen + expectedLen + GROWTH_SLACK;
}

/**
 * TEMPORARY diagnostic trace for a live duplication investigation (lengths
 * and tags only, never message content). Each write op reports what it did
 * so a reproduce-and-paste round identifies the appending op. Removed once
 * the mechanism is confirmed.
 */
function traceWrite(info: {
  attempt: number;
  op: string;
  execReturn: boolean;
  preOpLen: number;
  postOpLen: number;
  verifyOk: boolean;
  sameRoot: boolean;
  detail?: string;
}): void {
  try {
    console.debug("[jot] rich-write", info);
  } catch {
    // Logging must never break insertion.
  }
}

/** Outcome of a write op: whether it ran, what execCommand reported, and why it skipped. */
interface WriteOpOutcome {
  completed: boolean;
  execReturn: boolean;
  skipped?: "coverage-pre" | "coverage-post";
}

/**
 * Wait for the framework to map the DOM selection into its model: one
 * `selectionchange` event when observable, else the generic flush.
 * Executing before the model catches up appends at a stale cursor.
 */
async function syncSelection(deps: RichTextDeps): Promise<void> {
  if (deps.awaitSelectionSynced) {
    try {
      await deps.awaitSelectionSynced();
      return;
    } catch {
      // Fall through to the flush below.
    }
  }
  await deps.waitForFlush();
}

/**
 * Line-by-line insert for editors that mishandle embedded newlines in a
 * single `insertText` (the proven ProseMirror/TipTap pattern): select-all,
 * flush so the model selection maps, re-check coverage, then `insertText`
 * per line with `insertParagraph` between lines. Caller flushes and verifies.
 */
async function runMultilineInsert(
  root: EditableElement,
  deps: RichTextDeps,
  text: string,
): Promise<WriteOpOutcome> {
  if (!selectAllVerified(root, deps)) return { completed: false, execReturn: false, skipped: "coverage-pre" };
  await syncSelection(deps);
  if (!selectAllVerified(root, deps)) return { completed: false, execReturn: false, skipped: "coverage-post" };
  let execReturn = true;
  try {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        const paraOk = deps.execCommand("insertParagraph", false, "");
        execReturn = execReturn && paraOk;
        if (!paraOk) return { completed: false, execReturn };
      }
      const line = lines[i];
      if (line) {
        const lineOk = deps.execCommand("insertText", false, line);
        execReturn = execReturn && lineOk;
        if (!lineOk) return { completed: false, execReturn };
      }
    }
    root.dispatchEvent(deps.createInputEvent());
    return { completed: true, execReturn };
  } catch {
    return { completed: false, execReturn };
  }
}

/** Whole-text editing input: select, sync for model mapping, re-check, exec. Caller flushes and verifies. */
async function runWholeInsert(
  root: EditableElement,
  deps: RichTextDeps,
  text: string,
): Promise<WriteOpOutcome> {
  if (!selectAllVerified(root, deps)) return { completed: false, execReturn: false, skipped: "coverage-pre" };
  await syncSelection(deps);
  if (!selectAllVerified(root, deps)) return { completed: false, execReturn: false, skipped: "coverage-post" };
  let execReturn = false;
  try {
    execReturn = deps.execCommand("insertText", false, text);
  } catch {
    // Verification decides; execCommand lies in both directions.
  }
  try {
    root.dispatchEvent(deps.createInputEvent());
  } catch {
    // Verification decides; a dispatch failure alone is not fatal.
  }
  return { completed: true, execReturn };
}

/**
 * Verify for the plain-text framework path. Exact equality wins; otherwise
 * accept containment within a length bound proportional to the rewrite
 * (editor-added block structure scales with content; a fixed slack would
 * certify appends onto tiny composers). Appends fail earlier: full copies
 * trip the duplication breaker, original-plus-rewrite exceeds the bound.
 * An append must never verify: `execCommand` replaces the selection, so
 * anything else is a failed write.
 */
function verifySlack(expectedLen: number): number {
  return Math.min(64, Math.floor(expectedLen / 10));
}

function verifyTolerant(root: EditableElement, text: string): { ok: boolean; readBack: string } {
  const readBack = readComposerText(root);
  const expected = normalizeComposerMultiline(text);
  if (!expected) return { ok: false, readBack };
  const actual = normalizeComposerMultiline(readBack);
  if (actual === expected) return { ok: true, readBack };
  if (actual.includes(expected) && Math.abs(actual.length - expected.length) <= verifySlack(expected.length)) {
    return { ok: true, readBack };
  }
  return { ok: false, readBack };
}

/**
 * Best-effort restore of the pre-write snapshot after a failed run that grew
 * the composer: failure must leave the editor untouched, not bloated. Uses
 * the same gated path as writes; silently gives up when it cannot resolve.
 */
async function tryRestoreOriginal(deps: RichTextDeps, snapshot: string): Promise<void> {
  const resolved = resolveFrameworkRoot(deps);
  if (!resolved) return;
  const { root } = resolved;
  try {
    root.focus();
  } catch {
    return;
  }
  if (!focusLanded(root, deps)) return;
  if (!selectAllVerified(root, deps)) return;
  await deps.waitForFlush();
  if (!selectAllVerified(root, deps)) return;
  try {
    deps.execCommand("insertText", false, snapshot);
  } catch {
    // Best effort only; the panel stays open with copy/retry either way.
  }
  try {
    root.dispatchEvent(deps.createInputEvent());
  } catch {
    // Best effort only.
  }
  await deps.waitForFlush();
}

/**
 * Replace the framework composer contents via real editing input and verify.
 * Exactly one write op per strategy (whole-text, then line-by-line) with a
 * frame flush before every read-back; focus, selection coverage, and two
 * circuit-breakers (verbatim duplication, absolute growth) guard every step.
 * Reports failure instead of guessing — the caller keeps the panel open so
 * the rewrite stays copyable.
 */
export async function replaceRichText(text: string, deps: RichTextDeps): Promise<SlackReplaceResult> {
  const expected = normalizeComposerMultiline(text);
  const expectedLen = expected.length;
  const diag: SlackWriteDiagnostics = {
    strategy: null,
    tag: null,
    preLen: -1,
    postLen: -1,
    expectedLen,
    attempts: 0,
  };
  const fail = (readBack: string): SlackReplaceResult => {
    diag.postLen = normalizeComposerMultiline(readBack).length;
    return { ok: false, readBack, diagnostics: { ...diag } };
  };
  const succeed = (readBack: string): SlackReplaceResult => {
    diag.strategy = "exec";
    diag.postLen = normalizeComposerMultiline(readBack).length;
    return { ok: true, readBack, diagnostics: { ...diag } };
  };
  if (!expected) return fail("");
  let lastReadBack = "";
  let snapshot: string | null = null;
  let lastRoot: EditableElement | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const resolved = resolveFrameworkRoot(deps);
    if (!resolved) {
      traceWrite({
        attempt: diag.attempts,
        op: "resolve-missed",
        execReturn: false,
        preOpLen: -1,
        postOpLen: -1,
        verifyOk: false,
        sameRoot: false,
      });
      continue;
    }
    const { root } = resolved;
    // A re-attached editor subtree (custom elements re-render) resolves a
    // different node per attempt — writing across roots stacks content.
    const sameRoot = lastRoot !== null && lastRoot === root;
    lastRoot = root;
    diag.tag = typeof root.tagName === "string" ? root.tagName.toUpperCase() : null;
    if (diag.preLen < 0) {
      snapshot = readComposerText(root);
      diag.preLen = normalizeComposerMultiline(snapshot).length;
    }
    try {
      root.focus();
    } catch {
      continue;
    }
    if (!focusLanded(root, deps)) continue;
    diag.attempts += 1;
    // Every retry starts from identical state: restore the snapshot when a
    // previous attempt left the composer diverged. A restore that cannot
    // verify aborts the run instead of stacking another attempt on top.
    if (attempt > 0 && snapshot !== null) {
      const diverged = normalizeComposerMultiline(readComposerText(root)) !== normalizeComposerMultiline(snapshot);
      if (diverged) {
        await tryRestoreOriginal(deps, snapshot);
        const afterResolve = resolveFrameworkRoot(deps);
        const after = afterResolve ? readComposerText(afterResolve.root) : "";
        if (normalizeComposerMultiline(after) !== normalizeComposerMultiline(snapshot)) {
          // Restore failed: fail closed now instead of stacking another
          // attempt (and another restore) on corrupted state.
          return fail(after);
        }
      }
    }
    const preOpLen = normalizeComposerMultiline(readComposerText(root)).length;
    const whole = await runWholeInsert(root, deps, text);
    if (!whole.completed) {
      traceWrite({
        attempt: diag.attempts,
        op: "whole-skipped",
        execReturn: false,
        preOpLen,
        postOpLen: preOpLen,
        verifyOk: false,
        sameRoot,
        detail: whole.skipped,
      });
    }
    if (whole.completed) {
      await deps.waitForFlush();
      const check = verifyTolerant(root, text);
      lastReadBack = check.readBack;
      const actual = normalizeComposerMultiline(check.readBack);
      traceWrite({
        attempt: diag.attempts,
        op: "whole",
        execReturn: whole.execReturn,
        preOpLen,
        postOpLen: actual.length,
        verifyOk: check.ok,
        sameRoot,
      });
      if (isDuplicated(actual, expected) || isOvergrown(actual.length, diag.preLen, expectedLen)) break;
      if (check.ok) return succeed(check.readBack);
    }
    // Multiline select-all heals partial writes from the attempt above.
    const multi = await runMultilineInsert(root, deps, text);
    if (!multi.completed) {
      traceWrite({
        attempt: diag.attempts,
        op: "multiline-skipped",
        execReturn: false,
        preOpLen,
        postOpLen: preOpLen,
        verifyOk: false,
        sameRoot,
        detail: multi.skipped,
      });
    }
    if (multi.completed) {
      await deps.waitForFlush();
      const check = verifyTolerant(root, text);
      lastReadBack = check.readBack;
      const actual = normalizeComposerMultiline(check.readBack);
      traceWrite({
        attempt: diag.attempts,
        op: "multiline",
        execReturn: multi.execReturn,
        preOpLen,
        postOpLen: actual.length,
        verifyOk: check.ok,
        sameRoot,
      });
      if (isDuplicated(actual, expected) || isOvergrown(actual.length, diag.preLen, expectedLen)) break;
      if (check.ok) return succeed(check.readBack);
    }
  }
  if (lastReadBack) {
    if (snapshot !== null && normalizeComposerMultiline(lastReadBack).length > diag.preLen) {
      await tryRestoreOriginal(deps, snapshot);
      const resolved = resolveFrameworkRoot(deps);
      if (resolved) return fail(readComposerText(resolved.root));
    }
    return fail(lastReadBack);
  }
  const resolved = resolveFrameworkRoot(deps);
  return fail(resolved ? readComposerText(resolved.root) : "");
}

/** Build live deps from real browser globals (never called in tests). */
export function liveRichTextDeps(doc: Document, win: Window, activeField: HTMLElement | null): RichTextDeps {
  const base = liveSlackDeps(doc, win, activeField);
  const bindClosest = (el: Element | null): ((selector: string) => EditableElement | null) | null => {
    if (!el || typeof (el as HTMLElement).closest !== "function") return null;
    const target = el as HTMLElement;
    return (selector: string) => target.closest(selector) as unknown as EditableElement | null;
  };
  return {
    activeField: base.activeField,
    get activeElement() {
      return doc.activeElement as unknown as EditableElement | null;
    },
    getSelection: () => {
      const sel = win.getSelection();
      if (!sel) return null;
      return {
        selectAllChildren: (node: unknown) => sel.selectAllChildren(node as Node),
        selectionText: () => sel.toString(),
      };
    },
    execCommand: base.execCommand,
    createInputEvent: base.createInputEvent,
    createBeforeInputEvent: base.createBeforeInputEvent,
    waitForFlush: () =>
      new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        try {
          // Backgrounded tabs stall rAF; the timeout always releases.
          win.requestAnimationFrame(() => win.requestAnimationFrame(finish));
        } catch {
          finish();
        }
        setTimeout(finish, 150);
      }),
    // Lexical resyncs its model from selectionchange, so one post-select
    // event is strictly better evidence than a fixed frame count. The
    // timeout ceiling preserves the old behavior when nothing fires.
    awaitSelectionSynced: () =>
      new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        const onChange = () => {
          try {
            doc.removeEventListener("selectionchange", onChange);
          } catch {
            // Listener removal is best effort.
          }
          finish();
        };
        try {
          doc.addEventListener("selectionchange", onChange, { once: true });
        } catch {
          finish();
          return;
        }
        setTimeout(() => {
          try {
            doc.removeEventListener("selectionchange", onChange);
          } catch {
            // Listener removal is best effort.
          }
          finish();
        }, 150);
      }),
    closestFromField: bindClosest(activeField),
    get closestFromFocused() {
      return bindClosest(doc.activeElement);
    },
  };
}
