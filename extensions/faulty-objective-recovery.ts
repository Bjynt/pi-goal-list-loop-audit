/**
 * Durable suspicious-objective recovery.
 *
 * This module only classifies persisted text and selects already-recorded
 * intent. Callers own state mutation, queueing, and UI side effects; no repair
 * path creates a model turn or asks a model to invent an objective.
 */

import type { Goal, ObjectiveRepairRecord } from "./goal-loop-core.js";

export type SuspiciousObjectiveReason =
  | "empty"
  | "archive-metadata"
  | "verification-fragment"
  | "reviewer-fragment"
  | "heading"
  | "numbered-audit-fragment"
  | "command-only"
  | "marker-only"
  | "dangling-fragment"
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
  reason: string;
  evidence: string;
  confidence: "best-effort";
}

const IMPERATIVE_START = /^(add|allow|audit|build|cap|clarify|close|create|detect|document|ensure|fix|improve|implement|investigate|make|prevent|research|restore|support|test|update|verify|write|remove|repair|review|refactor|replace|preserve|resolve)\b/i;
const COMMAND_ONLY = /^(?:bun|npm|pnpm|yarn|npx|node|deno|git)\s+(?:test|run|check|diff|status|show|log|exec)\b/i;
const REVIEWER_MARKER = /^(?:audit|review|verdict|evidence|output|item|required\s+fixes?|completion\s+claim)\s*:/i;
const REVIEWER_VOCABULARY = /\b(?:passes\s+sequentially|zero\s+failures?|\d+\s+failures?|ran\s+\d+\s+tests?|verification\s+contract|regression\s+shield|auditor(?:[- ](?:approved|report|disapproved))?|completion\s+claim|<\/?(?:evidence|approved|disapproved|impossible)\b)\b/i;
const SEMANTIC_REVIEW_FRAGMENT = /\b(?:now\s+)?i\s+(?:need|should|must)\s+(?:to\s+)?(?:verify|check|inspect|confirm)\b/i;
const DANGling_END = /\b(?:or|and|but|to|with|because|if|when|of|the|a|an|in|for|from)\s*$/i;

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** Remove only explicit archive decoration. Never turn the valid objective
 * `Implement archive` into the incoherent objective `Implement`. */
function stripArchiveDecoration(text: string): string {
  return text
    .replace(/^\s*>\s*/, "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\s*\(\s*archive\s*\)\s*$/i, "")
    .replace(/\s*[_*`~]+archive[_*`~]+\s*$/i, "")
    .trim();
}

function archiveMetadata(text: string): boolean {
  return /^(?:archive|archived|\(?[_*`~]*archive[_*`~]*\)?)$/i.test(text)
    || /\b(?:archive[- ]derived|archive\s+metadata|archived\s+objective|objective\s+archive)\b/i.test(text)
    || /\(\s*archive\s*\)\s*$/i.test(text);
}

function isAuditLikeNumberedText(text: string): boolean {
  return /^\d+[.)]\s+/.test(text)
    && /\b(?:guard|evidence|revision|generation|stale|archive|repair|auditor|test|suite|required|fix|dispatch|provenance)\b/i.test(text);
}

export function assessSuspiciousObjective(objective: unknown, verificationContract?: unknown): SuspiciousObjectiveAssessment {
  const text = normalizedText(objective);
  const contract = normalizedText(verificationContract);
  const reasons: SuspiciousObjectiveReason[] = [];

  if (!text) reasons.push("empty");
  if (archiveMetadata(text)) reasons.push("archive-metadata");
  if (REVIEWER_MARKER.test(text) || REVIEWER_VOCABULARY.test(text)) reasons.push("verification-fragment");
  if (/^#{1,6}\s+\S/.test(text)) reasons.push("heading");
  if (isAuditLikeNumberedText(text)) reasons.push("numbered-audit-fragment");
  if (SEMANTIC_REVIEW_FRAGMENT.test(text)) reasons.push("reviewer-fragment");
  if (DANGling_END.test(text)) reasons.push("dangling-fragment");
  if (COMMAND_ONLY.test(text) && !contract) reasons.push("command-only");
  if (/^(?:done when|verify|objective|tasks?)\s*:??\s*$/i.test(text)) reasons.push("marker-only");
  // Lowercase prose is valid in some list items. It becomes suspicious only
  // when it also looks like evaluator prose, rather than merely because it is
  // lowercase.
  if (text && /^[a-z]/.test(text) && !IMPERATIVE_START.test(text) && /\b(?:passes|including|protections|contract|auditor|verification)\b/i.test(text)) {
    reasons.push("lowercase-fragment");
  }

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
  if (assessment.suspicious) return null;
  return candidate;
}

function usableContract(text: unknown): string | undefined {
  const candidate = normalizedText(text);
  if (!candidate || candidate.length < 8) return undefined;
  // A completion report/evidence tail is durable context, not a replacement
  // contract. Do not promote it into the contract field.
  if (REVIEWER_MARKER.test(candidate) || REVIEWER_VOCABULARY.test(candidate) || /<\/?(?:evidence|approved|disapproved)\b/i.test(candidate)) return undefined;
  return candidate;
}

function seedObjective(seed: unknown): string | null {
  const raw = normalizedText(seed);
  if (!raw) return null;
  // A raw seed can carry an inline contract. Keep the intent before the
  // marker, never the contract/report tail.
  return usableCandidate(raw.split(/\b(?:done\s+when|verify)\s*:/i)[0]);
}

function repairContract(goal: Goal): { value?: string; source: string } {
  const candidates: Array<[string, unknown]> = [
    ["current contract", goal.verificationContract],
    ["original contract", goal.objectiveProvenance?.originalContract],
    ["pending verification summary", goal.pendingCompletion?.verificationSummary],
  ];
  for (const [source, value] of candidates) {
    const usable = usableContract(value);
    if (usable) return { value: usable, source };
  }
  return { source: "no coherent durable contract" };
}

function durableSources(goal: Goal): string[] {
  const sources: string[] = [];
  if (goal.objectiveProvenance?.originalObjective) sources.push("original record");
  if ((goal.objectiveProvenance?.userSeeds ?? []).length > 0) sources.push("user seed");
  if ((goal.pendingTasks ?? []).length > 0) sources.push("pending tasks");
  if ((goal.taskList?.tasks ?? []).length > 0) sources.push("task list");
  if (goal.pendingCompletion?.verificationSummary) sources.push("pending verification summary");
  if ((goal.auditHistory ?? []).length > 0) sources.push("audit history");
  if (goal.completionSummary) sources.push("completion context");
  return sources;
}

function proposalFrom(
  goal: Goal,
  assessment: SuspiciousObjectiveAssessment,
  objective: string,
  source: string,
  reason: string,
): ObjectiveRepairProposal {
  const contract = repairContract(goal);
  const sources = durableSources(goal);
  return {
    objective,
    verificationContract: contract.value,
    source,
    reason,
    evidence: `${assessment.evidence}; consulted ${sources.length > 0 ? sources.join(", ") : "no durable provenance"}${contract.source === "no coherent durable contract" ? "; no replacement contract applied" : `; contract from ${contract.source}`}`,
    confidence: "best-effort",
  };
}

function approvedCompletionContext(goal: Goal): string | null {
  const latest = goal.auditHistory?.at(-1);
  if (!latest?.approved || latest.disapproved || latest.regressionShieldPassed === false) return null;
  return usableCandidate(goal.completionSummary);
}

/**
 * Choose only durable, already-recorded intent. This is intentionally not a
 * model call: event handlers must not create a turn or invent a task. The
 * original record and explicit user seed win over task/reviewer prose.
 */
export function deriveObjectiveRepair(goal: Goal, assessment: SuspiciousObjectiveAssessment): ObjectiveRepairProposal | null {
  if (!assessment.suspicious) return null;
  const current = normalizedText(goal.objective);
  const candidates: Array<[string, string | null, string]> = [];
  const provenance = goal.objectiveProvenance;
  candidates.push(["original-record", seedObjective(provenance?.originalObjective), "restored the durable original objective"]);
  for (const seed of provenance?.userSeeds ?? []) {
    candidates.push(["user-seed", seedObjective(seed), "restored an explicit user-supplied seed"]);
  }
  for (const task of goal.pendingTasks ?? []) {
    candidates.push(["pendingTasks", usableCandidate(task), "recovered the next durable pending task"]);
  }
  for (const task of goal.taskList?.tasks ?? []) {
    if (task.status === "complete") continue;
    candidates.push(["taskList", usableCandidate(task.title), "recovered the next incomplete durable task"]);
  }
  // completionSummary is not trusted merely because it is present. It is
  // eligible only when the durable audit history says that context passed.
  candidates.push(["verifiedCompletionContext", approvedCompletionContext(goal), "restored a completion context already approved by the auditor"]);

  for (const [source, candidate, reason] of candidates) {
    if (candidate && candidate !== current) return proposalFrom(goal, assessment, candidate, source, reason);
  }
  return null;
}

/** The repair item itself must be ordinary, actionable work. In particular it
 * must not echo the malformed/reviewer text or its reason codes, because that
 * would recursively trip the same gate when the repair item is activated. */
export function buildRepairTaskObjective(goal: Goal, _assessment: SuspiciousObjectiveAssessment): string {
  return `Repair the blocked ${goal.policy === "list" ? "list item" : "goal"} from saved intent`;
}

export function buildAutoRepairRecord(
  goal: Goal,
  proposal: ObjectiveRepairProposal,
  at: string,
  revisionBefore = goal.revision ?? 0,
): ObjectiveRepairRecord {
  return {
    at,
    action: "auto-applied",
    originalObjective: goal.objective,
    replacementObjective: proposal.objective,
    originalContract: goal.verificationContract,
    replacementContract: proposal.verificationContract,
    source: proposal.source,
    reason: proposal.reason,
    evidence: proposal.evidence,
    confidence: proposal.confidence,
    revisionBefore,
    revisionAfter: revisionBefore + 1,
  };
}

export function buildQueuedRepairRecord(goal: Goal, assessment: SuspiciousObjectiveAssessment, at: string): ObjectiveRepairRecord {
  const revision = goal.revision ?? 0;
  return {
    at,
    action: "queued",
    originalObjective: goal.objective,
    originalContract: goal.verificationContract,
    source: "repair-queue",
    reason: `no coherent repair from ${durableSources(goal).join(", ") || "durable provenance"}`,
    evidence: assessment.evidence,
    confidence: "fallback",
    revisionBefore: revision,
    revisionAfter: revision,
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
  const before = goal.revision ?? 0;
  const record = buildAutoRepairRecord(goal, proposal, at, before);
  goal.objective = proposal.objective;
  if (proposal.verificationContract !== undefined) goal.verificationContract = proposal.verificationContract;
  goal.revision = before + 1;
  goal.updatedAt = at;
  appendObjectiveRepairRecord(goal, record);
  return record;
}
