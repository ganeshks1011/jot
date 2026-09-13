import { browser } from "wxt/browser";
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { liveRichTextDeps, replaceRichText, resolveFrameworkRoot } from "@/lib/editors/richText";
import {
  alignMentionEntities,
  isSlackComposer,
  liveSlackDeps,
  type MentionEntity,
  normalizeComposerMultiline,
  outermostEditable,
  replaceSlackText,
  resolveLiveComposer,
  type SlackWriteDiagnostics,
  splitMentionRuns,
  splitRunsByLines,
} from "@/lib/editors/slack";
import { buildInitKey, shouldSendInit } from "@/lib/initHandshake";
import {
  IFRAME_MARGIN,
  isDarkBackground,
  isTransparentBackground,
  type OverlayPlacement,
  pickOpaqueBackground,
  resolveMaxPanelHeight,
  resolveOverlayGeometry,
  synthesizeAnchor,
} from "@/lib/overlayGeometry";
import { detectMentionLabels } from "@/lib/redaction/detectors";
import { hasRichFormatting, isMultilineText, sanitizeRichHtml } from "@/lib/richText";

/**
 * On-demand host controller, injected into the active tab via
 * chrome.scripting.executeScript only after the user explicitly invokes Jot
 * (chrome.commands shortcut or the toolbar action). There is NO persistent
 * content script: this code does not exist in a tab until invocation, and it
 * fully tears itself down when the overlay closes.
 *
 * Responsibilities (mirrors the former content script):
 * - capture the focused editable field or the active text selection
 * - create/position the chrome-extension:// overlay iframe
 * - validated postMessage bridge with the overlay (see overlay/lib/bridge.ts)
 * - insert the rewritten text back into the captured target
 */

declare global {
  interface Window {
    __jotHost?: HostController;
  }
}

interface HostController {
  /** Toggle open/closed; closing destroys the controller. */
  toggle(): void;
  destroy(): void;
}

const OVERLAY_URL = browser.runtime.getURL("/overlay.html");
// The card fills the iframe minus IFRAME_MARGIN of document padding on each
// side (room for shadow/glow). Card width matches the composer exactly.

export default defineUnlistedScript(() => {
  // Re-invocation while alive (e.g. executeScript raced the toggle message):
  // just toggle instead of stacking a second controller.
  if (window.__jotHost) {
    window.__jotHost.toggle();
    return;
  }
  window.__jotHost = createHost();
});

function isEditable(el: Element | null): el is HTMLElement {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return ["text", "search", "url", "email", "tel"].includes(el.type);
  }
  return (el as HTMLElement).isContentEditable === true;
}

function createHost(): HostController {
  let iframe: HTMLIFrameElement | null = null;
  let activeField: HTMLElement | null = null;
  let capturedText = "";
  let capturedStart = 0;
  let capturedEnd = 0;
  let capturedRange: Range | null = null;
  /**
   * Mention pills captured from the live Slack composer at invocation, in
   * document order. Cloned (never moved) at write-back so the originals stay
   * intact if the write is retried; cleared on destroy with everything else.
   */
  let capturedPills: Array<{ id: string; label: string; node: Element }> = [];
  /**
   * Sanitized HTML fragment when the capture carried user formatting
   * (bold/italics/lists); null for plain captures. Plain text always
   * travels alongside so textarea paths and the model fallback stay intact.
   */
  let capturedHtml: string | null = null;
  let capturedHasFormatting = false;
  let capturedMultiline = false;
  /**
   * The visible bordered box for highlight + anchoring. Usually the field
   * itself; for framework editors (Lexical, Slack) it is the bordered
   * ancestor wrapper. Resolved once per open; null for plain selections.
   */
  let highlightBox: HTMLElement | null = null;
  let panelVisible = false;
  let pendingShow: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  // ---------------------------------------------------------------------------
  // Capture: focused field first, then any plain text selection.
  // ---------------------------------------------------------------------------

  /**
   * Collect mention pills from a composer subtree. Scoped to the already
   * resolved composer. Never a global query. Evidence-backed against the
   * live Slack composer: `ts-mention[data-id][data-label]`; hidden paste
   * buffers (`aria-hidden`) are excluded.
   */
  function collectMentionPills(root: Element): Array<{ id: string; label: string; node: Element }> {
    const out: Array<{ id: string; label: string; node: Element }> = [];
    let pills: NodeListOf<Element>;
    try {
      pills = root.querySelectorAll("ts-mention");
    } catch {
      return out;
    }
    pills.forEach((pill) => {
      try {
        if (pill.closest('[aria-hidden="true"]')) return;
        const id = pill.getAttribute("data-id")?.trim() ?? "";
        const label = pill.getAttribute("data-label")?.trim() ?? pill.textContent?.trim() ?? "";
        if (id && label) out.push({ id, label, node: pill });
      } catch {
        // Skip unreadable nodes; validation fails safe later if needed.
      }
    });
    return out;
  }

  /** Serialize a range to sanitized HTML (formatting only, never scripts). */
  function serializeRangeHtml(range: Range | null): string | null {
    if (!range) return null;
    try {
      const holder = document.createElement("div");
      holder.appendChild(range.cloneContents());
      const clean = sanitizeRichHtml(holder.innerHTML);
      return clean ? clean : null;
    } catch {
      return null;
    }
  }

  function captureSelection(): void {
    capturedText = "";
    capturedStart = 0;
    capturedEnd = 0;
    capturedRange = null;
    capturedPills = [];
    capturedHtml = null;
    capturedHasFormatting = false;
    capturedMultiline = false;

    // Resolve the target at invocation time - there is no focus tracking
    // between invocations (that would require a persistent script).
    const el = document.activeElement;
    activeField = isEditable(el) ? el : null;

    if (activeField?.isContentEditable) {
      const sel = window.getSelection();
      const hasSelection = sel && sel.rangeCount > 0 && !sel.isCollapsed && activeField.contains(sel.anchorNode);
      if (hasSelection) {
        capturedRange = sel!.getRangeAt(0).cloneRange();
        capturedText = sel!.toString();
      } else {
        // No selection - use the entire contenteditable content.
        const range = document.createRange();
        range.selectNodeContents(activeField);
        capturedRange = range;
        capturedText = range.toString();
      }
      const html = serializeRangeHtml(capturedRange);
      capturedHasFormatting = html ? hasRichFormatting(html) : false;
      capturedHtml = capturedHasFormatting ? html : null;
      capturedMultiline = isMultilineText(capturedText) || (html ? /<(p|br|ul|ol|li)\b/i.test(html) : false);
      if (isSlackComposer(window.location.hostname)) {
        capturedPills = collectMentionPills(activeField);
      }
      return;
    }

    if (activeField instanceof HTMLTextAreaElement || activeField instanceof HTMLInputElement) {
      const start = activeField.selectionStart ?? 0;
      const end = activeField.selectionEnd ?? activeField.value.length;
      if (start !== end) {
        // Use the selected slice.
        capturedStart = start;
        capturedEnd = end;
        capturedText = activeField.value.slice(start, end);
      } else {
        // No selection - use the entire field value.
        capturedStart = 0;
        capturedEnd = activeField.value.length;
        capturedText = activeField.value;
      }
      capturedMultiline = isMultilineText(capturedText);
      return;
    }

    // No editable focused - fall back to a plain page text selection.
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed && sel.toString().trim()) {
      capturedRange = sel.getRangeAt(0).cloneRange();
      capturedText = sel.toString();
      const html = serializeRangeHtml(capturedRange);
      capturedHasFormatting = html ? hasRichFormatting(html) : false;
      capturedHtml = capturedHasFormatting ? html : null;
      capturedMultiline = isMultilineText(capturedText);
    }
  }

  // ---------------------------------------------------------------------------
  // Overlay iframe
  // ---------------------------------------------------------------------------

  function ensureIframe(): HTMLIFrameElement {
    if (iframe) return iframe;

    const frame = document.createElement("iframe");
    frame.src = OVERLAY_URL;
    frame.style.position = "fixed";
    // Sane default until positionIframe runs during openPanel.
    frame.style.width = `${Math.min(824, window.innerWidth)}px`;
    frame.style.height = "0px";
    frame.style.border = "none";
    // Seamless is a no-op in modern Chrome (attribute was removed from the
    // spec) but harmless; the real "seamless" work is the transparent
    // background + padded overlay document so the card's own shadow renders.
    frame.setAttribute("seamless", "");
    frame.style.background = "transparent";
    frame.style.zIndex = "2147483647";
    frame.style.visibility = "hidden";
    // Opacity only until the first placement lands; openPanel enables the
    // full glide transition afterwards so the panel never flies in from a
    // corner on open.
    frame.style.transition = "opacity 150ms ease";
    frame.style.opacity = "0";
    frame.setAttribute("aria-label", "Jot assistant");

    document.documentElement.appendChild(frame);
    iframe = frame;
    return frame;
  }

  /**
   * Glide follow-up placements (streaming growth, scroll, viewport resize).
   * Enabled only after the first placement lands so open never flies in
   * from a corner. Skipped entirely under prefers-reduced-motion.
   */
  function enableSmoothResize(frame: HTMLIFrameElement): void {
    try {
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
      frame.style.transition =
        "height 260ms ease, width 260ms ease, left 260ms ease, top 260ms ease, opacity 150ms ease";
    } catch {
      // Transition is cosmetic; never break open.
    }
  }

  function anchorRect(): DOMRect | null {
    const box = highlightBox ?? activeField;
    if (!box) return null;
    const rect = box.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    return rect;
  }

  /** Viewport-space anchor snapshot for geometry (null = unanchored). */
  function snapshotAnchor(): {
    left: number;
    top: number;
    bottom: number;
    width: number;
  } | null {
    const rect = anchorRect();
    return rect ? { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width } : null;
  }

  /**
   * Live selected-text rect for text-anchored positioning. Only a connected,
   * non-collapsed range counts; anything else falls back to the container
   * box. Textarea/input selections have no pixel rects and always fall back
   * (their boxes are tight). Recomputed on every reposition so scroll tracks
   * live and a detached range (framework re-render) fails safe to the box.
   */
  function snapshotTextAnchor(): {
    left: number;
    top: number;
    bottom: number;
    width: number;
  } | null {
    try {
      if (!capturedRange) return null;
      if (!capturedRange.commonAncestorContainer.isConnected) return null;
      const rect = capturedRange.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      return { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width };
    } catch {
      return null;
    }
  }

  /**
   * The bordered box to highlight and anchor to. Most fields carry their own
   * border; framework editors render a borderless inner node inside a
   * bordered wrapper, so climb for the nearest ancestor with a painted
   * border. Falls back to the field itself.
   */
  function resolveHighlightBox(): HTMLElement | null {
    if (!activeField) return null;
    try {
      let el: Element | null = activeField;
      for (let i = 0; i < 6 && el; i++) {
        if (el instanceof HTMLElement && el !== document.documentElement) {
          const cs = window.getComputedStyle(el);
          const width = Number.parseFloat(cs.borderTopWidth || "0");
          if (width > 0 && !isTransparentBackground(cs.borderTopColor || "")) return el;
        }
        el = el.parentElement;
        if (el === document.body || el === document.documentElement) break;
      }
    } catch {
      // Fall through to the field itself.
    }
    return activeField;
  }

  // Last computed placement, sent with init so the overlay can draw its
  // connector on the composer-facing edge.
  let lastPlacement: OverlayPlacement = "float";
  // Panel height budget backing the overlay's content cap (null = fallback).
  let lastMaxPanelHeight: number | null = null;
  // Once content trips the fullscreen threshold, stay fullscreen for the
  // rest of the open session. Avoids flip-flop while streaming grows the
  // panel.
  let fullscreenPinned = false;
  // Card-relative x of the connector diamond (null = hidden). Recomputed
  // with every placement so it tracks the anchor box, not the card center.
  let lastConnectorX: number | null = null;
  // Compact pre-content width. Panels start compact; the overlay reports
  // false with its first content resize. Remembered so scroll repositions
  // keep the current width instead of jumping prematurely.
  let lastCompact = true;
  // True while a verified write is pending. A second insert arriving
  // mid-write (double-Enter, timer race) is ignored instead of interleaved:
  // overlapping runs on a mutating framework editor stack duplicate copies.
  let insertInFlight = false;

  function positionIframe(height: number, compact = false): void {
    if (!iframe) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const box = snapshotAnchor();
    // Hug the selected words when usable; the container box otherwise.
    const anchor = box ? synthesizeAnchor(box, snapshotTextAnchor(), compact) : null;
    // Pinned fullscreen forces fullscreen geometry by presenting a
    // full-height panel.
    const g = resolveOverlayGeometry(viewport, anchor, fullscreenPinned ? viewport.height : height, compact);
    if (g.placement === "fullscreen") fullscreenPinned = true;
    lastPlacement = g.placement;
    lastMaxPanelHeight = resolveMaxPanelHeight(viewport, anchor, g.placement);
    if (g.placement === "fullscreen" || g.placement === "float" || !anchor) {
      lastConnectorX = null;
    } else {
      const centerX = anchor.left + anchor.width / 2 - g.left;
      lastConnectorX = Math.max(14, Math.min(centerX, g.cardWidth - 14));
    }
    if (g.placement === "fullscreen") {
      // Shrink-wrapped frame around the centered card (no backdrop — the
      // page stays interactive). Same margin math as anchored placements.
      const cardHeight = g.cardHeight ?? height;
      iframe.style.width = `${Math.round(g.frameWidth)}px`;
      iframe.style.height = `${Math.round(cardHeight + IFRAME_MARGIN * 2)}px`;
      iframe.style.left = `${Math.max(0, Math.round(g.left) - IFRAME_MARGIN)}px`;
      iframe.style.top = `${Math.max(0, Math.round(g.top) - IFRAME_MARGIN)}px`;
      return;
    }
    iframe.style.width = `${Math.round(g.frameWidth)}px`;
    // The overlay document pads the card by IFRAME_MARGIN on every side (that
    // padding is what leaves room for the card's shadow/glow), so shift the
    // iframe up/left by the same amount to keep the card itself anchored.
    iframe.style.left = `${Math.max(0, Math.round(g.left) - IFRAME_MARGIN)}px`;
    iframe.style.top = `${Math.max(0, Math.round(g.top) - IFRAME_MARGIN)}px`;
  }

  let lastInitKey = "";
  let lastInitAt = 0;
  function postInit(force = false): void {
    if (!iframe || !panelVisible) return;
    // Dedupe rapid double sends (load-timer + ready) for same captured text.
    // Forced sends always deliver: `ready` means the overlay's listener is
    // attached now, i.e. any earlier `init` was missed (cold first-invoke).
    const initKey = buildInitKey(
      capturedText,
      capturedHasFormatting,
      capturedHtml?.length ?? 0,
      window.location.hostname,
    );
    if (!shouldSendInit(lastInitKey, lastInitAt, initKey, Date.now(), force)) return;
    lastInitKey = initKey;
    lastInitAt = Date.now();
    const fieldType = activeField
      ? activeField.isContentEditable
        ? "contenteditable"
        : activeField instanceof HTMLTextAreaElement
          ? "textarea"
          : "input"
      : capturedRange
        ? "selection"
        : null;
    const colors = sampleComposerColors();
    // The overlay awaits a host verdict instead of auto-closing when the
    // target takes a verified write (Slack, framework editors). Focus has
    // already moved into the panel, so resolve from the captured field.
    const verifiedWrite =
      isSlackComposer(window.location.hostname) ||
      resolveFrameworkRoot(liveRichTextDeps(document, window, activeField)) !== null;
    iframe.contentWindow?.postMessage(
      {
        type: "init",
        text: capturedText,
        fieldType,
        site: window.location.hostname,
        placement: lastPlacement,
        maxPanelHeight: lastMaxPanelHeight,
        composerBg: colors.bg,
        composerFg: colors.fg,
        pageDark: colors.pageDark,
        connectorX: lastConnectorX,
        verifiedWrite,
        html: capturedHtml,
        hasFormatting: capturedHasFormatting,
        multiline: capturedMultiline,
      },
      "*",
    );
  }

  /** Push placement + panel budget + connector offset after viewport
   *  resizes (scroll reuses the last values; the iframe clamp guards
   *  overflow in between). */
  function postMetrics(): void {
    if (!iframe || !panelVisible) return;
    iframe.contentWindow?.postMessage(
      {
        type: "metrics",
        placement: lastPlacement,
        maxPanelHeight: lastMaxPanelHeight,
        connectorX: lastConnectorX,
      },
      "*",
    );
  }

  function onWindowResize(): void {
    handleReposition();
    postMetrics();
  }

  function attachReposition(): void {
    window.addEventListener("scroll", handleReposition, true);
    window.addEventListener("resize", onWindowResize);
  }

  function detachReposition(): void {
    window.removeEventListener("scroll", handleReposition, true);
    window.removeEventListener("resize", onWindowResize);
  }

  // Re-anchor while open when the composer itself moves or resizes (Slack
  // thread growth, Gmail autoresize). Disconnected on close/destroy.
  let fieldObserver: ResizeObserver | null = null;

  function observeField(): void {
    disconnectFieldObserver();
    const target = highlightBox ?? activeField;
    if (!target) return;
    try {
      fieldObserver = new ResizeObserver(() => handleReposition());
      fieldObserver.observe(target);
    } catch {
      fieldObserver = null;
    }
  }

  function disconnectFieldObserver(): void {
    try {
      fieldObserver?.disconnect();
    } catch {
      // Never break teardown.
    }
    fieldObserver = null;
  }

  /**
   * Sample the composer's painted colors for the overlay to mirror, plus
   * whether the page is dark (for a neutral shadow). Reads computed colors
   * only. Never page text.
   */
  function sampleComposerColors(): { bg: string | null; fg: string | null; pageDark: boolean | null } {
    if (!activeField) return { bg: null, fg: null, pageDark: null };
    try {
      const fg = window.getComputedStyle(activeField).color || null;
      const bgs: string[] = [];
      let el: Element | null = activeField;
      for (let i = 0; i < 6 && el; i++) {
        bgs.push(window.getComputedStyle(el).backgroundColor);
        el = el.parentElement;
      }
      const bg = pickOpaqueBackground(bgs);
      return { bg, fg, pageDark: bg ? isDarkBackground(bg) : null };
    } catch {
      return { bg: null, fg: null, pageDark: null };
    }
  }

  // Captured-text highlight, split by surface. Contenteditables keep the
  // native selection tinted by a scoped ::selection rule (zero restyling of
  // page elements; no underline since ::selection ignores text-decoration).
  // Textarea/input selections wash out when blurred, so those highlight via
  // their own border color instead — saved and restored on close. Tag,
  // class, and border color are all removed on close so the page is left
  // untouched.
  const SELECTION_STYLE_ID = "jot-selection";
  const FIELD_HIGHLIGHT_BORDER = "#c4b5fd";
  let highlightPrevBorderColor = "";
  let highlightBorderTarget: HTMLElement | null = null;

  function ensureSelectionStyle(): void {
    try {
      if (document.getElementById(SELECTION_STYLE_ID)) return;
      const tag = document.createElement("style");
      tag.id = SELECTION_STYLE_ID;
      tag.textContent =
        ".jot-sel::selection{background:rgb(196 181 253 / 0.55);color:inherit;}" +
        ".jot-sel ::selection{background:rgb(196 181 253 / 0.55);color:inherit;}";
      (document.head ?? document.documentElement).appendChild(tag);
    } catch {
      // Strict-CSP pages refuse the tag; the native selection still shows.
    }
  }

  function applySelectionHighlight(): void {
    clearSelectionHighlight();
    try {
      ensureSelectionStyle();
    } catch {
      // Cosmetic only; continue to the selection restore below.
    }
    try {
      const sel = window.getSelection();
      if (capturedRange && sel) {
        sel.removeAllRanges();
        sel.addRange(capturedRange.cloneRange());
      } else if (activeField instanceof HTMLTextAreaElement || activeField instanceof HTMLInputElement) {
        activeField.setSelectionRange(capturedStart, capturedEnd);
      }
    } catch {
      // A detached range fails safe; the tint scope below is harmless.
    }
    try {
      (highlightBox ?? activeField)?.classList.add("jot-sel");
    } catch {
      // Never break open.
    }
    // Text fields mark the captured selection with their border color,
    // which paints at full strength with or without focus.
    try {
      const target = highlightBox ?? activeField;
      if (
        target?.isConnected === true &&
        (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)
      ) {
        highlightBorderTarget = target;
        highlightPrevBorderColor = target.style.borderColor;
        target.style.borderColor = FIELD_HIGHLIGHT_BORDER;
      }
    } catch {
      highlightBorderTarget = null;
    }
  }

  function clearSelectionHighlight(): void {
    try {
      document.getElementById(SELECTION_STYLE_ID)?.remove();
      (highlightBox ?? activeField)?.classList.remove("jot-sel");
    } catch {
      // Never break teardown.
    }
    try {
      if (highlightBorderTarget) {
        highlightBorderTarget.style.borderColor = highlightPrevBorderColor;
      }
    } catch {
      // Never break teardown.
    }
    highlightBorderTarget = null;
  }

  function handleReposition(): void {
    if (!iframe || !panelVisible) return;
    const height = Math.max(160, Number.parseInt(iframe.style.height, 10) || 0);
    positionIframe(height, lastCompact);
  }

  /** Move keyboard focus into the overlay so Enter/Tab/arrows drive Jot,
   *  not the page underneath. Capture already ran, so the field/range is safe. */
  function focusPanel(): void {
    if (!iframe) return;
    try {
      iframe.contentWindow?.focus();
      iframe.focus();
    } catch {
      // Focus is best-effort; the overlay also focuses internally.
    }
  }

  function openPanel(): void {
    const frame = ensureIframe();
    captureSelection();
    highlightBox = resolveHighlightBox();

    frame.style.visibility = "visible";
    frame.style.opacity = "1";
    panelVisible = true;
    fullscreenPinned = false;
    lastCompact = true;
    lastConnectorX = null;
    attachReposition();
    observeField();
    applySelectionHighlight();
    focusPanel();

    // Every open starts as a small anchored overlay (overlap allowed); the
    // first streaming resize can still trip fullscreen later (one-way
    // upgrade, never flips back).
    positionIframe(160, true);
    enableSmoothResize(frame);

    // Fast path: send init once the frame has loaded. The overlay also sends
    // { type: "ready" } once its listener is attached, which re-sends init and
    // closes the mount race.
    const loaded = frame.contentDocument?.readyState === "complete";
    if (loaded) {
      pendingShow = setTimeout(postInit, 60);
    } else {
      frame.addEventListener(
        "load",
        () => {
          pendingShow = setTimeout(postInit, 60);
        },
        { once: true },
      );
      // Safety net: some frames never fire `load` if the document is cached.
      // Forced: by now the overlay listener may be attached, so deliver.
      setTimeout(() => {
        if (!pendingShow) postInit(true);
      }, 600);
    }
  }

  function closePanel(): void {
    if (!panelVisible) return;
    panelVisible = false;
    if (pendingShow) {
      clearTimeout(pendingShow);
      pendingShow = null;
    }
    disconnectFieldObserver();
    clearSelectionHighlight();
    // Restore the user's cursor focus to the field they launched from...
    activeField?.focus();
    // ...then tear everything down so nothing stays behind in the page.
    destroy();
  }

  function togglePanel(): void {
    if (panelVisible) closePanel();
    else openPanel();
  }

  // ---------------------------------------------------------------------------
  // Insertion into the host field
  // ---------------------------------------------------------------------------

  /**
   * Entity-preserving Slack write-back (multi-paragraph aware). Rebuilds the
   * composer's blocks from the rewritten text, splicing cloned mention pills
   * back in at placeholder positions so user identity survives. Lists travel
   * as plain "- "/"1. " lines inside blocks. Fails safe (no write) when
   * validation fails or the structure is unexpected. Never guess where a
   * mention belongs.
   */
  function insertSlackEntities(text: string): {
    ok: boolean;
    diagnostics?: SlackWriteDiagnostics;
  } {
    const expectedLen = normalizeComposerMultiline(text).length;
    const fail = (
      tag: string | null,
      preLen: number,
      postLen: number,
    ): { ok: boolean; diagnostics: SlackWriteDiagnostics } => ({
      ok: false,
      diagnostics: {
        strategy: "entity",
        tag,
        preLen,
        postLen,
        expectedLen,
        attempts: 1,
      },
    });

    try {
      const finalLabels = detectMentionLabels(text);
      const captured: MentionEntity[] = capturedPills.map(({ id, label }) => ({
        id,
        label,
      }));
      const alignment = alignMentionEntities(finalLabels, captured);
      // Every captured mention must survive exactly once; invented ones fail.
      if (!alignment.ok) return fail(null, -1, -1);

      const deps = liveSlackDeps(document, window, activeField);
      const resolved = resolveLiveComposer(deps);
      if (!resolved) return fail(null, -1, -1);
      const composer = outermostEditable(resolved) as unknown as HTMLElement;
      const tag = typeof composer.tagName === "string" ? composer.tagName.toUpperCase() : null;
      const preLen = normalizeComposerMultiline(composer.innerText ?? "").length;

      // Multi-block scope: one visible P/DIV child per paragraph. Zero
      // visible blocks fails safe; anything else rebuilds block-for-block.
      const blocks = Array.from(composer.children).filter(
        (k) => /^(P|DIV)$/i.test(k.tagName) && k.getAttribute("aria-hidden") !== "true",
      );
      if (blocks.length === 0) return fail(tag, preLen, preLen);

      const slots = finalLabels.map((label, i) => {
        const entity = alignment.ordered[i];
        if (!entity) throw new Error("unreachable");
        return { label, entity };
      });
      const runs = splitMentionRuns(text, slots);
      const lineBlocks = splitRunsByLines(runs);
      const pool = new Map<string, Element[]>();
      for (const p of capturedPills) {
        const q = pool.get(p.label);
        if (q) q.push(p.node);
        else pool.set(p.label, [p.node]);
      }
      const appendRunNodes = (parent: Node, blockRuns: typeof runs): boolean => {
        for (const run of blockRuns) {
          if (run.kind === "text") {
            if (run.text) parent.appendChild(document.createTextNode(run.text));
          } else {
            const src = pool.get(run.slot.label)?.shift();
            if (!src) return false;
            const pill = src.cloneNode(true) as Element;
            pill.textContent = run.slot.label;
            parent.appendChild(pill);
          }
        }
        return true;
      };
      const newBlocks: HTMLElement[] = [];
      for (const blockRuns of lineBlocks) {
        const div = document.createElement("div");
        if (!appendRunNodes(div, blockRuns)) return fail(tag, preLen, preLen);
        // Empty paragraphs need a break to stay visible/selectable.
        if (!div.hasChildNodes()) div.appendChild(document.createElement("br"));
        newBlocks.push(div);
      }

      composer.focus();
      for (const b of blocks) b.remove();
      for (const nb of newBlocks) composer.appendChild(nb);
      composer.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true }));
      composer.dispatchEvent(new InputEvent("input", { bubbles: true }));

      const readBack = composer.innerText ?? "";
      const actual = normalizeComposerMultiline(readBack);
      const textOk = actual === normalizeComposerMultiline(text) || actual.includes(normalizeComposerMultiline(text));
      const liveIds = Array.from(composer.querySelectorAll("ts-mention"))
        .filter((p) => !p.closest('[aria-hidden="true"]'))
        .map((p) => p.getAttribute("data-id") ?? "");
      const expectedIds = alignment.ordered.map((e) => e.id);
      const idsOk = liveIds.length === expectedIds.length && liveIds.every((id, i) => id === expectedIds[i]);
      if (textOk && idsOk) {
        capturedRange = null;
        return {
          ok: true,
          diagnostics: {
            strategy: "entity",
            tag,
            preLen,
            postLen: actual.length,
            expectedLen,
            attempts: 1,
          },
        };
      }
      return fail(tag, preLen, actual.length);
    } catch {
      return fail(null, -1, -1);
    }
  }

  /**
   * Insert into the host field. Returns whether the write verified.
   * Non-Slack behavior is unchanged (always treated as success).
   * `html` is the sanitized preserve-only fragment; textarea/input always
   * take plain `text`, contenteditables prefer HTML when present.
   * Async: the framework-editor path awaits frame flushes before verifying.
   */
  async function insertText(
    text: string,
    html?: string | null,
  ): Promise<{
    ok: boolean;
    diagnostics?: SlackWriteDiagnostics;
  }> {
    // Slack re-renders its composer and only accepts real editing input.
    // Isolated in @/lib/editors/slack so generic behavior never changes.
    if (isSlackComposer(window.location.hostname)) {
      // Mention-aware path when either side involves entities; otherwise the
      // plain-text path (unchanged behavior for ordinary messages).
      if (capturedPills.length > 0 || detectMentionLabels(text).length > 0) {
        return insertSlackEntities(text);
      }
      const result = replaceSlackText(text, liveSlackDeps(document, window, activeField));
      if (result.ok) capturedRange = null;
      return { ok: result.ok, diagnostics: result.diagnostics };
    }

    // Model-driven editors (Lexical, Slate, ProseMirror/TipTap, Quill,
    // Draft.js, CKEditor) reconcile the DOM against internal state, so range
    // surgery is silently reverted. Verified editing input instead.
    const richTextDeps = liveRichTextDeps(document, window, activeField);
    if (resolveFrameworkRoot(richTextDeps)) {
      const result = await replaceRichText(text, richTextDeps);
      if (result.ok) capturedRange = null;
      return { ok: result.ok, diagnostics: result.diagnostics };
    }

    if (activeField instanceof HTMLTextAreaElement || activeField instanceof HTMLInputElement) {
      activeField.focus();
      const start = capturedStart ?? activeField.selectionStart ?? activeField.value.length;
      const end = capturedEnd ?? activeField.selectionEnd ?? start;
      activeField.setRangeText(text, start, end, "end");
      activeField.dispatchEvent(new Event("input", { bubbles: true }));
      activeField.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }

    // Contenteditable fields and plain text selections both insert at the
    // captured range. Only the user's own selection/target is ever touched.
    if (capturedRange) {
      if (activeField) activeField.focus();
      const sel = window.getSelection();
      if (!sel) return { ok: false };
      sel.removeAllRanges();
      sel.addRange(capturedRange);
      const cleanHtml = html ? sanitizeRichHtml(html) : null;
      if (cleanHtml && cleanHtml.trim()) {
        // Preserve-only HTML: real editing input first, template fallback
        // second (never innerHTML assignment on the live field).
        if (document.execCommand("insertHTML", false, cleanHtml)) {
          capturedRange = null;
          return { ok: true };
        }
        try {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const template = document.createElement("template");
          template.innerHTML = cleanHtml;
          range.insertNode(template.content.cloneNode(true));
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
          capturedRange = null;
          return { ok: true };
        } catch {
          // Fall through to the plain-text path.
          sel.removeAllRanges();
          if (capturedRange) sel.addRange(capturedRange);
        }
      }
      if (!document.execCommand("insertText", false, text)) {
        // Plain fallback must preserve line breaks: one <br> per newline
        // (blank lines yield a second <br> and stay visible).
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const frag = document.createDocumentFragment();
        const parts = text.split("\n");
        parts.forEach((part, i) => {
          if (i > 0) frag.appendChild(document.createElement("br"));
          if (part) frag.appendChild(document.createTextNode(part));
          else if (i > 0) frag.appendChild(document.createElement("br"));
        });
        range.insertNode(frag);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      capturedRange = null;
      return { ok: true };
    }
    return { ok: false };
  }

  /** Report a verified write (lengths/tags only, never text). */
  function postInsertResult(ok: boolean, diagnostics: SlackWriteDiagnostics): void {
    try {
      // Page console persists after the panel closes. The diagnostic trail
      // for silent-close reports.
      console.info("[jot] verified insert", {
        ok,
        strategy: diagnostics.strategy,
        tag: diagnostics.tag,
        preLen: diagnostics.preLen,
        postLen: diagnostics.postLen,
        expectedLen: diagnostics.expectedLen,
        attempts: diagnostics.attempts,
      });
    } catch {
      // Logging must never break insertion.
    }
    iframe?.contentWindow?.postMessage(
      {
        type: "insert-result",
        ok,
        strategy: diagnostics.strategy,
        tag: diagnostics.tag,
        preLen: diagnostics.preLen,
        postLen: diagnostics.postLen,
        expectedLen: diagnostics.expectedLen,
        attempts: diagnostics.attempts,
      },
      "*",
    );
  }

  /** Report a failed write back to the overlay (which stays open). */
  function postInsertFailed(text: string, diagnostics?: SlackWriteDiagnostics, html?: string | null): void {
    iframe?.contentWindow?.postMessage(
      {
        type: "insert-failed",
        text,
        html: html ?? null,
        strategy: diagnostics?.strategy ?? null,
        tag: diagnostics?.tag ?? null,
        preLen: diagnostics?.preLen ?? -1,
        postLen: diagnostics?.postLen ?? -1,
        expectedLen: diagnostics?.expectedLen ?? -1,
        attempts: diagnostics?.attempts ?? 0,
      },
      "*",
    );
  }

  // ---------------------------------------------------------------------------
  // postMessage contract (overlay <-> this controller)
  // ---------------------------------------------------------------------------

  async function handleOverlayMessage(event: MessageEvent): Promise<void> {
    // Validate by origin: only documents served from this extension's own
    // chrome-extension:// origin can post overlay events. Derive the expected
    // origin from `runtime.id` (NOT by parsing `runtime.getURL()` - the URL
    // shape can vary, e.g. web-accessible resource rewriting).
    // NOTE: do NOT compare `event.source === iframe.contentWindow` here - in
    // the isolated world, cross-origin WindowProxy wrappers are not strictly
    // equal even for the same underlying frame.
    const expectedOrigin = `chrome-extension://${browser.runtime.id}`;
    if (event.origin !== expectedOrigin) return;
    if (event.source === window) return; // ignore self-posted messages

    const msg = event.data as {
      type?: string;
      text?: string;
      html?: string | null;
      height?: number;
      compact?: boolean | null;
    } | null;
    if (!msg || typeof msg !== "object") return;

    switch (msg.type) {
      case "ready": {
        // The overlay's init listener is attached now. Force the resend so
        // a cold first-invoke `init` lost before mount still gets through.
        postInit(true);
        // The frame finished loading after openPanel's focus call; focus
        // again now that its document can receive it.
        focusPanel();
        break;
      }
      case "resize": {
        if (!iframe) break;
        lastCompact = msg.compact ?? false;
        // Let placement decide first: content past a third of the viewport
        // scales to fullscreen (pinned). Anchored panels keep the
        // content-driven height as before.
        positionIframe(msg.height ?? 0, lastCompact);
        if (lastPlacement === "fullscreen") break;
        const height = Math.min(msg.height ?? 0, window.innerHeight - 24);
        iframe.style.height = `${Math.max(160, height)}px`;
        positionIframe(height, lastCompact);
        break;
      }
      case "insert": {
        if (typeof msg.text === "string") {
          if (insertInFlight) break; // serialized: never interleave runs
          const html = typeof msg.html === "string" ? msg.html : null;
          if (isSlackComposer(window.location.hostname)) {
            // Verified write; on failure the panel stays open so the user
            // can copy the rewrite instead of silently losing it.
            // Slack composers take plain text (pills rebuilt from labels).
            insertInFlight = true;
            try {
              const outcome = await insertText(msg.text);
              if (outcome.diagnostics) {
                postInsertResult(outcome.ok, outcome.diagnostics);
              }
              if (outcome.ok) closePanel();
              else postInsertFailed(msg.text, outcome.diagnostics);
            } finally {
              insertInFlight = false;
            }
            break;
          }
          const richTextDeps = liveRichTextDeps(document, window, activeField);
          if (resolveFrameworkRoot(richTextDeps)) {
            // Same verified-write contract as Slack: framework editors get
            // plain text and the panel stays open on failure. The sanitized
            // HTML rides along so a failed auto-insert stays manually
            // pastable with formatting intact.
            insertInFlight = true;
            try {
              const outcome = await insertText(msg.text);
              if (outcome.diagnostics) {
                postInsertResult(outcome.ok, outcome.diagnostics);
              }
              if (outcome.ok) closePanel();
              else postInsertFailed(msg.text, outcome.diagnostics, html);
            } finally {
              insertInFlight = false;
            }
            break;
          }
          const outcome = await insertText(msg.text, html);
          if (outcome.diagnostics) {
            postInsertResult(outcome.ok, outcome.diagnostics);
          }
          closePanel();
        } else {
          closePanel();
        }
        break;
      }
      case "close": {
        closePanel();
        break;
      }
    }
  }

  function handleRuntimeMessage(message: unknown): { ok: boolean } | undefined {
    const msg = message as { type?: string } | null;
    if (msg?.type === "TOGGLE_OVERLAY") {
      togglePanel();
      return { ok: true };
    }
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    detachReposition();
    window.removeEventListener("message", handleOverlayMessage);
    browser.runtime.onMessage.removeListener(handleRuntimeMessage);
    iframe?.remove();
    iframe = null;
    disconnectFieldObserver();
    clearSelectionHighlight();
    activeField = null;
    highlightBox = null;
    capturedRange = null;
    capturedText = "";
    capturedPills = [];
    capturedHtml = null;
    capturedHasFormatting = false;
    capturedMultiline = false;
    fullscreenPinned = false;
    delete window.__jotHost;
  }

  // Wire up and open immediately - injection only ever happens because the
  // user invoked Jot on this tab.
  window.addEventListener("message", handleOverlayMessage);
  browser.runtime.onMessage.addListener(handleRuntimeMessage);

  const controller: HostController = {
    toggle: togglePanel,
    destroy,
  };
  openPanel();
  return controller;
}
