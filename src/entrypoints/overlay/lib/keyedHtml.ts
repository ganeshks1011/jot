/**
 * Rebuild sanitized HTML from keyed Lexical nodes plus a rewrite map.
 * One HTML source for the keyed flow's preview, clipboard flavors, and
 * insert payload: whatever the overlay shows is exactly what copy/insert
 * carry. Paragraphs become `<p>`; consecutive `listitem` runs group into
 * a single `<ul>`; everything else falls back to `<p>`. Values are escaped
 * before wrapping and the result passes `sanitizeRichHtml` (defense in
 * depth — all overlay HTML goes through the sanitizer).
 */

import type { LexicalTextNode } from "@wurkflo/shared";
import { sanitizeRichHtml } from "../../../lib/richText";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Build the preview/insert/copy HTML for rewritten nodes. Falls back to
 * each node's original text for ids missing from the map; returns null
 * when there is nothing to render.
 */
export function buildKeyedHtml(nodes: LexicalTextNode[], map: Record<string, string>): string | null {
  if (nodes.length === 0) return null;
  const parts: string[] = [];
  let openList = false;
  const closeList = (): void => {
    if (openList) {
      parts.push("</ul>");
      openList = false;
    }
  };
  for (const node of nodes) {
    const text = map[node.id] ?? node.text;
    if (!text) continue;
    if (node.block === "listitem") {
      if (!openList) {
        parts.push("<ul>");
        openList = true;
      }
      parts.push(`<li>${escapeHtml(text)}</li>`);
    } else {
      closeList();
      parts.push(`<p>${escapeHtml(text)}</p>`);
    }
  }
  closeList();
  const html = parts.join("");
  return html ? sanitizeRichHtml(html) : null;
}
