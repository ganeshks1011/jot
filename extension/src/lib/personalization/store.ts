import { getStarter } from "../onboardingExamples";
import {
  getContextExamples,
  getPersonalizationSnapshot,
  saveContextExample,
  saveContextExamples,
  savePersonalizationSnapshot,
} from "../storage";
import type { ContextDomain, PersonalizationContext } from "../types";
import { getDefaultInstruction } from "./canonical";
import { CONTEXT_ORDER } from "./resolve";
import type { PersonalizationSnapshot, SliderLevels, TeachState } from "./types";

const NEUTRAL_LEVELS: SliderLevels = { casual: 3, direct: 3, length: 3 };

function neutralLevels(): SliderLevels {
  return { ...NEUTRAL_LEVELS };
}

function emptyRecord<T>(fill: () => T): Record<PersonalizationContext, T> {
  return {
    default: fill(),
    email: fill(),
    text: fill(),
    social: fill(),
    work: fill(),
  };
}

function freshSnapshot(): PersonalizationSnapshot {
  return {
    contexts: emptyRecord(() => ({ prompt: "", sliders: neutralLevels() })),
    domains: [],
  };
}

export async function loadSnapshot(): Promise<PersonalizationSnapshot> {
  const existing = await getPersonalizationSnapshot();
  if (existing && typeof existing === "object" && existing.contexts && Array.isArray(existing.domains)) {
    return existing;
  }
  const snapshot = freshSnapshot();
  await savePersonalizationSnapshot(snapshot);
  return snapshot;
}

/** Full Teach UI state (starter examples seed empty slots). */
export async function loadTeachState(): Promise<TeachState> {
  const [snapshot, ctxExamples] = await Promise.all([loadSnapshot(), getContextExamples()]);
  const prompts = emptyRecord(() => "");
  const sliders = emptyRecord(neutralLevels);
  for (const ctx of CONTEXT_ORDER) {
    prompts[ctx] = snapshot.contexts[ctx]?.prompt ?? "";
    sliders[ctx] = { ...(snapshot.contexts[ctx]?.sliders ?? neutralLevels()) };
  }
  const examples = emptyRecord(() => "");
  for (const e of ctxExamples) {
    if (e && CONTEXT_ORDER.includes(e.context)) examples[e.context] = e.text;
  }
  for (const ctx of CONTEXT_ORDER) {
    if (!examples[ctx]) examples[ctx] = getStarter(ctx, 0);
  }
  return { prompts, sliders, domains: snapshot.domains, examples };
}

function sanitizeDomains(domains: ContextDomain[]): ContextDomain[] {
  const allowed = new Set(["email", "text", "social", "work"]);
  const dedup = new Map<string, ContextDomain>();
  for (const d of domains) {
    if (!d?.pattern || !allowed.has(d.context)) continue;
    const pattern = d.pattern.trim().toLowerCase();
    if (!pattern) continue;
    dedup.set(`${d.context}::${pattern}`, { context: d.context, pattern });
  }
  return [...dedup.values()];
}

export async function savePrompt(ctx: PersonalizationContext, prompt: string): Promise<void> {
  const snapshot = await loadSnapshot();
  snapshot.contexts[ctx].prompt = prompt.trim();
  await savePersonalizationSnapshot(snapshot);
}

export async function saveSliders(ctx: PersonalizationContext, levels: SliderLevels): Promise<void> {
  const snapshot = await loadSnapshot();
  const style = snapshot.contexts[ctx];
  style.sliders = { ...levels };
  // A style with committed (non-neutral) levels but no text would otherwise
  // be inert at resolve time; seed the default instruction to preserve the
  // previous effective behavior (slider moves used to bake text in).
  const nonNeutral = (Object.values(levels) as number[]).some((l) => l !== 3);
  if (!style.prompt.trim() && nonNeutral) {
    style.prompt = getDefaultInstruction();
  }
  await savePersonalizationSnapshot(snapshot);
}

export async function saveDomains(domains: ContextDomain[]): Promise<void> {
  const snapshot = await loadSnapshot();
  snapshot.domains = sanitizeDomains(domains);
  await savePersonalizationSnapshot(snapshot);
}

export async function saveExample(ctx: PersonalizationContext, text: string): Promise<void> {
  await saveContextExample(ctx, text);
}

/** Canonical re-persist of Teach state. */
export async function flushTeachState(state: TeachState): Promise<void> {
  const prompts = { ...state.prompts };
  if (!prompts.default.trim()) prompts.default = getDefaultInstruction();
  const snapshot: PersonalizationSnapshot = {
    contexts: emptyRecord(() => ({ prompt: "", sliders: neutralLevels() })),
    domains: sanitizeDomains(state.domains),
  };
  for (const ctx of CONTEXT_ORDER) {
    snapshot.contexts[ctx] = {
      prompt: (prompts[ctx] ?? "").trim(),
      sliders: { ...(state.sliders[ctx] ?? neutralLevels()) },
    };
  }
  await savePersonalizationSnapshot(snapshot);
  const exampleList = (Object.entries(state.examples) as [PersonalizationContext, string][])
    .map(([context, text]) => ({ context, text }))
    .filter((e) => e.text.trim());
  await saveContextExamples(exampleList);
}
