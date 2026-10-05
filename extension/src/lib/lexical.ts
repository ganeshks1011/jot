/**
 * Lexical editor-instance capture and commit for the Jot host controller.
 *
 * Instead of driving the editor through synthetic editing input (which races
 * Lexical's async model selection and duplicates or flattens content), this
 * module reads the live editor instance parked on the editor root DOM node
 * (`__lexicalEditor`), snapshots its serializable state, and commits a
 * rewritten state built with the shared JSON transforms. Structure
 * (lists, paragraphs, inline formats) survives as data, never as tags.
 *
 * Rules for this module:
 * - Never touch editor internals beyond the three documented methods
 *   (`getEditorState`, `parseEditorState`, `setEditorState`).
 * - Every DOM/property access is guarded; anything unexpected resolves to
 *   null/false so callers fall back to the existing text-insert path.
 * - Verification reads the committed state back; mismatch means failure.
 */

import { applyLexicalRewrites, extractLexicalTextNodes, type LexicalTextNode } from "@wurkflo/shared";

/** Attribute marking a Lexical editor root element. */
export const LEXICAL_ROOT_SELECTOR = '[data-lexical-editor="true"]';

/** Minimal structural surface needed for root resolution (DOM + fakes). */
export interface LexicalElementLike {
  readonly isConnected: boolean;
  closest(selector: string): unknown;
}

function isLexicalElementLike(value: unknown): value is LexicalElementLike {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.isConnected === "boolean" && typeof record.closest === "function";
}

/**
 * Resolve the Lexical editor root for a captured field. `closest` includes
 * the element itself, so a focused root matches directly. Returns null for
 * anything without a connected Lexical root.
 */
export function resolveLexicalRoot(field: unknown): LexicalElementLike | null {
  if (!isLexicalElementLike(field)) return null;
  let found: unknown;
  try {
    found = field.closest(LEXICAL_ROOT_SELECTOR);
  } catch {
    return null;
  }
  if (!isLexicalElementLike(found)) return null;
  return found.isConnected ? found : null;
}

/** Minimal structural surface of a Lexical editor instance. */
export interface LexicalEditorStateLike {
  toJSON(): unknown;
}

export interface LexicalEditorLike {
  getEditorState(): LexicalEditorStateLike;
  parseEditorState(state: unknown): unknown;
  setEditorState(state: unknown): void;
}

function isLexicalEditorLike(value: unknown): value is LexicalEditorLike {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.getEditorState === "function" &&
    typeof record.parseEditorState === "function" &&
    typeof record.setEditorState === "function"
  );
}

/**
 * Read the live Lexical editor instance parked on the root DOM node.
 * Returns null when absent or structurally incomplete (caller falls back).
 */
export function readLexicalEditor(root: unknown): LexicalEditorLike | null {
  if (typeof root !== "object" || root === null) return null;
  let candidate: unknown;
  try {
    candidate = (root as Record<string, unknown>).__lexicalEditor;
  } catch {
    return null;
  }
  return isLexicalEditorLike(candidate) ? candidate : null;
}

export interface LexicalCapture {
  editor: LexicalEditorLike;
  /** Serializable editor-state JSON snapshot (for commit + restore). */
  state: unknown;
  nodes: LexicalTextNode[];
}

/**
 * Capture the live Lexical state and its rewritable text nodes for a
 * captured field. Returns null when there is no usable Lexical instance
 * or no text to rewrite (caller keeps the existing text path).
 */
export function captureLexical(field: unknown): LexicalCapture | null {
  const root = resolveLexicalRoot(field);
  if (!root) return null;
  const editor = readLexicalEditor(root);
  if (!editor) return null;
  let state: unknown;
  try {
    state = editor.getEditorState().toJSON();
  } catch {
    return null;
  }
  const nodes = extractLexicalTextNodes(state);
  if (nodes.length === 0) return null;
  return { editor, state, nodes };
}

/**
 * Commit an id->text rewrite map into the live editor by building a new
 * state object and setting it atomically. Verifies by re-reading: every
 * mapped id must be present with exactly the rewritten text. Returns false
 * on any failure (caller falls back; the editor may be partially updated
 * only if the instance itself applied partially — callers restore from
 * snapshot on failure).
 */
export function commitLexicalMap(editor: LexicalEditorLike, state: unknown, map: Record<string, string>): boolean {
  let next: unknown;
  try {
    next = applyLexicalRewrites(state, map);
  } catch {
    return false;
  }
  try {
    editor.setEditorState(editor.parseEditorState(next));
  } catch {
    return false;
  }
  let check: unknown;
  try {
    check = editor.getEditorState().toJSON();
  } catch {
    return false;
  }
  const byId = new Map(extractLexicalTextNodes(check).map((n) => [n.id, n.text] as const));
  for (const [id, want] of Object.entries(map)) {
    if (byId.get(id) !== want) return false;
  }
  return true;
}
