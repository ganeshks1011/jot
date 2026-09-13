/**
 * Framework-aware write-back for model-driven rich-text editors
 * (Lexical, Slate, ProseMirror/TipTap, Quill, Draft.js, CKEditor).
 *
 * These editors keep an internal model and reconcile the DOM against it, so
 * the generic range-surgery path is silently reverted. They all honor real
 * editing input (`execCommand("insertText")` on a live selection, which
 * Chrome surfaces as `beforeinput`), so this module does exactly that and
 * verifies every write by reading back.
 *
 * Two failure modes shape this module (both seen live on Reddit):
 * - Frameworks flush model updates asynchronously: a synchronous read-back
 *   races the flush, reports "unchanged", and triggers retries that pile
 *   duplicate copies into the editor. Every verify therefore awaits a
 *   frame flush first.
 * - `execCommand` already fires a real `beforeinput`; dispatching an extra
 *   synthetic one double-applies the text. There is exactly one write op
 *   per strategy (whole-text, then line-by-line), never stacked.
 *
 * Rules for this module:
 * - Never assign innerHTML / innerText / textContent / value (reads only).
 * - Framework markers are data for *root resolution only* — one code path
 *   for all frameworks, never per-framework branches.
 * - Re-resolve the live root on every attempt; never trust a range cloned
 *   at capture time (frameworks re-render while the overlay is open). The
 *   trace records root identity so a re-attached subtree is visible.
 * - No op runs without verified focus and model-mapped selection coverage:
 *   select, wait for one `selectionchange` (timeout ceiling), re-check.
 * - Every strategy is clear-then-insert: delete the selection, confirm the
 *   editor is empty (or provably untouched), and only then insert — appends
 *   require pre-existing content, which the clear step eliminates first.
 * - Every retry starts from identical state: a diverged composer is
 *   restored from snapshot first, and a restore that cannot verify aborts
 *   the run instead of stacking another attempt on corrupted state.
 * - Two circuit-breakers (verbatim duplication, absolute growth) and a
 *   best-effort snapshot restore bound every failure mode.
 * - With sanitized HTML, clipboard-mediated paste runs first (trusted
 *   path over overlay-written flavors), synthetic paste second, trusted
 *   execCommand insertHTML last: framework clipboard matchers build real
 *   nodes (lists, bold) from a paste-like input. Verified by item-text
 *   containment with the same breakers; any failure falls through to the
 *   plain path.
 */

import { htmlToPlainText } from "../richText";
import {
  type EditableElement,
  isEditableTarget,
  liveSlackDeps,
  normalizeComposerMultiline,
  normalizeComposerText,
  readComposerText,
  type SlackDeps,
  type SlackReplaceResult,
  type SlackWriteDiagnostics,
} from "./slack";

/** Framework markers: editor-root selectors. Data only — adding an editor
 *  is adding one line here, never a new branch. Exported so tests pin each
 *  selector. */
export const FRAMEWORK_MARKERS = [
  { id: "lexical", selector: '[data-lexical-editor="true"]' },
  { id: "slate", selector: '[data-slate-editor="true"]' },
  { id: "prosemirror", selector: ".ProseMirror" },
  { id: "quill", selector: ".ql-editor" },
  { id: "draft", selector: ".public-DraftEditor-content" },
  { id: "ckeditor", selector: ".ck-editor__editable" },
] as const;

export interface RichTextSelection {
  selectAllChildren: (node: unknown) => void;
  /** Live selection text for coverage checks; absent when unprovidable. */
  selectionText?: () => string | null;
}

export interface RichTextDeps extends SlackDeps {
  getSelection: () => RichTextSelection | null;
  /** Resolves after the framework flushes a write to the DOM. */
  waitForFlush: () => Promise<void>;
  /**
   * Resolves after the framework maps the current DOM selection into its
   * model (one `selectionchange` event, timeout ceiling). Absent callers
   * fall back to `waitForFlush`.
   */
  awaitSelectionSynced?: () => Promise<void>;
  /**
   * Clipboard payload/event shells for the synthetic paste attempt. Absent
   * outside real DOM (tests, workers) — the paste attempt then skips
   * cleanly to the execCommand fallback.
   */
  createDataTransfer?: () => DataTransferLike | null;
  createPasteEvent?: () => PasteEventLike | null;
  /** `closest` bound to the captured field (null when unavailable). */
  closestFromField: ((selector: string) => EditableElement | null) | null;
  /** `closest` bound to the currently focused element (null when unavailable). */
  closestFromFocused: ((selector: string) => EditableElement | null) | null;
}

/** Minimal structural surface of a clipboard payload (DOM + fakes). */
export interface DataTransferLike {
  setData(format: string, data: string): void;
}

/** Minimal structural surface of a paste event shell (DOM + fakes). */
export interface PasteEventLike {
  [key: string]: unknown;
}

export interface FrameworkRoot {
  root: EditableElement;
  framework: string;
}

/**
 * Resolve the live framework editor root: captured field first, then the
 * focused element. Returns null when no framework marker matches, in which
 * case callers keep the existing generic path byte-identical.
 */
export function resolveFrameworkRoot(deps: RichTextDeps): FrameworkRoot | null {
  for (const marker of FRAMEWORK_MARKERS) {
    const fromField = deps.closestFromField?.(marker.selector);
    if (fromField?.isConnected && isEditableTarget(fromField)) {
      return { root: fromField, framework: marker.id };
    }
    const fromFocused = deps.closestFromFocused?.(marker.selector);
    if (fromFocused?.isConnected && isEditableTarget(fromFocused)) {
      return { root: fromFocused, framework: marker.id };
    }
  }
  return null;
}

/**
 * True when focus actually landed in the resolved root. Focusing a detached
 * node is a silent no-op, and writing then appends at the live cursor
 * instead of replacing — the Reddit duplication signature. Unverifiable
 * (null active element) proceeds, matching historical behavior.
 */
function focusLanded(root: EditableElement, deps: RichTextDeps): boolean {
  const active = deps.activeElement;
  if (!active) return true;
  let el: EditableElement | null | undefined = active;
  for (let i = 0; i < 25 && el; i++) {
    if (el === root) return true;
    el = el.parentElement ?? null;
  }
  return false;
}

/**
 * Select-all with coverage proof: the live selection must cover the whole
 * editor text before any `execCommand` runs. A collapsed or partial
 * selection would append instead of replace, so the op is skipped.
 * Unprovidable selection text (or an empty editor) proceeds.
 *
 * Comparison is structure-insensitive (all whitespace collapsed): selection
 * text and `innerText` disagree on break placement around list and block
 * markup, which must not block writes on rich content. Word content still
 * has to match in full — a partial selection never verifies.
 */
function selectAllVerified(root: EditableElement, deps: RichTextDeps): boolean {
  const sel = deps.getSelection();
  if (!sel) return false;
  try {
    sel.selectAllChildren(root);
  } catch {
    return false;
  }
  const covered = sel.selectionText?.();
  if (covered == null) return true;
  const editorText = normalizeComposerText(readComposerText(root));
  if (!editorText) return true;
  return normalizeComposerText(covered) === editorText;
}

/**
 * Duplication signature: the expected text already present twice or more.
 * Fails closed immediately instead of stacking further copies.
 */
function isDuplicated(actual: string, expected: string): boolean {
  if (!expected) return false;
  let count = 0;
  let from = 0;
  while (from <= actual.length) {
    const at = actual.indexOf(expected, from);
    if (at === -1) return false;
    count += 1;
    if (count >= 2) return true;
    from = at + expected.length;
  }
  return false;
}

/**
 * Absolute-growth circuit-breaker slack (chars). Complements the verbatim
 * count above: fragment stacks never form two exact copies but still bloat.
 * Legit overshoot (trailing blocks, formatting wrappers) stays far below.
 */
const GROWTH_SLACK = 512;

function isOvergrown(actualLen: number, preLen: number, expectedLen: number): boolean {
  return preLen >= 0 && actualLen > preLen + expectedLen + GROWTH_SLACK;
}

/**
 * TEMPORARY diagnostic trace for a live duplication investigation (lengths
 * and tags only, never message content). Each write op reports what it did
 * so a reproduce-and-paste round identifies the appending op. Removed once
 * the mechanism is confirmed.
 */
function traceWrite(info: {
  attempt: number;
  op: string;
  execReturn: boolean;
  preOpLen: number;
  postOpLen: number;
  verifyOk: boolean;
  sameRoot: boolean;
  detail?: string;
}): void {
  try {
    console.debug("[jot] rich-write", info);
  } catch {
    // Logging must never break insertion.
  }
}

/**
 * TEMPORARY degrade-step trace for the live tag-stripping investigation.
 * Logs every fallback transition (not just op outcomes) via console.log so
 * it is visible without the Verbose level. Lengths, tags, and reasons
 * only — never message content. Removed once the stripping step is
 * confirmed.
 */
function traceDegrade(info: {
  attempt: number;
  from: string;
  to: string;
  reason?: string;
  preOpLen?: number;
  postOpLen?: number;
  shape?: { lcpLen: number; lcsLen: number; startsWith: boolean; endsWith: boolean };
  /**
   * TEMPORARY content-bearing diagnostics for the tag-stripping
   * investigation: exact normalized strings being compared. Local console
   * only — contains the user's draft text, so redact before sharing
   * anywhere. Removed with the rest of this trace once confirmed.
   */
  actual?: string;
  expected?: string;
}): void {
  try {
    console.log("[jot] degrade", info);
  } catch {
    // Logging must never break insertion.
  }
}

/**
 * TEMPORARY content-shape descriptor for the tag-stripping investigation.
 * Characterizes how a verify-failed read-back differs from expectation
 * using lengths and booleans only — never content. lcpLen/lcsLen locate
 * the deformation (trailing strip: lcp≈actual length; leading strip:
 * suffix≈actual length; interior substitution: both large but neither
 * full). Unit-indexed; astral-plane text may skew counts by a unit or
 * two, which does not affect classification. Exported for unit tests.
 */
export interface ContentShape {
  lcpLen: number;
  lcsLen: number;
  startsWith: boolean;
  endsWith: boolean;
}

export function describeShape(actual: string, expected: string): ContentShape {
  const maxPrefix = Math.min(actual.length, expected.length);
  let lcpLen = 0;
  while (lcpLen < maxPrefix && actual[lcpLen] === expected[lcpLen]) lcpLen++;
  let lcsLen = 0;
  while (lcsLen < maxPrefix - lcpLen && actual[actual.length - 1 - lcsLen] === expected[expected.length - 1 - lcsLen]) {
    lcsLen++;
  }
  return {
    lcpLen,
    lcsLen,
    startsWith: expected.startsWith(actual) || actual.startsWith(expected),
    endsWith: expected.endsWith(actual) || actual.endsWith(expected),
  };
}

/** Outcome of a write op: whether it ran, what execCommand reported, and why it skipped. */
interface WriteOpOutcome {
  completed: boolean;
  execReturn: boolean;
  skipped?: "coverage-pre" | "coverage-post" | "clear-failed" | "paste-unavailable";
  /** Which mechanism a completed HTML op used (trace + tests). */
  mechanism?: "clipboard" | "paste" | "exec";
}

/**
 * Wait for the framework to map the DOM selection into its model: one
 * `selectionchange` event when observable, else the generic flush.
 * Executing before the model catches up appends at a stale cursor.
 */
async function syncSelection(deps: RichTextDeps): Promise<void> {
  if (deps.awaitSelectionSynced) {
    try {
      await deps.awaitSelectionSynced();
      return;
    } catch {
      // Fall through to the flush below.
    }
  }
  await deps.waitForFlush();
}

/**
 * Clear-then-insert prelude shared by every strategy: select, sync, and
 * re-check, then delete the selection and confirm the outcome. Splitting
 * the replace this way removes the stale-cursor append class entirely —
 * the insert always lands in an empty (or provably untouched) editor.
 * Returns "cleared" (empty, insert away), "unchanged" (delete was a no-op;
 * legacy replace semantics still apply), or "failed" (partial clear —
 * never insert into unknown state).
 */
async function clearEditor(root: EditableElement, deps: RichTextDeps): Promise<"cleared" | "unchanged" | "failed"> {
  if (!selectAllVerified(root, deps)) return "failed";
  await syncSelection(deps);
  if (!selectAllVerified(root, deps)) return "failed";
  const before = normalizeComposerMultiline(readComposerText(root));
  if (!before) return "cleared";
  try {
    deps.execCommand("delete", false, "");
  } catch {
    return "failed";
  }
  try {
    root.dispatchEvent(deps.createInputEvent());
  } catch {
    // The read below decides; a dispatch failure alone is not fatal.
  }
  await deps.waitForFlush();
  const after = normalizeComposerMultiline(readComposerText(root));
  if (!after) return "cleared";
  if (after === before) return "unchanged";
  return "failed";
}

/**
 * Line-by-line insert for editors that mishandle embedded newlines in a
 * single `insertText` (the proven ProseMirror/TipTap pattern): clear first,
 * then `insertText` per line with `insertParagraph` between lines into the
 * empty editor. Caller flushes and verifies.
 */
async function runMultilineInsert(root: EditableElement, deps: RichTextDeps, text: string): Promise<WriteOpOutcome> {
  const cleared = await clearEditor(root, deps);
  if (cleared === "failed") return { completed: false, execReturn: false, skipped: "clear-failed" };
  // (Re)assert selection right before executing: the clear's flush may have
  // moved it, and an empty editor selects trivially.
  if (!selectAllVerified(root, deps)) return { completed: false, execReturn: false, skipped: "coverage-post" };
  let execReturn = true;
  try {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        const paraOk = deps.execCommand("insertParagraph", false, "");
        execReturn = execReturn && paraOk;
        if (!paraOk) return { completed: false, execReturn };
      }
      const line = lines[i];
      if (line) {
        const lineOk = deps.execCommand("insertText", false, line);
        execReturn = execReturn && lineOk;
        if (!lineOk) return { completed: false, execReturn };
      }
    }
    root.dispatchEvent(deps.createInputEvent());
    return { completed: true, execReturn };
  } catch {
    return { completed: false, execReturn };
  }
}

/** Whole-text editing input into the cleared editor. Caller flushes and verifies. */
async function runWholeInsert(root: EditableElement, deps: RichTextDeps, text: string): Promise<WriteOpOutcome> {
  const cleared = await clearEditor(root, deps);
  if (cleared === "failed") return { completed: false, execReturn: false, skipped: "clear-failed" };
  if (!selectAllVerified(root, deps)) return { completed: false, execReturn: false, skipped: "coverage-post" };
  let execReturn = false;
  try {
    execReturn = deps.execCommand("insertText", false, text);
  } catch {
    // Verification decides; execCommand lies in both directions.
  }
  try {
    root.dispatchEvent(deps.createInputEvent());
  } catch {
    // Verification decides; a dispatch failure alone is not fatal.
  }
  return { completed: true, execReturn };
}

/**
 * Synthetic paste into the cleared editor: a real DataTransfer (text/html
 * + block-aware text/plain) carried on an untrusted paste event through
 * the framework's native paste pipeline — the same matchers real user
 * pastes hit. Chrome's ClipboardEventInit has no clipboardData member (it
 * is silently dropped from the constructor dict), so the prototype's
 * readonly getter is shadowed with our payload instead. Caller flushes
 * and verifies; any failure falls through to execCommand.
 */
async function runPasteInsert(root: EditableElement, deps: RichTextDeps, html: string): Promise<WriteOpOutcome> {
  if (!selectAllVerified(root, deps)) return { completed: false, execReturn: false, skipped: "coverage-post" };
  let transfer: DataTransferLike | null = null;
  let pasteEvent: PasteEventLike | null = null;
  try {
    transfer = deps.createDataTransfer?.() ?? null;
    pasteEvent = deps.createPasteEvent?.() ?? null;
  } catch {
    return { completed: false, execReturn: false, skipped: "paste-unavailable" };
  }
  if (!transfer || !pasteEvent) return { completed: false, execReturn: false, skipped: "paste-unavailable" };
  try {
    transfer.setData("text/html", html);
    transfer.setData("text/plain", htmlToPlainText(html));
  } catch {
    return { completed: false, execReturn: false, skipped: "paste-unavailable" };
  }
  try {
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: transfer,
      configurable: true,
      enumerable: true,
      writable: false,
    });
  } catch {
    return { completed: false, execReturn: false, skipped: "paste-unavailable" };
  }
  try {
    root.focus();
  } catch {
    // Focus is best-effort; the dispatch below decides.
  }
  let dispatched = false;
  try {
    dispatched = root.dispatchEvent(pasteEvent as unknown as Event);
  } catch {
    return { completed: false, execReturn: false };
  }
  try {
    root.dispatchEvent(deps.createInputEvent());
  } catch {
    // Verification decides; a dispatch failure alone is not fatal.
  }
  return { completed: true, execReturn: dispatched };
}

/**
 * Clipboard-mediated paste: the overlay wrote real clipboard flavors on
 * Enter (same user gesture), so a plain `paste` command pulls them through
 * the browser's most trusted path — no synthetic events involved. Gated
 * like every op; Chrome may refuse without a manifest permission change
 * (which is deliberately not attempted here) — verify decides, and the
 * chain degrades to the tiers below. Caller flushes and verifies.
 */
async function runClipboardPaste(root: EditableElement, deps: RichTextDeps): Promise<WriteOpOutcome> {
  if (!selectAllVerified(root, deps)) return { completed: false, execReturn: false, skipped: "coverage-post" };
  let execReturn = false;
  try {
    execReturn = deps.execCommand("paste", false, "");
  } catch {
    // Verification decides; execCommand lies in both directions.
  }
  try {
    root.dispatchEvent(deps.createInputEvent());
  } catch {
    // Verification decides; a dispatch failure alone is not fatal.
  }
  return { completed: true, execReturn };
}

/**
 * Rich HTML insert into the cleared editor. Clipboard-mediated paste runs
 * first (trusted path over overlay-written flavors), synthetic paste
 * second, trusted execCommand insertHTML last. Caller verifies by
 * item-text containment and falls back to the plain path.
 */
async function runHtmlInsert(
  root: EditableElement,
  deps: RichTextDeps,
  html: string,
  attempt = 0,
): Promise<
  WriteOpOutcome & { mechanism?: "clipboard" | "paste" | "exec"; pasteTried?: boolean; clipboardTried?: boolean }
> {
  const cleared = await clearEditor(root, deps);
  if (cleared === "failed") return { completed: false, execReturn: false, skipped: "clear-failed" };
  const plainExpected = normalizeComposerMultiline(htmlToPlainText(html));
  // Attempt 0: clipboard-mediated paste. The overlay wrote real clipboard
  // flavors on Enter; a trusted paste pulls them through the most native
  // path. Falls through on refusal — no permission changes attempted.
  const clipped = await runClipboardPaste(root, deps);
  const clipboardTried = clipped.completed;
  if (clipped.completed && plainExpected) {
    await deps.waitForFlush();
    const actual = normalizeComposerMultiline(readComposerText(root));
    if (verifyEquivalent(actual, plainExpected))
      return { ...clipped, mechanism: "clipboard" as const, clipboardTried: true };
    traceDegrade({
      attempt,
      from: "html-clipboard-paste",
      to: "html-paste",
      reason: "verify-false",
      postOpLen: actual.length,
      shape: describeShape(actual, plainExpected),
      actual,
      expected: plainExpected,
    });
  }
  // Attempt 1: synthetic paste. On dispatch-but-no-verify, fall through to
  // exec below: re-select covers whatever the paste left, so the replace
  // heals partial application instead of stacking onto it.
  const pasted = await runPasteInsert(root, deps, html);
  if (pasted.completed && plainExpected) {
    await deps.waitForFlush();
    const actual = normalizeComposerMultiline(readComposerText(root));
    if (verifyEquivalent(actual, plainExpected)) return { ...pasted, mechanism: "paste" as const, pasteTried: true };
    traceDegrade({
      attempt,
      from: "html-paste",
      to: "html-exec",
      reason: "verify-false",
      postOpLen: actual.length,
      shape: describeShape(actual, plainExpected),
      actual,
      expected: plainExpected,
    });
  } else if (!pasted.completed) {
    traceDegrade({
      attempt,
      from: "html-paste",
      to: "html-exec",
      reason: pasted.skipped ?? "skipped",
      postOpLen: normalizeComposerMultiline(readComposerText(root)).length,
    });
  }
  const pasteTried = pasted.completed;
  // Attempt 2: trusted execCommand insertHTML.
  if (!selectAllVerified(root, deps)) return { completed: false, execReturn: false, skipped: "coverage-post" };
  let execReturn = false;
  try {
    execReturn = deps.execCommand("insertHTML", false, html);
  } catch {
    // Verification decides; execCommand lies in both directions.
  }
  try {
    root.dispatchEvent(deps.createInputEvent());
  } catch {
    // Verification decides; a dispatch failure alone is not fatal.
  }
  return { completed: true, execReturn, mechanism: "exec" as const, pasteTried, clipboardTried };
}

/**
 * Verify for the plain-text framework path. Exact equality wins; otherwise
 * the editor-added block structure scales with content, so a fixed slack
 * would certify appends onto tiny composers. Appends fail earlier: full
 * copies trip the duplication breaker, original-plus-rewrite exceeds the
 * bound. An append must never verify: `execCommand` replaces the selection,
 * so anything else is a failed write.
 */
function verifySlack(expectedLen: number): number {
  return Math.min(64, Math.floor(expectedLen / 10));
}

/**
 * Strip list-marker prefixes so both sides of a verify comparison use one
 * convention. Model-side text marks items with "- " (via htmlToPlainText)
 * while rendered innerText of real <li> nodes carries no dash (bullets
 * live in ::marker, browser-dependently) — without this, a perfect list
 * insert mismatches on every line by construction. Verify-scoped only:
 * diagnostics lengths and stored content are untouched.
 */
function stripListMarkers(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""))
    .join("\n");
}

/**
 * True when edit distance fits within `bound`, with early exit past it.
 * Two-row DP; typical cost O(bound × n) since rows abort once every entry
 * exceeds the bound. Texts here are a few hundred chars — trivial.
 */
function editDistanceWithin(a: string, b: string, bound: number): boolean {
  if (a === b) return true;
  if (bound < 0 || Math.abs(a.length - b.length) > bound) return false;
  let prev: number[] = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      // Indexing is safe: both rows are seeded for every column beforehand.
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const cell = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      cur[j] = cell;
      if (cell < rowMin) rowMin = cell;
    }
    if (rowMin > bound) return false;
    prev = cur;
  }
  return (prev[b.length] ?? bound + 1) <= bound;
}

/**
 * Full verify: marker-aligned edit distance. Answers "does the editor hold
 * essentially the intended text?" rather than "is one string contained in
 * the other?" — containment cannot express interior micro-edits (a dash
 * normalized here, a space collapsed there), which is exactly how editors
 * deform committed text. Appends and duplicates fail by distance and by
 * the breakers, which are untouched.
 */
function verifyEquivalent(actual: string, expected: string): boolean {
  if (!expected || !actual) return false;
  const a = stripListMarkers(actual);
  const e = stripListMarkers(expected);
  if (a === e) return true;
  return editDistanceWithin(a, e, verifySlack(e.length));
}

function verifyTolerant(root: EditableElement, text: string): { ok: boolean; readBack: string } {
  const readBack = readComposerText(root);
  const expected = normalizeComposerMultiline(text);
  if (!expected) return { ok: false, readBack };
  const actual = normalizeComposerMultiline(readBack);
  return { ok: verifyEquivalent(actual, expected), readBack };
}

/**
 * Best-effort restore of the pre-write snapshot after a failed run that grew
 * the composer: failure must leave the editor untouched, not bloated. Uses
 * the same gated path as writes; silently gives up when it cannot resolve.
 */
async function tryRestoreOriginal(deps: RichTextDeps, snapshot: string): Promise<void> {
  const resolved = resolveFrameworkRoot(deps);
  if (!resolved) return;
  const { root } = resolved;
  try {
    root.focus();
  } catch {
    return;
  }
  if (!focusLanded(root, deps)) return;
  if (!selectAllVerified(root, deps)) return;
  await deps.waitForFlush();
  if (!selectAllVerified(root, deps)) return;
  try {
    deps.execCommand("insertText", false, snapshot);
  } catch {
    // Best effort only; the panel stays open with copy/retry either way.
  }
  try {
    root.dispatchEvent(deps.createInputEvent());
  } catch {
    // Best effort only.
  }
  await deps.waitForFlush();
}

/**
 * Replace the framework composer contents via real editing input and verify.
 * With sanitized HTML, a synthetic paste attempt runs first (then trusted
 * execCommand insertHTML); then the plain-text path exactly as before.
 * Exactly one write op per strategy with a frame flush before every
 * read-back; focus, selection coverage, and two circuit-breakers (verbatim
 * duplication, absolute growth) guard every step. Reports failure instead
 * of guessing — the caller keeps the panel open so the rewrite stays
 * copyable.
 */
export async function replaceRichText(
  text: string,
  deps: RichTextDeps,
  html?: string | null,
): Promise<SlackReplaceResult> {
  const expected = normalizeComposerMultiline(text);
  const expectedLen = expected.length;
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
  const succeed = (readBack: string): SlackReplaceResult => {
    diag.strategy = "exec";
    diag.postLen = normalizeComposerMultiline(readBack).length;
    return { ok: true, readBack, diagnostics: { ...diag } };
  };
  if (!expected) return fail("");
  let lastReadBack = "";
  let snapshot: string | null = null;
  let lastRoot: EditableElement | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const resolved = resolveFrameworkRoot(deps);
    if (!resolved) {
      traceWrite({
        attempt: diag.attempts,
        op: "resolve-missed",
        execReturn: false,
        preOpLen: -1,
        postOpLen: -1,
        verifyOk: false,
        sameRoot: false,
      });
      continue;
    }
    const { root } = resolved;
    // A re-attached editor subtree (custom elements re-render) resolves a
    // different node per attempt — writing across roots stacks content.
    const sameRoot = lastRoot !== null && lastRoot === root;
    lastRoot = root;
    diag.tag = typeof root.tagName === "string" ? root.tagName.toUpperCase() : null;
    if (diag.preLen < 0) {
      snapshot = readComposerText(root);
      diag.preLen = normalizeComposerMultiline(snapshot).length;
    }
    try {
      root.focus();
    } catch {
      continue;
    }
    if (!focusLanded(root, deps)) continue;
    diag.attempts += 1;
    // Every retry starts from identical state: restore the snapshot when a
    // previous attempt left the composer diverged. A restore that cannot
    // verify aborts the run instead of stacking another attempt on top.
    if (attempt > 0 && snapshot !== null) {
      const current = normalizeComposerMultiline(readComposerText(root));
      const snapNorm = normalizeComposerMultiline(snapshot);
      const diverged = !verifyEquivalent(current, snapNorm);
      if (diverged) {
        traceDegrade({
          attempt: diag.attempts,
          from: "retry-diverged",
          to: "restore",
          preOpLen: normalizeComposerMultiline(readComposerText(root)).length,
          postOpLen: normalizeComposerMultiline(snapshot).length,
        });
        await tryRestoreOriginal(deps, snapshot);
        const afterResolve = resolveFrameworkRoot(deps);
        const after = afterResolve ? readComposerText(afterResolve.root) : "";
        if (!verifyEquivalent(normalizeComposerMultiline(after), normalizeComposerMultiline(snapshot))) {
          // Restore failed: fail closed now instead of stacking another
          // attempt (and another restore) on corrupted state.
          traceDegrade({
            attempt: diag.attempts,
            from: "restore",
            to: "abort",
            reason: "restore-unverifiable",
            postOpLen: normalizeComposerMultiline(after).length,
          });
          return fail(after);
        }
      }
    }
    const preOpLen = normalizeComposerMultiline(readComposerText(root)).length;
    // Rich attempt first when sanitized HTML is present: the framework's
    // clipboard matchers build real nodes (lists, bold) from a paste-like
    // input, where plain insertText can only ever produce text. Verified by
    // item-text containment; any failure falls through to plain text below.
    const cleanHtml = html?.trim() ? html : null;
    const plainExpected = cleanHtml ? normalizeComposerMultiline(htmlToPlainText(cleanHtml)) : "";
    if (cleanHtml && plainExpected) {
      const rich = await runHtmlInsert(root, deps, cleanHtml, diag.attempts);
      if (!rich.completed) {
        traceWrite({
          attempt: diag.attempts,
          op: "html-skipped",
          execReturn: false,
          preOpLen,
          postOpLen: preOpLen,
          verifyOk: false,
          sameRoot,
          detail: rich.skipped,
        });
      }
      if (rich.completed) {
        await deps.waitForFlush();
        const readBack = readComposerText(root);
        const actual = normalizeComposerMultiline(readBack);
        lastReadBack = readBack;
        const htmlOk = verifyEquivalent(actual, plainExpected);
        traceWrite({
          attempt: diag.attempts,
          op:
            rich.mechanism === "clipboard"
              ? "html-clipboard-paste"
              : rich.mechanism === "paste"
                ? "html-paste"
                : "html-exec",
          execReturn: rich.execReturn,
          preOpLen,
          postOpLen: actual.length,
          verifyOk: htmlOk,
          sameRoot,
          detail:
            rich.mechanism === "exec" && rich.pasteTried
              ? "paste-unverified"
              : rich.mechanism === "exec" && rich.clipboardTried
                ? "clipboard-unverified"
                : undefined,
        });
        if (isDuplicated(actual, plainExpected) || isOvergrown(actual.length, diag.preLen, plainExpected.length)) {
          traceDegrade({
            attempt: diag.attempts,
            from: rich.mechanism === "clipboard" ? "html-clipboard-paste" : "html",
            to: "abort",
            reason: isDuplicated(actual, plainExpected) ? "breaker-duplicated" : "breaker-overgrown",
            preOpLen,
            postOpLen: actual.length,
          });
          break;
        }
        if (htmlOk) return succeed(readBack);
        traceDegrade({
          attempt: diag.attempts,
          from: rich.mechanism === "clipboard" ? "html-clipboard-paste" : "html",
          to: "plain-whole",
          reason: "verify-false",
          preOpLen,
          postOpLen: actual.length,
          shape: describeShape(actual, plainExpected),
          actual,
          expected: plainExpected,
        });
      }
    }
    const whole = await runWholeInsert(root, deps, text);
    if (!whole.completed) {
      traceWrite({
        attempt: diag.attempts,
        op: "whole-skipped",
        execReturn: false,
        preOpLen,
        postOpLen: preOpLen,
        verifyOk: false,
        sameRoot,
        detail: whole.skipped,
      });
    }
    if (whole.completed) {
      await deps.waitForFlush();
      const check = verifyTolerant(root, text);
      lastReadBack = check.readBack;
      const actual = normalizeComposerMultiline(check.readBack);
      traceWrite({
        attempt: diag.attempts,
        op: "whole",
        execReturn: whole.execReturn,
        preOpLen,
        postOpLen: actual.length,
        verifyOk: check.ok,
        sameRoot,
      });
      if (isDuplicated(actual, expected) || isOvergrown(actual.length, diag.preLen, expectedLen)) {
        traceDegrade({
          attempt: diag.attempts,
          from: "plain-whole",
          to: "abort",
          reason: isDuplicated(actual, expected) ? "breaker-duplicated" : "breaker-overgrown",
          preOpLen,
          postOpLen: actual.length,
        });
        break;
      }
      if (check.ok) return succeed(check.readBack);
      traceDegrade({
        attempt: diag.attempts,
        from: "plain-whole",
        to: "plain-multiline",
        reason: "verify-false",
        preOpLen,
        postOpLen: actual.length,
        shape: describeShape(actual, expected),
        actual,
        expected,
      });
    }
    // Multiline select-all heals partial writes from the attempt above.
    const multi = await runMultilineInsert(root, deps, text);
    if (!multi.completed) {
      traceWrite({
        attempt: diag.attempts,
        op: "multiline-skipped",
        execReturn: false,
        preOpLen,
        postOpLen: preOpLen,
        verifyOk: false,
        sameRoot,
        detail: multi.skipped,
      });
    }
    if (multi.completed) {
      await deps.waitForFlush();
      const check = verifyTolerant(root, text);
      lastReadBack = check.readBack;
      const actual = normalizeComposerMultiline(check.readBack);
      traceWrite({
        attempt: diag.attempts,
        op: "multiline",
        execReturn: multi.execReturn,
        preOpLen,
        postOpLen: actual.length,
        verifyOk: check.ok,
        sameRoot,
      });
      if (isDuplicated(actual, expected) || isOvergrown(actual.length, diag.preLen, expectedLen)) {
        traceDegrade({
          attempt: diag.attempts,
          from: "plain-multiline",
          to: "abort",
          reason: isDuplicated(actual, expected) ? "breaker-duplicated" : "breaker-overgrown",
          preOpLen,
          postOpLen: actual.length,
        });
        break;
      }
      if (check.ok) return succeed(check.readBack);
      traceDegrade({
        attempt: diag.attempts,
        from: "plain-multiline",
        to: "next-attempt",
        reason: "verify-false",
        preOpLen,
        postOpLen: actual.length,
        shape: describeShape(actual, expected),
        actual,
        expected,
      });
    }
  }
  if (lastReadBack) {
    if (snapshot !== null && normalizeComposerMultiline(lastReadBack).length > diag.preLen) {
      await tryRestoreOriginal(deps, snapshot);
      const resolved = resolveFrameworkRoot(deps);
      if (resolved) {
        const restored = readComposerText(resolved.root);
        traceDegrade({
          attempt: diag.attempts,
          from: "restore",
          to: "fail",
          reason: "growth-restore-attempted",
          preOpLen: diag.preLen,
          postOpLen: normalizeComposerMultiline(restored).length,
        });
        return fail(restored);
      }
    }
    traceDegrade({
      attempt: diag.attempts,
      from: "loop-exhausted",
      to: "fail",
      reason: "verify-false",
      preOpLen: diag.preLen,
      postOpLen: normalizeComposerMultiline(lastReadBack).length,
    });
    return fail(lastReadBack);
  }
  const resolved = resolveFrameworkRoot(deps);
  return fail(resolved ? readComposerText(resolved.root) : "");
}

/** Build live deps from real browser globals (never called in tests). */
export function liveRichTextDeps(doc: Document, win: Window, activeField: HTMLElement | null): RichTextDeps {
  const base = liveSlackDeps(doc, win, activeField);
  const bindClosest = (el: Element | null): ((selector: string) => EditableElement | null) | null => {
    if (!el || typeof (el as HTMLElement).closest !== "function") return null;
    const target = el as HTMLElement;
    return (selector: string) => target.closest(selector) as unknown as EditableElement | null;
  };
  return {
    activeField: base.activeField,
    get activeElement() {
      return doc.activeElement as unknown as EditableElement | null;
    },
    getSelection: () => {
      const sel = win.getSelection();
      if (!sel) return null;
      return {
        selectAllChildren: (node: unknown) => sel.selectAllChildren(node as Node),
        selectionText: () => sel.toString(),
      };
    },
    execCommand: base.execCommand,
    createInputEvent: base.createInputEvent,
    createBeforeInputEvent: base.createBeforeInputEvent,
    waitForFlush: () =>
      new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        try {
          // Backgrounded tabs stall rAF; the timeout always releases.
          win.requestAnimationFrame(() => win.requestAnimationFrame(finish));
        } catch {
          finish();
        }
        setTimeout(finish, 150);
      }),
    // Lexical resyncs its model from selectionchange, so one post-select
    // event is strictly better evidence than a fixed frame count. The
    // timeout ceiling preserves the old behavior when nothing fires.
    awaitSelectionSynced: () =>
      new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        const onChange = () => {
          try {
            doc.removeEventListener("selectionchange", onChange);
          } catch {
            // Listener removal is best effort.
          }
          finish();
        };
        try {
          doc.addEventListener("selectionchange", onChange, { once: true });
        } catch {
          finish();
          return;
        }
        setTimeout(() => {
          try {
            doc.removeEventListener("selectionchange", onChange);
          } catch {
            // Listener removal is best effort.
          }
          finish();
        }, 150);
      }),
    // Synthetic paste shells: real constructors when available, absent
    // otherwise (tests, workers) so the paste attempt skips to execCommand.
    createDataTransfer: () => {
      try {
        return new DataTransfer();
      } catch {
        return null;
      }
    },
    createPasteEvent: () => {
      try {
        return new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          composed: true,
        }) as unknown as PasteEventLike;
      } catch {
        return null;
      }
    },
    closestFromField: bindClosest(activeField),
    get closestFromFocused() {
      return bindClosest(doc.activeElement);
    },
  };
}
