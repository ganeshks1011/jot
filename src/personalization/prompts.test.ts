import { describe, expect, it } from "vitest";
import { BASE_PROMPT, buildFeedbackBlock, buildSystemPrompt, buildUserMessage, PLACEHOLDER_GUARD } from "./prompts";

describe("buildSystemPrompt", () => {
  it("wraps mode prompt in COMMON_PROMPT via {mode_instruction}", () => {
    const modePrompt = "Test mode prompt";
    const result = buildSystemPrompt(modePrompt);
    expect(result).toContain("ACTIVE MODE:");
    expect(result).toContain(modePrompt);
    expect(result).toContain("You rewrite text according to the active mode.");
    expect(result).not.toContain("{mode_instruction}");
    expect(result).toContain("Preserve the user's meaning");
    expect(result).toContain("Preserve the user's structure");
    expect(result).toContain("do not invent new formatting");
  });
  it("trims mode prompt", () => {
    expect(buildSystemPrompt("  hello  ")).toContain("ACTIVE MODE:\nhello");
  });
  it("omits the placeholder guard by default", () => {
    expect(buildSystemPrompt("hello")).not.toContain("Preserve every placeholder");
  });
  it("appends the placeholder guard when opted in", () => {
    const result = buildSystemPrompt("hello", { preservePlaceholders: true });
    expect(result).toContain("ACTIVE MODE:\nhello");
    expect(result).toContain(PLACEHOLDER_GUARD);
  });
});

describe("buildFeedbackBlock", () => {
  it("returns framing plus feedback block", () => {
    expect(buildFeedbackBlock("shorter")).toBe(
      `Apply the feedback below to guide this rewrite. Feedback refines the output within the selected mode; never include the feedback text itself in the rewritten text.\n\n` +
        `<feedback>\nshorter\n</feedback>`,
    );
  });
  it("returns empty for blank feedback", () => {
    expect(buildFeedbackBlock("   ")).toBe("");
    expect(buildFeedbackBlock()).toBe("");
  });
});

describe("buildUserMessage", () => {
  it("returns a single user_input block wrapping the input when called with only input", () => {
    const input = "test input";
    const result = buildUserMessage({ input });

    expect(result).toBe(`<user_input>\ntest input\n</user_input>`);
  });

  it("preserves surrounding whitespace in input (not trimming)", () => {
    const input = "  test with whitespace  ";
    const result = buildUserMessage({ input });

    expect(result).toBe(`<user_input>\n  test with whitespace  \n</user_input>`);
  });

  it("includes custom instructions block before user_input when customInstruction is provided and non-empty", () => {
    const result = buildUserMessage({
      input: "test input",
      customInstruction: "Do this thing",
    });

    expect(result).toBe(
      `<custom_instructions>\nDo this thing\n</custom_instructions>\n\n` + `<user_input>\ntest input\n</user_input>`,
    );
  });

  it("trims custom instructions before including them", () => {
    const result = buildUserMessage({
      input: "test input",
      customInstruction: "  trim this  ",
    });

    expect(result).toBe(
      `<custom_instructions>\ntrim this\n</custom_instructions>\n\n` + `<user_input>\ntest input\n</user_input>`,
    );
  });

  it("omits custom instructions block when customInstruction is whitespace-only or empty", () => {
    const result1 = buildUserMessage({
      input: "test input",
      customInstruction: "   ",
    });

    expect(result1).toBe(`<user_input>\ntest input\n</user_input>`);

    const result2 = buildUserMessage({
      input: "test input",
      customInstruction: "",
    });

    expect(result2).toBe(`<user_input>\ntest input\n</user_input>`);
  });

  it("includes feedback framing and feedback block when feedback is provided and non-empty", () => {
    const result = buildUserMessage({
      input: "test input",
      feedback: "Some feedback",
    });

    expect(result).toBe(
      `Apply the feedback below to guide this rewrite. Feedback refines the output within the selected mode; never include the feedback text itself in the rewritten text.\n\n` +
        `<feedback>\nSome feedback\n</feedback>\n\n` +
        `<user_input>\ntest input\n</user_input>`,
    );
  });

  it("trims feedback before including it", () => {
    const result = buildUserMessage({
      input: "test input",
      feedback: "  trim this  ",
    });

    expect(result).toBe(
      `Apply the feedback below to guide this rewrite. Feedback refines the output within the selected mode; never include the feedback text itself in the rewritten text.\n\n` +
        `<feedback>\ntrim this\n</feedback>\n\n` +
        `<user_input>\ntest input\n</user_input>`,
    );
  });

  it("omits feedback block when feedback is whitespace-only or empty", () => {
    const result1 = buildUserMessage({
      input: "test input",
      feedback: "   ",
    });

    expect(result1).toBe(`<user_input>\ntest input\n</user_input>`);

    const result2 = buildUserMessage({
      input: "test input",
      feedback: "",
    });

    expect(result2).toBe(`<user_input>\ntest input\n</user_input>`);
  });

  it("maintains correct order of blocks: custom_instructions (if any), feedback framing + feedback (if any), user_input (always last)", () => {
    const result = buildUserMessage({
      input: "test input",
      customInstruction: "Custom instruction",
      feedback: "Some feedback",
    });

    expect(result).toBe(
      `<custom_instructions>\nCustom instruction\n</custom_instructions>\n\n` +
        `Apply the feedback below to guide this rewrite. Feedback refines the output within the selected mode; never include the feedback text itself in the rewritten text.\n\n` +
        `<feedback>\nSome feedback\n</feedback>\n\n` +
        `<user_input>\ntest input\n</user_input>`,
    );
  });

  it("includes the sanitized HTML block ahead of plain input when provided", () => {
    const result = buildUserMessage({
      input: "hi there",
      inputHtml: "<p>hi <b>there</b></p>",
    });
    expect(result).toBe(
      `<user_input_html>\n<p>hi <b>there</b></p>\n</user_input_html>\n\n` + `<user_input>\nhi there\n</user_input>`,
    );
  });

  it("omits the HTML block when absent or blank", () => {
    expect(buildUserMessage({ input: "x" })).toBe(`<user_input>\nx\n</user_input>`);
    expect(buildUserMessage({ input: "x", inputHtml: "   " })).toBe(`<user_input>\nx\n</user_input>`);
  });

  it("does not include raw instruction text from system prompt in user message output", () => {
    const result = buildUserMessage({
      input: "test input",
      customInstruction: "Do this thing",
      feedback: "Some feedback",
    });

    // The actual expected behavior:
    // - custom instructions are properly formatted inside <custom_instructions> block
    // - The system prompt's instructional text should NOT leak (e.g. 'Preserve the original meaning')
    expect(result).toContain("<custom_instructions>\nDo this thing\n</custom_instructions>");
    expect(result).toContain("Apply the feedback below to guide this rewrite");

    // But the actual instruction text that is being passed in IS legitimately present inside its block
    expect(result).toContain("Do this thing");
    expect(result).toContain("Some feedback");

    // The important part: the base prompt instructions like "Preserve the original meaning" do NOT leak
    expect(result).not.toContain("Preserve the original meaning");
  });
});
