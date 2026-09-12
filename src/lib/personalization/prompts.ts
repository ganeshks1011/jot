/**
 * Client-side prompt construction. Mirrors the server module in the Wurkflo
 * backend (app/core/utils/rewritePrompts.ts) - keep the two in sync.
 *
 * The user's input and feedback are DATA. They are only ever placed in the
 * user message inside explicit delimiters, never interpolated into the
 * instructional text.
 */

/**
 * Common prompt with {mode_instruction} placeholder.
 * Keep in sync with Wurkflo backend rewritePrompts.
 */
export const COMMON_PROMPT = [
  "You rewrite text according to the active mode.",
  "",
  "ACTIVE MODE:",
  "{mode_instruction}",
  "",
  "Preserve the user's meaning, intent, facts, viewpoint, and important details. Keep roughly the same length unless the active mode requires otherwise.",
  "",
  "Preserve the user's structure: keep paragraph breaks, blank lines between paragraphs, and list structure (bullets, numbering, list markers) exactly as arranged. Never collapse multiline text into a single paragraph.",
  "",
  "Preserve existing formatting and do not invent new formatting: keep bold, italics, underline, and links exactly where the user already used them (HTML subset: p, br, ul, ol, li, b, strong, i, em, u, a). Do not add bold, italics, headings, or links that were not already present.",
  "",
  "Make it natural, clear, direct, and human. Improve expression, not substance.",
  "",
  "Do not invent facts or context, change the author's position, or add hype, CTAs, hashtags, headings, or explanations unless required by the active mode or already present. Do not add new structure beyond what the input already contains.",
  "",
  'Use standard keyboard characters only. Preserve meaningful characters such as URLs, @mentions, hashtags, code, product names, and technical syntax. Use "-" instead of em/en dashes, "..." instead of "…", straight quotes and apostrophes, and normal spaces. Do not introduce decorative or non-standard Unicode characters.',
  "",
  "When the input contains HTML formatting, return only the rewritten HTML fragment using the same allowed tags. Otherwise return only the rewritten plain text with its line breaks intact. Never wrap the output in explanations or code fences.",
].join("\n");

// Legacy alias for tests that still reference BASE_PROMPT
export const BASE_PROMPT = COMMON_PROMPT;

/** Static framing shown once before the feedback block (byte-stable). */
const FEEDBACK_FRAMING =
  "Apply the feedback below to guide this rewrite. Feedback refines the " +
  "output within the selected mode; never include the feedback text itself " +
  "in the rewritten text.";

/**
 * Feedback block shared by both transports. The direct-provider path embeds
 * it in the user message; the Jot rewrite API path (systemPrompt + raw input
 * only) appends it to the system prompt. Returns "" when blank.
 */
export function buildFeedbackBlock(feedback?: string): string {
  if (!feedback?.trim()) return "";
  return `${FEEDBACK_FRAMING}\n\n<feedback>\n${feedback.trim()}\n</feedback>`;
}

/**
 * Guard appended when sensitive values were redacted locally. Placeholders
 * must survive the rewrite verbatim so the originals can be restored.
 */
export const PLACEHOLDER_GUARD = [
  "Sensitive information has been replaced with placeholders such as [EMAIL_1] and [PHONE_1].",
  "Preserve every placeholder exactly as written.",
  "Do not rename, remove, translate, modify, or invent placeholders.",
  "Never split, recase, or escape a placeholder with formatting tags.",
].join("\n");

/** system message: common prompt with active mode instruction. */
export function buildSystemPrompt(modePrompt: string, opts?: { preservePlaceholders?: boolean }): string {
  const base = COMMON_PROMPT.replace("{mode_instruction}", modePrompt.trim());
  if (opts?.preservePlaceholders) return `${base}\n\n${PLACEHOLDER_GUARD}`;
  return base;
}

/**
 * user message: delimited blocks for custom instructions / feedback / input,
 * always in that fixed order. User content never reaches the system prompt.
 * When the capture carried formatting, the sanitized HTML fragment travels
 * in <user_input_html> ahead of the plain <user_input> so the model can
 * preserve tags it otherwise could not see.
 */
export function buildUserMessage(opts: {
  input: string;
  feedback?: string;
  customInstruction?: string;
  inputHtml?: string | null;
}): string {
  const blocks: string[] = [];
  if (opts.customInstruction?.trim()) {
    blocks.push(`<custom_instructions>\n${opts.customInstruction.trim()}\n</custom_instructions>`);
  }
  const feedbackBlock = buildFeedbackBlock(opts.feedback);
  if (feedbackBlock) blocks.push(feedbackBlock);
  if (opts.inputHtml?.trim()) {
    blocks.push(`<user_input_html>\n${opts.inputHtml.trim()}\n</user_input_html>`);
  }
  blocks.push(`<user_input>\n${opts.input}\n</user_input>`);
  return blocks.join("\n\n");
}
