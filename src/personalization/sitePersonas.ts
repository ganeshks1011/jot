/**
 * Built-in website personalities - single source of truth.
 *
 * Shared by the Jot extension and the Wurkflo web app
 * (`@wurkflo/shared`). These are defaults, never user data: they are not
 * written to persistent storage and always stay updatable here in one place. A user's own
 * per-site prompt (jot:sitePrompts) takes priority; deleting that override
 * falls back to the built-in default below. Applied as a safety-net fallback
 * during personalization resolution (see personalization/resolve.ts).
 */

export interface BuiltinSitePersona {
  id: "facebook" | "x" | "reddit" | "linkedin";
  label: string;
  /** Hostname match patterns (subdomains included). First entry is canonical. */
  hostnames: string[];
  prompt: string;
}

/**
 * Appended to every built-in website personality prompt.
 */
export const GLOBAL_CHARACTER_RULE =
  "Only use characters that a normal user could reasonably type from a standard keyboard. Do not add AI-style special characters, decorative symbols, em dashes, smart quotes, or other unusual Unicode characters.";

export const BUILTIN_SITE_PERSONAS: BuiltinSitePersona[] = [
  {
    id: "facebook",
    label: "Facebook",
    hostnames: ["facebook.com"],
    prompt:
      "Write naturally for Facebook. Keep the tone friendly, conversational, and personal. Preserve the user's personality and opinions. Avoid sounding overly polished, corporate, or like marketing copy. Keep it easy to read and appropriate for a broad social audience. Don't add hashtags, emojis, or extra context unless they are already present or clearly requested. Prefer natural sentences over overly structured formatting, but preserve any paragraphs, lists, or formatting the user already used.",
  },
  {
    id: "x",
    label: "X",
    hostnames: ["x.com", "twitter.com"],
    prompt:
      "Write naturally for X. Be concise, direct, conversational, and easy to scan. Preserve the user's personality, opinions, and sense of humor. Remove unnecessary words without changing the meaning. Avoid corporate or overly polished language. Don't add hashtags, emojis, or engagement bait unless they are already present or clearly requested. Keep the writing punchy without making it sound like a marketing post.",
  },
  {
    id: "reddit",
    label: "Reddit",
    hostnames: ["reddit.com"],
    prompt:
      "Write naturally for Reddit. Keep the tone conversational, direct, and authentic. Preserve the user's personality, opinions, and level of confidence. Avoid corporate language, marketing-speak, excessive polish, and generic AI phrasing. Don't add unnecessary headings, hashtags, emojis, or calls to action beyond what is already present. Write like a real Reddit user participating in the conversation. Don't make the response more authoritative than the original.",
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    hostnames: ["linkedin.com"],
    prompt:
      "Write naturally for LinkedIn. Keep the tone professional, confident, and conversational without sounding corporate or overly polished. Preserve the user's personality and original point of view. Make the writing clear and easy to scan. Avoid generic motivational language, buzzwords, exaggerated claims, and obvious engagement bait. Don't add hashtags, emojis, or calls to action unless they are already present or clearly requested.",
  },
];

/**
 * Match a hostname against a configured pattern. `example.com` matches itself
 * and its subdomains; `*.example.com` matches subdomains only.
 */
export function matchesSite(pattern: string, hostname: string): boolean {
  const p = pattern
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "");
  const host = hostname.trim().toLowerCase();
  if (!p) return false;
  if (p.startsWith("*.")) {
    const rest = p.slice(2);
    return host === rest || host.endsWith(`.${rest}`);
  }
  return host === p || host.endsWith(`.${p}`);
}

/** The built-in persona matching this hostname, if any. */
export function findBuiltinPersona(site?: string): BuiltinSitePersona | null {
  if (!site?.trim()) return null;
  return BUILTIN_SITE_PERSONAS.find((p) => p.hostnames.some((h) => matchesSite(h, site))) ?? null;
}

/** Full instruction for a built-in persona: its prompt + the character rule. */
export function buildPersonaPrompt(persona: BuiltinSitePersona): string {
  return `${persona.prompt}\n\n${GLOBAL_CHARACTER_RULE}`;
}
