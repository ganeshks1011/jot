import { describe, expect, it } from "vitest";
import { hasRichFormatting, htmlToPlainText, isMultilineText, sanitizeRichHtml } from "./richText";

describe("sanitizeRichHtml", () => {
  it("keeps the allowlist tags, strips attributes except safe href", () => {
    expect(sanitizeRichHtml("<p>hi <b>there</b></p>")).toBe("<p>hi <b>there</b></p>");
    expect(sanitizeRichHtml('<a href="https://x.com">x</a>')).toBe('<a href="https://x.com">x</a>');
    expect(sanitizeRichHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeRichHtml('<b class="x" style="y">t</b>')).toBe("<b>t</b>");
  });

  it("unwraps non-allowlist tags but keeps their text", () => {
    expect(sanitizeRichHtml("<div>hi <span>there</span></div>")).toBe("hi there");
    expect(sanitizeRichHtml("<h1>title</h1><p>body</p>")).toBe("title<p>body</p>");
  });

  it("removes scripts, event handlers, and comments", () => {
    expect(sanitizeRichHtml('<p onclick="evil()">hi</p><script>alert(1)</script>')).toBe("<p>hi</p>");
    expect(sanitizeRichHtml("a<!-- secret -->b")).toBe("ab");
  });
});

describe("htmlToPlainText", () => {
  it("maps paragraphs, breaks, and list items to newlines", () => {
    expect(htmlToPlainText("<p>one</p><p>two</p>")).toBe("one\n\ntwo");
    expect(htmlToPlainText("one<br>two")).toBe("one\ntwo");
    expect(htmlToPlainText("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
  });

  it("keeps bold/italic text, drops the tags", () => {
    expect(htmlToPlainText("<p>hi <b>there</b></p>")).toBe("hi there");
  });
});

describe("hasRichFormatting", () => {
  it("detects user formatting, ignores plain paragraphs", () => {
    expect(hasRichFormatting("<p>hi <b>x</b></p>")).toBe(true);
    expect(hasRichFormatting("<ul><li>x</li></ul>")).toBe(true);
    expect(hasRichFormatting("<p>plain</p>")).toBe(false);
    expect(hasRichFormatting("plain")).toBe(false);
  });
});

describe("isMultilineText", () => {
  it("detects line breaks", () => {
    expect(isMultilineText("one\ntwo")).toBe(true);
    expect(isMultilineText("one")).toBe(false);
  });
});
