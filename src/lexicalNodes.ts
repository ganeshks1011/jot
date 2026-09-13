/**
 * Lexical editor-state transforms shared by the web backend and the Jot
 * extension. Pure JSON in / JSON out: no DOM, no `chrome.*`, no Lexical
 * dependency on either side.
 *
 * The extension captures `editor.getEditorState().toJSON()` from the live
 * Lexical instance, sends the extracted text nodes to the backend, and
 * applies the returned id->text map back into a cloned state object which
 * the instance commits atomically. Node ids are index paths (`"0/2/0"`)
 * from `root.children`, stable within a single capture/apply round trip.
 */

export interface LexicalTextNode {
  /** Index path from `root.children`, e.g. `"0/2/0"`. */
  id: string;
  text: string;
  /**
   * Nearest block-ancestor type (`paragraph`, `listitem`, `heading`, …).
   * Lets clients rebuild list/paragraph structure without the full state.
   * Ignored by apply and never sent to the model.
   */
  block: string;
}

interface LexicalNodeJson {
  type?: unknown;
  children?: unknown;
  text?: unknown;
  [key: string]: unknown;
}

interface LexicalRootJson {
  children?: unknown;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNodeArray(value: unknown): LexicalNodeJson[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every(isRecord)) return null;
  return value as LexicalNodeJson[];
}

/**
 * Extract rewritable text nodes from a Lexical editor-state JSON value.
 * Returns an empty array for anything that is not a well-formed state
 * (defensive: capture must never throw on foreign JSON).
 */
export function extractLexicalTextNodes(state: unknown): LexicalTextNode[] {
  if (!isRecord(state)) return [];
  const root = state["root"];
  if (!isRecord(root)) return [];
  const children = asNodeArray((root as LexicalRootJson)["children"]);
  if (!children) return [];
  const out: LexicalTextNode[] = [];
  const walk = (nodes: LexicalNodeJson[], base: string, parentBlock: string): void => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!isRecord(node)) continue;
      const path = base === "" ? `${i}` : `${base}/${i}`;
      const kids = asNodeArray(node["children"]);
      if (kids) {
        const childBlock = typeof node.type === "string" && node.type ? node.type : parentBlock;
        walk(kids, path, childBlock);
        continue;
      }
      const text = node["text"];
      if (typeof text === "string" && text.length > 0) {
        out.push({ id: path, text, block: parentBlock || "paragraph" });
      }
    }
  };
  walk(children, "", "");
  return out;
}

/**
 * Apply an id->rewritten-text map to a Lexical editor-state JSON value.
 * Returns a deep-cloned state with matched text nodes replaced; the input
 * is never mutated. Unknown map ids are ignored; unmapped nodes are kept.
 * Returns a clone of the input unchanged when it is not a well-formed
 * state (callers verify separately).
 */
export function applyLexicalRewrites(state: unknown, rewrites: Record<string, string>): unknown {
  let clone: unknown;
  try {
    clone = JSON.parse(JSON.stringify(state)) as unknown;
  } catch {
    return state;
  }
  if (!isRecord(clone)) return clone;
  const root = clone["root"];
  if (!isRecord(root)) return clone;
  const children = asNodeArray((root as LexicalRootJson)["children"]);
  if (!children) return clone;
  const walk = (nodes: LexicalNodeJson[], base: string): void => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!isRecord(node)) continue;
      const path = base === "" ? `${i}` : `${base}/${i}`;
      const kids = asNodeArray(node["children"]);
      if (kids) {
        walk(kids, path);
        continue;
      }
      if (typeof node["text"] === "string" && typeof rewrites[path] === "string") {
        node["text"] = rewrites[path];
      }
    }
  };
  walk(children, "");
  return clone;
}

/** Total visible characters across extracted nodes (for budgets). */
export function lexicalTextLength(nodes: LexicalTextNode[]): number {
  let total = 0;
  for (const node of nodes) total += node.text.length;
  return total;
}
