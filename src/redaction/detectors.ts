import type { DetectedSpan, Detector, SensitiveDataType } from "./types";

/** Trailing chars that terminate a match but are never part of the value. */
function trimTrailing(value: string): string {
  return value.replace(/[.,;:!?'"*)}\]>]+$/, "");
}

function span(start: number, value: string): DetectedSpan {
  return { start, end: start + value.length, value };
}

function collectMatches(pattern: RegExp, text: string): DetectedSpan[] {
  const out: DetectedSpan[] = [];
  for (const m of text.matchAll(pattern)) {
    if (m.index === undefined || !m[0]) continue;
    const value = trimTrailing(m[0]);
    if (value) out.push(span(m.index, value));
  }
  return out;
}

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'`)\]]+/gi;

// \p{L} covers accented local parts (josé@…); domain stays ASCII
// (punycode in practice) to avoid matching prose around dots.
const EMAIL_PATTERN = /[\p{L}0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu;

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

const UUID_PATTERN = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_PATTERN = new RegExp(`\\b${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}\\b`, "g");
const IPV6_FULL_PATTERN = /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g;

const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

const CARD_CANDIDATE_PATTERN = /(?<!\d)(?:\d[ \-\u2013\u2014]?){13,19}(?!\d)/g;

const PHONE_PATTERN = /(?<!\d)(?:\+\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}(?!\d)/g;

// High-confidence secret prefixes (API keys, tokens, private keys).
const SECRET_PREFIX_PATTERN = new RegExp(
  [
    "sk-ant-[A-Za-z0-9-_]{8,}",
    "sk-[A-Za-z0-9-_]{8,}",
    "github_pat_[A-Za-z0-9_]{8,}",
    "gh[pousr]_[A-Za-z0-9_]{8,}",
    "xox[baprs]-[A-Za-z0-9-]{8,}",
    "AKIA[0-9A-Z]{16}",
    "AIza[0-9A-Za-z_-]{30,}",
    "glpat-[A-Za-z0-9-_]{8,}",
    "dop_v1_[A-Za-z0-9]{16,}",
    "ssh-(?:rsa|ed25519) [A-Za-z0-9+/=]+",
    "-----BEGIN [A-Z ]*PRIVATE KEY-----",
  ].join("|"),
  "g",
);

// Labeled assignments with a secret-looking value (no spaces, ≥12 chars).
// Conservative by design: "token of appreciation" has no colon; short
// values like "password: hunter2" are left alone.
const LABELED_SECRET_PATTERN =
  /(?:api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd)\s*[:=]\s*['"]?([A-Za-z0-9\-_./+]{12,})['"]?/gi;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const urlDetector: Detector = {
  type: "url",
  detect: (text) => collectMatches(URL_PATTERN, text),
};

const secretDetector: Detector = {
  type: "secret",
  detect: (text) => {
    const out = collectMatches(JWT_PATTERN, text);
    out.push(...collectMatches(SECRET_PREFIX_PATTERN, text));
    for (const m of text.matchAll(LABELED_SECRET_PATTERN)) {
      if (m.index === undefined || !m[1]) continue;
      const raw = m[0];
      const value = trimTrailing(m[1]);
      const offset = raw.indexOf(m[1]);
      if (value && offset >= 0) out.push(span(m.index + offset, value));
    }
    return out;
  },
};

const uuidDetector: Detector = {
  type: "uuid",
  detect: (text) => collectMatches(UUID_PATTERN, text),
};

const ipDetector: Detector = {
  type: "ip",
  detect: (text) => [...collectMatches(IPV4_PATTERN, text), ...collectMatches(IPV6_FULL_PATTERN, text)],
};

const ssnDetector: Detector = {
  type: "ssn",
  detect: (text) => {
    const out: DetectedSpan[] = [];
    for (const m of text.matchAll(SSN_PATTERN)) {
      if (m.index === undefined) continue;
      const area = m[0].slice(0, 3);
      // Reject obviously invalid areas (000, 666, 900-999).
      if (area === "000" || area === "666" || area[0] === "9") continue;
      out.push(span(m.index, m[0]));
    }
    return out;
  },
};

const cardDetector: Detector = {
  type: "card",
  detect: (text) => {
    const out: DetectedSpan[] = [];
    for (const m of text.matchAll(CARD_CANDIDATE_PATTERN)) {
      if (m.index === undefined) continue;
      // The candidate pattern consumes a trailing separator; strip it.
      const value = trimTrailing(m[0]).replace(/[ \-\u2013\u2014]+$/, "");
      const digits = value.replace(/\D/g, "");
      if (digits.length < 13 || digits.length > 19) continue;
      // Luhn filters out phone numbers, dates, and other digit runs.
      if (!luhnValid(digits)) continue;
      out.push(span(m.index, value));
    }
    return out;
  },
};

const emailDetector: Detector = {
  type: "email",
  detect: (text) => {
    const out: DetectedSpan[] = [];
    for (const m of text.matchAll(EMAIL_PATTERN)) {
      if (m.index === undefined || !m[0]) continue;
      // Skip addresses already claimed as part of a URL.
      if (m.index >= 7 && text.slice(m.index - 7, m.index).includes("://")) continue;
      if (m.index >= 4 && text.slice(m.index - 4, m.index).endsWith("://")) continue;
      const value = trimTrailing(m[0]);
      if (value) out.push(span(m.index, value));
    }
    return out;
  },
};

// Explicit @mention handles (chat apps, Slack). Conservative: the handle
// must start with a letter, must not be glued to a preceding word char
// (so `john@acme.com` never matches), and bare "@" with no handle is
// ignored ("email me @ noon"). Runs last so emails/URLs/secrets win.
const MENTION_PATTERN = /(?<![\p{L}\p{N}._%+-])@\p{L}[\p{L}0-9._-]*/gu;

const mentionDetector: Detector = {
  type: "mention",
  detect: (text) => collectMatches(MENTION_PATTERN, text),
};

/** Mention display labels in order of appearance (e.g. `["@Byte", "@Ada"]`).
 *  Shared with the Slack host controller so entity write-back can re-anchor
 *  pills using the exact same detection the redaction pipeline uses. */
export function detectMentionLabels(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_PATTERN)) {
    if (m.index === undefined || !m[0]) continue;
    const value = trimTrailing(m[0]);
    if (value) out.push(value);
  }
  return out;
}

const phoneDetector: Detector = {
  type: "phone",
  detect: (text) => {
    const out: DetectedSpan[] = [];
    for (const m of text.matchAll(PHONE_PATTERN)) {
      if (m.index === undefined || !m[0]) continue;
      const raw = m[0];
      // Bare digit runs are not phone numbers. Require a separator,
      // parentheses, or an explicit country code.
      if (!/[-.\s()]/.test(raw) && !raw.startsWith("+")) continue;
      const digits = raw.replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 15) continue;
      const value = trimTrailing(raw);
      if (value) out.push(span(m.index, value));
    }
    return out;
  },
};

/**
 * Priority order: earlier detectors win overlapping spans, so broad or
 * structural patterns (URL, secrets, UUID, IP) run before narrow numeric
 * ones (SSN, card, phone) that could match inside them.
 */
export const DETECTORS: Detector[] = [
  urlDetector,
  secretDetector,
  uuidDetector,
  ipDetector,
  ssnDetector,
  cardDetector,
  emailDetector,
  phoneDetector,
  mentionDetector,
];

export const DETECTOR_TYPES: SensitiveDataType[] = DETECTORS.map((d) => d.type);
