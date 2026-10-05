import { describe, expect, it, vi } from "vitest";
import {
  FRAMEWORK_MARKERS,
  liveRichTextDeps,
  pasteClipboardOnce,
  type RichTextDeps,
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
      return true;
    },
    createInputEvent: () => {
      calls.push("inputEvent");
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

describe("pasteClipboardOnce", () => {
  it("focuses, selects all, and pastes exactly once", () => {
    const focused: unknown[] = [];
    const { root, closest } = markedRoot("lexical", {
      innerText: "old",
      focus: () => {
        focused.push(root);
      },
    });
    const d = deps({ field: root, closestFromField: closest });
    expect(pasteClipboardOnce(root, d)).toBe(true);
    expect(focused).toEqual([root]);
    expect(d.calls).toEqual(["selectAll", "exec:paste:"]);
  });

  it("returns the execCommand verdict", () => {
    const { root, closest } = markedRoot("lexical", { innerText: "old" });
    const execCommand = vi.fn(() => false);
    const d = deps({ field: root, closestFromField: closest, execCommand });
    expect(pasteClipboardOnce(root, d)).toBe(false);
    expect(execCommand).toHaveBeenCalledWith("paste", false, "");
  });

  it("returns false without a live selection and never executes", () => {
    const { root, closest } = markedRoot("lexical", { innerText: "old" });
    const execCommand = vi.fn(() => true);
    const d = deps({ field: root, closestFromField: closest, execCommand, getSelection: () => null });
    expect(pasteClipboardOnce(root, d)).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("returns false when select-all throws and never executes", () => {
    const execCommand = vi.fn(() => true);
    const d = deps({
      field: element(),
      getSelection: () => ({
        selectAllChildren: () => {
          throw new Error("nope");
        },
      }),
      execCommand,
    });
    expect(pasteClipboardOnce(element(), d)).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("returns false when the paste command throws", () => {
    const execCommand = vi.fn(() => {
      throw new Error("denied");
    });
    const { root, closest } = markedRoot("lexical", { innerText: "old" });
    const d = deps({ field: root, closestFromField: closest, execCommand });
    expect(pasteClipboardOnce(root, d)).toBe(false);
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
