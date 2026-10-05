/**
 * Jot design tokens: the single source of truth for fonts, brand, and
 * shape shared by the web landing and the extension overlay/options.
 *
 * Colors live as CSS vars in styles.css (light-first with [data-theme]
 * overrides); this module mirrors the few values JS needs (storage keys,
 * font stacks, gradient strings) without touching the DOM.
 */

export const JOT_THEME_STORAGE_KEY = "jot:theme";
export const JOT_REDACTION_STORAGE_KEY = "jot:redactionEnabled";
export const JOT_STYLE_STORAGE_KEY = "jot:styleLevels";

export const JOT_FONT_SANS = '"Instrument Sans", ui-sans-serif, system-ui, sans-serif';
export const JOT_FONT_JOT = '"Poppins", ui-sans-serif, system-ui, sans-serif';

/** Red→violet brand extension. Soft by design: low alpha, wide blur. */
export const JOT_BRAND_GRADIENT = "linear-gradient(135deg, #7c3aed, #ef4444)";
export const JOT_BRAND_GRADIENT_DARK = "linear-gradient(135deg, #8b5cf6, #f87171)";

export const JOT_ACCENT = "oklch(0.6204 0.195 253.83)";
export const JOT_ACCENT_FOREGROUND = "oklch(0.99 0 0)";

export const JOT_RADIUS = "0.375rem";
export const JOT_CARD_SHADOW = "0 8px 30px rgb(0 0 0 / 0.18)";
