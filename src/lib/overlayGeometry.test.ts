import { describe, expect, it } from "vitest";
import {
  COMPACT_CARD_WIDTH,
  estimatePanelHeight,
  FLOAT_CARD_WIDTH,
  isDarkBackground,
  isTransparentBackground,
  MODAL_CARD_WIDTH,
  pickOpaqueBackground,
  resolveMaxPanelHeight,
  resolveOverlayGeometry,
  shouldPrePromptModal,
  shouldUseCenterModal,
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

  it("trips the center modal when content exceeds a viewport third", () => {
    // 900px viewport → third is 300; 301 trips even with room below.
    const g = resolveOverlayGeometry(viewport, { left: 200, top: 300, bottom: 340, width: 560 }, 301);
    expect(g.placement).toBe("center");
    expect(g.cardWidth).toBe(MODAL_CARD_WIDTH);
    expect(g.left).toBe(0);
    expect(g.top).toBe(0);
    expect(g.frameWidth).toBe(1440);
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
    expect(g.placement).toBe("center");
    expect(g.top).toBe(0);
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
    const modal = resolveOverlayGeometry(narrow, { left: 0, top: 100, bottom: 140, width: 360 }, 400);
    expect(modal.placement).toBe("center");
    expect(modal.cardWidth).toBe(400 - 16);
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

  it("budgets free space below the composer", () => {
    expect(resolveMaxPanelHeight(viewport, { left: 200, top: 300, bottom: 340, width: 560 }, "below")).toBe(
      900 - 340 - 8,
    );
  });

  it("budgets space above the composer", () => {
    expect(resolveMaxPanelHeight(viewport, { left: 200, top: 700, bottom: 740, width: 560 }, "above")).toBe(700 - 20);
  });

  it("returns null without an anchor", () => {
    expect(resolveMaxPanelHeight(viewport, null, "float")).toBeNull();
    expect(resolveMaxPanelHeight(viewport, { left: 200, top: 300, bottom: 340, width: 560 }, "float")).toBeNull();
  });

  it("budgets a viewport fraction for the center modal", () => {
    expect(resolveMaxPanelHeight(viewport, { left: 200, top: 300, bottom: 340, width: 560 }, "center")).toBe(
      Math.floor(900 * 0.8),
    );
  });
});

describe("shouldUseCenterModal", () => {
  const viewport = { width: 1440, height: 900 };

  it("trips above a viewport third, holds at exactly a third", () => {
    expect(shouldUseCenterModal(viewport, 301)).toBe(true);
    expect(shouldUseCenterModal(viewport, 300)).toBe(false);
    expect(shouldUseCenterModal(viewport, 160)).toBe(false);
  });
});

describe("estimatePanelHeight", () => {
  it("grows with lines and wraps long lines at the card width", () => {
    const short = estimatePanelHeight("hello", 800);
    const tall = estimatePanelHeight("one\ntwo\nthree\nfour\nfive\nsix", 800);
    expect(tall).toBeGreaterThan(short);
    const wrapped = estimatePanelHeight("x".repeat(300), 800);
    expect(wrapped).toBeGreaterThan(short);
  });

  it("charges formatted input an extra row of block overhead", () => {
    expect(estimatePanelHeight("hello", 800, true)).toBeGreaterThan(estimatePanelHeight("hello", 800, false));
  });

  it("keeps empty input small enough to stay anchored", () => {
    expect(estimatePanelHeight("", 800)).toBeLessThanOrEqual(300);
  });
});

describe("shouldPrePromptModal", () => {
  const viewport = { width: 1440, height: 900 };
  const roomy = { left: 200, top: 300, bottom: 340, width: 560 };

  it("stays anchored for short inputs with room to fit", () => {
    expect(shouldPrePromptModal(viewport, roomy, "hello", 560, false)).toBe(false);
  });

  it("goes modal before the prompt for long inputs", () => {
    const long = Array.from({ length: 12 }, (_, i) => `line ${i} of a long draft`).join("\n");
    expect(shouldPrePromptModal(viewport, roomy, long, 560, false)).toBe(true);
  });

  it("goes modal when the estimate fits on neither side", () => {
    // Tall viewport so the third-rule stays quiet (third = 400); a short
    // two-line input (estimate 225) still trips because both free spaces
    // (~192px) are smaller.
    const tallViewport = { width: 1440, height: 1200 };
    const squeezed = { left: 200, top: 200, bottom: 1000, width: 560 };
    expect(shouldPrePromptModal(tallViewport, squeezed, "one\ntwo", 560, false)).toBe(true);
    expect(
      shouldPrePromptModal(tallViewport, { left: 200, top: 300, bottom: 340, width: 560 }, "one\ntwo", 560, false),
    ).toBe(false);
  });

  it("judges float panels by the viewport rule only", () => {
    expect(shouldPrePromptModal(viewport, null, "hello", 800, false)).toBe(false);
    const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    expect(shouldPrePromptModal(viewport, null, long, 800, false)).toBe(true);
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
