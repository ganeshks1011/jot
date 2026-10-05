/**
 * Research Agent domain types — shared by the web backend
 * (`app/core/routes/api.ai.research.*`) and the campaign Chrome extension
 * (`apps/campaign`). Framework-free pure TS: no React, no DOM, no chrome.*.
 */

export type ResearchSourceType = "reddit" | "linkedin" | "product_reviews" | "community" | "competitor";

export type ResearchStepType = "search" | "open" | "extract" | "analyze" | "stop";

export type ObservationType = "problem" | "workflow" | "complaint" | "desire" | "solution" | "quote";

export interface ResearchObjective {
  title: string;
}

export interface ResearchQuery {
  query: string;
  sourceTypes: ResearchSourceType[];
}

export interface ResearchPlan {
  question: string;
  objectives: string[];
  sourceTypes: ResearchSourceType[];
  queries: ResearchQuery[];
  extractionRules: ObservationType[];
  synthesisQuestions: string[];
}

export interface ResearchStep {
  type: ResearchStepType;
  target?: string;
  reason: string;
}

export interface ResearchSource {
  id: string;
  topicId: string;
  url: string;
  platform: string;
  title?: string;
  author?: string;
  capturedAt: number;
  content: string;
}

export interface Observation {
  id: string;
  topicId: string;
  sourceId: string;
  type: ObservationType;
  text: string;
  tags: string[];
  confidence?: number;
}

export interface ResearchFinding {
  title: string;
  summary: string;
  evidence: string[];
}

export interface ResearchReport {
  topicId: string;
  findings: ResearchFinding[];
  gaps: string[];
  coverage: Record<string, number>;
  createdAt: number;
}

const MAX_QUESTION_CHARS = 2000;
const MAX_OBSERVATION_TEXT_CHARS = 5000;

export function isResearchSourceType(value: unknown): value is ResearchSourceType {
  return (
    value === "reddit" ||
    value === "linkedin" ||
    value === "product_reviews" ||
    value === "community" ||
    value === "competitor"
  );
}

export function isObservationType(value: unknown): value is ObservationType {
  return (
    value === "problem" ||
    value === "workflow" ||
    value === "complaint" ||
    value === "desire" ||
    value === "solution" ||
    value === "quote"
  );
}

/** Validate a research question before planning. Returns an error message or null. */
export function validateResearchQuestion(question: unknown): string | null {
  if (typeof question !== "string" || question.trim().length === 0) return "question is required";
  if (question.trim().length > MAX_QUESTION_CHARS) return `question exceeds ${MAX_QUESTION_CHARS} characters`;
  return null;
}

/** Validate observation text extracted from a page. Returns an error message or null. */
export function validateObservationText(text: unknown): string | null {
  if (typeof text !== "string" || text.trim().length === 0) return "text is required";
  if (text.length > MAX_OBSERVATION_TEXT_CHARS) return `text exceeds ${MAX_OBSERVATION_TEXT_CHARS} characters`;
  return null;
}

/** Group observations by tag for the Themes view. Pure helper for extension + web. */
export function groupObservationsByTag(observations: Observation[]): Map<string, Observation[]> {
  const groups = new Map<string, Observation[]>();
  for (const observation of observations) {
    for (const tag of observation.tags) {
      const existing = groups.get(tag);
      if (existing) existing.push(observation);
      else groups.set(tag, [observation]);
    }
  }
  return groups;
}
