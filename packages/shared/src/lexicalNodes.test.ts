import { describe, expect, it } from "vitest";
import { applyLexicalRewrites, extractLexicalTextNodes, lexicalTextLength } from "./lexicalNodes";

function paragraph(...texts: string[]): unknown {
  return {
    type: "paragraph",
    version: 1,
    children: texts.map((text) => ({ type: "text", version: 1, text, format: 0 })),
  };
}

describe("extractLexicalTextNodes", () => {
  it("extracts nested text with index-path ids", () => {
    const state = {
      root: {
        type: "root",
        version: 1,
        children: [
          paragraph("Hello", "world"),
          {
            type: "list",
            version: 1,
            children: [
              { type: "listitem", version: 1, children: [{ type: "text", version: 1, text: "one" }] },
              { type: "listitem", version: 1, children: [{ type: "text", version: 1, text: "two" }] },
            ],
          },
        ],
      },
    };
    expect(extractLexicalTextNodes(state)).toEqual([
      { id: "0/0", text: "Hello", block: "paragraph" },
      { id: "0/1", text: "world", block: "paragraph" },
      { id: "1/0/0", text: "one", block: "listitem" },
      { id: "1/1/0", text: "two", block: "listitem" },
    ]);
  });

  it("skips empty text and returns [] for malformed state", () => {
    expect(extractLexicalTextNodes({ root: { children: [{ type: "text", text: "" }] } })).toEqual([]);
    expect(extractLexicalTextNodes(null)).toEqual([]);
    expect(extractLexicalTextNodes({})).toEqual([]);
    expect(extractLexicalTextNodes({ root: { children: "nope" } })).toEqual([]);
  });

  it("records heading blocks and falls back to paragraph at root", () => {
    const state = {
      root: {
        children: [
          { type: "heading", children: [{ type: "text", text: "Title" }] },
          { type: "text", text: "loose" },
        ],
      },
    };
    expect(extractLexicalTextNodes(state)).toEqual([
      { id: "0/0", text: "Title", block: "heading" },
      { id: "1", text: "loose", block: "paragraph" },
    ]);
  });
});

describe("applyLexicalRewrites", () => {
  it("replaces mapped nodes, preserves structure and formatting keys", () => {
    const firstText = { type: "text", version: 1, text: "Hello", format: 1 };
    const state = {
      root: {
        type: "root",
        version: 1,
        children: [
          {
            type: "paragraph",
            version: 1,
            children: [firstText],
          },
          {
            type: "list",
            version: 1,
            listType: "bullet",
            children: [{ type: "listitem", version: 1, children: [{ type: "text", version: 1, text: "one" }] }],
          },
        ],
      },
    };
    const next = applyLexicalRewrites(state, { "0/0": "Hi", "1/0/0": "uno", "9/9": "ignored" });
    expect(next).toEqual({
      root: {
        type: "root",
        version: 1,
        children: [
          {
            type: "paragraph",
            version: 1,
            children: [{ type: "text", version: 1, text: "Hi", format: 1 }],
          },
          {
            type: "list",
            version: 1,
            listType: "bullet",
            children: [{ type: "listitem", version: 1, children: [{ type: "text", version: 1, text: "uno" }] }],
          },
        ],
      },
    });
    // Input not mutated.
    expect(firstText.text).toBe("Hello");
  });

  it("returns a clone unchanged for malformed state", () => {
    const weird = { nope: 1 };
    const next = applyLexicalRewrites(weird, { "0": "x" });
    expect(next).toEqual(weird);
    expect(next).not.toBe(weird);
  });
});

describe("lexicalTextLength", () => {
  it("sums node text lengths", () => {
    expect(
      lexicalTextLength([
        { id: "0", text: "ab", block: "paragraph" },
        { id: "1", text: "cde", block: "listitem" },
      ]),
    ).toBe(5);
    expect(lexicalTextLength([])).toBe(0);
  });
});
