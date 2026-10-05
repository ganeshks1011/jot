/** Single source for the codevu backend origin (the built-in Jot rewrite service). */
export const CODEVU_ORIGIN: string =
  (import.meta.env.VITE_CODEVU_ORIGIN as string | undefined) || "https://codevu.com";
