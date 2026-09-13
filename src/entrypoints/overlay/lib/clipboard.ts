/** Clipboard write with execCommand fallback (iframe contexts vary). */

export interface ClipboardLike {
  writeText: (text: string) => Promise<void>;
  /** Multi-flavor write; absent on older contexts and in most fakes. */
  write?: (items: ClipboardItem[]) => Promise<void>;
}

/** Buildable in fakes and feature-detected live (older contexts lack it). */
function flavoredWriter(
  clipboard: ClipboardLike | null | undefined,
): ((items: ClipboardItem[]) => Promise<void>) | null {
  const write = clipboard?.write;
  if (typeof write !== "function" || typeof ClipboardItem === "undefined") return null;
  return (items) => write.call(clipboard, items);
}

export async function copyText(
  text: string,
  clipboard?: ClipboardLike | null,
  doc?: Document | null,
  execCopy?: (() => boolean) | null,
): Promise<boolean> {
  if (clipboard) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand below.
    }
  }
  if (doc && execCopy) {
    try {
      const area = doc.createElement("textarea");
      area.value = text;
      doc.body.appendChild(area);
      area.select();
      const ok = execCopy();
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Copy rich output with a plain fallback: `text/html` + `text/plain`
 * flavors so pasting into a rich editor keeps lists and inline formatting
 * while plain fields still receive text. Falls back to plain-only copy
 * when HTML flavors are unavailable or no HTML is provided.
 */
export async function copyHtml(
  html: string | null,
  plain: string,
  clipboard?: ClipboardLike | null,
  doc?: Document | null,
  execCopy?: (() => boolean) | null,
): Promise<boolean> {
  const writer = flavoredWriter(clipboard);
  if (html?.trim() && writer) {
    try {
      await writer([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]);
      return true;
    } catch {
      // Fall through to plain-only copy below.
    }
  }
  return copyText(
    plain,
    clipboard,
    doc,
    execCopy,
  );
}

/** Minimal structural surface of a readable content node (DOM + fakes). */
export interface ContentNodeLike {
  readonly tagName: string;
  readonly innerHTML: string;
  readonly innerText: string;
  readonly value?: string;
}

/**
 * Copy the live `#jot-content` preview DOM verbatim: the preview div's
 * inner HTML plus its rendered text, with no sanitize or rebuild pass.
 * (Render already sanitizes on the way in, so the DOM holds nothing
 * unsanitized.) Textareas copy their value as plain text. Returns which
 * path succeeded, or false when no usable node exists (caller falls back
 * to its state-derived copy; never throws for missing DOM).
 */
export async function copyDomHtml(
  getEl: () => ContentNodeLike | null,
  clipboard?: ClipboardLike | null,
  doc?: Document | null,
  execCopy?: (() => boolean) | null,
): Promise<"html" | "plain" | false> {
  let el: ContentNodeLike | null;
  try {
    el = getEl();
  } catch {
    return false;
  }
  if (!el) return false;
  if (el.tagName.toUpperCase() === "TEXTAREA") {
    const ok = await copyText(el.value ?? "", clipboard, doc, execCopy);
    return ok ? "plain" : false;
  }
  if (!el.innerHTML.trim()) return false;
  const writer = flavoredWriter(clipboard);
  if (writer) {
    try {
      await writer([
        new ClipboardItem({
          "text/html": new Blob([el.innerHTML], { type: "text/html" }),
          "text/plain": new Blob([el.innerText], { type: "text/plain" }),
        }),
      ]);
      return "html";
    } catch {
      // Fall through to plain-only copy below.
    }
  }
  const ok = await copyText(el.innerText, clipboard, doc, execCopy);
  return ok ? "plain" : false;
}
