import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Chip } from "@heroui/react/chip";
import { Kbd } from "@heroui/react/kbd";
import { Tooltip } from "@heroui/react/tooltip";
import { Check, Settings as SettingsIcon, X } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { type EditorType, editorTypeFor, siteLabelFor, track } from "@/lib/analytics";
import type { ProviderError } from "@/lib/api";
import { WURKFLO_ORIGIN } from "@/lib/config";
import { isSlackComposer } from "@/lib/editors/slack";
import { MIN_CONTENT_HEIGHT } from "@/lib/overlayGeometry";
import { htmlToPlainText, sanitizeRichHtml } from "@/lib/richText";
import { ContentBox, type ContentStatus } from "./components/ContentBox";
import { FeedbackInput } from "./components/FeedbackInput";
import {
  isEmbedded,
  type OverlayPlacement,
  onInit,
  onInsertFailed,
  onInsertResult,
  onMetrics,
  postReady,
  postResize,
  postToParent,
} from "./lib/bridge";
import { copyText } from "./lib/clipboard";
import { type FocusZone, selectHelperText, zoneForTarget } from "./lib/helperText";
import { startReadyRetry } from "./lib/readyRetry";
import { useGeneration } from "./lib/useGeneration";

const SAMPLE_TEXT = "This is the sample selection used to preview the overlay outside of an extension host.";

function errorMessage(err: ProviderError): string {
  switch (err.kind) {
    case "no-key":
      return "Add your API key in Jot's extension settings to start rewriting.";
    case "auth":
      return err.message || "The provider rejected the request - check your settings.";
    case "rate-limit":
      return "Rate limited - try again in a moment.";
    case "network":
      return "Could not reach the model server.";
    case "empty":
      return "The model returned an empty response.";
    case "quota":
      return err.message || "You've used all Jot completions this month.";
  }
}

const openOptionsPage = () => {
  void browser.runtime.openOptionsPage();
};

const openUpgradePage = (upgrade: ProviderError["upgrade"]) => {
  const uri = upgrade?.redirectUri?.trim();
  // Validate relative redirectUri per api.md. Never trust arbitrary URLs.
  const safeUri = uri && uri.startsWith("/") ? uri : "/jot/upgrade";
  const url = `${WURKFLO_ORIGIN.replace(/\/+$/, "")}${safeUri}`;
  void browser.tabs.create({ url });
};

export default function App() {
  const [source, setSource] = useState("");
  const [sourceHtml, setSourceHtml] = useState<string | null>(null);
  const [hasFormatting, setHasFormatting] = useState(false);
  const [inputText, setInputText] = useState("");
  const [inserted, setInserted] = useState(false);
  // Rewrite the host rejected (e.g. Slack composer). Panel stays open so the
  // user can copy it instead of losing the result.
  const [failedText, setFailedText] = useState<string | null>(null);
  const [failedMetrics, setFailedMetrics] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Composer mirroring from the host: placement drives the connector edge,
  // sampled colors theme the content areas (null = theme fallback).
  const [placement, setPlacement] = useState<OverlayPlacement>("float");
  const [composerBg, setComposerBg] = useState<string | null>(null);
  const [composerFg, setComposerFg] = useState<string | null>(null);
  const [pageDark, setPageDark] = useState<boolean | null>(null);
  const [connectorX, setConnectorX] = useState<number | null>(null);
  const [maxPanelHeight, setMaxPanelHeight] = useState<number | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const siteRef = useRef<string | undefined>(undefined);
  const editorRef = useRef<EditorType>("unknown");
  const insertedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const {
    output,
    setOutput,
    status,
    setStatus,
    error,
    setError,
    busyRef,
    pendingRef,
    abortRef,
    runGenerate,
    clearCache,
  } = useGeneration(siteRef, editorRef);

  // Rewrite the captured source, applying the input box text as a tweak
  // instruction on top. Formatting HTML travels alongside the plain source
  // so the model can preserve tags it otherwise could not see.
  const generate = useCallback(
    (followUp?: string) => {
      if (!source.trim()) return;
      if (busyRef.current) {
        pendingRef.current = { text: source, followUp, html: sourceHtml };
        return;
      }
      void runGenerate(source, followUp, sourceHtml);
    },
    [source, sourceHtml, runGenerate],
  );

  const copyFailedText = useCallback(async () => {
    if (!failedText) return;
    const ok = await copyText(
      failedText,
      typeof navigator !== "undefined" ? (navigator.clipboard ?? undefined) : undefined,
      document,
      () => document.execCommand("copy"),
    );
    setCopied(ok);
    if (ok) {
      void track("rewrite_copied", {
        site: siteLabelFor(siteRef.current),
        editor_type: editorRef.current,
      });
    }
  }, [failedText]);

  const retryFailed = useCallback(() => {
    setFailedText(null);
    setCopied(false);
    generate(inputText);
  }, [generate, inputText]);

  // Helper text follows focus: result → replace/copy, tweak with input →
  // tweak, empty tweak box → invite.
  const [focusZone, setFocusZone] = useState<FocusZone>(null);
  const [copiedHint, setCopiedHint] = useState<"copied" | "unavailable" | null>(null);
  const copiedHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      setFocusZone(zoneForTarget(event.target));
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  useEffect(
    () => () => {
      if (copiedHintTimer.current) clearTimeout(copiedHintTimer.current);
    },
    [],
  );

  const copyOutput = useCallback(async () => {
    if (!output) return;
    // Clipboard takes plain text; formatted output converts via block-aware
    // plain conversion (paragraphs/lists intact, tags dropped).
    const plain = hasFormatting && /<[a-zA-Z]/.test(output) ? htmlToPlainText(output) : output;
    // Clipboard may be denied by the page's permissions policy (e.g. Google
    // Chat). Degrade to a notice, never block the insert path.
    const ok = await copyText(
      plain,
      typeof navigator !== "undefined" ? (navigator.clipboard ?? undefined) : undefined,
      document,
      () => document.execCommand("copy"),
    );
    setCopiedHint(ok ? "copied" : "unavailable");
    if (ok) {
      void track("rewrite_copied", {
        site: siteLabelFor(siteRef.current),
        editor_type: editorRef.current,
      });
    }
    if (copiedHintTimer.current) clearTimeout(copiedHintTimer.current);
    copiedHintTimer.current = setTimeout(() => setCopiedHint(null), 2000);
  }, [output, hasFormatting]);

  // Move keyboard focus into the overlay on open so arrows/Enter work
  // immediately (the host focuses the frame; cross-origin-safe). Focus lands
  // on the result so Enter inserts it right away. Or on the feedback input
  // when there is no result yet (idle/empty state has no focusable content).
  const focusInitial = useCallback(() => {
    const content = document.getElementById("jot-content");
    (content ?? document.getElementById("jot-feedback"))?.focus();
  }, []);

  useEffect(() => {
    const t = setTimeout(focusInitial, 150);
    return () => clearTimeout(t);
  }, [focusInitial]);

  // When a rewrite lands, move focus to the result so Enter inserts it with
  // no navigation, unless a tweak is being composed (inputText non-empty),
  // in which case stealing focus would interrupt typing. The ref keeps the
  // effect scoped to resolve transitions instead of refiring per keystroke.
  const inputTextRef = useRef(inputText);
  useEffect(() => {
    inputTextRef.current = inputText;
  }, [inputText]);

  useEffect(() => {
    if (status !== "output" || !output) return;
    if (inputTextRef.current.trim()) return;
    document.getElementById("jot-content")?.focus();
  }, [status, output]);

  // Host could not apply the rewrite (panel stays open by design).
  // Metrics are lengths/tags only. Never message content.
  const describeMetrics = useCallback(
    (m: {
      strategy?: "exec" | "beforeinput" | "entity" | null;
      tag?: string | null;
      preLen?: number;
      postLen?: number;
      expectedLen?: number;
      attempts?: number;
    }) =>
      `via ${m.strategy ?? "?"} · composer ${m.tag ?? "?"} · ` +
      `before ${m.preLen ?? "?"} → after ${m.postLen ?? "?"} chars ` +
      `(expected ${m.expectedLen ?? "?"}) · ${m.attempts ?? "?"} attempts`,
    [],
  );

  // Host-pushed metrics (placement + panel budget) after viewport resize.
  useEffect(() => {
    return onMetrics((msg) => {
      setPlacement(msg.placement);
      setMaxPanelHeight(msg.maxPanelHeight);
      setConnectorX(msg.connectorX ?? null);
    });
  }, []);

  // Grow the result box with its content, capped by the host-provided panel
  // budget minus measured chrome (header/footer/hints/gaps). scrollHeight is
  // cap-independent, so the chrome measurement stays stable. The HTML preview
  // div auto-sizes (no inline height) but shares the same content cap.
  useEffect(() => {
    const card = rootRef.current;
    const content = document.getElementById("jot-content");
    if (!card || !(content instanceof HTMLElement)) return;
    if (content instanceof HTMLTextAreaElement) {
      content.style.height = "auto";
      content.style.height = `${content.scrollHeight}px`;
    }
    if (maxPanelHeight == null) {
      card.style.removeProperty("--jot-content-max");
      return;
    }
    const chrome = card.scrollHeight - content.scrollHeight;
    const cap = Math.max(MIN_CONTENT_HEIGHT, maxPanelHeight - chrome);
    card.style.setProperty("--jot-content-max", `${Math.round(cap)}px`);
  }, [maxPanelHeight, output, status, hasFormatting]);

  // Paint audit: computed backgrounds after first paint, to diagnose
  // background pairing issues. Theme values only, never content.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const card = rootRef.current;
        const diamond = card?.querySelector(".jot-connector") ?? document.querySelector(".jot-connector");
        const cs = (el: Element | null) => (el ? getComputedStyle(el).backgroundColor : null);
        console.debug("[jot] paint audit", {
          card: cs(card),
          diamond: cs(diamond),
          document: getComputedStyle(document.documentElement).backgroundColor,
          paired: card?.classList.contains("jot-paired") ?? null,
        });
      } catch {
        // Logging must never break the panel.
      }
    }, 500);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const unsubs = [
      onInsertFailed((msg) => {
        setFailedText(msg.text);
        setFailedMetrics(describeMetrics(msg));
        setCopied(false);
        setInserted(false);
      }),
      onInsertResult((msg) => {
        // Success closes from the host side; keep a console trail anyway.
        try {
          console.debug("[jot] insert-result", {
            ok: msg.ok,
            strategy: msg.strategy,
            tag: msg.tag,
            preLen: msg.preLen,
            postLen: msg.postLen,
            expectedLen: msg.expectedLen,
            attempts: msg.attempts,
          });
        } catch {
          // Logging must never break the panel.
        }
      }),
    ];
    return () => unsubs.forEach((unsub) => unsub());
  }, [describeMetrics]);

  const lastInitKeyRef = useRef<string>("");
  const lastInitAtRef = useRef<number>(0);

  // Initialize from the content script's captured selection. When text is
  // present, automatically rewrite it (default mode per hierarchy) and show the result.
  useEffect(() => {
    let initReceived = false;
    const unsub = onInit((msg) => {
      initReceived = true;
      const text = msg.text ?? "";
      const site = msg.site ?? undefined;
      const html = msg.html ?? null;
      const formatted = msg.hasFormatting === true && !!html;
      const initKey = `${text}||${site ?? ""}||${formatted ? "html" : "plain"}`;
      // Track last init for debugging; host already dedupes rapid double sends.
      // We intentionally do NOT early-return here. Per-site > global > casual
      // requires re-evaluating mode even for same text+site if hierarchy changes.
      lastInitKeyRef.current = initKey;
      lastInitAtRef.current = Date.now();

      siteRef.current = site;
      editorRef.current = editorTypeFor(msg.fieldType);
      setSource(text);
      setSourceHtml(formatted ? html : null);
      setHasFormatting(formatted);
      setPlacement(msg.placement ?? "float");
      setMaxPanelHeight(msg.maxPanelHeight ?? null);
      setComposerBg(msg.composerBg ?? null);
      setComposerFg(msg.composerFg ?? null);
      setPageDark(msg.pageDark ?? null);
      setConnectorX(msg.connectorX ?? null);
      try {
        // Theme colors only. Diagnostic trail for background pairing issues.
        console.debug("[jot] composer colors", {
          bg: msg.composerBg ?? null,
          fg: msg.composerFg ?? null,
        });
      } catch {
        // Logging must never break the panel.
      }
      clearCache();
      if (!text) {
        setStatus("idle");
        setTimeout(focusInitial, 60);
        return;
      }
      // If a generation is already in flight (e.g., duplicate init), queue rather than dropping.
      if (busyRef.current) {
        pendingRef.current = { text, html: formatted ? html : null };
        // Abort current to let the correct text run next; runGenerate's finally will pick up pending.
        abortRef.current?.abort();
        return;
      }
      void runGenerate(text, undefined, formatted ? html : null);
      // Focus the selected tab once the DOM settles.
      setTimeout(focusInitial, 60);
    });

    if (!isEmbedded()) {
      setSource(SAMPLE_TEXT);
      setOutput(SAMPLE_TEXT);
      setStatus("output");
    }

    postReady();
    // Cold first-invoke: the host may have posted `init` before this
    // listener attached. Re-post `ready` until the first `init` lands so
    // the host's forced resend reaches us; stops on init or unmount.
    const stopRetry = startReadyRetry(postReady, () => initReceived);
    return () => {
      stopRetry();
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const insertText = useCallback(
    (text: string) => {
      if (!text) return;
      // Formatted output travels as both: plain text for textarea/Slack and
      // the sanitized HTML fragment for rich contenteditables. The host picks
      // per target; text-only hosts ignore `html` entirely.
      const outputHtml = hasFormatting && /<[a-zA-Z]/.test(text) ? sanitizeRichHtml(text) : null;
      const plain = outputHtml ? htmlToPlainText(text) : text;
      postToParent({ type: "insert", text: plain, html: outputHtml });
      setInserted(true);
      // Host-confirmed only on the verified Slack path; elsewhere the host
      // insert is effectively infallible, so record it as confirmed.
      const confirmed = !isSlackComposer(siteRef.current ?? "");
      void track("rewrite_applied", {
        site: siteLabelFor(siteRef.current),
        editor_type: editorRef.current,
        confirmed,
      });
      if (insertedTimer.current) clearTimeout(insertedTimer.current);
      // Slack write-back is verified by the host: success closes the panel
      // from the host side, failure reports insert-failed. Auto-closing here
      // would destroy the panel (and its copy/retry UI) before the verdict.
      if (isSlackComposer(siteRef.current ?? "")) return;
      insertedTimer.current = setTimeout(() => {
        postToParent({ type: "close" });
      }, 700);
    },
    [hasFormatting],
  );

  const close = useCallback(() => {
    // Stop an in-flight stream so it can't write state after dismissal.
    abortRef.current?.abort();
    postToParent({ type: "close" });
  }, []);

  // Abort any in-flight stream when the overlay unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  // The global browser shortcut (chrome.commands) closes the overlay through
  // the background worker, which toggles the injected host controller - even
  // while the iframe has keyboard focus. Escape below handles in-panel close.

  // Global keyboard contract - see docs/PLAN.md §5. Capture phase so Enter
  // inside inputs is always observed. Enforces a focus trap (Tab never
  // leaves the overlay: settings → close → content → feedback) and Up/Down
  // switches between the two sections (content → feedback). While a provider
  // error is shown, the error's action buttons take the content slot so they
  // stay reachable by keyboard.
  useEffect(() => {
    const getErrorActions = (): HTMLElement[] => [
      ...document.querySelectorAll<HTMLElement>("[data-jot-error-actions] button"),
    ];

    const getSections = (): HTMLElement[] => {
      const out: HTMLElement[] = [];
      const errorActions = getErrorActions();
      const content = errorActions[0] ?? document.getElementById("jot-content");
      const input = document.getElementById("jot-feedback");
      if (content) out.push(content);
      if (input) out.push(input);
      return out;
    };

    const getFocusables = (): HTMLElement[] => {
      const out: HTMLElement[] = [];
      const settings = document.querySelector<HTMLElement>('[aria-label="Open settings"]');
      const closeBtn = document.querySelector<HTMLElement>('[aria-label="Close Jot"]');
      if (settings) out.push(settings);
      if (closeBtn) out.push(closeBtn);
      const errorActions = getErrorActions();
      if (errorActions.length > 0) {
        // Error state: the error's action buttons, then feedback.
        out.push(...errorActions);
        const input = document.getElementById("jot-feedback");
        if (input) out.push(input);
        return out;
      }
      return [...out, ...getSections()];
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;

      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }

      if (event.key === "Tab") {
        const focusables = getFocusables();
        if (focusables.length === 0) return;
        const idx = el ? focusables.indexOf(el) : -1;
        const next = event.shiftKey
          ? focusables[(idx - 1 + focusables.length) % focusables.length]
          : focusables[(idx + 1) % focusables.length];
        event.preventDefault();
        next?.focus();
        return;
      }

      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const sections = getSections();
        if (sections.length === 0) return;
        const idx = el ? sections.indexOf(el) : -1;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next = sections[(idx + delta + sections.length) % sections.length];
        next?.focus();
        return;
      }

      if (event.key === "Enter" && event.shiftKey) {
        // Copy the rewrite without inserting (content focused only; the
        // tweak box keeps Shift+Enter submitting the tweak).
        const target = event.target as HTMLElement | null;
        if (target?.closest?.("#jot-content") && output) {
          event.preventDefault();
          void copyOutput();
        }
        return;
      }
      if (event.key !== "Enter" || event.shiftKey) return;
      if (!el) return;
      if (el.id === "jot-content") {
        // Apply the rewrite back into the source field.
        event.preventDefault();
        if (output) insertText(output);
      } else if (el.id === "jot-feedback") {
        // Refetch with the current tweak instruction (no apply).
        event.preventDefault();
        if (!source.trim()) return;
        void runGenerate(source, inputText);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [insertText, runGenerate, close, inputText, source, output, copyOutput]);

  // Report the panel height to the parent whenever content changes size.
  // Compact until rewritten text lands, so wide composers open small.
  useEffect(() => {
    postResize(!output);
  }, [status, output, inserted, error]);

  const compactRef = useRef(true);
  compactRef.current = !output;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => postResize(compactRef.current));
    observer.observe(root);
    const initial = setTimeout(() => postResize(compactRef.current), 100);
    const late = setTimeout(() => postResize(compactRef.current), 450);
    return () => {
      observer.disconnect();
      clearTimeout(initial);
      clearTimeout(late);
    };
  }, []);

  useEffect(
    () => () => {
      if (insertedTimer.current) clearTimeout(insertedTimer.current);
    },
    [],
  );

  // Sampled composer colors as CSS vars, applied only as a pair: a lone
  // bg or fg would pair a sampled color against a mismatched theme color.
  // Unset = theme styling untouched. Paired cards take the composer
  // background as their face so overlay and composer read as one.
  // Detached center modals always use the theme surface (no composer tint).
  // The shadow is neutral and page-aware: white on dark pages, black on
  // light pages, falling back to the overlay's own theme.
  const isCenter = placement === "center";
  const paired = composerBg !== null && composerFg !== null && !isCenter;
  const overlayDark = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
  const pageIsDark = pageDark ?? overlayDark;
  const cardVars = {
    "--jot-shadow": pageIsDark ? "0 8px 30px rgb(255 255 255 / 0.14)" : "0 8px 30px rgb(0 0 0 / 0.18)",
    ...(paired
      ? {
          "--jot-cbg": composerBg,
          "--jot-cfg": composerFg,
          "--jot-card-face": "var(--jot-cbg)",
        }
      : {}),
  } as CSSProperties;

  const card = (
    <Card
      ref={rootRef}
      style={cardVars}
      className={`jot-card-glow relative w-full gap-2 overflow-visible rounded-[8px] px-3 pb-3 pt-1 backdrop-blur-xl${paired ? " jot-paired" : ""}${isCenter ? " jot-modal-card" : ""}`}
    >
      {placement === "below" && (
        <span
          aria-hidden
          className="jot-connector jot-connector-top"
          style={connectorX != null ? { left: connectorX } : undefined}
        />
      )}
      {placement === "above" && (
        <span
          aria-hidden
          className="jot-connector jot-connector-bottom"
          style={connectorX != null ? { left: connectorX } : undefined}
        />
      )}
      <Card.Header className="flex-row items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <img src={browser.runtime.getURL("/icon/icon128.png")} alt="" className="size-5 rounded-md" />
          <span className="jot-chrome text-sm font-medium tracking-tight">Jot</span>
        </div>
        <div className="jot-chrome flex items-center gap-0.5">
          {inserted && (
            <Chip size="sm" color="success" variant="soft">
              <Check className="size-3" />
              Inserted
            </Chip>
          )}
          <Tooltip>
            <Tooltip.Trigger className="inline-flex">
              <Button isIconOnly size="sm" variant="ghost" aria-label="Open settings" onPress={openOptionsPage}>
                <SettingsIcon className="size-4" />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content>Settings</Tooltip.Content>
          </Tooltip>
          <Tooltip>
            <Tooltip.Trigger className="inline-flex">
              <Button isIconOnly size="sm" variant="ghost" aria-label="Close Jot" onPress={close}>
                <X className="size-4" />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content>Close</Tooltip.Content>
          </Tooltip>
        </div>
      </Card.Header>

      <Card.Content className="gap-1.5 pt-1">
        {error ? (
          error.kind === "quota" ? (
            <div className="rounded-lg border border-warning/30 bg-warning-soft/40 p-3 text-xs" role="alert">
              <p className="mb-1 font-medium text-foreground">{errorMessage(error)}</p>
              {error.upgrade?.message && <p className="mb-2 text-muted">{error.upgrade.message}</p>}
              {error.quota && (
                <p className="mb-2 text-[11px] text-muted">
                  {error.quota.used} / {error.quota.limit} used
                  {error.quota.period ? ` · ${error.quota.period}` : ""}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2" data-jot-error-actions>
                {error.upgrade?.available && error.upgrade.redirectUri ? (
                  <Button size="sm" variant="primary" onPress={() => openUpgradePage(error.upgrade)}>
                    {error.upgrade.name ? `Upgrade to ${error.upgrade.name}` : "Upgrade"}
                  </Button>
                ) : null}
                <Button size="sm" variant="tertiary" onPress={openOptionsPage}>
                  Open settings
                </Button>
                {/* Retry intentionally hidden for quota. It would just 402 again. */}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-danger/30 bg-danger-soft/40 p-3 text-xs text-danger" role="alert">
              <p className="mb-2 font-medium">{errorMessage(error)}</p>
              <div className="flex items-center gap-2" data-jot-error-actions>
                <Button size="sm" variant="primary" onPress={openOptionsPage}>
                  Open settings
                </Button>
                <Button size="sm" variant="tertiary" onPress={() => void generate(inputText)}>
                  Retry
                </Button>
              </div>
            </div>
          )
        ) : failedText ? (
          <div className="rounded-lg border border-warning/30 bg-warning-soft/40 p-3 text-xs" role="alert">
            <p className="mb-1 font-medium text-foreground">
              Couldn&apos;t update the editor. Copy the rewrite instead.
            </p>
            <p className="mb-2 line-clamp-3 break-words whitespace-pre-wrap text-muted">{failedText}</p>
            {failedMetrics && <p className="mb-2 text-[11px] text-muted">{failedMetrics}</p>}
            <div className="flex items-center gap-2" data-jot-error-actions>
              <Button size="sm" variant="primary" onPress={() => void copyFailedText()}>
                {copied ? "Copied" : "Copy to clipboard"}
              </Button>
              <Button size="sm" variant="tertiary" onPress={retryFailed}>
                Retry
              </Button>
            </div>
          </div>
        ) : (
          <ContentBox output={output} status={status} hasFormatting={hasFormatting} />
        )}
        {(() => {
          const kind = selectHelperText({
            hasOutput: status === "output" && !!output,
            focusZone,
            hasTweakInput: !!inputText.trim(),
          });
          if (!kind) return null;
          return (
            <p className="jot-secondary flex items-center gap-1.5 px-1 text-[11px] text-muted">
              {copiedHint === "copied" ? (
                "Copied to clipboard"
              ) : copiedHint === "unavailable" ? (
                <>
                  Copy unavailable here. Use <Kbd>⏎</Kbd> to replace
                </>
              ) : kind === "replace" ? (
                <>
                  Hit <Kbd>⏎</Kbd> to use. Hit <Kbd>⇧</Kbd> + <Kbd>⏎</Kbd> to copy to clipboard.
                </>
              ) : kind === "tweak" ? (
                <>
                  <Kbd>⏎</Kbd> to tweak the output
                </>
              ) : (
                "Tell Jot what to change…"
              )}
            </p>
          );
        })()}
      </Card.Content>

      <Card.Footer className="gap-2 pt-1">
        <FeedbackInput
          value={inputText}
          onChange={setInputText}
          onEnter={() => void generate(inputText)}
          disabled={status === "generating"}
          pending={status === "generating"}
          placeholder={
            status === "output" && output ? "Make it shorter, warmer, more direct..." : "What would you like to say?"
          }
        />
      </Card.Footer>
    </Card>
  );

  // Center modal: dimmed fullscreen backdrop (Escape/buttons only, no
  // click-to-close), fixed-width card centered with internally scrolling
  // content (capped by the host-provided modal budget).
  if (isCenter) {
    return (
      <div className="jot-modal-backdrop">
        <div className="jot-modal-inner">{card}</div>
      </div>
    );
  }
  return card;
}
