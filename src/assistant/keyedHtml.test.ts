import { describe, expect, it } from "vitest";
import { buildKeyedHtml } from "./keyedHtml";

const identity = (html: string): string => html;

const nodes = [
  { id: "0/0", text: "Hello", block: "paragraph" },
  { id: "1/0/0", text: "one", block: "listitem" },
  { id: "1/1/0", text: "two", block: "listitem" },
];

describe("buildKeyedHtml", () => {
  it("wraps paragraphs and groups consecutive list items", () => {
    expect(buildKeyedHtml(nodes, { "0/0": "Hi", "1/0/0": "uno", "1/1/0": "dos" }, identity)).toBe(
      "<p>Hi</p><ul><li>uno</li><li>dos</li></ul>",
    );
  });

  it("splits lists interrupted by paragraphs and falls back to originals", () => {
    const mixed = [
      ...nodes,
      { id: "2/0", text: "After", block: "paragraph" },
      { id: "3/0/0", text: "three", block: "listitem" },
    ];
    expect(buildKeyedHtml(mixed, { "0/0": "Hi" }, identity)).toBe(
      "<p>Hi</p><ul><li>one</li><li>two</li></ul><p>After</p><ul><li>three</li></ul>",
    );
  });

  it("escapes values and treats unknown blocks as paragraphs", () => {
    expect(buildKeyedHtml([{ id: "0", text: "a&b", block: "quote" }], { "0": "x<y>" }, identity)).toBe(
      "<p>x&lt;y&gt;</p>",
    );
  });

  it("returns null with no nodes", () => {
    expect(buildKeyedHtml([], {}, identity)).toBeNull();
  });
});
