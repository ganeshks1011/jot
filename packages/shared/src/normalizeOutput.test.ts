import { describe, expect, it } from "vitest";
import { normalizeRewriteOutput } from "./normalizeOutput";

describe("normalizeRewriteOutput", () => {
  it("normalizes em and en dashes to a hyphen", () => {
    expect(normalizeRewriteOutput("a \u2014 b")).toBe("a - b");
    expect(normalizeRewriteOutput("a \u2013 b")).toBe("a - b");
  });

  it("normalizes smart quotes to straight quotes", () => {
    expect(normalizeRewriteOutput("\u201Chello\u201D")).toBe('"hello"');
    expect(normalizeRewriteOutput("\u2018hi\u2019")).toBe("'hi'");
    expect(normalizeRewriteOutput("it\u2019s")).toBe("it's");
  });

  it("normalizes the ellipsis character to three dots", () => {
    expect(normalizeRewriteOutput("wait\u2026")).toBe("wait...");
  });

  it("normalizes decorative bullets to hyphens", () => {
    expect(normalizeRewriteOutput("\u2022 item")).toBe("- item");
  });

  it("normalizes non-breaking spaces to regular spaces", () => {
    expect(normalizeRewriteOutput("a\u00A0b")).toBe("a b");
    expect(normalizeRewriteOutput("a\u202Fb")).toBe("a b");
  });

  it("strips zero-width characters entirely", () => {
    expect(normalizeRewriteOutput("in\u200Bvis\u200Cible\u200D")).toBe("invisible");
    expect(normalizeRewriteOutput("\uFEFFstart")).toBe("start");
  });

  it("preserves legitimate non-English characters", () => {
    const text = "Caf\u00E9 na\u00EFve \u4E2D\u6587 \u0440\u0443\u0441\u0441\u043A\u0438\u0439 \u{1F642}";
    expect(normalizeRewriteOutput(text)).toBe(text);
  });

  it("preserves URLs, @mentions, hashtags, and technical syntax", () => {
    const tech = "Visit https://example.com/a_b?x=1#frag, ping @user_name about #Topic, code: obj?.prop ?? 0";
    expect(normalizeRewriteOutput(tech)).toBe(tech);
  });

  it("leaves already-normalized text unchanged (no double replacement)", () => {
    expect(normalizeRewriteOutput("test - hyphen")).toBe("test - hyphen");
    expect(normalizeRewriteOutput('test "quoted"')).toBe('test "quoted"');
    expect(normalizeRewriteOutput("test ... ellipsis")).toBe("test ... ellipsis");
  });

  it("is idempotent", () => {
    const once = normalizeRewriteOutput("\u201Cx\u201D \u2014 y\u2026");
    expect(normalizeRewriteOutput(once)).toBe(once);
  });

  it("preserves paragraph breaks, list markers, and HTML tags for rewrite output", () => {
    expect(normalizeRewriteOutput("one\n\ntwo")).toBe("one\n\ntwo");
    expect(normalizeRewriteOutput("- one\n- two")).toBe("- one\n- two");
    expect(normalizeRewriteOutput("<p>hi <b>there</b></p>")).toBe("<p>hi <b>there</b></p>");
  });
});
