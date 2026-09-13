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
