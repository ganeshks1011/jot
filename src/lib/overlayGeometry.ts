/**
 * Pure overlay positioning helpers (tested; used by the injected host
 * controller). The overlay matches the composer's exact width and anchors
 * directly above or below it, flipping when space requires.
 */

export const OVERLAY_PADDING = 8;
/** Document padding inside the overlay iframe (shadow/glow room). */
export const IFRAME_MARGIN = 12;
/** Centered modal card width (fixed, independent of composer width). */
export const MODAL_CARD_WIDTH = 800;
/** Unanchored float panel shares the detached 800px width. */
export const FLOAT_CARD_WIDTH = MODAL_CARD_WIDTH;
/** Fraction of the viewport height bounding the centered modal panel. */
export const MODAL_PANEL_FRACTION = 0.8;

export interface ViewportSize {
  width: number;
  height: number;
}

export interface AnchorRect {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

export type OverlayPlacement = "above" | "below" | "float" | "center";

export interface OverlayGeometry {
  /** Iframe width: card width plus document margin on both sides. */
  frameWidth: number;
  /** Card width: exactly the composer's width. */
  cardWidth: number;
  /** Card left edge (viewport coords). */
  left: number;
  /** Card top edge (viewport coords). */
  top: number;
  placement: OverlayPlacement;
}

export function resolveOverlayGeometry(
  viewport: ViewportSize,
  anchor: AnchorRect | null,
  height: number,
): OverlayGeometry {
  // Centered modal fallback: content taller than a third of the viewport
  // leaves too little room for a useful anchored panel. Detach into a
  // dimmed, centered modal instead of squeezing above/below the composer.
  if (shouldUseCenterModal(viewport, height)) {
    const cardWidth = Math.min(MODAL_CARD_WIDTH, viewport.width - OVERLAY_PADDING * 2);
    return {
      frameWidth: viewport.width,
      cardWidth,
      left: 0,
      top: 0,
      placement: "center",
    };
  }
  if (!anchor || anchor.width <= 0) {
    // No anchored field (plain selection): float near the top center.
    const cardWidth = Math.min(FLOAT_CARD_WIDTH, viewport.width - OVERLAY_PADDING * 2);
    return {
      frameWidth: cardWidth + IFRAME_MARGIN * 2,
      cardWidth,
      left: Math.max(OVERLAY_PADDING, Math.round((viewport.width - cardWidth) / 2)),
      top: Math.max(OVERLAY_PADDING, Math.round(viewport.height * 0.2)),
      placement: "float",
    };
  }

  const cardWidth = anchor.width;
  const frameWidth = cardWidth + IFRAME_MARGIN * 2;
  const left = Math.max(OVERLAY_PADDING, Math.min(anchor.left, viewport.width - cardWidth - OVERLAY_PADDING));
  // Zero gap: the card edge touches the composer edge so the two read as one
  // connected surface (the connector diamond straddles the seam).
  const below = anchor.bottom;
  const above = anchor.top - height;
  const fitsBelow = below + height <= viewport.height;
  const placement: OverlayPlacement = fitsBelow || above < OVERLAY_PADDING ? "below" : "above";
  const top = placement === "below" ? below : Math.max(above, OVERLAY_PADDING);
  return { frameWidth, cardWidth, left, top, placement };
}

/** True when panel content exceeds a third of the viewport height. */
export function shouldUseCenterModal(viewport: ViewportSize, height: number): boolean {
  if (viewport.height <= 0) return false;
  return height > viewport.height / 3;
}

/**
 * Pre-prompt panel height estimate from the captured input, so the
 * modal-vs-overlay decision happens before the rewrite streams back.
 *
 * Rows come from explicit line breaks wrapped at the card's usable width;
 * formatted (HTML) input costs one extra row of block overhead. One spare
 * row biases borderline inputs toward the modal, which degrades gracefully
 * (centered, scrollable) while a squeezed anchored panel does not.
 */
export const PANEL_CHROME_HEIGHT = 150;
export const RESULT_LINE_HEIGHT = 25;
const AVG_CHAR_WIDTH = 7;
const CONTENT_GUTTER = 32;

export function estimatePanelHeight(text: string, cardWidth: number, hasFormatting = false): number {
  const usable = Math.max(160, cardWidth - CONTENT_GUTTER);
  const charsPerLine = Math.max(20, Math.floor(usable / AVG_CHAR_WIDTH));
  let rows = 0;
  for (const line of text.split("\n")) {
    rows += Math.max(1, Math.ceil(line.length / charsPerLine));
  }
  rows += 1; // spare row: borderline inputs prefer the modal
  if (hasFormatting) rows += 1; // block-tag overhead
  return PANEL_CHROME_HEIGHT + rows * RESULT_LINE_HEIGHT;
}

/**
 * Pre-prompt modal decision: true when the estimated panel exceeds a third
 * of the viewport or fits on neither side of the anchor. Null anchor
 * (float) is judged by the viewport rule only. The anchored side itself
 * stays with resolveOverlayGeometry at runtime; this only pins the modal
 * early so the first paint is already centered. One-way: a false here
 * still allows the streaming resize path to trip the modal later.
 */
export function shouldPrePromptModal(
  viewport: ViewportSize,
  anchor: AnchorRect | null,
  text: string,
  cardWidth: number,
  hasFormatting = false,
): boolean {
  const estimate = estimatePanelHeight(text, cardWidth, hasFormatting);
  if (shouldUseCenterModal(viewport, estimate)) return true;
  if (!anchor || anchor.width <= 0) return false;
  const spaceAbove = anchor.top - OVERLAY_PADDING;
  const spaceBelow = viewport.height - anchor.bottom - OVERLAY_PADDING;
  return estimate > spaceAbove && estimate > spaceBelow;
}

/** Floor keeping the result box usable when space is tight. */
export const MIN_CONTENT_HEIGHT = 96;

/**
 * Panel-level height budget: how tall the card may grow while keeping the
 * composer visible (panel sits flush against it, so the budget is the free
 * space on the placement side minus a viewport margin). Null when floating
 * (no anchor). The overlay falls back to its default cap.
 */
export function resolveMaxPanelHeight(
  viewport: ViewportSize,
  anchor: AnchorRect | null,
  placement: OverlayPlacement,
): number | null {
  // Centered modal budget: a viewport fraction, independent of the anchor.
  // The card is detached, so free space above/below no longer applies.
  if (placement === "center") {
    return Math.max(MIN_CONTENT_HEIGHT, Math.floor(viewport.height * MODAL_PANEL_FRACTION));
  }
  if (!anchor || anchor.width <= 0 || placement === "float") return null;
  if (placement === "below") {
    return viewport.height - anchor.bottom - OVERLAY_PADDING;
  }
  return anchor.top - (OVERLAY_PADDING + IFRAME_MARGIN);
}

/** True when a CSS background carries no visible paint. */
export function isTransparentBackground(color: string): boolean {
  const c = color.trim().toLowerCase();
  if (!c || c === "transparent") return true;
  const rgba = /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*([\d.]+))?\s*\)$/.exec(c);
  if (rgba) return rgba[1] !== undefined && Number(rgba[1]) <= 0;
  if (/^#[0-9a-f]{8}$/.test(c)) return c.endsWith("00");
  return false;
}

/**
 * First painted background from self-outward (already resolved computed
 * values, `getComputedStyle` order). Returns null when everything is
 * transparent so callers fall back to theme surfaces.
 */
export function pickOpaqueBackground(colors: string[]): string | null {
  for (const color of colors) {
    if (!isTransparentBackground(color)) return color;
  }
  return null;
}
