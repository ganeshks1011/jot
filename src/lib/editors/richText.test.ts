import { describe, expect, it, vi } from "vitest";
import {
  FRAMEWORK_MARKERS,
  liveRichTextDeps,
  type RichTextDeps,
  replaceRichText,
  resolveFrameworkRoot,
} from "./richText";
import type { EditableElement } from "./slack";

function element(overrides: Partial<EditableElement> = {}): EditableElement {
  return {
    isConnected: true,
    isContentEditable: true,
    focus: () => {},
    dispatchEvent: () => true,
    innerText: "",
    ...overrides,
  };
}

/** Fake root carrying one framework marker; closest resolves it by selector. */
function markedRoot(markerId: string, overrides: Partial<EditableElement> = {}) {
  const marker = FRAMEWORK_MARKERS.find((m) => m.id === markerId);
  if (!marker) throw new Error(`unknown marker ${markerId}`);
  const root = element({ tagName: "DIV", ...overrides });
  const closest = (selector: string) => (selector === marker.selector ? root : null);
  return { root, closest };
}

function deps(
  overrides: Partial<RichTextDeps> & {
    field?: EditableElement | null;
    focused?: EditableElement | null;
    calls?: string[];
  } = {},
): RichTextDeps & { calls: string[] } {
  const calls: string[] = overrides.calls ?? [];
  const composer = (overrides.field ?? overrides.focused ?? null) as EditableElement | null;
  const fieldClosest = overrides.closestFromField !== undefined ? overrides.closestFromField : () => composer;
  return {
    activeField: overrides.field ?? null,
    activeElement: overrides.focused ?? null,
    getSelection: () => ({
      selectAllChildren: (node: unknown) => {
        calls.push("selectAll");
        expect(node).toBe(composer);
      },
    }),
    execCommand: (command: string, _showUI: boolean, value: string) => {
      calls.push(`exec:${command}:${value}`);
      if (composer) composer.innerText = value;
      return true;
    },
    createInputEvent: () => {
      calls.push("inputEvent");
      return {} as Event;
    },
    createBeforeInputEvent: (text: string) => {
      calls.push(`beforeinput:${text}`);
      return {} as Event;
    },
    closestFromField: fieldClosest,
    closestFromFocused: null,
    ...overrides,
    calls,
  } as RichTextDeps & { calls: string[] };
}

describe("resolveFrameworkRoot", () => {
  it.each(FRAMEWORK_MARKERS.map((m) => m.id))("resolves the %s root from the captured field", (id) => {
    const { root, closest } = markedRoot(id, { innerText: "hello world" });
    const resolved = resolveFrameworkRoot(deps({ field: root, closestFromField: closest }));
    expect(resolved?.root).toBe(root);
    expect(resolved?.framework).toBe(id);
  });

  it("falls back to the focused element when the capture is detached", () => {
    const field = element({ isConnected: false });
    const { root, closest } = markedRoot("lexical", { innerText: "hello world" });
    const d = deps({
      field,
      focused: root,
      closestFromField: () => null,
      closestFromFocused: closest,
    });
    const resolved = resolveFrameworkRoot(d);
    expect(resolved?.root).toBe(root);
    expect(resolved?.framework).toBe("lexical");
  });

  it("returns null when no framework marker matches", () => {
    const d = deps({
      field: element(),
      closestFromField: () => null,
      closestFromFocused: () => null,
    });
    expect(resolveFrameworkRoot(d)).toBeNull();
  });

  it("ignores disconnected roots", () => {
    const { root, closest } = markedRoot("slate", { isConnected: false });
    const d = deps({ field: root, closestFromField: closest, closestFromFocused: () => null });
    expect(resolveFrameworkRoot(d)).toBeNull();
  });
});

describe("replaceRichText", () => {
  it("writes via editing input and verifies", () => {
    const { root, closest } = markedRoot("lexical", { innerText: "hello world" });
    const d = deps({ field: root, closestFromField: closest });
    const result = replaceRichText("hello brave world", d);
    expect(result.ok).toBe(true);
    expect(d.calls).toContain("selectAll");
    expect(d.calls).toContain("exec:insertText:hello brave world");
    expect(d.calls).toContain("inputEvent");
  });

  it("reports text-free diagnostics on success", () => {
    const { root, closest } = markedRoot("prosemirror", { innerText: "old" });
    const d = deps({ field: root, closestFromField: closest });
    const result = replaceRichText("new text", d);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.strategy).toBe("exec");
    expect(result.diagnostics.tag).toBe("DIV");
    expect(result.diagnostics.expectedLen).toBe("new text".length);
    expect(result.diagnostics.attempts).toBe(1);
    expect(JSON.stringify(result.diagnostics)).not.toContain("new text");
  });

  it("falls back to line-by-line insert when whole-text exec fails", () => {
    const { root, closest } = markedRoot("prosemirror", { innerText: "old" });
    const lines: string[] = [];
    const d = deps({
      field: root,
      closestFromField: closest,
      createBeforeInputEvent: undefined,
      execCommand: (command: string, _showUI: boolean, value: string) => {
        if (command === "insertText" && value.includes("\n")) return false;
        if (command === "insertText") {
          lines.push(value);
          root.innerText = lines.join("\n");
          return true;
        }
        if (command === "insertParagraph") return true;
        return false;
      },
    });
    const result = replaceRichText("one\ntwo", d);
    expect(result.ok).toBe(true);
    expect(root.innerText).toBe("one\ntwo");
  });

  it("reports diagnostics on failure without leaking text", () => {
    const { root, closest } = markedRoot("quill", { innerText: "old content" });
    const execCommand = vi.fn(() => true); // claims success, changes nothing
    const d = deps({ field: root, closestFromField: closest, execCommand });
    const result = replaceRichText("new text", d);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.strategy).toBeNull();
    expect(result.diagnostics.preLen).toBe("old content".length);
    expect(result.diagnostics.attempts).toBe(3);
    expect(JSON.stringify(result.diagnostics)).not.toContain("new text");
  });
});

describe("liveRichTextDeps", () => {
  it("binds closest to the live document", () => {
    const root = { closest: (selector: string) => (selector === "x" ? root : null) };
    const doc = {
      activeElement: root,
      execCommand: () => true,
    };
    const win = { getSelection: () => null };
    const field = { closest: () => null };
    const d = liveRichTextDeps(doc as unknown as Document, win as unknown as Window, field as unknown as HTMLElement);
    expect(d.closestFromField?.("anything")).toBeNull();
    expect(d.closestFromFocused?.("x")).toBe(root);
    expect(d.activeElement).toBe(root);
  });
});
