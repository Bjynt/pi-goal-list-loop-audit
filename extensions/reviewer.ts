// pi-goal-list-loop-audit — v0.26.0
// extensions/reviewer.ts
//
// The Reviewer: post-completion follow-up enqueuer. Fires after a /goal
// completes or a /list queue empties, extracts findings from the archive
// + ledger, classifies them by leverage, writes a review report, and
// cascades: bug/refactor findings → /list items (no Confirm, per the
// leverage principle), architectural findings → /goal proposal (Confirm),
// clean completions → audit /goal proposal, strategic-only → notify+idle.
//
// Deterministic by design (REVIEWER-DESIGN-2026-07-24: "makes NO new tool
// calls — purely analytical"). All side effects are injected so tests
// drive it without a pi host. /loop completions never trigger it.

import * as fs from "node:fs";
import * as path from "node:path";

export interface ReviewerConfig {
  enabled: boolean;
  fireOn: Array<"goal-complete" | "list-complete">;
  doNotFireOn: string[];
  cascade: Array<"convert-findings-to-list" | "queue-leftovers" | "fire-audit-on-clean" | "notify-and-idle">;
  auditCadence: string;
  auditScope: string;
  leverageMode: "fix-without-confirm" | "confirm-all";
  confirmOn: string[];
  maxFindingsPerReview: number;
  maxReviewsPerDay: number;
}

export const DEFAULT_REVIEWER_CONFIG: ReviewerConfig = {
  enabled: true,
  fireOn: ["goal-complete", "list-complete"],
  doNotFireOn: ["goal-aborted", "goal-paused"],
  cascade: ["convert-findings-to-list", "queue-leftovers", "fire-audit-on-clean", "notify-and-idle"],
  auditCadence: "every-clean-completion",
  auditScope: "regression-scan",
  leverageMode: "fix-without-confirm",
  confirmOn: ["architectural-decision", "new-dependency", "schema-change"],
  maxFindingsPerReview: 10,
  maxReviewsPerDay: 20,
};

/** Merge a partial project-settings block over the defaults. */
export function resolveReviewerConfig(block?: Partial<ReviewerConfig>): ReviewerConfig {
  return { ...DEFAULT_REVIEWER_CONFIG, ...(block ?? {}) };
}

export type FindingClass = "bug" | "refactor" | "architectural" | "strategic";

export interface Finding {
  text: string;
  source: string;
  class: FindingClass;
}

/** Leverage classification (contract item 5). Order matters: strategic
 * and architectural win over bug/refactor — "should we rewrite this
 * broken schema" is a decision, not a fix. */
const CLASS_PATTERNS: Array<{ class: FindingClass; re: RegExp }> = [
  { class: "strategic", re: /\bshould we\b|\bdeprecat|ship this\??|strategic/i },
  { class: "architectural", re: /\brewrite\b|new dependency|schema change|architectural|redesign/i },
  { class: "bug", re: /\bTODO\b|\bFIXME\b|\bbug\b|\bissue\b|regression|broken|\bfixme\b/i },
  { class: "refactor", re: /could be cleaner|consider refactoring|duplicat|refactor|left ?out|follow[\s-]?up|deferred/i },
];

export function classifyFindingText(line: string): FindingClass | undefined {
  const t = line.trim();
  if (t.length < 8) return undefined;
  for (const { class: cls, re } of CLASS_PATTERNS) {
    if (re.test(t)) return cls;
  }
  return undefined;
}

/** Scan source texts line-by-line for finding-shaped content. */
export function extractFindings(sources: Array<{ name: string; text: string }>, max: number): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const { name, text } of sources) {
    for (const line of text.split("\n")) {
      const cls = classifyFindingText(line);
      if (!cls) continue;
      const clean = line.trim().replace(/^[-*>\s\[\]x]+/, "").slice(0, 200);
      if (clean.length < 8 || seen.has(clean)) continue;
      seen.add(clean);
      out.push({ text: clean, source: name, class: cls });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Runaway prevention (contract item 6/9): a reviewer fire in the last
 * `windowMs` suppresses re-firing — reviewer-created work completing
 * immediately must not recursively fire the reviewer. */
export function reviewerFiredRecently(entries: Array<{ type: string; at?: string }>, windowMs: number, nowMs: number): boolean {
  return entries.some((e) => e.type === "reviewer_fired" && e.at !== undefined && nowMs - Date.parse(e.at) < windowMs);
}

/** Per-day cap (contract item 10). */
export function reviewsToday(entries: Array<{ type: string; at?: string }>, nowMs: number): number {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return entries.filter((e) => e.type === "reviewer_fired" && e.at?.startsWith(day)).length;
}

export interface ReviewReport {
  goalId: string;
  kind: "goal" | "list";
  objective: string;
  findings: Finding[];
  cascadeStep: string;
  at: string;
}

export function formatReviewReport(r: ReviewReport): string {
  const byClass = (c: FindingClass) => r.findings.filter((f) => f.class === c);
  const section = (title: string, items: Finding[]) =>
    items.length === 0 ? "" : `\n## ${title}\n\n${items.map((f) => `- ${f.text} _(${f.source})_`).join("\n")}\n`;
  return [
    `# Review — ${r.goalId}`,
    "",
    `**Kind**: ${r.kind} · **At**: ${r.at}`,
    "",
    "## Summary",
    "",
    `Completed: ${r.objective.slice(0, 300)}`,
    "",
    `**Cascade step**: ${r.cascadeStep}`,
    "",
    `## Findings (${r.findings.length})`,
    section("Bug-class (enqueued to /list, no Confirm)", byClass("bug")),
    section("Refactor-class (enqueued to /list, no Confirm)", byClass("refactor")),
    section("Architectural-class (proposed as /goal, Confirm required)", byClass("architectural")),
    section("Strategic-class (notify only)", byClass("strategic")),
    r.findings.length === 0 ? "\n(none — completion looks clean)\n" : "",
  ].join("\n");
}

export function writeReviewReport(cwd: string, report: ReviewReport): string {
  const dir = path.join(cwd, ".pi-glla", "reviews");
  fs.mkdirSync(dir, { recursive: true });
  const ts = report.at.replace(/[:.]/g, "-");
  const file = path.join(dir, `${report.goalId}-${ts}.md`);
  fs.writeFileSync(file, formatReviewReport(report));
  return file;
}

/** Injectable side effects — goal.ts binds these to the live session. */
export interface ReviewerDeps {
  cwd: string;
  nowMs: number;
  /** /review <id> manual invocation — bypasses fireOn/doNotFireOn gates,
   * the refire window, and the day cap (the user asked explicitly). */
  manual?: boolean;
  ledgerEntries: Array<{ type: string; at?: string; value?: any }>;
  /** Source texts for finding extraction (archive md, audit reports). */
  sources: Array<{ name: string; text: string }>;
  enqueueListItems: (objectives: string[]) => void;
  proposeGoal: (objective: string, reason: string) => void;
  notify: (message: string, level: "info" | "warning") => void;
  ledger: (type: string, value: Record<string, unknown>) => void;
}

export interface ReviewerOutcome {
  fired: boolean;
  suppressedReason?: string;
  report?: ReviewReport;
  reportPath?: string;
  enqueued: number;
  proposed: number;
}

export const REVIEWER_REFIRE_WINDOW_MS = 5 * 60_000;

/** The reviewer lifecycle (contract item 1). */
export function runReviewer(
  config: ReviewerConfig,
  source: { kind: "goal" | "list"; goalId: string; objective: string; terminal: string },
  deps: ReviewerDeps,
): ReviewerOutcome {
  const none = (suppressedReason: string): ReviewerOutcome => ({ fired: false, suppressedReason, enqueued: 0, proposed: 0 });
  if (!config.enabled && !deps.manual) return none("reviewer disabled");
  const event = source.kind === "goal" ? `${source.terminal}` : "list-complete";
  if (!deps.manual) {
    if (config.doNotFireOn.includes(event)) return none(`doNotFireOn: ${event}`);
    if (source.kind === "goal" && source.terminal !== "goal-complete") return none(`not a completion: ${source.terminal}`);
    if (!config.fireOn.includes(source.kind === "goal" ? "goal-complete" : "list-complete")) return none("fireOn excludes this event");
    if (reviewerFiredRecently(deps.ledgerEntries, REVIEWER_REFIRE_WINDOW_MS, deps.nowMs)) {
      deps.ledger("reviewer_suppressed", { reason: "refire-window", goalId: source.goalId });
      return none("reviewer fired within the last 5 minutes (runaway prevention)");
    }
    const today = reviewsToday(deps.ledgerEntries, deps.nowMs);
    if (today >= config.maxReviewsPerDay) {
      deps.ledger("reviewer_suppressed", { reason: "day-cap", count: today, cap: config.maxReviewsPerDay, goalId: source.goalId });
      return none(`day cap reached (${today}/${config.maxReviewsPerDay})`);
    }
  }

  const findings = extractFindings(deps.sources, config.maxFindingsPerReview);
  const bugs = findings.filter((f) => f.class === "bug" || f.class === "refactor");
  const architectural = findings.filter((f) => f.class === "architectural");
  const strategic = findings.filter((f) => f.class === "strategic");

  let enqueued = 0;
  let proposed = 0;
  let cascadeStep = "notify-and-idle";

  // Cascade: findings → list items (leverage: fix-without-confirm).
  const convertStep = source.kind === "goal" ? "convert-findings-to-list" : "queue-leftovers";
  if (bugs.length > 0 && config.cascade.includes(convertStep)) {
    deps.enqueueListItems(bugs.map((f) => f.text));
    enqueued = bugs.length;
    cascadeStep = convertStep;
  }
  // Architectural findings → /goal proposal WITH Confirm.
  if (architectural.length > 0) {
    deps.proposeGoal(
      architectural.map((f) => f.text).join("; "),
      `reviewer found ${architectural.length} architectural-class finding(s) — needs your Confirm`,
    );
    proposed += architectural.length;
    cascadeStep = "propose-goal";
  }
  // Clean completion → audit /goal (opt-in cascade step).
  if (findings.length === 0 && config.cascade.includes("fire-audit-on-clean")) {
    deps.proposeGoal(
      `Post-completion regression scan after ${source.goalId} (${config.auditScope})`,
      "reviewer: completion looks clean — firing the audit step",
    );
    proposed++;
    cascadeStep = "fire-audit-on-clean";
  }

  const report: ReviewReport = {
    goalId: source.goalId,
    kind: source.kind,
    objective: source.objective,
    findings,
    cascadeStep,
    at: new Date(deps.nowMs).toISOString(),
  };
  const reportPath = writeReviewReport(deps.cwd, report);
  deps.ledger("reviewer_fired", {
    goalId: source.goalId,
    kind: source.kind,
    findings: findings.length,
    enqueued,
    proposed,
    cascadeStep,
    report: path.relative(deps.cwd, reportPath),
  });
  deps.notify(
    `Reviewer: ${findings.length} finding(s) — ${enqueued} enqueued to /list, ${proposed} proposed as /goal (${cascadeStep}). Report: ${path.relative(deps.cwd, reportPath)}`,
    "info",
  );
  if (strategic.length > 0) {
    deps.notify(`Reviewer: ${strategic.length} strategic finding(s) need YOUR call — see the report's Strategic section.`, "warning");
  }
  return { fired: true, report, reportPath, enqueued, proposed };
}
