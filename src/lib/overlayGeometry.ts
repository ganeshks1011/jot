/**
 * Pure overlay positioning helpers (tested; used by the injected host
 * controller). The overlay opens small near the composer, grows with the
 * rewritten text, and scales to a centered near-fullscreen card past a
 * third of the viewport. No modal mode: the page stays interactive.
 */

export const OVERLAY_PADDING = 8;
/** Document padding inside the overlay iframe (shadow/glow room). */
export const IFRAME_MARGIN = 12;
/** Fullscreen card width (fixed, viewport-clamped). */
export const FULLSCREEN_CARD_WIDTH = 880;
/** Viewport margin around the fullscreen card. */
export const FULLSCREEN_MARGIN = 16;
/** Compact pre-content card width: the loader opens small even on wide composers. */
export const COMPACT_CARD_WIDTH = 480;
/** Floor keeping selection-anchored cards readable (never narrower). */
export const TEXT_ANCHORED_MIN_WIDTH = 360;
/** Unanchored float panel shares a fixed detached width. */
export const FLOAT_CARD_WIDTH = 800;

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

/** Live selected-text rect (viewport coords). Null when nothing usable. */
export interface TextSelectionRect {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

/**
 * Effective anchor for geometry: the selected text when usable, else the
 * container box. Card hugs the words (floored for readability, capped at
 * the container and the fullscreen width) and centers on the selection;
 * budgets and the connector follow automatically downstream.
 */
export function synthesizeAnchor(
  box: AnchorRect,
  sel: TextSelectionRect | null,
  compact: boolean,
): AnchorRect {
  const usable =
    sel && sel.width > 0 && sel.bottom > sel.top ? sel : null;
  const boxed = Math.min(box.width, FULLSCREEN_CARD_WIDTH);
  const centerX = usable ? usable.left + usable.width / 2 : box.left + box.width / 2;
  let cardW = boxed;
  if (usable) cardW = Math.min(boxed, Math.max(TEXT_ANCHORED_MIN_WIDTH, Math.min(usable.width, boxed)));
  if (compact) cardW = Math.min(cardW, COMPACT_CARD_WIDTH);
  return {
    left: centerX - cardW / 2,
    top: usable ? usable.top : box.top,
    bottom: usable ? usable.bottom : box.bottom,
    width: cardW,
  };
}

export type OverlayPlacement = "above" | "below" | "float" | "fullscreen";

export interface OverlayGeometry {
  /** Iframe width: card width plus document margin on both sides. */
  frameWidth: number;
  /** Card width: exactly the composer's width. */
  cardWidth: number;
  /** Card left edge (viewport coords). */
  left: number;
  /** Card top edge (viewport coords). */
  top: number;
  /** Card height for fullscreen (null = host sizes the iframe to content). */
  cardHeight: number | null;
  placement: OverlayPlacement;
}

export function resolveOverlayGeometry(
  viewport: ViewportSize,
  anchor: AnchorRect | null,
  height: number,
  compact = false,
): OverlayGeometry {
  // Near-fullscreen fallback: content taller than a third of the viewport
  // can no longer sit beside the composer. Scale the same card up to a
  // centered near-fullscreen surface (shrink-wrapped iframe, no backdrop,
  // page stays interactive) instead of squeezing above/below.
  if (shouldUseFullscreen(viewport, height)) {
    const cardWidth = Math.min(FULLSCREEN_CARD_WIDTH, viewport.width - FULLSCREEN_MARGIN * 2);
    const cardHeight = Math.min(height, viewport.height - FULLSCREEN_MARGIN * 2);
    return {
      frameWidth: cardWidth + IFRAME_MARGIN * 2,
      cardWidth,
      left: Math.max(OVERLAY_PADDING, Math.round((viewport.width - cardWidth) / 2)),
      top: Math.max(OVERLAY_PADDING, Math.round((viewport.height - cardHeight) / 2)),
      cardHeight,
      placement: "fullscreen",
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
      cardHeight: null,
      placement: "float",
    };
  }

  const cardWidth = compact ? Math.min(anchor.width, COMPACT_CARD_WIDTH) : anchor.width;
  const frameWidth = cardWidth + IFRAME_MARGIN * 2;
  // Full-width cards align to the composer edge; compact cards center on
  // the anchor box so the loader hugs the field instead of spanning it.
  const anchorLeft = compact ? anchor.left + (anchor.width - cardWidth) / 2 : anchor.left;
  const left = Math.max(OVERLAY_PADDING, Math.min(anchorLeft, viewport.width - cardWidth - OVERLAY_PADDING));
  // Zero gap: the card edge touches the composer edge so the two read as one
  // connected surface (the connector diamond straddles the seam).
  const below = anchor.bottom;
  const above = anchor.top - height;
  const fitsBelow = below + height <= viewport.height;
  const placement: OverlayPlacement = fitsBelow || above < OVERLAY_PADDING ? "below" : "above";
  const top = placement === "below" ? below : Math.max(above, OVERLAY_PADDING);
  return { frameWidth, cardWidth, left, top, cardHeight: null, placement };
}

/** True when panel content exceeds a third of the viewport height. */
export function shouldUseFullscreen(viewport: ViewportSize, height: number): boolean {
  if (viewport.height <= 0) return false;
  return height > viewport.height / 3;
}

/** Floor keeping the result box usable when space is tight. */
export const MIN_CONTENT_HEIGHT = 96;

/**
 * Panel-level height budget: how tall the card may grow. Grow-first policy:
 * the budget derives from the viewport rather than the free space beside
 * the anchor, so the panel overlaps page content instead of scrolling
 * internally while viewport space sits unused. Placement still docks to
 * the side with room (decided from uncapped content height); the budget
 * only binds near viewport exhaustion. Null when the viewport itself is
 * unusable; callers fall back to their default cap.
 */
export function resolveMaxPanelHeight(viewport: ViewportSize, placement: OverlayPlacement): number | null {
  if (viewport.height <= 0) return null;
  if (placement === "fullscreen") {
    return Math.max(MIN_CONTENT_HEIGHT, viewport.height - FULLSCREEN_MARGIN * 2);
  }
  return Math.max(MIN_CONTENT_HEIGHT, viewport.height - OVERLAY_PADDING * 2 - IFRAME_MARGIN);
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

/**
 * True when a painted background is dark (luminance below midpoint), false
 * when light, null when unparsable. The host uses it to pick a neutral
 * shadow color (white on dark pages, black on light pages).
 */
export function isDarkBackground(color: string): boolean | null {
  const c = color.trim().toLowerCase();
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(c);
  let r: number;
  let g: number;
  let b: number;
  if (rgba) {
    if (rgba[4] !== undefined && Number(rgba[4]) <= 0) return null;
    r = Number(rgba[1]);
    g = Number(rgba[2]);
    b = Number(rgba[3]);
  } else {
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c);
    if (!hex) return null;
    const h = hex[1] ?? "";
    const full = h.length === 3 ? h.replace(/./g, "$&$&") : h;
    r = Number.parseInt(full.slice(0, 2), 16);
    g = Number.parseInt(full.slice(2, 4), 16);
    b = Number.parseInt(full.slice(4, 6), 16);
  }
  if (![r, g, b].every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) return null;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
}
