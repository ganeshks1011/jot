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
 * Rules for this module:
 * - Never assign innerHTML / innerText / textContent / value (reads only).
 * - Framework markers are data for *root resolution only* — one code path
 *   for all frameworks, never per-framework branches.
 * - Re-resolve the live root on every attempt; never trust a range cloned
 *   at capture time (frameworks re-render while the overlay is open).
 * - Verify every write by reading back; retry, then report failure.
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
  tryBeforeInput,
  tryExecInsert,
  verifiedRead,
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

export interface RichTextDeps extends SlackDeps {
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
 * Line-by-line insert for editors that mishandle embedded newlines in a
 * single `insertText` (the proven ProseMirror/TipTap pattern): select-all,
 * then `insertText` per line with `insertParagraph` between lines.
 */
function tryMultilineInsert(root: EditableElement, deps: RichTextDeps, text: string): boolean {
  const sel = deps.getSelection();
  if (!sel) return false;
  try {
    sel.selectAllChildren(root);
  } catch {
    return false;
  }
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

/**
 * Replace the framework composer contents via real editing input and verify.
 * Whole-text first, then line-by-line, then failure. Reports failure instead
 * of guessing — the caller keeps the panel open so the rewrite stays
 * copyable.
 */
export function replaceRichText(text: string, deps: RichTextDeps): SlackReplaceResult {
  const expectedLen = normalizeComposerMultiline(text).length;
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
  const succeed = (readBack: string, strategy: "exec" | "beforeinput"): SlackReplaceResult => {
    diag.strategy = strategy;
    diag.postLen = normalizeComposerMultiline(readBack).length;
    return { ok: true, readBack, diagnostics: { ...diag } };
  };
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
    diag.attempts += 1;
    tryExecInsert(root, deps, text);
    let check = verifiedRead(root, text);
    if (check.ok) return succeed(check.readBack, "exec");
    lastReadBack = check.readBack;
    if (tryBeforeInput(root, deps, text)) {
      check = verifiedRead(root, text);
      if (check.ok) return succeed(check.readBack, "beforeinput");
      lastReadBack = check.readBack;
    }
    // Multiline select-all heals partial writes from the attempts above.
    if (tryMultilineInsert(root, deps, text)) {
      check = verifiedRead(root, text);
      if (check.ok) return succeed(check.readBack, "exec");
      lastReadBack = check.readBack;
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
    getSelection: base.getSelection,
    execCommand: base.execCommand,
    createInputEvent: base.createInputEvent,
    createBeforeInputEvent: base.createBeforeInputEvent,
    closestFromField: bindClosest(activeField),
    get closestFromFocused() {
      return bindClosest(doc.activeElement);
    },
  };
}
