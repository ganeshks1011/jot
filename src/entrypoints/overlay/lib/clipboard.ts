/** Clipboard write with execCommand fallback (iframe contexts vary). */

export interface ClipboardLike {
  writeText: (text: string) => Promise<void>;
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
