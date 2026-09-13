import { Skeleton } from "@heroui/react/skeleton";
import { TextArea } from "@heroui/react/textarea";

export type ContentStatus = "idle" | "generating" | "output";

interface ContentBoxProps {
  output: string;
  status: ContentStatus;
  /** Prebuilt sanitized HTML (keyed flow); overrides output-derived preview. */
  htmlPreview?: string | null;
  /**
   * HTML sanitizer (allowlist). The extension passes sanitizeRichHtml;
   * hosts without HTML rewrites omit it and always render plain text.
   */
  sanitize?: (html: string) => string;
}

/**
 * Shared rewrite result box: skeletons while streaming starts, idle hint,
 * sanitized HTML preview when the host provides one, read-only text
 * otherwise. Keeps the jot-content identity everywhere.
 */
export function ContentBox({ output, status, htmlPreview, sanitize }: ContentBoxProps) {
  if (status === "generating" && !output) {
    return (
      <div className="flex flex-col gap-2 px-1 py-1" role="status" aria-live="polite" aria-busy="true">
        <Skeleton className="h-3 w-11/12 rounded" />
        <Skeleton className="h-3 w-4/5 rounded" />
        <Skeleton className="h-3 w-3/5 rounded" />
      </div>
    );
  }

  if (status === "idle") {
    return (
      <p className="jot-secondary px-1 py-3 text-center text-xs text-muted">
        Select some text or focus a field to get started
      </p>
    );
  }

  const raw = htmlPreview?.trim() || (/<[a-zA-Z]/.test(output) ? output : "");
  const preview = raw && sanitize ? sanitize(raw) : null;
  if (preview) {
    return (
      <div
        id="jot-content"
        tabIndex={0}
        role="textbox"
        aria-label="Rewritten text"
        aria-readonly="true"
        className="w-full px-1"
        dangerouslySetInnerHTML={{ __html: preview }}
      />
    );
  }

  return (
    <TextArea
      id="jot-content"
      readOnly
      aria-label="Rewritten text"
      value={output}
      placeholder="Rewritten text appears here. Press Enter to insert it."
      variant="secondary"
      className="min-h-16 w-full resize-none border-0 bg-transparent px-1 shadow-none scrollbar-thin"
    />
  );
}
