import type { RewriteErrorShape } from "./adapter";

/** Human message per error kind. Pure; shared by every host surface. */
export function errorMessage(err: RewriteErrorShape): string {
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

/** "via exec · composer textarea · before 12 → after 40 chars…" */
export function describeInsertMetrics(m: {
  strategy?: "exec" | "beforeinput" | "entity" | null;
  tag?: string | null;
  preLen?: number | null;
  postLen?: number | null;
  expectedLen?: number | null;
  attempts?: number | null;
}): string {
  return (
    `via ${m.strategy ?? "?"} · composer ${m.tag ?? "?"} · ` +
    `before ${m.preLen ?? "?"} → after ${m.postLen ?? "?"} chars ` +
    `(expected ${m.expectedLen ?? "?"}) · ${m.attempts ?? "?"} attempts`
  );
}
