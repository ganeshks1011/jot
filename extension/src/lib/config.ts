/** Single source for Wurkflo backend origin. Overridable via VITE_WURKFLO_ORIGIN for local QA. */
export const WURKFLO_ORIGIN: string =
  (import.meta.env.VITE_WURKFLO_ORIGIN as string | undefined) || "https://wurkflo.app";
