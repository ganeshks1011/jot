import { Skeleton } from "@heroui/react/skeleton";
import { TextArea } from "@heroui/react/textarea";
import { sanitizeRichHtml } from "@/lib/richText";

export type ContentStatus = "idle" | "generating" | "output";

interface ContentBoxProps {
  output: string;
  status: ContentStatus;
  /** True when the capture carried formatting worth previewing as HTML. */
  hasFormatting?: boolean;
}

export function ContentBox({ output, status, hasFormatting }: ContentBoxProps) {
  // Skeletons only until the first streamed tokens land; after that the
  // partial text renders live in the read-only box below.
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

  // Preserve-only HTML preview: sanitized allowlist fragment, read-only.
  // Keeps the jot-content identity so focus, Enter-to-insert, and the
  // result cap all behave exactly like the plain-text box.
  if (hasFormatting && /<[a-zA-Z]/.test(output)) {
    const clean = sanitizeRichHtml(output);
    return (
      <div
        id="jot-content"
        tabIndex={0}
        role="textbox"
        aria-label="Rewritten text"
        aria-readonly="true"
        className="w-full px-1"
        dangerouslySetInnerHTML={{ __html: clean }}
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
