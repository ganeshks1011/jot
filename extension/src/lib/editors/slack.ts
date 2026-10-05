/**
 * Slack-specific write-back. Slack re-renders its composer while the overlay
 * is open, so the range cloned at capture time may point at detached nodes;
 * and its editor model only accepts edits delivered as real editing input.
 *
 * Rules for this module:
 * - Never assign innerHTML / innerText / textContent / value (reads only).
 * - Never use Slack-specific DOM selectors. Resolution is purely
 *   `activeField` (if still connected) falling back to `activeElement`,
 *   then climbed to the outermost editable ancestor (focus often lands on
 *   a nested node such as a mention pill).
 * - Verify every write by reading back; retry with fresh resolution,
 *   then report failure.
 */

export interface EditableElement {
  isConnected: boolean;
  isContentEditable: boolean;
  tagName?: string;
  type?: string;
  parentElement?: EditableElement | null;
  focus: () => void;
  dispatchEvent: (event: Event) => boolean;
  innerText?: string;
  value?: string;
}

export interface SelectionLike {
  selectAllChildren: (node: unknown) => void;
}

export interface SlackDeps {
  activeField: EditableElement | null;
  activeElement: EditableElement | null;
  getSelection: () => SelectionLike | null;
  execCommand: (command: string, showUI: boolean, value: string) => boolean;
  createInputEvent: () => Event;
  /** Optional: some editors only honor a trusted-style beforeinput. */
  createBeforeInputEvent?: (text: string) => Event;
}

/**
 * Text-free diagnostics for a write attempt. Lengths and tag names only.
 * Never message content, so they are safe to log and report.
 */
export interface SlackWriteDiagnostics {
  /** Strategy that verified, or null when nothing verified. */
  strategy: "exec" | "beforeinput" | "entity" | null;
  /** Tag of the resolved composer root, if any. */
  tag: string | null;
  /** Composer text length before the first attempt. */
  preLen: number;
  /** Composer text length at the final read-back. */
  postLen: number;
  /** Expected text length. */
  expectedLen: number;
  /** Number of write attempts made. */
  attempts: number;
}

export interface SlackReplaceResult {
  ok: boolean;
  readBack: string;
  diagnostics: SlackWriteDiagnostics;
}

/**
 * A mention entity captured from the live composer: Slack user identity plus
 * the display label. Identity comes from the pill node (`data-id`); the
 * label is what the rewrite text contains.
 */
export interface MentionEntity {
  id: string;
  label: string;
}

export interface MentionSlot {
  label: string;
  entity: MentionEntity;
}

export type MentionRun = { kind: "text"; text: string } | { kind: "mention"; slot: MentionSlot };

/**
 * Validate final-text mention labels against the captured entities. Every
 * captured label must appear exactly as often (moved mentions are fine.
 * order may differ); unknown, removed, or duplicated labels fail. Returns
 * entities ordered to match the final text for rebuild.
 */
export function alignMentionEntities(
  finalLabels: string[],
  captured: MentionEntity[],
): { ok: boolean; ordered: MentionEntity[] } {
  if (finalLabels.length !== captured.length) return { ok: false, ordered: [] };
  const pools = new Map<string, MentionEntity[]>();
  for (const e of captured) {
    const q = pools.get(e.label);
    if (q) q.push(e);
    else pools.set(e.label, [e]);
  }
  const ordered: MentionEntity[] = [];
  for (const label of finalLabels) {
    const q = pools.get(label);
    const next = q?.shift();
    if (!next) return { ok: false, ordered: [] };
    ordered.push(next);
  }
  return { ok: true, ordered };
}

/**
 * Split text into text runs and mention slots, following the given label
 * order (as produced by `detectMentionLabels` on the same text, so every
 * occurrence is found in sequence).
 */
export function splitMentionRuns(text: string, slots: MentionSlot[]): MentionRun[] {
  const runs: MentionRun[] = [];
  let cursor = 0;
  for (const slot of slots) {
    const at = text.indexOf(slot.label, cursor);
    if (at < 0) continue; // Unreachable post-validation; skip defensively.
    if (at > cursor) runs.push({ kind: "text", text: text.slice(cursor, at) });
    runs.push({ kind: "mention", slot });
    cursor = at + slot.label.length;
  }
  if (cursor < text.length) runs.push({ kind: "text", text: text.slice(cursor) });
  return runs;
}

export function isSlackComposer(hostname: string): boolean {
  return hostname === "slack.com" || hostname.endsWith(".slack.com");
}

export function isEditableTarget(el: EditableElement | null): el is EditableElement {
  if (!el) return false;
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    return ["text", "search", "url", "email", "tel"].includes((el.type ?? "text").toLowerCase());
  }
  return el.isContentEditable === true;
}

/** Re-resolve the live composer: preferred element if still attached,
 *  otherwise whatever editable currently has focus. Reads focus exactly
 *  once. The live getter may return a different element per read. */
export function resolveLiveComposer(deps: SlackDeps): EditableElement | null {
  if (deps.activeField?.isConnected && isEditableTarget(deps.activeField)) {
    return deps.activeField;
  }
  const focused = deps.activeElement;
  if (isEditableTarget(focused)) return focused;
  return null;
}

/** Read-back for verification only. Never used to write. */
export function readComposerText(composer: EditableElement): string {
  if (composer.isContentEditable) return composer.innerText ?? "";
  return composer.value ?? "";
}

function normalize(text: string): string {
  // Strip zero-width/format chars too: editors re-rendering a mention pill
  // around the replaced text can introduce them.
  return text
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Shared normalizer for host-side verification and diagnostics. */
export { normalize as normalizeComposerText };

/**
 * Newline-aware composer normalizer: strips zero-width chars, collapses
 * horizontal whitespace per line, preserves line breaks and paragraph gaps.
 * Single-line inputs normalize identically to `normalizeComposerText`.
 */
export function normalizeComposerMultiline(text: string): string {
  const stripped = text.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
  const lines = stripped
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\u00A0\u202F]+/g, " ").trim());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/**
 * Split mention/text runs at line breaks into per-block run lists for
 * multi-paragraph rebuilds. Mention runs never contain newlines, so they
 * stay atomic; text runs split and empty lines become empty blocks.
 */
export function splitRunsByLines(runs: MentionRun[]): MentionRun[][] {
  const blocks: MentionRun[][] = [[]];
  const pushText = (text: string): void => {
    const parts = text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) blocks.push([]);
      if (part) blocks[blocks.length - 1]!.push({ kind: "text", text: part });
    });
  };
  for (const run of runs) {
    if (run.kind === "mention") {
      blocks[blocks.length - 1]!.push(run);
    } else {
      pushText(run.text);
    }
  }
  return blocks;
}

/**
 * Climb from a focused node to the outermost editable ancestor (the actual
 * composer root). Focus often lands on a nested node (e.g. a mention pill,
 * which inherits `isContentEditable`. Selecting only that node would
 * replace part of the draft instead of the whole composer.
 */
export function outermostEditable(start: EditableElement): EditableElement {
  let node = start;
  for (let guard = 0; guard < 25; guard++) {
    const parent = node.parentElement;
    if (!parent || parent === node) break;
    const tag = typeof parent.tagName === "string" ? parent.tagName.toUpperCase() : "";
    if (tag === "BODY" || tag === "HTML" || tag === "") break;
    if (parent.isContentEditable !== true) break;
    node = parent;
  }
  return node;
}

/** Verified read-back, or null. Accepts an exact match or the expected text
 *  contained in the composer (editors may wrap replacements in formatting).
 *  Newline-aware: multiline rewrites verify with line breaks intact. Shared
 *  with the framework-agnostic path in `./richText`. */
export function verifiedRead(composer: EditableElement, text: string): { ok: boolean; readBack: string } {
  const readBack = readComposerText(composer);
  const expected = normalizeComposerMultiline(text);
  if (!expected) return { ok: false, readBack };
  const actual = normalizeComposerMultiline(readBack);
  return { ok: actual === expected || actual.includes(expected), readBack };
}

/** Select-all + execCommand insertText + input event. Shared with `./richText`. */
export function tryExecInsert(composer: EditableElement, deps: SlackDeps, text: string): boolean {
  const sel = deps.getSelection();
  if (!sel) return false;
  try {
    sel.selectAllChildren(composer);
  } catch {
    return false;
  }
  let inserted = false;
  try {
    inserted = deps.execCommand("insertText", false, text);
  } catch {
    inserted = false;
  }
  try {
    composer.dispatchEvent(deps.createInputEvent());
  } catch {
    // Verification decides; a dispatch failure alone is not fatal.
  }
  return inserted;
}

/** Dispatch a trusted-style beforeinput for editors that only honor that path. Shared with `./richText`. */
export function tryBeforeInput(composer: EditableElement, deps: SlackDeps, text: string): boolean {
  if (!deps.createBeforeInputEvent) return false;
  try {
    composer.dispatchEvent(deps.createBeforeInputEvent(text));
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace the composer contents via real editing input and verify.
 * Retries with a fresh resolution; tries execCommand first, then a
 * beforeinput event for editors that only honor that path. Reports failure
 * instead of guessing.
 */
export function replaceSlackText(text: string, deps: SlackDeps): SlackReplaceResult {
  const expectedLen = normalizeComposerMultiline(text).length;
  const diag: SlackWriteDiagnostics = {
    strategy: null,
    tag: null,
    preLen: -1,
    postLen: -1,
    expectedLen,
    attempts: 0,
  };
  const fail = (readBack: string): SlackReplaceResult => {
    diag.postLen = normalizeComposerMultiline(readBack).length;
    return { ok: false, readBack, diagnostics: { ...diag } };
  };
  let lastReadBack = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const resolved = resolveLiveComposer(deps);
    if (!resolved) continue;
    const composer = outermostEditable(resolved);
    diag.tag = typeof composer.tagName === "string" ? composer.tagName.toUpperCase() : null;
    if (diag.preLen < 0) diag.preLen = normalizeComposerMultiline(readComposerText(composer)).length;
    try {
      composer.focus();
    } catch {
      continue;
    }
    diag.attempts += 1;
    tryExecInsert(composer, deps, text);
    let check = verifiedRead(composer, text);
    if (check.ok) {
      diag.strategy = "exec";
      diag.postLen = normalizeComposerMultiline(check.readBack).length;
      return { ok: true, readBack: check.readBack, diagnostics: { ...diag } };
    }
    lastReadBack = check.readBack;
    if (tryBeforeInput(composer, deps, text)) {
      check = verifiedRead(composer, text);
      if (check.ok) {
        diag.strategy = "beforeinput";
        diag.postLen = normalizeComposerMultiline(check.readBack).length;
        return {
          ok: true,
          readBack: check.readBack,
          diagnostics: { ...diag },
        };
      }
      lastReadBack = check.readBack;
    }
  }
  if (lastReadBack) return fail(lastReadBack);
  const composer = resolveLiveComposer(deps);
  return fail(composer ? readComposerText(composer) : "");
}

/** Build live deps from real browser globals (never called in tests). */
export function liveSlackDeps(doc: Document, win: Window, activeField: HTMLElement | null): SlackDeps {
  return {
    activeField: activeField as EditableElement | null,
    // Getter, not a snapshot: every resolve (including retries) sees the
    // currently focused element, so focusing the composer on attempt 1 is
    // visible to attempt 2.
    get activeElement() {
      return doc.activeElement as EditableElement | null;
    },
    getSelection: () => {
      const sel = win.getSelection();
      if (!sel) return null;
      return { selectAllChildren: (node: unknown) => sel.selectAllChildren(node as Node) };
    },
    execCommand: (command, showUI, value) => doc.execCommand(command, showUI, value),
    createInputEvent: () => new InputEvent("input", { bubbles: true }),
    createBeforeInputEvent: (text) =>
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text,
      }),
  };
}
