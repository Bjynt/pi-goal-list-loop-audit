import type { Goal, Status } from "./goal-loop-core.js";

/**
 * The durable, user-facing terminal recap contract. Keep this as a small
 * string contract rather than a second verdict object: the auditor's report
 * remains independent evidence.
 */
export const COMPLETION_SUMMARY_LABELS = [
  "Outcome:",
  "Changed:",
  "Evidence:",
  "Tests:",
  "Unresolved:",
  "Next:",
] as const;

export type CompletionSummaryLabel = typeof COMPLETION_SUMMARY_LABELS[number];

export interface CompletionSummaryResolution {
  summary: string;
  usedFallback: boolean;
  reason?: "missing" | "generic" | "incomplete";
  raw?: string;
}

export interface CompletionSummaryFacts {
  goal: Goal;
  status: Status;
  stopReason?: string;
  archivePath?: string;
}

function labelIndex(text: string, label: CompletionSummaryLabel): number {
  return text.toLowerCase().indexOf(label.toLowerCase());
}

/** Return labels that are absent or have no value after the label. */
export function missingCompletionSummaryLabels(text: string): CompletionSummaryLabel[] {
  const normalized = text.trim();
  return COMPLETION_SUMMARY_LABELS.filter((label) => {
    const start = labelIndex(normalized, label);
    if (start < 0) return true;
    const valueStart = start + label.length;
    const next = COMPLETION_SUMMARY_LABELS
      .map((candidate) => labelIndex(normalized.slice(valueStart), candidate))
      .filter((index) => index >= 0)
      .map((index) => valueStart + index)
      .sort((a, b) => a - b)[0];
    return normalized.slice(valueStart, next ?? normalized.length).trim().length === 0;
  });
}

export function isGenericCompletionSummary(text: string): boolean {
  return /^\s*(?:done|complete|completed|shipped|fixed|finished|all\s+done)\s*[.!]?\s*$/i.test(text.trim());
}

/** A recap is useful only when every label has a non-empty value. */
export function isUsefulCompletionSummary(text: string | undefined): boolean {
  if (!text?.trim() || isGenericCompletionSummary(text)) return false;
  return missingCompletionSummaryLabels(text).length === 0;
}

/**
 * Project a durable six-label recap into one bounded notification line.
 * Terminal state keeps the complete multi-line text; this projection is only
 * for chat/UI/external surfaces where six short facts must remain scannable.
 * Missing labels are retained as `not recorded` so a compact notification
 * cannot accidentally imply evidence that the durable recap did not contain.
 */
export function compactCompletionSummary(text: string | undefined, maxValueLength = 72): string {
  const source = text?.replace(/\\s+/g, " ").trim();
  if (!source) return "not recorded";
  const lower = source.toLowerCase();
  const limit = Math.max(8, Math.floor(maxValueLength));
  const positions = COMPLETION_SUMMARY_LABELS
    .map((label) => ({ label, start: lower.indexOf(label.toLowerCase()) }))
    .filter((entry) => entry.start >= 0);
  const parts = COMPLETION_SUMMARY_LABELS.map((label) => {
    const current = positions.find((entry) => entry.label === label);
    const name = label.slice(0, -1);
    if (!current) return `${name}: not recorded`;
    const valueStart = current.start + label.length;
    const nextStart = positions
      .filter((entry) => entry.start > current.start)
      .map((entry) => entry.start)
      .sort((a, b) => a - b)[0] ?? source.length;
    const rawValue = source.slice(valueStart, nextStart).trim();
    const value = rawValue || "not recorded";
    return `${name}: ${value.length > limit ? `${value.slice(0, limit - 1)}…` : value}`;
  });
  return parts.join(" · ");
}

function safeFact(value: unknown, fallback = "not recorded"): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text || fallback;
}

function objectiveExcerpt(objective: string): string {
  const clean = safeFact(objective);
  return clean.length > 220 ? `${clean.slice(0, 217)}…` : clean;
}

function stopReasonExcerpt(reason: string | undefined): string {
  const clean = safeFact(reason);
  return clean.length > 260 ? `${clean.slice(0, 257)}…` : clean;
}

function auditEvidence(goal: Goal): string {
  const history = goal.auditHistory;
  const latest = history && history.length > 0 ? history[history.length - 1] : undefined;
  if (!latest) return "no auditor verdict was recorded";
  const verdict = latest.approved ? "approved" : latest.impossible ? "impossible" : latest.disapproved ? "disapproved" : "no verdict";
  const model = safeFact(latest.model, "unknown model");
  return `latest auditor verdict=${verdict} by ${model} at ${safeFact(latest.at)}`;
}

function executionEvidence(goal: Goal): string {
  const telemetry = goal.telemetry;
  if (!telemetry) return "no execution telemetry was recorded";
  return `${telemetry.turns} turns, ${telemetry.fileWrites} file-write signals, and ${telemetry.bashCalls} bash calls were recorded`;
}

/**
 * Build a fallback from facts already present in durable GLLA state. This
 * intentionally does not inspect the working tree or infer that a command
 * passed: absent facts are named as absent instead of being invented.
 */
export function buildRecordedFactsCompletionSummary(facts: CompletionSummaryFacts): string {
  const { goal, status, stopReason, archivePath } = facts;
  const hasFileSignals = (goal.telemetry?.fileWrites ?? 0) > 0;
  const changed = hasFileSignals
    ? `${goal.telemetry!.fileWrites} file-write signal(s) were recorded; changed paths were not captured`
    : "not recorded — no file-write signal was captured";
  const tests = goal.verificationContract
    ? "not recorded — a verification contract was present, but no terminal test result was captured"
    : "not recorded — no terminal test result was captured";
  const unresolved = stopReason
    ? `terminal reason: ${stopReasonExcerpt(stopReason)}`
    : "not recorded";
  const next = archivePath
    ? `review the durable record at ${archivePath}`
    : "review the durable archived record";

  return [
    `Outcome: Objective "${objectiveExcerpt(goal.objective)}" archived with status=${status}.`,
    `Changed: ${changed}.`,
    `Evidence: goal ${safeFact(goal.id)}; ${executionEvidence(goal)}; ${auditEvidence(goal)}.`,
    `Tests: ${tests}.`,
    `Unresolved: ${unresolved}.`,
    `Next: ${next}.`,
  ].join("\n");
}

/** Resolve a caller claim into the exact durable recap written at terminalization. */
export function resolveCompletionSummary(
  facts: CompletionSummaryFacts,
  candidate = facts.goal.completionSummary,
): CompletionSummaryResolution {
  const raw = candidate?.trim();
  if (raw && isUsefulCompletionSummary(raw)) {
    return { summary: raw, usedFallback: false };
  }
  const reason: CompletionSummaryResolution["reason"] = !raw
    ? "missing"
    : isGenericCompletionSummary(raw)
      ? "generic"
      : "incomplete";
  return {
    summary: buildRecordedFactsCompletionSummary(facts),
    usedFallback: true,
    reason,
    ...(raw ? { raw } : {}),
  };
}

/**
 * Loop terminal states use the same six-label user-facing contract. Loop
 * state is converted to the smaller Goal-shaped fact set by the caller, so
 * this module remains independent of the loop runtime.
 */
/** Lifecycle/recovery holds are not terminal outcomes even though the loop
 * is temporarily inactive. All other explicit stop reasons receive a recap. */
export function isTerminalLoopStopReason(stopReason: string | undefined): boolean {
  if (!stopReason?.trim()) return false;
  const transient = [
    "held: restored in a fresh session",
    "extension api stale",
    "stalled: continuation refires landed no turn",
    "stalled: continuation start acknowledgement timed out",
    "send-retry storm:",
    "main model recovery",
  ];
  return !transient.some((prefix) => stopReason === prefix || stopReason.startsWith(prefix));
}

export function buildLoopCompletionSummary(facts: {
  target: string;
  stopReason: string;
  iteration: number;
  bestValue: number | null;
  historyLength: number;
}): string {
  const reason = safeFact(facts.stopReason);
  const best = facts.bestValue === null ? "not recorded" : String(facts.bestValue);
  return [
    `Outcome: Loop "${objectiveExcerpt(facts.target)}" stopped with reason: ${reason}.`,
    "Changed: not recorded — the loop does not persist a changed-file manifest in its terminal state.",
    `Evidence: ${facts.iteration} iteration(s), ${facts.historyLength} measurement record(s), best=${best}.`,
    "Tests: not recorded — no terminal test result was captured by the loop supervisor.",
    `Unresolved: ${reason}.`,
    "Next: review the loop history and resume or start a new loop when the stop reason is understood.",
  ].join("\n");
}
