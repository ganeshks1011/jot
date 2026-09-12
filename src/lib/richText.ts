/**
 * Preserve-only rich-text helpers (pure string functions, no DOM).
 *
 * Contract: Jot never invents formatting. It only preserves paragraphs,
 * lists, and inline tags the user already used. The allowlist is shared by
 * capture sanitizing, model-output checks, preview rendering, and insert:
 * `p, br, ul, ol, li, b, strong, i, em, u, a (href only)`.
 *
 * All functions are safe to run per streamed delta (single UTF-16 code
 * units only) and in Node tests (no DOMParser).
 */

const ALLOWED_BARE = new Set(["p", "br", "ul", "ol", "li", "b", "strong", "i", "em", "u"]);

const DANGEROUS_WITH_CONTENT = /<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const DANGEROUS_OPEN = /<(script|style|iframe|object|embed|link|meta)\b[^>]*\/?>/gi;
const HTML_COMMENTS = /<!--[\s\S]*?-->/g;
const EVENT_ATTRS = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const TAG_TOKEN = /<\/?([a-zA-Z0-9]+)(\s[^<>]*)?\/?>/g;
const HREF_ATTR = /\shref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i;

/** True when the text contains a line break. */
export function isMultilineText(text: string): boolean {
  return text.includes("\n");
}

/** True when sanitized HTML carries user-visible formatting to preserve. */
export function hasRichFormatting(html: string): boolean {
  return /<(b|strong|i|em|u|a|ul|ol|li)\b/i.test(html);
}

/** Strip unsafe content and non-allowlist tags (unwrapped, text kept). */
export function sanitizeRichHtml(html: string): string {
  if (!html) return "";
  let out = html
    .replace(HTML_COMMENTS, "")
    .replace(DANGEROUS_WITH_CONTENT, "")
    .replace(DANGEROUS_OPEN, "")
    .replace(EVENT_ATTRS, "");
  out = out.replace(TAG_TOKEN, (full, rawTag: string, attrs: string | undefined) => {
    const tag = String(rawTag).toLowerCase();
    const closing = full.startsWith("</");
    if (ALLOWED_BARE.has(tag)) {
      if (tag === "br") return "<br>";
      return closing ? `</${tag}>` : `<${tag}>`;
    }
    if (tag === "a") {
      if (closing) return "</a>";
      const href = extractSafeHref(attrs ?? "");
      // Unsafe hrefs lose the attribute but keep the (harmless) tag so
      // open/close stays balanced; text is never dropped.
      return href ? `<a href="${href}">` : "<a>";
    }
    // Unwrap everything else (div, span, headings, etc.). Keep inner text.
    return "";
  });
  return out;
}

function extractSafeHref(attrs: string): string | null {
  const m = HREF_ATTR.exec(attrs);
  if (!m) return null;
  let href = (m[1] ?? "").trim();
  if ((href.startsWith('"') && href.endsWith('"')) || (href.startsWith("'") && href.endsWith("'"))) {
    href = href.slice(1, -1);
  }
  href = href.trim();
  if (!href) return null;
  const lower = href.toLowerCase();
  if (lower.startsWith("javascript:") || lower.startsWith("data:") || lower.startsWith("vbscript:")) {
    return null;
  }
  // Escape double quotes so the rebuilt attribute stays well-formed.
  return href.replace(/"/g, "%22");
}

/**
 * Convert HTML to plain text with paragraph breaks and list markers:
 * `P/DIV → blank line`, `BR → newline`, `LI → "- " prefix`.
 */
export function htmlToPlainText(html: string): string {
  if (!html) return "";
  let out = html
    .replace(HTML_COMMENTS, "")
    .replace(DANGEROUS_WITH_CONTENT, " ")
    .replace(/<(br)\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|h[1-6]|blockquote|section|article)\b[^>]*>/gi, "\n\n")
    .replace(/<\/?(ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/li\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  out = decodeEntities(out);
  const lines = out.split("\n").map((line) => line.replace(/[ \t\f\v\u00A0\u202F]+/g, " ").replace(/ +$/g, ""));
  // Drop leading blank lines but keep structural breaks inside.
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}
