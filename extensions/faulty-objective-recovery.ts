/**
 * Suspicious-objective recovery stays deliberately independent of the goal
 * orchestrator. It classifies text and chooses a repair from durable goal
 * provenance; callers own persistence, queueing, and UI side effects.
 */

import type { Goal, ObjectiveRepairRecord } from "./goal-loop-core.js";

export type SuspiciousObjectiveReason =
  | "empty"
  | "archive-metadata"
  | "verification-fragment"
  | "command-only"
  | "marker-only"
  | "lowercase-fragment";

export interface SuspiciousObjectiveAssessment {
  suspicious: boolean;
  reasons: SuspiciousObjectiveReason[];
  evidence: string;
}

export interface ObjectiveRepairProposal {
  objective: string;
  verificationContract?: string;
  source: string;
  evidence: string;
  confidence: "best-effort";
}

const IMPERATIVE_START = /^(add|allow|audit|build|cap|clarify|close|create|detect|document|ensure|fix|implement|improve|investigate|make|prevent|research|restore|support|test|update|verify|write|remove|repair|review|refactor|replace|preserve)\b/i;
const COMMAND_ONLY = /^(?:bun|npm|pnpm|yarn|npx|node|deno|git)\s+(?:test|run|check|diff|status|show|log|exec)\b/i;

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function stripArchiveDecoration(text: string): string {
  return text
    .replace(/\s*[_*`~]*\(?archive\)?[_*`~]*\s*$/i, "")
    .replace(/^\s*>\s*/, "")
    .replace(/^\s*[-*]\s+/, "")
    .trim();
}

export function assessSuspiciousObjective(objective: unknown, verificationContract?: unknown): SuspiciousObjectiveAssessment {
  const text = normalizedText(objective);
  const contract = normalizedText(verificationContract);
  const reasons: SuspiciousObjectiveReason[] = [];

  if (!text) reasons.push("empty");
  if (/\(?_?\s*archive\s*_?\)?\s*$/i.test(text) || /\barchived?\s+objective\b/i.test(text)) reasons.push("archive-metadata");
  if (/\b(?:verification contract|passes sequentially|auditor(?:-approved| report)?|no-proof)\b/i.test(text)) reasons.push("verification-fragment");
  if (COMMAND_ONLY.test(text) && !contract) reasons.push("command-only");
  if (/^(?:done when|verify|objective|tasks?)\s*:?\s*$/i.test(text)) reasons.push("marker-only");
  if (text && /^[a-z]/.test(text) && !IMPERATIVE_START.test(text) && text.length < 220) reasons.push("lowercase-fragment");

  const unique = [...new Set(reasons)];
  return {
    suspicious: unique.length > 0,
    reasons: unique,
    evidence: unique.length > 0 ? `${unique.join(", ")}: ${text.slice(0, 240)}` : "",
  };
}

function usableCandidate(text: unknown): string | null {
  const candidate = stripArchiveDecoration(normalizedText(text));
  if (!candidate || candidate.length < 8) return null;
  const assessment = assessSuspiciousObjective(candidate);
  if (assessment.suspicious && assessment.reasons.some((r) => r !== "archive-metadata")) return null;
  return candidate;
}

/**
 * Choose only durable, already-recorded intent. This is intentionally not a
 * model call: event handlers must not create turns or invent a task. If no
 * coherent source exists, callers must take the queued-repair fallback.
 */
export function deriveObjectiveRepair(goal: Goal, assessment: SuspiciousObjectiveAssessment): ObjectiveRepairProposal | null {
  if (!assessment.suspicious) return null;

  const normalized = usableCandidate(goal.objective);
  if (normalized && normalized !== normalizedText(goal.objective)) {
    return {
      objective: normalized,
      verificationContract: normalizedText(goal.verificationContract) || undefined,
      source: "objective-normalization",
      evidence: assessment.evidence,
      confidence: "best-effort",
    };
  }

  for (const task of goal.pendingTasks ?? []) {
    const candidate = usableCandidate(task);
    if (candidate) {
      return {
        objective: candidate,
        verificationContract: normalizedText(goal.verificationContract) || undefined,
        source: "pendingTasks",
        evidence: `pending task recovered after ${assessment.evidence}`,
        confidence: "best-effort",
      };
    }
  }

  for (const task of goal.taskList?.tasks ?? []) {
    if (task.status === "complete") continue;
    const candidate = usableCandidate(task.title);
    if (candidate) {
      return {
        objective: candidate,
        verificationContract: normalizedText(goal.verificationContract) || undefined,
        source: "taskList",
        evidence: `pending task recovered after ${assessment.evidence}`,
        confidence: "best-effort",
      };
    }
  }

  const recap = usableCandidate(goal.completionSummary);
  if (recap && IMPERATIVE_START.test(recap)) {
    return {
      objective: recap,
      verificationContract: normalizedText(goal.verificationContract) || undefined,
      source: "completionSummary",
      evidence: `completion recap recovered after ${assessment.evidence}`,
      confidence: "best-effort",
    };
  }

  return null;
}

export function buildRepairTaskObjective(goal: Goal, assessment: SuspiciousObjectiveAssessment): string {
  return `Repair suspicious objective: ${normalizedText(goal.objective).slice(0, 180)} (${assessment.reasons.join(", ")})`;
}

export function buildAutoRepairRecord(
  goal: Goal,
  proposal: ObjectiveRepairProposal,
  at: string,
): ObjectiveRepairRecord {
  return {
    at,
    action: "auto-applied",
    originalObjective: goal.objective,
    replacementObjective: proposal.objective,
    originalContract: goal.verificationContract,
    replacementContract: proposal.verificationContract,
    source: proposal.source,
    evidence: proposal.evidence,
    confidence: proposal.confidence,
  };
}

export function buildQueuedRepairRecord(goal: Goal, assessment: SuspiciousObjectiveAssessment, at: string): ObjectiveRepairRecord {
  return {
    at,
    action: "queued",
    originalObjective: goal.objective,
    originalContract: goal.verificationContract,
    source: "repair-queue",
    evidence: assessment.evidence,
    confidence: "fallback",
  };
}

export function appendObjectiveRepairRecord(goal: Goal, record: ObjectiveRepairRecord): void {
  goal.objectiveRepairHistory = [...(goal.objectiveRepairHistory ?? []), record].slice(-10);
}

export function hasQueuedObjectiveRepair(goal: Goal): boolean {
  return (goal.objectiveRepairHistory ?? []).some((record) =>
    record.action === "queued" && record.originalObjective === goal.objective,
  );
}

export function applyObjectiveRepair(goal: Goal, proposal: ObjectiveRepairProposal, at: string): ObjectiveRepairRecord {
  const record = buildAutoRepairRecord(goal, proposal, at);
  goal.objective = proposal.objective;
  goal.verificationContract = proposal.verificationContract;
  goal.revision = (goal.revision ?? 0) + 1;
  goal.updatedAt = at;
  appendObjectiveRepairRecord(goal, record);
  return record;
}
