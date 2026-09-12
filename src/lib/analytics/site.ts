import type { EditorType, SiteLabel } from "./types";

/**
 * Reduce a hostname to a coarse, non-identifying site label. Raw hostnames
 * must never leave the device (e.g. `acme.slack.com` names a workspace).
 * Unknown hosts map to "other". Never invent labels from user data.
 */
const SITE_TABLE: Array<{ label: Exclude<SiteLabel, "other">; domains: string[] }> = [
  { label: "gmail", domains: ["mail.google.com", "gmail.com"] },
  { label: "outlook", domains: ["outlook.live.com", "outlook.com", "hotmail.com", "live.com"] },
  { label: "yahoo", domains: ["mail.yahoo.com", "yahoo.com"] },
  { label: "slack", domains: ["slack.com"] },
  { label: "linkedin", domains: ["linkedin.com"] },
  { label: "x", domains: ["x.com", "twitter.com"] },
  { label: "facebook", domains: ["facebook.com"] },
  { label: "reddit", domains: ["reddit.com"] },
];

export function siteLabelFor(hostname?: string | null): SiteLabel {
  const host = (hostname ?? "").trim().toLowerCase().split(":")[0] ?? "";
  if (!host) return "other";
  for (const { label, domains } of SITE_TABLE) {
    for (const d of domains) {
      if (host === d || host.endsWith(`.${d}`)) return label;
    }
  }
  return "other";
}

/** Map jot-host fieldType values to the coarse editor vocabulary. */
export function editorTypeFor(fieldType?: string | null): EditorType {
  switch ((fieldType ?? "").trim().toLowerCase()) {
    case "textarea":
      return "textarea";
    case "input":
      return "input";
    case "contenteditable":
      return "richtext";
    case "selection":
      return "selection";
    default:
      return "unknown";
  }
}
