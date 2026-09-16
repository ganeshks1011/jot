import { Skeleton } from "@heroui/react/skeleton";
import { TextArea } from "@heroui/react/textarea";
import { useEffect, useLayoutEffect } from "react";

export type ContentStatus = "idle" | "loading" | "generating" | "output";

// Layout effect on the client (no SSR warning), passive on the server.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

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
  /**
   * The host opened with empty input (nothing captured). The idle box then
   * invites the user to write instead of showing the selection hint.
   */
  emptyPrompt?: boolean;
}

/**
 * Shared rewrite result box: skeletons while the host handshake (loading)
 * or the stream (generating) is still starting, idle hint or write prompt,
 * sanitized HTML preview when the host provides one, read-only text
 * otherwise. Keeps the jot-content identity everywhere.
 */
export function ContentBox({ output, status, htmlPreview, sanitize, emptyPrompt }: ContentBoxProps) {
  // Grow the plain-text box with its content (textareas never self-size).
  // The CSS max-height cap still applies; the HTML preview div grows
  // naturally and needs no measuring. Same lines the extension reporter
  // uses, now local so every host benefits.
  useIsomorphicLayoutEffect(() => {
    const el = document.getElementById("jot-content");
    if (el instanceof HTMLTextAreaElement) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [output, status]);

  if (status === "loading" || (status === "generating" && !output)) {
    return (
      <div className="jot-loading flex flex-col gap-2 px-1 py-1" role="status" aria-live="polite" aria-busy="true">
        <Skeleton className="h-3 w-11/12 rounded" />
        <Skeleton className="h-3 w-4/5 rounded" />
        <Skeleton className="h-3 w-3/5 rounded" />
      </div>
    );
  }

  if (status === "idle") {
    return (
      <p className="jot-secondary px-1 py-3 text-center text-xs text-muted">
        {emptyPrompt ? "What do you want me to write?" : "Select some text or focus a field to get started"}
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
      className="w-full resize-none scrollbar-thin"
    />
  );
}
