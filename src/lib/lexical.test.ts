import { describe, expect, it, vi } from "vitest";
import {
  captureLexical,
  commitLexicalMap,
  LEXICAL_ROOT_SELECTOR,
  type LexicalEditorLike,
  readLexicalEditor,
  resolveLexicalRoot,
} from "./lexical";

function element(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { isConnected: true, closest: () => null, ...overrides };
}

function editorWith(
  state: unknown,
  opts: { throwsOnSet?: boolean } = {},
): {
  editor: LexicalEditorLike;
  current: { value: unknown };
} {
  const current = { value: state };
  const editor: LexicalEditorLike = {
    getEditorState: () => ({ toJSON: () => current.value }),
    parseEditorState: (s: unknown) => s,
    setEditorState: (s: unknown) => {
      if (opts.throwsOnSet) throw new Error("set failed");
      current.value = s;
    },
  };
  return { editor, current };
}

function lexicalState(): unknown {
  return {
    root: {
      type: "root",
      version: 1,
      children: [
        {
          type: "paragraph",
          version: 1,
          children: [{ type: "text", version: 1, text: "Hello" }],
        },
        {
          type: "list",
          version: 1,
          children: [{ type: "listitem", version: 1, children: [{ type: "text", version: 1, text: "one" }] }],
        },
      ],
    },
  };
}

describe("resolveLexicalRoot", () => {
  it("matches a focused root directly", () => {
    const root = element({ closest: (sel: string) => (sel === LEXICAL_ROOT_SELECTOR ? root : null) });
    expect(resolveLexicalRoot(root)).toBe(root);
  });

  it("returns null without a connected root", () => {
    const detached = element({ isConnected: false, closest: () => detached });
    expect(resolveLexicalRoot(detached)).toBeNull();
    expect(resolveLexicalRoot(element())).toBeNull();
    expect(resolveLexicalRoot(null)).toBeNull();
    expect(resolveLexicalRoot("nope")).toBeNull();
  });
});

describe("readLexicalEditor", () => {
  it("accepts a structurally complete instance", () => {
    const { editor } = editorWith(lexicalState());
    expect(readLexicalEditor({ __lexicalEditor: editor })).toBe(editor);
  });

  it("rejects missing or partial instances", () => {
    expect(readLexicalEditor({})).toBeNull();
    expect(readLexicalEditor({ __lexicalEditor: { getEditorState: () => ({}) } })).toBeNull();
    expect(readLexicalEditor(null)).toBeNull();
  });
});

describe("captureLexical", () => {
  it("captures state and nodes from a live root", () => {
    const state = lexicalState();
    const { editor } = editorWith(state);
    const root = element({ closest: () => root });
    const holder: Record<string, unknown> = root;
    holder.__lexicalEditor = editor;
    const capture = captureLexical(root);
    expect(capture?.editor).toBe(editor);
    expect(capture?.state).toBe(state);
    expect(capture?.nodes).toEqual([
      { id: "0/0", text: "Hello" },
      { id: "1/0/0", text: "one" },
    ]);
  });

  it("returns null with no text nodes", () => {
    const { editor } = editorWith({ root: { children: [] } });
    const root = element({ closest: () => root });
    (root as Record<string, unknown>).__lexicalEditor = editor;
    expect(captureLexical(root)).toBeNull();
  });
});

describe("commitLexicalMap", () => {
  it("applies the map and verifies the committed state", () => {
    const { editor } = editorWith(lexicalState());
    const state = editor.getEditorState().toJSON();
    const ok = commitLexicalMap(editor, state, { "0/0": "Hi", "1/0/0": "uno" });
    expect(ok).toBe(true);
    const committed = editor.getEditorState().toJSON() as {
      root: { children: Array<{ children?: Array<{ text?: string }> }> };
    };
    expect(committed.root.children[0]?.children?.[0]?.text).toBe("Hi");
  });

  it("returns false when set throws", () => {
    const { editor } = editorWith(lexicalState(), { throwsOnSet: true });
    expect(commitLexicalMap(editor, editor.getEditorState().toJSON(), { "0/0": "Hi" })).toBe(false);
  });

  it("returns false when the committed state drops a mapped id", () => {
    const dropping: LexicalEditorLike = {
      getEditorState: () => ({ toJSON: () => ({ root: { children: [] } }) }),
      parseEditorState: (s: unknown) => s,
      setEditorState: vi.fn(),
    };
    expect(commitLexicalMap(dropping, lexicalState(), { "0/0": "Hi" })).toBe(false);
  });
});
