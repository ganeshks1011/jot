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
      selectionText: () => composer?.innerText ?? null,
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
    waitForFlush: async () => {},
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
  it("writes via editing input and verifies", async () => {
    const { root, closest } = markedRoot("lexical", { innerText: "hello world" });
    const d = deps({ field: root, closestFromField: closest });
    const result = await replaceRichText("hello brave world", d);
    expect(result.ok).toBe(true);
    expect(d.calls).toContain("selectAll");
    expect(d.calls).toContain("exec:insertText:hello brave world");
    expect(d.calls).toContain("inputEvent");
    // No synthetic beforeinput: execCommand already fires a real one, and
    // stacking both double-applies the text in Lexical.
    expect(d.calls.filter((c) => c.startsWith("beforeinput:"))).toHaveLength(0);
  });

  it("verifies after the framework flush, not synchronously", async () => {
    const { root, closest } = markedRoot("lexical", { innerText: "old" });
    let pending: string | null = null;
    const d = deps({
      field: root,
      closestFromField: closest,
      execCommand: (command: string, _showUI: boolean, value: string) => {
        if (command === "insertText") {
          pending = value; // Lexical batches the commit; DOM updates on flush.
          return true;
        }
        return false;
      },
      waitForFlush: async () => {
        if (pending != null) {
          root.innerText = pending;
          pending = null;
        }
      },
    });
    const result = await replaceRichText("new text", d);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.attempts).toBe(1);
  });

  it("reports text-free diagnostics on success", async () => {
    const { root, closest } = markedRoot("prosemirror", { innerText: "old" });
    const d = deps({ field: root, closestFromField: closest });
    const result = await replaceRichText("new text", d);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.strategy).toBe("exec");
    expect(result.diagnostics.tag).toBe("DIV");
    expect(result.diagnostics.expectedLen).toBe("new text".length);
    expect(result.diagnostics.attempts).toBe(1);
    expect(JSON.stringify(result.diagnostics)).not.toContain("new text");
  });

  it("accepts containment within a proportional length bound", async () => {
    const base =
      "The quick brown fox jumps over the lazy dog near the riverbank at dawn. " +
      "The quick brown fox jumps over the lazy dog near the riverbank at dawn. " +
      "The quick brown fox jumps over the lazy dog near the riverbank at dawn. " +
      "The quick brown fox jumps over the lazy dog near the riverbank at dawn. ";
    // Editor-added residue (~5 chars) on a ~290-char rewrite: within slack.
    const { root, closest } = markedRoot("lexical", { innerText: `${base}coda` });
    const execCommand = vi.fn(() => true); // claims success, changes nothing
    const d = deps({ field: root, closestFromField: closest, execCommand });
    const result = await replaceRichText(base, d);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.strategy).toBe("exec");
  });

  it("rejects containment beyond the proportional bound", async () => {
    const base =
      "The quick brown fox jumps over the lazy dog near the riverbank at dawn. " +
      "The quick brown fox jumps over the lazy dog near the riverbank at dawn. ";
    const prefix = "Leftover original preamble that dwarfs the tolerance bound entirely factory. ";
    const { root, closest } = markedRoot("lexical", { innerText: `${prefix}${base}` });
    const execCommand = vi.fn(() => true); // claims success, changes nothing
    const d = deps({ field: root, closestFromField: closest, execCommand });
    const result = await replaceRichText(base, d);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.attempts).toBe(3);
  });

  it("falls back to line-by-line insert when whole-text exec fails", async () => {
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
    const result = await replaceRichText("one\ntwo", d);
    expect(result.ok).toBe(true);
    expect(root.innerText).toBe("one\ntwo");
  });

  it("skips writes when focus did not land in the editor", async () => {
    const { root, closest } = markedRoot("lexical", { innerText: "old" });
    const other = element({ tagName: "BODY", isContentEditable: false });
    const execCommand = vi.fn(() => true);
    const d = deps({ field: root, focused: other, closestFromField: closest, execCommand });
    const result = await replaceRichText("new text", d);
    expect(result.ok).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
    expect(result.diagnostics.attempts).toBe(0);
    expect(root.innerText).toBe("old");
  });

  it("skips exec when the selection does not cover the editor", async () => {
    const { root, closest } = markedRoot("lexical", { innerText: "full text here" });
    const execCommand = vi.fn(() => true);
    const d = deps({
      field: root,
      closestFromField: closest,
      execCommand,
      getSelection: () => ({
        selectAllChildren: () => {},
        selectionText: () => "partial", // collapsed/partial: would append
      }),
    });
    const result = await replaceRichText("new text", d);
    expect(result.ok).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
    expect(root.innerText).toBe("full text here");
  });

  it("aborts further writes once duplication is detected", async () => {
    const { root, closest } = markedRoot("lexical", { innerText: "old" });
    const execCommand = vi.fn((_command: string, _showUI: boolean, value: string) => {
      root.innerText = `${root.innerText}${value}${value}`; // double-apply in one op
      return true;
    });
    const d = deps({ field: root, closestFromField: closest, execCommand });
    const result = await replaceRichText("new text", d);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.strategy).toBeNull();
    // One op applied twice, then the breaker trips; restore appends the
    // snapshot with this append-only fake (replace semantics live).
    expect(execCommand).toHaveBeenCalledTimes(2);
    expect((root.innerText ?? "").endsWith("old")).toBe(true);
  });

  it("reports diagnostics on failure without leaking text", async () => {
    const { root, closest } = markedRoot("quill", { innerText: "old content" });
    const execCommand = vi.fn(() => true); // claims success, changes nothing
    const d = deps({ field: root, closestFromField: closest, execCommand });
    const result = await replaceRichText("new text", d);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.strategy).toBeNull();
    expect(result.diagnostics.preLen).toBe("old content".length);
    expect(result.diagnostics.attempts).toBe(3);
    expect(JSON.stringify(result.diagnostics)).not.toContain("new text");
  });

  it("retries and reports failure when verification fails", async () => {
    const { root, closest } = markedRoot("quill", { innerText: "old content" });
    const execCommand = vi.fn(() => true); // claims success, changes nothing
    const d = deps({ field: root, closestFromField: closest, execCommand });
    const result = await replaceRichText("new text", d);
    expect(result.ok).toBe(false);
    // Whole-text + multiline exec per attempt across 3 attempts.
    expect(execCommand).toHaveBeenCalledTimes(6);
    expect(result.readBack).toBe("old content");
  });

  it("waits for the model selection to map before executing", async () => {
    const { root, closest } = markedRoot("lexical", { innerText: "old" });
    let mapped: string | null = null; // model selection: nothing mapped yet
    let domSel = "";
    const execCommand = vi.fn((command: string, _showUI: boolean, value: string) => {
      if (command !== "insertText") return false;
      // The framework executes against the MAPPED selection: a stale
      // mapping appends at the old cursor instead of replacing.
      if (mapped === root.innerText) root.innerText = value;
      else root.innerText = `${root.innerText}${value}`;
      return true;
    });
    const d = deps({
      field: root,
      closestFromField: closest,
      execCommand,
      getSelection: () => ({
        selectAllChildren: (_node: unknown) => {
          domSel = root.innerText ?? "";
        },
        selectionText: () => mapped,
      }),
      waitForFlush: async () => {
        mapped = domSel; // flush commits the DOM selection into the model
      },
    });
    const result = await replaceRichText("new text", d);
    expect(result.ok).toBe(true);
    expect(root.innerText).toBe("new text");
    expect(result.diagnostics.attempts).toBe(1);
  });

  it("verifies coverage across list markup with different break placement", async () => {
    const { root, closest } = markedRoot("lexical", { innerText: "Item one\nItem two\nItem three" });
    const execCommand = vi.fn((_command: string, _showUI: boolean, value: string) => {
      root.innerText = value;
      return true;
    });
    const d = deps({
      field: root,
      closestFromField: closest,
      execCommand,
      getSelection: () => ({
        selectAllChildren: () => {},
        // Selection text joins blocks with spaces where innerText uses newlines.
        selectionText: () => "Item one Item two Item three",
      }),
    });
    const result = await replaceRichText("Item 1\nItem 2", d);
    expect(result.ok).toBe(true);
    expect(root.innerText).toBe("Item 1\nItem 2");
  });

  it("still rejects partial selections on rich content", async () => {
    const { root, closest } = markedRoot("lexical", { innerText: "Item one\nItem two" });
    const execCommand = vi.fn(() => true);
    const d = deps({
      field: root,
      closestFromField: closest,
      execCommand,
      getSelection: () => ({
        selectAllChildren: () => {},
        selectionText: () => "Item one",
      }),
    });
    const result = await replaceRichText("Replacement text here", d);
    expect(result.ok).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
    expect(root.innerText).toBe("Item one\nItem two");
  });

  it("skips the op when the mapped selection never covers the editor", async () => {
    const { root, closest } = markedRoot("lexical", { innerText: "full text here" });
    const execCommand = vi.fn(() => true);
    const d = deps({
      field: root,
      closestFromField: closest,
      execCommand,
      getSelection: () => ({
        selectAllChildren: () => {},
        selectionText: () => "stale",
      }),
    });
    const result = await replaceRichText("new text", d);
    expect(result.ok).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
    expect(root.innerText).toBe("full text here");
  });

  it("aborts when content outgrows the expected write", async () => {
    const { root, closest } = markedRoot("lexical", { innerText: "old" });
    const execCommand = vi.fn((_command: string, _showUI: boolean, value: string) => {
      // The rewrite write blows past the growth cap; the restore write applies.
      root.innerText = `${root.innerText}${value === "new text" ? "z".repeat(600) : value}`;
      return true;
    });
    const d = deps({ field: root, closestFromField: closest, execCommand });
    const result = await replaceRichText("new text", d);
    expect(result.ok).toBe(false);
    // Growth cap trips on the first op; restore appends the snapshot with
    // this append-only fake (replace semantics live).
    expect(execCommand).toHaveBeenCalledTimes(2);
    expect((root.innerText ?? "").endsWith("old")).toBe(true);
  });

  it("attempts snapshot restore when a failed run grew the composer", async () => {
    const { root, closest } = markedRoot("lexical", { innerText: "old" });
    const execCommand = vi.fn((_command: string, _showUI: boolean, value: string) => {
      root.innerText = `${root.innerText}${value}`; // append-only editor
      return true;
    });
    const d = deps({ field: root, closestFromField: closest, execCommand });
    const result = await replaceRichText("new text", d);
    expect(result.ok).toBe(false);
    // Whole-text append, multiline append (trips the breaker), restore.
    expect(execCommand).toHaveBeenCalledTimes(3);
    expect((root.innerText ?? "").endsWith("old")).toBe(true);
  });

  it("restores the snapshot before retrying a diverged composer", async () => {
    const { root, closest } = markedRoot("lexical", { innerText: "old" });
    const execCommand = vi.fn((_command: string, _showUI: boolean, value: string) => {
      if (value === "old") root.innerText = value; // restore replaces
      else root.innerText = `${root.innerText ?? ""}!`; // ops append a fragment
      return true;
    });
    const d = deps({ field: root, closestFromField: closest, execCommand });
    const result = await replaceRichText("new text", d);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.attempts).toBe(3);
    // Attempt 1 ops (2) + attempt 2 restore (1) and ops (2) + attempt 3
    // restore (1) and ops (2) + final restore (1): every retry starts clean.
    expect(execCommand).toHaveBeenCalledTimes(9);
    expect(result.readBack).toBe("old");
  });

  it("aborts the run when the retry restore cannot verify", async () => {
    const { root, closest } = markedRoot("lexical", { innerText: "old" });
    const execCommand = vi.fn((_command: string, _showUI: boolean, value: string) => {
      if (value.includes("\n")) {
        root.innerText = `${root.innerText ?? ""}!`; // whole-op fragment
        return true;
      }
      if (value === "old") {
        root.innerText = `${root.innerText ?? ""}${value}`; // broken restore appends
        return true;
      }
      return false; // line execs fail
    });
    const d = deps({ field: root, closestFromField: closest, execCommand });
    const result = await replaceRichText("aa\nbb", d);
    expect(result.ok).toBe(false);
    // Attempt 1 (whole + line) then a single restore attempt that cannot
    // verify: fail closed instead of stacking attempt 3 on corruption.
    expect(execCommand).toHaveBeenCalledTimes(3);
    expect(result.diagnostics.attempts).toBe(2);
    expect(result.readBack).toBe("old!old");
  });

  it("prefers the selection event over a bare flush for model sync", async () => {
    const { root, closest } = markedRoot("lexical", { innerText: "old" });
    const syncSpy = vi.fn(async () => {});
    const flushSpy = vi.fn(async () => {});
    const d = deps({
      field: root,
      closestFromField: closest,
      awaitSelectionSynced: syncSpy,
      waitForFlush: flushSpy,
    });
    const result = await replaceRichText("new text", d);
    expect(result.ok).toBe(true);
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(flushSpy).toHaveBeenCalledTimes(1); // post-op verify flush only
  });

  it("tracks root identity across attempts for re-attached editors", async () => {
    const rootA = element({ tagName: "DIV", innerText: "old" });
    const rootB = element({ tagName: "DIV", innerText: "old" });
    const marker = FRAMEWORK_MARKERS.find((m) => m.id === "lexical");
    if (!marker) throw new Error("missing lexical marker");
    let resolves = 0;
    let selected: EditableElement | null = null;
    const execCommand = vi.fn((_command: string, _showUI: boolean, value: string) => {
      if (!selected) return false;
      // Restore replaces; ops append fragments (stale-model editor).
      if (value === "old") selected.innerText = value;
      else selected.innerText = `${selected.innerText ?? ""}!`;
      return true;
    });
    const d = deps({
      field: rootA,
      closestFromField: (selector: string) => {
        if (selector !== marker.selector) return null;
        resolves += 1;
        return resolves === 1 ? rootA : rootB; // re-attach after attempt 1
      },
      closestFromFocused: () => null,
      execCommand,
      getSelection: () => ({
        selectAllChildren: (node: unknown) => {
          selected = node as EditableElement;
        },
        selectionText: () => selected?.innerText ?? null,
      }),
    });
    const seen: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(console, "debug").mockImplementation((...args: unknown[]) => {
      if (args[0] === "[jot] rich-write") seen.push(args[1] as Record<string, unknown>);
    });
    const result = await replaceRichText("new text", d);
    spy.mockRestore();
    expect(result.ok).toBe(false);
    const wholeRoots = seen.filter((t) => t.op === "whole").map((t) => t.sameRoot);
    expect(wholeRoots).toEqual([false, false, true]);
    expect(result.readBack).toBe("old");
  });

  it("inserts sanitized HTML when the editor honors insertHTML", async () => {
    const { root, closest } = markedRoot("lexical", { innerText: "old" });
    const html = "<ul><li>one</li><li>two</li></ul>";
    const commands: string[] = [];
    const execCommand = vi.fn((command: string, _showUI: boolean, _value: string) => {
      commands.push(command);
      if (command === "insertHTML") {
        root.innerText = "- one\n- two";
        return true;
      }
      return false;
    });
    const d = deps({ field: root, closestFromField: closest, execCommand });
    const result = await replaceRichText("one\ntwo", d, html);
    expect(result.ok).toBe(true);
    expect(commands).toEqual(["insertHTML"]);
  });

  it("falls back to plain text when insertHTML is refused", async () => {
    const { root, closest } = markedRoot("lexical", { innerText: "old" });
    const html = "<ul><li>one</li><li>two</li></ul>";
    const commands: string[] = [];
    const execCommand = vi.fn((command: string, _showUI: boolean, value: string) => {
      commands.push(command);
      if (command === "insertHTML") return false;
      if (command === "insertText") {
        root.innerText = value;
        return true;
      }
      return false;
    });
    const d = deps({ field: root, closestFromField: closest, execCommand });
    const result = await replaceRichText("Replacement text here", d, html);
    expect(result.ok).toBe(true);
    expect(commands[0]).toBe("insertHTML");
    expect(commands).toContain("insertText");
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
