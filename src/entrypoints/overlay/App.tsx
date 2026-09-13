import { Button } from "@heroui/react/button";
import { Card } from "@heroui/react/card";
import { Chip } from "@heroui/react/chip";
import { Kbd } from "@heroui/react/kbd";
import { Tooltip } from "@heroui/react/tooltip";
import type { LexicalTextNode } from "@wurkflo/shared";
import { Check, Settings as SettingsIcon, X } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { type EditorType, editorTypeFor, siteLabelFor, track } from "@/lib/analytics";
import { ProviderError, rewriteLexicalNodes } from "@/lib/api";
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
import { copyDomHtml, copyHtml, type ContentNodeLike } from "./lib/clipboard";
import { buildKeyedHtml } from "./lib/keyedHtml";
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

/** Select the live preview node so a legacy execCommand copy carries its
 *  HTML (same as manual Cmd+C). Throws when selection is unavailable so
 *  the caller degrades to the plain-text textarea path. */
function prepareDomCopy(el: ContentNodeLike): void {
  const sel = window.getSelection();
  if (!sel) throw new Error("selection unavailable");
  sel.removeAllRanges();
  sel.selectAllChildren(el as unknown as Node);
}

/**
 * Best-effort clipboard priming for the host's clipboard-paste tier: write
 * Best-effort clipboard priming for the host's single paste: copies the
 * live preview node (HTML flavors when present, plain value otherwise) so
 * the clipboard always holds this rewrite and never another app's content.
 * Never throws, never blocks the insert that follows.
 */
async function primeClipboardForInsert(html: string | null, plain: string): Promise<void> {
  // Every insert primes the clipboard (plain minimum) so the host's single
  // paste can never fire on another app's content. Best effort only.
  try {
    await copyDomHtml(
      () => document.getElementById("jot-content") as ContentNodeLike | null,
      typeof navigator !== "undefined" ? (navigator.clipboard ?? undefined) : undefined,
      document,
      () => document.execCommand("copy"),
      prepareDomCopy,
    );
  } catch {
    // Best effort only; the host's other tiers do not depend on it.
  }
}

export default function App() {
  const [source, setSource] = useState("");
  const [sourceHtml, setSourceHtml] = useState<string | null>(null);
  const [inputText, setInputText] = useState("");
  const [inserted, setInserted] = useState(false);
  // Rewrite the host rejected (e.g. Slack composer). Panel stays open so the
  // user can copy it instead of losing the result.
  const [failedText, setFailedText] = useState<string | null>(null);
  const [failedHtml, setFailedHtml] = useState<string | null>(null);
  const [failedMetrics, setFailedMetrics] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Composer mirroring from the host: placement drives the connector edge,
  // sampled colors theme the content areas (null = theme fallback).
  const [placement, setPlacement] = useState<OverlayPlacement>("float");
  const [composerBg, setComposerBg] = useState<string | null>(null);
  const [composerFg, setComposerFg] = useState<string | null>(null);
  const [pageDark, setPageDark] = useState<boolean | null>(null);
  const [, setConnectorX] = useState<number | null>(null);
  // Lexical keyed flow: index-path nodes from the host for the structure-
  // preserving rewrite. The result map drives `insertLexical`; absent
  // nodes (or any keyed failure) keep the existing string flow. Refs only:
  // every map arrival also sets output, which re-renders.
  const [maxPanelHeight, setMaxPanelHeight] = useState<number | null>(null);
  const nodesRef = useRef<LexicalTextNode[] | null>(null);
  const mapRef = useRef<Record<string, string> | null>(null);
  const keyedBusyRef = useRef(false);
  // Built keyed HTML for preview, clipboard flavors, and the insert
  // payload: one source so all three surfaces always agree.
  const [keyedHtml, setKeyedHtml] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const siteRef = useRef<string | undefined>(undefined);
  const editorRef = useRef<EditorType>("unknown");
  const insertedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const verdictTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True when the host reports a write verdict for this target (Slack,
  // framework editors): close/hold-open follows the verdict, never a timer.
  const verifiedWriteRef = useRef(false);
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
  // Lexical keyed flow first when the host supplied nodes: structure is
  // rewritten by id and committed atomically by the host instance.
  const runKeyedGenerate = useCallback(
    async (nodes: LexicalTextNode[], followUp?: string) => {
      if (keyedBusyRef.current || nodes.length === 0) return;
      keyedBusyRef.current = true;
      busyRef.current = true;
      setStatus("generating");
      setError(null);
      setOutput("");
      mapRef.current = null;
      setKeyedHtml(null);
      const controller = new AbortController();
      abortRef.current = controller;
      let handedOff = false;
      try {
        const map = await rewriteLexicalNodes(nodes, {
          source,
          site: siteRef.current,
          followUp,
          handlers: { signal: controller.signal },
        });
        mapRef.current = map;
        setKeyedHtml(buildKeyedHtml(nodes, map));
        setOutput(nodes.map((n) => map[n.id] ?? n.text).join("\n\n"));
        setStatus("output");
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        // Keyed failure falls through to the string flow below when the
        // run was the initial auto-generate; tweaks surface the error.
        if (!followUp) {
          nodesRef.current = null;
          mapRef.current = null;
          setKeyedHtml(null);
          setStatus("idle");
          keyedBusyRef.current = false;
          handedOff = true;
          void runGenerate(source, undefined, sourceHtml);
          return;
        }
        setError(err instanceof ProviderError ? err : new ProviderError("network", "Something went wrong."));
        setOutput("");
        setKeyedHtml(null);
        setStatus("output");
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        // A handed-off string run owns the busy flag from here.
        if (!handedOff) busyRef.current = false;
        keyedBusyRef.current = false;
      }
    },
    [source, sourceHtml, runGenerate, abortRef, busyRef],
  );

  const generate = useCallback(
    (followUp?: string) => {
      if (!source.trim()) return;
      if (busyRef.current || keyedBusyRef.current) {
        pendingRef.current = { text: source, followUp, html: sourceHtml };
        return;
      }
      const nodes = nodesRef.current;
      if (nodes && nodes.length > 0) {
        void runKeyedGenerate(nodes, followUp);
        return;
      }
      mapRef.current = null;
      setKeyedHtml(null);
      void runGenerate(source, followUp, sourceHtml);
    },
    [source, sourceHtml, runGenerate, runKeyedGenerate],
  );

  const copyFailedText = useCallback(async () => {
    if (!failedText) return;
    // Prefer the live preview DOM verbatim; fall back to state-derived HTML.
    const dom = await copyDomHtml(
      () => document.getElementById("jot-content") as ContentNodeLike | null,
      typeof navigator !== "undefined" ? (navigator.clipboard ?? undefined) : undefined,
      document,
      () => document.execCommand("copy"),
      prepareDomCopy,
    );
    const ok =
      dom !== false
        ? true
        : await copyHtml(
            failedHtml ?? keyedHtml,
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
  }, [failedText, failedHtml, keyedHtml]);

  const retryFailed = useCallback(() => {
    setFailedText(null);
    setFailedHtml(null);
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
    // Prefer the live preview DOM verbatim; fall back to state-derived HTML
    // (keyed build first, else tags carried by the output itself). Rich
    // editors paste HTML, plain fields take the block-aware plain
    // conversion (tags dropped).
    const dom = await copyDomHtml(
      () => document.getElementById("jot-content") as ContentNodeLike | null,
      typeof navigator !== "undefined" ? (navigator.clipboard ?? undefined) : undefined,
      document,
      () => document.execCommand("copy"),
      prepareDomCopy,
    );
    const outputHtml = keyedHtml ?? (/<[a-zA-Z]/.test(output) ? sanitizeRichHtml(output) : null);
    const plain = outputHtml ? htmlToPlainText(output) : output;
    // Clipboard may be denied by the page's permissions policy (e.g. Google
    // Chat). Degrade to a notice, never block the insert path.
    const ok =
      dom !== false
        ? true
        : await copyHtml(
            outputHtml,
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
  }, [output, keyedHtml]);

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
    // Report uncapped want alongside: the host decides placement from content
    // that wants to exist, not from the height the current cap allows.
    postResize(!output, content.scrollHeight);
  }, [maxPanelHeight, output, status]);

  const close = useCallback(() => {
    // Stop an in-flight stream so it can't write state after dismissal.
    abortRef.current?.abort();
    postToParent({ type: "close" });
  }, []);

  useEffect(() => {
    const unsubs = [
      onInsertFailed((msg) => {
        if (verdictTimer.current) clearTimeout(verdictTimer.current);
        setFailedText(msg.text);
        setFailedHtml(typeof msg.html === "string" ? msg.html : null);
        setFailedMetrics(describeMetrics(msg));
        setCopied(false);
        setInserted(false);
      }),
      onInsertResult((msg) => {
        if (verdictTimer.current) clearTimeout(verdictTimer.current);
        // Success closes from the host side; mirror it here in case the
        // host already tore down (or this verdict arrived first).
        if (msg.ok) close();
      }),
    ];
    return () => unsubs.forEach((unsub) => unsub());
  }, [describeMetrics, close]);

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
      const nodes = msg.lexicalNodes && msg.lexicalNodes.length > 0 ? msg.lexicalNodes : null;
      nodesRef.current = nodes;
      mapRef.current = null;
      setKeyedHtml(null);
      setPlacement(msg.placement ?? "float");
      setMaxPanelHeight(msg.maxPanelHeight ?? null);
      setComposerBg(msg.composerBg ?? null);
      setComposerFg(msg.composerFg ?? null);
      setPageDark(msg.pageDark ?? null);
      setConnectorX(msg.connectorX ?? null);
      verifiedWriteRef.current = msg.verifiedWrite ?? false;
      clearCache();
      if (!text) {
        setStatus("idle");
        setTimeout(focusInitial, 60);
        return;
      }
      // If a generation is already in flight (e.g., duplicate init), queue rather than dropping.
      if (busyRef.current || keyedBusyRef.current) {
        // Queued runs take the string flow; drop keyed state so a stale
        // map can never drive the insert path.
        nodesRef.current = null;
        mapRef.current = null;
        pendingRef.current = { text, html: formatted ? html : null };
        // Abort current to let the correct text run next; runGenerate's finally will pick up pending.
        abortRef.current?.abort();
        return;
      }
      if (nodes) {
        void runKeyedGenerate(nodes);
      } else {
        void runGenerate(text, undefined, formatted ? html : null);
      }
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
    async (text: string) => {
      if (!text) return;
      const keyedMap = mapRef.current;
      if (keyedMap) {
        // Keyed flow: the host commits the map through the live Lexical
        // instance; `text` is the plain fallback and `html` the built
        // preview HTML for rich fallback and failure-panel paste. Prime the
        // clipboard first so the trusted paste tier has real flavors.
        await primeClipboardForInsert(keyedHtml, text);
        postToParent({ type: "insertLexical", map: keyedMap, text, html: keyedHtml });
        setInserted(true);
        void track("rewrite_applied", {
          site: siteLabelFor(siteRef.current),
          editor_type: editorRef.current,
          confirmed: false,
        });
        if (insertedTimer.current) clearTimeout(insertedTimer.current);
        if (verdictTimer.current) clearTimeout(verdictTimer.current);
        // Verified targets: the host closes on success and holds the panel
        // open (copy/retry UI) on failure — never auto-close under an
        // in-flight write. The 15s timer backstops a dead host only;
        // worst-case writes settle in ~2s.
        if (verifiedWriteRef.current) {
          verdictTimer.current = setTimeout(() => {
            postToParent({ type: "close" });
          }, 15000);
          return;
        }
        insertedTimer.current = setTimeout(() => {
          postToParent({ type: "close" });
        }, 700);
        return;
      }
      // Formatted output travels as both: plain text for textarea/Slack and
      // the sanitized HTML fragment for rich contenteditables. The host picks
      // per target; text-only hosts ignore `html` entirely. Keyed off the
      // text content so preview, copy, and insert always agree. Prime the
      // clipboard first so the trusted paste tier has real flavors.
      const outputHtml = /<[a-zA-Z]/.test(text) ? sanitizeRichHtml(text) : null;
      const plain = outputHtml ? htmlToPlainText(text) : text;
      await primeClipboardForInsert(outputHtml, plain);
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
      if (verdictTimer.current) clearTimeout(verdictTimer.current);
      // Verified targets: the host closes on success and holds the panel
      // open (copy/retry UI) on failure — never auto-close under an
      // in-flight write. The 15s timer backstops a dead host only;
      // worst-case writes settle in ~2s.
      if (verifiedWriteRef.current) {
        verdictTimer.current = setTimeout(() => {
          postToParent({ type: "close" });
        }, 15000);
        return;
      }
      insertedTimer.current = setTimeout(() => {
        postToParent({ type: "close" });
      }, 700);
    },
    [keyedHtml],
  );

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
        if (output) void insertText(output);
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
      if (verdictTimer.current) clearTimeout(verdictTimer.current);
    },
    [],
  );

  // Sampled composer colors as CSS vars, applied only as a pair: a lone
  // bg or fg would pair a sampled color against a mismatched theme color.
  // Unset = theme styling untouched. Paired cards take the composer
  // background as their face so overlay and composer read as one.
  // Detached fullscreen cards always use the theme surface (no composer tint).
  // The shadow is neutral and page-aware: white on dark pages, black on
  // light pages, falling back to the overlay's own theme.
  const isFullscreen = placement === "fullscreen";
  const paired = composerBg !== null && composerFg !== null && !isFullscreen;
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
      className={`jot-card-glow relative w-full gap-2 overflow-visible rounded-[8px] px-3 pb-3 pt-1 backdrop-blur-xl${paired ? " jot-paired" : ""}${isFullscreen ? " jot-fullscreen-card" : ""}`}
    >
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
              Couldn&apos;t update the editor. Copy the rewrite, then paste it into the editor (⌘V / Ctrl+V).
            </p>
            <p className="jot-failed-text mb-2 break-words whitespace-pre-wrap text-muted">{failedText}</p>
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
          <ContentBox output={output} status={status} htmlPreview={keyedHtml} />
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

  // Fullscreen: the same card scaled up and centered by the host (no
  // backdrop — the page stays interactive). Content scrolls inside via
  // --jot-content-max (host-provided fullscreen budget); header/footer
  // stay pinned. Escape/buttons only, no click-to-close (nothing to click).
  return card;
}
