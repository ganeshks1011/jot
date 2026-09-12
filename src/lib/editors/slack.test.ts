import { describe, expect, it, vi } from "vitest";
import {
  alignMentionEntities,
  type EditableElement,
  isEditableTarget,
  isSlackComposer,
  type MentionEntity,
  normalizeComposerMultiline,
  outermostEditable,
  readComposerText,
  replaceSlackText,
  resolveLiveComposer,
  type SlackDeps,
  splitMentionRuns,
  splitRunsByLines,
} from "./slack";

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

function deps(overrides: Partial<SlackDeps> = {}): SlackDeps & { calls: string[] } {
  const calls: string[] = [];
  const composer = (overrides.activeField ?? overrides.activeElement) as EditableElement | null;
  return {
    activeField: null,
    activeElement: null,
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
    ...overrides,
    calls,
  } as SlackDeps & { calls: string[] };
}

describe("isSlackComposer", () => {
  it("matches slack hostnames only", () => {
    expect(isSlackComposer("app.slack.com")).toBe(true);
    expect(isSlackComposer("slack.com")).toBe(true);
    expect(isSlackComposer("gmail.com")).toBe(false);
    expect(isSlackComposer("fakeslack.com")).toBe(false);
  });
});

describe("isEditableTarget", () => {
  it("accepts contenteditables, textareas, and text inputs", () => {
    expect(isEditableTarget(element())).toBe(true);
    expect(isEditableTarget(element({ isContentEditable: false, tagName: "TEXTAREA" }))).toBe(true);
    expect(isEditableTarget(element({ isContentEditable: false, tagName: "INPUT", type: "text" }))).toBe(true);
    expect(isEditableTarget(element({ isContentEditable: false, tagName: "DIV" }))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("resolveLiveComposer", () => {
  it("prefers the connected capture target", () => {
    const field = element();
    const active = element();
    expect(resolveLiveComposer(deps({ activeField: field, activeElement: active }))).toBe(field);
  });

  it("falls back to the focused element when the capture is detached", () => {
    const field = element({ isConnected: false });
    const active = element();
    expect(resolveLiveComposer(deps({ activeField: field, activeElement: active }))).toBe(active);
  });

  it("returns null when nothing viable is focused", () => {
    expect(
      resolveLiveComposer(
        deps({ activeField: null, activeElement: element({ isContentEditable: false, tagName: "DIV" }) }),
      ),
    ).toBeNull();
  });
});

describe("replaceSlackText", () => {
  it("writes via editing input and verifies", () => {
    const composer = element({ innerText: "@Byte - status update?" });
    const d = deps({ activeField: composer });
    const result = replaceSlackText("@Byte - could you give me a status update?", d);
    expect(result.ok).toBe(true);
    expect(d.calls).toContain("selectAll");
    expect(d.calls).toContain("exec:insertText:@Byte - could you give me a status update?");
    expect(d.calls).toContain("inputEvent");
  });

  it("reports text-free diagnostics on success", () => {
    const composer = element({ tagName: "DIV", innerText: "@Byte - status update?" });
    const d = deps({ activeField: composer });
    const result = replaceSlackText("@Byte - could you give me a status update?", d);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.strategy).toBe("exec");
    expect(result.diagnostics.tag).toBe("DIV");
    expect(result.diagnostics.expectedLen).toBe("@Byte - could you give me a status update?".length);
    expect(result.diagnostics.postLen).toBe("@Byte - could you give me a status update?".length);
    expect(result.diagnostics.attempts).toBe(1);
    expect(JSON.stringify(result.diagnostics)).not.toContain("@Byte");
  });

  it("reports diagnostics on failure without leaking text", () => {
    const composer = element({ tagName: "DIV", innerText: "@Byte - status update?" });
    const execCommand = vi.fn(() => true); // claims success, changes nothing
    const d = deps({ activeField: composer, execCommand });
    const result = replaceSlackText("new text", d);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.strategy).toBeNull();
    expect(result.diagnostics.preLen).toBe("@Byte - status update?".length);
    expect(result.diagnostics.attempts).toBe(3);
    expect(JSON.stringify(result.diagnostics)).not.toContain("@Byte");
  });

  it("retries and reports failure when verification fails", () => {
    const composer = element({ innerText: "@Byte - status update?" });
    const execCommand = vi.fn(() => true); // claims success, changes nothing
    const d = deps({ activeField: composer, execCommand });
    const result = replaceSlackText("new text", d);
    expect(result.ok).toBe(false);
    expect(execCommand).toHaveBeenCalledTimes(3);
    expect(result.readBack).toBe("@Byte - status update?");
  });

  it("climbs from a nested mention pill to the composer root", () => {
    const composer = element({ tagName: "DIV", innerText: "@Byte - status update?" });
    const pill = element({ tagName: "SPAN", parentElement: composer });
    const calls: string[] = [];
    let selected: unknown = null;
    const d = {
      activeField: pill,
      activeElement: null,
      getSelection: () => ({
        selectAllChildren: (node: unknown) => {
          selected = node;
          calls.push("selectAll");
        },
      }),
      execCommand: (_command: string, _showUI: boolean, value: string) => {
        calls.push("exec");
        composer.innerText = value;
        return true;
      },
      createInputEvent: () => ({}) as Event,
    } as SlackDeps;
    const result = replaceSlackText("@Byte - could you give me a status update?", d);
    expect(result.ok).toBe(true);
    // Selection covers the whole composer, not just the pill.
    expect(selected).toBe(composer);
    expect(composer.innerText).toBe("@Byte - could you give me a status update?");
  });

  it("stops climbing at non-editable ancestors", () => {
    const wrapper = element({ isContentEditable: false, tagName: "DIV" });
    const composer = element({ tagName: "DIV", parentElement: wrapper });
    const pill = element({ tagName: "SPAN", parentElement: composer });
    expect(outermostEditable(pill)).toBe(composer);
    expect(outermostEditable(composer)).toBe(composer);
  });

  it("falls back to beforeinput when execCommand is not honored", () => {
    const composer = element({ innerText: "@Byte - status update?" });
    const calls: string[] = [];
    const d = {
      activeField: composer,
      activeElement: null,
      getSelection: () => ({
        selectAllChildren: () => {
          calls.push("selectAll");
        },
      }),
      execCommand: () => {
        calls.push("exec-denied");
        return false;
      },
      createInputEvent: () => ({}) as Event,
      createBeforeInputEvent: (value: string) => {
        calls.push("beforeinput");
        composer.innerText = value;
        return {} as Event;
      },
    } as SlackDeps;
    const result = replaceSlackText("@Byte - could you give me a status update?", d);
    expect(result.ok).toBe(true);
    expect(calls).toContain("exec-denied");
    expect(calls).toContain("beforeinput");
  });

  it("accepts verification when the editor wraps the replacement", () => {
    const composer = element({ innerText: "@Byte - status update?" });
    const d = deps({
      activeField: composer,
      execCommand: (_command: string, _showUI: boolean, value: string) => {
        // Editor keeps the text but adds surrounding formatting/pill markup.
        composer.innerText = ` ${value} `;
        return true;
      },
    });
    const result = replaceSlackText("new text", d);
    expect(result.ok).toBe(true);
  });

  it("re-reads focus on retry instead of reusing a snapshot", () => {
    const composer = element({ innerText: "" });
    const stale = element({ isConnected: false });
    // Nothing focused on the first resolution; focus lands on the composer
    // before the retry (as focusing during attempt 1 would cause live).
    const focusStates: Array<EditableElement | null> = [null, composer];
    const calls: string[] = [];
    const d = {
      activeField: stale,
      get activeElement() {
        return focusStates.shift() ?? null;
      },
      getSelection: () => ({
        selectAllChildren: () => {
          calls.push("selectAll");
        },
      }),
      execCommand: (_command: string, _showUI: boolean, value: string) => {
        calls.push("exec");
        composer.innerText = value;
        return true;
      },
      createInputEvent: () => ({}) as Event,
    } as SlackDeps;
    const result = replaceSlackText("hello", d);
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["selectAll", "exec"]);
  });

  it("reports failure when no composer can be resolved", () => {
    const d = deps({});
    const result = replaceSlackText("new text", d);
    expect(result.ok).toBe(false);
    expect(result.readBack).toBe("");
  });
});

describe("alignMentionEntities", () => {
  const byte: MentionEntity = { id: "U0C0UHAJAQG", label: "@Byte" };
  const ada: MentionEntity = { id: "U999", label: "@Ada" };

  it("accepts exact matches in order", () => {
    const r = alignMentionEntities(["@Byte", "@Ada"], [byte, ada]);
    expect(r.ok).toBe(true);
    expect(r.ordered).toEqual([byte, ada]);
  });

  it("accepts moved mentions in any order", () => {
    const r = alignMentionEntities(["@Ada", "@Byte"], [byte, ada]);
    expect(r.ok).toBe(true);
    expect(r.ordered).toEqual([ada, byte]);
  });

  it("accepts repeated identical mentions", () => {
    const r = alignMentionEntities(["@Byte", "@Byte"], [byte, byte]);
    expect(r.ok).toBe(true);
    expect(r.ordered).toEqual([byte, byte]);
  });

  it("rejects removed mentions", () => {
    expect(alignMentionEntities(["@Byte"], [byte, ada]).ok).toBe(false);
  });

  it("rejects duplicated mentions", () => {
    expect(alignMentionEntities(["@Byte", "@Byte"], [byte]).ok).toBe(false);
  });

  it("rejects unknown mentions", () => {
    expect(alignMentionEntities(["@Byte", "@Zed"], [byte]).ok).toBe(false);
  });

  it("accepts empty both sides", () => {
    expect(alignMentionEntities([], []).ok).toBe(true);
  });
});

describe("splitMentionRuns", () => {
  const byte: MentionEntity = { id: "U0C0UHAJAQG", label: "@Byte" };

  function slots(labels: string[]): Array<{ label: string; entity: MentionEntity }> {
    return labels.map((label) => ({ label, entity: byte }));
  }

  it("splits mention at the beginning", () => {
    expect(splitMentionRuns("@Byte - update?", slots(["@Byte"]))).toEqual([
      { kind: "mention", slot: { label: "@Byte", entity: byte } },
      { kind: "text", text: " - update?" },
    ]);
  });

  it("splits mention in the middle and at the end", () => {
    expect(
      splitMentionRuns("hi @Byte, ping @Ada", [
        { label: "@Byte", entity: byte },
        { label: "@Ada", entity: { id: "U999", label: "@Ada" } },
      ]),
    ).toEqual([
      { kind: "text", text: "hi " },
      { kind: "mention", slot: { label: "@Byte", entity: byte } },
      { kind: "text", text: ", ping " },
      {
        kind: "mention",
        slot: { label: "@Ada", entity: { id: "U999", label: "@Ada" } },
      },
    ]);
  });

  it("handles mention plus newline", () => {
    expect(splitMentionRuns("@Byte\nship it", slots(["@Byte"]))).toEqual([
      { kind: "mention", slot: { label: "@Byte", entity: byte } },
      { kind: "text", text: "\nship it" },
    ]);
  });
});

describe("readComposerText", () => {
  it("reads contenteditable innerText and field values", () => {
    expect(readComposerText(element({ innerText: "hi" }))).toBe("hi");
    expect(readComposerText(element({ isContentEditable: false, tagName: "TEXTAREA", value: "v" }))).toBe("v");
  });
});

describe("normalizeComposerMultiline", () => {
  it("preserves line breaks while collapsing horizontal whitespace", () => {
    expect(normalizeComposerMultiline("one\ntwo")).toBe("one\ntwo");
    expect(normalizeComposerMultiline("one\n\ntwo")).toBe("one\n\ntwo");
    expect(normalizeComposerMultiline("one  two\nhi   there")).toBe("one two\nhi there");
    expect(normalizeComposerMultiline("one")).toBe("one");
  });

  it("strips zero-width chars without touching newlines", () => {
    expect(normalizeComposerMultiline("a​\nb")).toBe("a\nb");
  });
});

describe("splitRunsByLines", () => {
  it("splits text runs into per-block lists, keeps mentions atomic", () => {
    const byte = { id: "U1", label: "@Byte" };
    const blocks = splitRunsByLines([
      { kind: "text", text: "hi " },
      { kind: "mention", slot: { label: "@Byte", entity: byte } },
      { kind: "text", text: "\n- ship\n- it" },
    ]);
    expect(blocks).toEqual([
      [
        { kind: "text", text: "hi " },
        { kind: "mention", slot: { label: "@Byte", entity: byte } },
      ],
      [{ kind: "text", text: "- ship" }],
      [{ kind: "text", text: "- it" }],
    ]);
  });
});
