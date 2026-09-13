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
 *   at capture time (frameworks re-render while the overlay is open).
 * - No op runs without verified focus and selection coverage; a failed
 *   verify with duplicated content aborts further writes immediately.
 */

import {
  type EditableElement,
  isEditableTarget,
  liveSlackDeps,
  normalizeComposerMultiline,
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
  const editorText = normalizeComposerMultiline(readComposerText(root));
  if (!editorText) return true;
  return normalizeComposerMultiline(covered) === editorText;
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
 * Line-by-line insert for editors that mishandle embedded newlines in a
 * single `insertText` (the proven ProseMirror/TipTap pattern): select-all,
 * then `insertText` per line with `insertParagraph` between lines. Caller
 * flushes and verifies.
 */
function runMultilineInsert(root: EditableElement, deps: RichTextDeps, text: string): boolean {
  if (!selectAllVerified(root, deps)) return false;
  try {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0 && !deps.execCommand("insertParagraph", false, "")) return false;
      const line = lines[i];
      if (line && !deps.execCommand("insertText", false, line)) return false;
    }
    root.dispatchEvent(deps.createInputEvent());
    return true;
  } catch {
    return false;
  }
}

/** Whole-text editing input. Caller flushes and verifies. */
function runWholeInsert(root: EditableElement, deps: RichTextDeps, text: string): boolean {
  if (!selectAllVerified(root, deps)) return false;
  try {
    deps.execCommand("insertText", false, text);
  } catch {
    // Verification decides; execCommand lies in both directions.
  }
  try {
    root.dispatchEvent(deps.createInputEvent());
  } catch {
    // Verification decides; a dispatch failure alone is not fatal.
  }
  return true;
}

/**
 * Exact-match verify for the plain-text framework path. Unlike the shared
 * `verifiedRead` (which accepts containment for Slack's formatting
 * wrappers), an append must never verify: `execCommand("insertText")`
 * replaces the selection with plain text, so anything but equality is a
 * failed write.
 */
function verifyExact(root: EditableElement, text: string): { ok: boolean; readBack: string } {
  const readBack = readComposerText(root);
  const expected = normalizeComposerMultiline(text);
  if (!expected) return { ok: false, readBack };
  return { ok: normalizeComposerMultiline(readBack) === expected, readBack };
}

/**
 * Replace the framework composer contents via real editing input and verify.
 * Exactly one write op per strategy (whole-text, then line-by-line) with a
 * frame flush before every read-back; focus, selection coverage, and a
 * duplication circuit-breaker guard every step. Reports failure instead of
 * guessing — the caller keeps the panel open so the rewrite stays copyable.
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
  for (let attempt = 0; attempt < 3; attempt++) {
    const resolved = resolveFrameworkRoot(deps);
    if (!resolved) continue;
    const { root } = resolved;
    diag.tag = typeof root.tagName === "string" ? root.tagName.toUpperCase() : null;
    if (diag.preLen < 0) diag.preLen = normalizeComposerMultiline(readComposerText(root)).length;
    try {
      root.focus();
    } catch {
      continue;
    }
    if (!focusLanded(root, deps)) continue;
    diag.attempts += 1;
    if (runWholeInsert(root, deps, text)) {
      await deps.waitForFlush();
      const check = verifyExact(root, text);
      lastReadBack = check.readBack;
      const actual = normalizeComposerMultiline(check.readBack);
      if (isDuplicated(actual, expected)) return fail(check.readBack);
      if (check.ok) return succeed(check.readBack);
    }
    // Multiline select-all heals partial writes from the attempt above.
    if (runMultilineInsert(root, deps, text)) {
      await deps.waitForFlush();
      const check = verifyExact(root, text);
      lastReadBack = check.readBack;
      const actual = normalizeComposerMultiline(check.readBack);
      if (isDuplicated(actual, expected)) return fail(check.readBack);
      if (check.ok) return succeed(check.readBack);
    }
  }
  if (lastReadBack) return fail(lastReadBack);
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
    closestFromField: bindClosest(activeField),
    get closestFromFocused() {
      return bindClosest(doc.activeElement);
    },
  };
}
