import { describe, expect, it } from "vitest";
import { DEMO_EXAMPLES, getDemoExamples } from "./onboardingExamples";

describe("getDemoExamples", () => {
  it("returns default examples for default context", () => {
    const list = getDemoExamples("default");
    expect(list).toHaveLength(5);
    expect(list[0]?.title).toBe("Messy thought");
    expect(list[0]?.input).toContain("launch");
  });

  it("returns email-specific examples for email context", () => {
    const list = getDemoExamples("email");
    expect(list).toHaveLength(5);
    expect(list.map((e) => e.title)).toContain("Follow up");
    expect(list[0]?.input).toContain("last week");
  });

  it("returns five non-empty entries per context", () => {
    for (const ctx of Object.keys(DEMO_EXAMPLES) as (keyof typeof DEMO_EXAMPLES)[]) {
      const list = getDemoExamples(ctx);
      expect(list).toHaveLength(5);
      for (const ex of list) {
        expect(ex.title.trim()).not.toBe("");
        expect(ex.input.trim()).not.toBe("");
      }
    }
  });
});
