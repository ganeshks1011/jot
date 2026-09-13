/**
 * Framework-aware write-back for model-driven rich-text editors
 * (Lexical, Slate, ProseMirror/TipTap, Quill, Draft.js, CKEditor).
 *
 * Single strategy by design: the overlay writes real clipboard flavors on
 * Enter, and the host pulls them through one trusted `paste` command into
 * the resolved editor root. No read-back, no retries, no fallbacks —
 * verification proved unable to distinguish editor normalization from
 * failure, and every fallback multiplied the failure modes it claimed to
 * cover. A refused paste is atomic at the selection and leaves the editor
 * untouched; the user recovers with the Copy button, which holds the same
 * content.
 *
 * Rules for this module:
 * - Never assign innerHTML / innerText / textContent / value.
 * - Framework markers are data for *root resolution only* — one code path
 *   for all frameworks, never per-framework branches.
 * - Never write without a live selection on the resolved root: abort
 *   instead of pasting into unknown state.
 */

import {
  type EditableElement,
  isEditableTarget,
  liveSlackDeps,
  type SlackDeps,
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
}

export interface RichTextDeps extends SlackDeps {
  getSelection: () => RichTextSelection | null;
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
 * Single-shot clipboard paste into the resolved framework root. Focuses,
 * selects all, and pastes once; returns whether the command was
 * dispatched. Never reads back, never retries — a refusal leaves the
 * editor untouched by construction.
 */
export function pasteClipboardOnce(root: EditableElement, deps: RichTextDeps): boolean {
  try {
    root.focus();
  } catch {
    // Focus is best-effort; the selection below decides.
  }
  const sel = deps.getSelection();
  if (!sel) return false;
  try {
    sel.selectAllChildren(root);
  } catch {
    return false;
  }
  try {
    return deps.execCommand("paste", false, "");
  } catch {
    return false;
  }
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
      return { selectAllChildren: (node: unknown) => sel.selectAllChildren(node as Node) };
    },
    execCommand: base.execCommand,
    createInputEvent: base.createInputEvent,
    createBeforeInputEvent: base.createBeforeInputEvent,
    closestFromField: bindClosest(activeField),
    get closestFromFocused() {
      return bindClosest(doc.activeElement);
    },
  };
}
