import { describe, expect, it } from "vitest";
import {
  COMPACT_CARD_WIDTH,
  FLOAT_CARD_WIDTH,
  FULLSCREEN_CARD_WIDTH,
  isDarkBackground,
  isTransparentBackground,
  pickOpaqueBackground,
  resolveMaxPanelHeight,
  resolveOverlayGeometry,
  shouldUseFullscreen,
  synthesizeAnchor,
  TEXT_ANCHORED_MIN_WIDTH,
} from "./overlayGeometry";

describe("resolveOverlayGeometry", () => {
  const viewport = { width: 1440, height: 900 };

  it("matches the composer width exactly with aligned left edge", () => {
    const g = resolveOverlayGeometry(viewport, { left: 200, top: 300, bottom: 340, width: 560 }, 300);
    expect(g.cardWidth).toBe(560);
    expect(g.frameWidth).toBe(560 + 24);
    expect(g.left).toBe(200);
    expect(g.placement).toBe("below");
    expect(g.top).toBe(340);
  });

  it("matches wide composers without clamping", () => {
    const g = resolveOverlayGeometry(viewport, { left: 100, top: 300, bottom: 360, width: 950 }, 300);
    expect(g.cardWidth).toBe(950);
    expect(g.left).toBe(100);
  });

  it("flips above when there is no room below", () => {
    const g = resolveOverlayGeometry(viewport, { left: 200, top: 700, bottom: 740, width: 560 }, 300);
    expect(g.placement).toBe("above");
    expect(g.top).toBe(700 - 300);
  });

  it("scales to fullscreen when content exceeds a viewport third", () => {
    // 900px viewport → third is 300; 301 trips even with room below.
    const g = resolveOverlayGeometry(viewport, { left: 200, top: 300, bottom: 340, width: 560 }, 301);
    expect(g.placement).toBe("fullscreen");
    expect(g.cardWidth).toBe(FULLSCREEN_CARD_WIDTH);
    expect(g.cardHeight).toBe(301);
    expect(g.left).toBe(Math.round((1440 - FULLSCREEN_CARD_WIDTH) / 2));
    expect(g.top).toBe(Math.round((900 - 301) / 2));
    expect(g.frameWidth).toBe(FULLSCREEN_CARD_WIDTH + 24);
  });

  it("stays anchored at exactly a viewport third", () => {
    const g = resolveOverlayGeometry(viewport, { left: 200, top: 300, bottom: 340, width: 560 }, 300);
    expect(g.placement).toBe("below");
  });

  it("opens compact centered on wide composers", () => {
    const g = resolveOverlayGeometry(viewport, { left: 200, top: 300, bottom: 340, width: 900 }, 120, true);
    expect(g.cardWidth).toBe(COMPACT_CARD_WIDTH);
    expect(g.left).toBe(200 + (900 - COMPACT_CARD_WIDTH) / 2);
    expect(g.placement).toBe("below");
  });

  it("never widens narrow fields in compact mode", () => {
    const g = resolveOverlayGeometry(viewport, { left: 200, top: 300, bottom: 340, width: 300 }, 120, true);
    expect(g.cardWidth).toBe(300);
    expect(g.left).toBe(200);
  });

  it("clamps compact cards at the viewport edge", () => {
    const g = resolveOverlayGeometry(viewport, { left: 1100, top: 300, bottom: 340, width: 500 }, 120, true);
    expect(g.cardWidth).toBe(COMPACT_CARD_WIDTH);
    expect(g.left).toBe(1440 - COMPACT_CARD_WIDTH - 8);
  });

  it("centers tall content even when neither side fits", () => {
    const g = resolveOverlayGeometry(viewport, { left: 200, top: 100, bottom: 140, width: 560 }, 900);
    expect(g.placement).toBe("fullscreen");
    expect(g.cardHeight).toBe(900 - 32);
    expect(g.top).toBe(Math.round((900 - (900 - 32)) / 2));
  });

  it("clamps position at the viewport edge", () => {
    const g = resolveOverlayGeometry(viewport, { left: 1300, top: 300, bottom: 340, width: 560 }, 300);
    expect(g.left).toBe(1440 - 560 - 8);
  });

  it("floats centered without an anchor", () => {
    const g = resolveOverlayGeometry(viewport, null, 300);
    expect(g.placement).toBe("float");
    expect(g.cardWidth).toBe(FLOAT_CARD_WIDTH);
    expect(g.cardWidth).toBe(800);
    expect(g.left).toBe(Math.round((1440 - 800) / 2));
  });

  it("clamps the detached widths on narrow viewports", () => {
    const narrow = { width: 400, height: 900 };
    const full = resolveOverlayGeometry(narrow, { left: 0, top: 100, bottom: 140, width: 360 }, 400);
    expect(full.placement).toBe("fullscreen");
    expect(full.cardWidth).toBe(400 - 32);
    const float = resolveOverlayGeometry(narrow, null, 100);
    expect(float.cardWidth).toBe(400 - 16);
  });
});

describe("isTransparentBackground", () => {
  it("detects transparent values", () => {
    expect(isTransparentBackground("transparent")).toBe(true);
    expect(isTransparentBackground("rgba(0, 0, 0, 0)")).toBe(true);
    expect(isTransparentBackground("rgba(255,255,255,0)")).toBe(true);
    expect(isTransparentBackground("#ffffff00")).toBe(true);
    expect(isTransparentBackground("")).toBe(true);
  });

  it("accepts painted values", () => {
    expect(isTransparentBackground("rgb(255, 255, 255)")).toBe(false);
    expect(isTransparentBackground("rgba(255, 255, 255, 1)")).toBe(false);
    expect(isTransparentBackground("#ffffff")).toBe(false);
    expect(isTransparentBackground("#ffffffff")).toBe(false);
    expect(isTransparentBackground("white")).toBe(false);
  });
});

describe("resolveMaxPanelHeight", () => {
  const viewport = { width: 1440, height: 900 };

  it("budgets near-viewport height for anchored placements", () => {
    expect(resolveMaxPanelHeight(viewport, "below")).toBe(900 - 16 - 12);
    expect(resolveMaxPanelHeight(viewport, "above")).toBe(900 - 16 - 12);
  });

  it("budgets near-viewport height when floating", () => {
    expect(resolveMaxPanelHeight(viewport, "float")).toBe(900 - 16 - 12);
  });

  it("budgets viewport minus margin for fullscreen", () => {
    expect(resolveMaxPanelHeight(viewport, "fullscreen")).toBe(900 - 32);
  });

  it("returns null for unusable viewports", () => {
    expect(resolveMaxPanelHeight({ width: 1440, height: 0 }, "below")).toBeNull();
  });
});

describe("shouldUseFullscreen", () => {
  const viewport = { width: 1440, height: 900 };

  it("trips above a viewport third, holds at exactly a third", () => {
    expect(shouldUseFullscreen(viewport, 301)).toBe(true);
    expect(shouldUseFullscreen(viewport, 300)).toBe(false);
    expect(shouldUseFullscreen(viewport, 160)).toBe(false);
  });
});

describe("pickOpaqueBackground", () => {
  it("returns the first painted background", () => {
    expect(pickOpaqueBackground(["rgba(0, 0, 0, 0)", "transparent", "rgb(30, 30, 30)"])).toBe("rgb(30, 30, 30)");
  });

  it("returns null when everything is transparent", () => {
    expect(pickOpaqueBackground(["transparent", "rgba(0,0,0,0)"])).toBeNull();
  });
});

describe("isDarkBackground", () => {
  it("classifies rgb black and white", () => {
    expect(isDarkBackground("rgb(0, 0, 0)")).toBe(true);
    expect(isDarkBackground("rgb(255, 255, 255)")).toBe(false);
  });

  it("classifies hex short and long forms", () => {
    expect(isDarkBackground("#000")).toBe(true);
    expect(isDarkBackground("#fff")).toBe(false);
    expect(isDarkBackground("#1e3a5f")).toBe(true);
    expect(isDarkBackground("#f5f5f5")).toBe(false);
  });

  it("returns null for transparent or unparsable input", () => {
    expect(isDarkBackground("transparent")).toBeNull();
    expect(isDarkBackground("rgba(0, 0, 0, 0)")).toBeNull();
    expect(isDarkBackground("CanvasText")).toBeNull();
    expect(isDarkBackground("")).toBeNull();
  });
});

describe("synthesizeAnchor", () => {
  const box = { left: 100, top: 300, bottom: 420, width: 1000 };

  it("hugs a narrow selection with the readability floor", () => {
    const sel = { left: 400, top: 330, bottom: 350, width: 80 };
    const a = synthesizeAnchor(box, sel, false);
    expect(a.width).toBe(TEXT_ANCHORED_MIN_WIDTH);
    expect(a.left).toBe(440 - TEXT_ANCHORED_MIN_WIDTH / 2);
    expect(a.top).toBe(330);
    expect(a.bottom).toBe(350);
  });

  it("follows a wide selection up to the box width", () => {
    const sel = { left: 150, top: 330, bottom: 350, width: 600 };
    const a = synthesizeAnchor(box, sel, false);
    expect(a.width).toBe(600);
    expect(a.left).toBe(150);
  });

  it("caps the card at the fullscreen width on huge containers", () => {
    const huge = { left: 0, top: 300, bottom: 420, width: 2000 };
    expect(synthesizeAnchor(huge, null, false).width).toBe(FULLSCREEN_CARD_WIDTH);
    const sel = { left: 500, top: 330, bottom: 350, width: 1500 };
    expect(synthesizeAnchor(huge, sel, false).width).toBe(FULLSCREEN_CARD_WIDTH);
  });

  it("never narrows below a small container", () => {
    const small = { left: 100, top: 300, bottom: 360, width: 200 };
    const sel = { left: 120, top: 310, bottom: 330, width: 40 };
    expect(synthesizeAnchor(small, sel, false).width).toBe(200);
  });

  it("centers compact cards on the selection", () => {
    const sel = { left: 700, top: 330, bottom: 350, width: 80 };
    const a = synthesizeAnchor(box, sel, true);
    expect(a.width).toBe(TEXT_ANCHORED_MIN_WIDTH);
    expect(a.left).toBe(740 - TEXT_ANCHORED_MIN_WIDTH / 2);
  });

  it("falls back to the box for absent or collapsed selections", () => {
    const a = synthesizeAnchor(box, null, false);
    expect(a.width).toBe(FULLSCREEN_CARD_WIDTH);
    expect(a.left).toBe(600 - FULLSCREEN_CARD_WIDTH / 2);
    expect(a.top).toBe(300);
    expect(a.bottom).toBe(420);
    const collapsed = { left: 400, top: 330, bottom: 330, width: 0 };
    expect(synthesizeAnchor(box, collapsed, false)).toEqual(a);
  });
});
