/**
 * pi-goal-list-loop-audit — v0.2.0
 * extensions/goal-loop-shield.ts
 *
 * regression_shield — pure, dependency-free enforcement logic.
 *
 * When a goal has a verification contract, an <approved/> verdict is only
 * accepted if the auditor's report carries an <evidence> section that
 * references every contract item. This kills the "auditor ran bash true and
 * approved" class of bamboozle that pi-goal-x's author explicitly documented
 * as a known hole.
 *
 * Kept free of pi imports so unit tests can exercise it under plain node.
 */

/** Split a verification contract into its individual checkable items. */
export function contractItems(contract: string): string[] {
  return contract
    .split("\n")
    .map((l) => l.trim())
    .map((l) => l.replace(/^(?:done when|verify|verified when|verification|done)\s*:\s*/i, ""))
    .map((l) => l.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, ""))
    .filter((l) => l.length > 0)
    // Boundary lines ("Out of scope: ...") constrain the auditor's judgment;
    // they are not deliverables and have no evidence to quote (v0.22.6).
    .filter((l) => !/^out of scope\b/i.test(l))
    // Preamble lines are not checkable items (v0.23.4, darklord field bug:
    // "Done when ALL of the following are true:" survived as an "item" —
    // the prefix strip only fires when a colon directly follows "done
    // when" — and the shield then blocked TWO genuine approvals forever,
    // because no evidence can reference a preamble). Two mechanical
    // predicates: a line still ending in a colon introduces a list, and a
    // "(done when) (all of) the following ..." line IS the introducer.
    .filter((l) => !l.endsWith(":"))
    .filter((l) => !/^(?:done when\s+)?(?:all of\s+)?the following\b/i.test(l));
}

export interface RegressionShieldResult {
  passed: boolean;
  missingItems: string[];
  hasEvidenceBlock: boolean;
}

/** Strip prose punctuation glued to a token ("file/element." → "file/element").
 * v0.34.77 (GitHub #5): Unicode-aware — \p{L}\p{N} with the /u flag keeps
 * CJK letters. The old ASCII-only class treated every Chinese character as
 * punctuation, so a pure-Chinese token like 调研报告文件 shrank to nothing. */
function stripEdgePunct(w: string): string {
  return w.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}/_.-]+$/u, "");
}

/**
 * Is a candidate token present in the report? Compound tokens joined by
 * "-" or "/" (left-cropped, file/element, Phaser/Svelte) count as present
 * when ALL their segments (len >= 3) appear — a good-faith report writes
 * "no cropped strip on the left", not the contract's literal compound.
 */
function tokenPresent(candidate: string, reportLower: string): boolean {
  const c = candidate.toLowerCase();
  if (reportLower.includes(c)) return true;
  // v0.34.77 (GitHub #5): Han (CJK) tokens match by exact substring only —
  // Chinese words have no compound-segment decomposition, so the ASCII
  // segment rule below would wrongly reject a quoted 章节 line.
  if (/\p{Script=Han}/u.test(c)) return reportLower.includes(c);
  const segments = c.split(/[-/]+/).filter((s) => s.length >= 3);
  return segments.length > 1 && segments.every((s) => reportLower.includes(s));
}

/** v0.34.77 (GitHub #5): punctuation-edge-normalized lowercase for the
 * no-candidate fallback — a verbatim quote that drops the item's trailing
 * full-width colon (章节： → 章节) still counts as a reference. */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "").replace(/\s+/g, " ");
}

/**
 * Check an approved auditor report against the verification contract.
 * Rules (deliberately simple + auditable):
 *   1. The report must contain an <evidence> ... </evidence> block.
 *   2. Every contract item must be referenced inside the report by ANY of
 *      its top-3 longest tokens (>= 5 chars, edge punctuation stripped;
 *      compounds match via their segments). v0.22.6: the previous
 *      single-longest-word rule false-rejected genuine approvals when the
 *      longest word was contract-only vocabulary ("left-cropped") or had
 *      prose punctuation glued on ("file/element.") — three real approved
 *      audits on hegemon were converted to disapprovals that way.
 */
export function checkRegressionShield(report: string, contract: string): RegressionShieldResult {
  const hasEvidenceBlock = /<evidence>[\t\n\r ]*[\s\S]*?<\/evidence>/i.test(report);
  const items = contractItems(contract);
  const missingItems: string[] = [];
  const reportLower = report.toLowerCase();
  for (const item of items) {
    // v0.34.77 (GitHub #5): Unicode-aware token split — \p{L}\p{N} treats
    // CJK characters as letters, so a pure-Chinese contract line is ONE
    // candidate token instead of a pile of delimiters.
    const candidates = item
      .split(/[^\p{L}\p{N}_.\-/]+/u)
      .map(stripEdgePunct)
      .filter((w) => w.length >= 5)
      .sort((a, b) => b.length - a.length)
      .slice(0, 3);
    const addressed = candidates.length > 0
      ? candidates.some((c) => tokenPresent(c, reportLower))
      : reportLower.includes(normalizeForMatch(item));
    if (!addressed) missingItems.push(item);
  }
  return {
    passed: hasEvidenceBlock && missingItems.length === 0,
    missingItems,
    hasEvidenceBlock,
  };
}

/**
 * v0.24.2: pure auditor-verdict parser (approved / disapproved / impossible).
 * Lives here (not goal-loop-auditor.ts) so tests can import it without
 * dragging in the auditor's relative .js imports. The verdict is read from
 * the last output block that mentions any verdict tag.
 */
export function parseAuditorVerdict(output: string): { approved: boolean; disapproved: boolean; impossible: boolean; impossibleReason?: string } {
  const parts = output.split("\n\n");
  const lastAssistant = [...parts].reverse().find((t) => /<\/?(approved|disapproved|impossible)[ />]/i.test(t)) ?? output;
  const impossibleMatch = /<impossible>([\s\S]*?)<\/impossible>/i.exec(lastAssistant);
  return {
    approved: /<approved\/>/i.test(lastAssistant),
    disapproved: /<disapproved\/>/i.test(lastAssistant),
    impossible: impossibleMatch !== null,
    impossibleReason: impossibleMatch?.[1]?.trim().slice(0, 300) || undefined,
  };
}

/**
 * v0.35.7: Extract mechanical shell command gates from a verification contract.
 * Captures explicit commands (e.g. `npm test`, `tsc --noEmit`, `cargo test`)
 * for deterministic fast-fail pre-auditing before spawning the heavy LLM worker.
 */
export function extractMechanicalCheckCommands(contract: string): string[] {
  if (!contract) return [];
  const items = contractItems(contract);
  const commands: string[] = [];
  for (const item of items) {
    const backtickMatch = /`([^`]+)`/.exec(item);
    const candidate = backtickMatch ? backtickMatch[1]!.trim() : item.trim();
    if (/^(?:npm\s+(?:test|run\s+[\w:-]+)|bun\s+(?:test|run\s+[\w:-]+)|pnpm\s+(?:test|run\s+[\w:-]+)|yarn\s+(?:test|[\w:-]+)|tsc\b|cargo\s+(?:test|check|build)|pytest\b|python\s+-m\s+unittest|go\s+test|vitest\b|jest\b|make\s+test|git\s+diff|test\s+-[a-z])/i.test(candidate)) {
      commands.push(candidate);
    }
  }
  return commands;
}

export interface MechanicalCheckResult {
  passed: boolean;
  failedCommand?: string;
  output?: string;
  exitCode?: number;
}

/**
 * v0.35.7: Execute mechanical pre-audit checks deterministically.
 */
export function runMechanicalPreAuditChecks(cwd: string, commands: string[], timeoutMs = 60000): MechanicalCheckResult {
  if (!commands || commands.length === 0) return { passed: true };
  const { execSync } = require("node:child_process");
  for (const cmd of commands) {
    try {
      execSync(cmd, { cwd, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" });
    } catch (err: any) {
      const exitCode = typeof err.status === "number" ? err.status : (typeof err.code === "number" ? err.code : 1);
      const stdout = err.stdout ? String(err.stdout) : "";
      const stderr = err.stderr ? String(err.stderr) : "";
      const output = (stdout + "\n" + stderr).trim() || err.message || "Command failed";
      return {
        passed: false,
        failedCommand: cmd,
        output: output.slice(0, 4000),
        exitCode,
      };
    }
  }
  return { passed: true };
}

