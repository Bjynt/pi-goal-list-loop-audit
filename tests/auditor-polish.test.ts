// pi-goal-list-loop-audit — v0.25.4
// tests/auditor-polish.test.ts
//
// Auditor polish: durable audit log, think-block stripping, tail-aware
// excerpt, infra-transparent streaks, auditor-quiet widget.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  appendAuditLog,
  auditFeedbackExcerpt,
  auditLogPath,
  countTrailingDisapprovals,
  formatAuditLog,
  readAuditLog,
  stripThinkBlocks,
  type AuditLogEntry,
} from "../extensions/goal-loop-core.ts";
import { buildWidgetLines } from "../extensions/goal-loop-display.ts";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

test("stripThinkBlocks removes think bodies, fragments, and artifacts", () => {
  // Wild-caught shape (pully hsq4xq, 2026-07-25): leading think body:
  assert.equal(
    stripThinkBlocks("<think>let me check... 让我先把这些确认一下</think>\n## Audit result\nAll good."),
    "## Audit result\nAll good.",
  );
  // Stray fragments (pi-chrome eiq4zb): three orphan </think> tags:
  assert.equal(stripThinkBlocks("</think> </think> </think> Verifying the cited lines."), "Verifying the cited lines.");
  // Partial-tag artifact:
  assert.equal(stripThinkBlocks("<200b>卧槽，不对劲 done.\nReport body."), "卧槽，不对劲 done.\nReport body.");
  // An unterminated streamed block is private reasoning too; do not leak its
  // body into the widget/report if the provider never emitted the close tag.
  assert.equal(stripThinkBlocks("<think>partial private reasoning"), "");
  // Clean text untouched:
  assert.equal(stripThinkBlocks("## Audit result\nAll good."), "## Audit result\nAll good.");
});

test("audit log: append + read round-trip, malformed lines skipped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-auditlog-"));
  assert.deepEqual(readAuditLog(dir), []);
  const entry: AuditLogEntry = {
    at: "2026-07-25T20:00:00Z",
    goalId: "20260725-abc123",
    objective: "ship the thing",
    verdict: "disapproved",
    model: "MiniMax-M3",
    thinkingLevel: "high",
    report: "## Audit result\nMissing evidence.\n\n## Required fixes\n- add the test",
  };
  appendAuditLog(dir, entry);
  appendAuditLog(dir, { ...entry, verdict: "approved", at: "2026-07-25T21:00:00Z" });
  fs.appendFileSync(auditLogPath(dir), "not json\n");
  const all = readAuditLog(dir);
  assert.equal(all.length, 2);
  assert.equal(all[0]!.verdict, "disapproved");
  // Limit takes the NEWEST:
  const last1 = readAuditLog(dir, 1);
  assert.equal(last1.length, 1);
  assert.equal(last1[0]!.verdict, "approved");
});

test("formatAuditLog: one line per verdict with glyph, goal, model, first report line", () => {
  const entries: AuditLogEntry[] = [
    { at: "2026-07-25T20:00:00Z", goalId: "20260725-abc123", objective: "x", verdict: "disapproved", model: "MiniMax-M3", thinkingLevel: "high", report: "\n## Audit result\nbody" },
    { at: "2026-07-25T21:00:00Z", goalId: "20260725-def456", objective: "y", verdict: "approved", model: "k3", thinkingLevel: "high", report: "All checks pass." },
  ];
  const out = formatAuditLog(entries);
  const lines = out.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^✖ 07-25 20:00 \[abc123\] MiniMax-M3 — ## Audit result$/);
  assert.match(lines[1]!, /^✔ 07-25 21:00 \[def456\] k3 — All checks pass\.$/);
  assert.match(formatAuditLog([]), /no audits logged yet/);
});

test("tail-aware excerpt: capped output keeps the Required-fixes tail", () => {
  const head = "A".repeat(500);
  const report = `${head}\n\n## Required fixes\n- add the regression test\n- quote raw evidence`;
  const excerpt = auditFeedbackExcerpt(report, 100);
  assert.match(excerpt, /^\[head truncated — full report via \/goal status\]\n…/);
  assert.ok(excerpt.includes("quote raw evidence"), "tail preserved");
  assert.ok(!excerpt.includes("A".repeat(200)), "head cut");
  // Full by default; short reports untouched:
  assert.equal(auditFeedbackExcerpt(report, 0), report);
  assert.equal(auditFeedbackExcerpt("short", 100), "short");
});

test("audit feedback excerpts redact provider payloads before executor output", () => {
  const report = [
    "403",
    "{",
    '  "account": "secret-account",',
    '  "message": "Token Plan rate limit reached"',
    "}",
    "## Required fixes",
    "- keep the safe finding",
  ].join("\n");
  const excerpt = auditFeedbackExcerpt(report, 0);
  assert.match(excerpt, /safe finding/);
  assert.doesNotMatch(excerpt, /403|secret-account|Token Plan|rate limit/);
  assert.match(excerpt, /provider diagnostic redacted/);
});

test("disapproval feedback is surfaced even when the continuation turn never starts", () => {
  const src = readGoalRuntimeSource();
  assert.match(src, /returned tool text reaches the executor only if a continuation/);
  assert.match(src, /ctx\.ui\.notify\(`Auditor disapproved\. Report excerpt:/);
  assert.match(src, /no actionable feedback returned; use \/glla audits full/);
});

test("infra errors are transparent to the disapproval streak (not breakers)", () => {
  const v = (over: object) => ({ at: "x", approved: false, disapproved: false, model: "m", report: "r", ...over });
  // D, D, infra, D → 3 trailing (infra is not a verdict):
  assert.equal(countTrailingDisapprovals([v({ disapproved: true }), v({ disapproved: true }), v({ error: "quota" }), v({ disapproved: true })]), 3);
  // approval breaks:
  assert.equal(countTrailingDisapprovals([v({ disapproved: true }), v({ approved: true }), v({ disapproved: true })]), 1);
  // all infra → 0:
  assert.equal(countTrailingDisapprovals([v({ error: "quota" }), v({ error: "quota" })]), 0);
  // plain streak still works:
  assert.equal(countTrailingDisapprovals([v({ disapproved: true }), v({ disapproved: true })]), 2);
});

test("widget flags auditor-quiet stalls after 3 minutes", () => {
  const goal: any = {
    id: "g1",
    objective: "ship it",
    status: "auditing",
    policy: "goal",
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    usage: { tokensUsed: 0, tokensLimit: 0 },
  };
  const state: any = { goal, list: [] };
  const now = Date.now();
  // Fresh progress → no quiet warning:
  const fresh = buildWidgetLines(state, { label: "running", elapsedMs: 60_000, lastEventAt: now - 30_000 }, now)!;
  assert.ok(!fresh.some((l) => l.includes("quiet")), "fresh progress shows no stall");
  // Stale progress → quiet warning with duration:
  const stale = buildWidgetLines(state, { label: "running", elapsedMs: 600_000, lastEventAt: now - 7 * 60_000 }, now)!;
  const quietLine = stale.find((l) => l.includes("auditor quiet"));
  assert.ok(quietLine, "stale progress flags the stall");
  assert.match(quietLine!, /auditor quiet 7m/);
  assert.match(quietLine!, /\/goal cancel discards the claim/);
});

test("auditor prompt requires the Required-fixes tail + no think blocks", () => {
  const src = fs.readFileSync("extensions/goal-loop-auditor.ts", "utf-8");
  assert.match(src, /## Required fixes/);
  assert.match(src, /one line per blocking gap/);
  assert.match(src, /never emit <think> blocks/);
  assert.match(src, /Write the report in English/);
});

test("isRetriableInfraError: aborts and missing-model are NOT retried", async () => {
  const { isRetriableInfraError } = await import("../extensions/goal-loop-core.ts");
  assert.equal(isRetriableInfraError(undefined), false);
  assert.equal(isRetriableInfraError("Auditor aborted."), false);
  assert.equal(isRetriableInfraError("no model (session model also unset)"), false);
  assert.equal(isRetriableInfraError("no auditor model"), false);
  assert.equal(isRetriableInfraError("stream error: connection reset"), true);
  assert.equal(isRetriableInfraError("403 Forbidden (quota?)"), true);
});

test("runWithInfraRetry: retriable infra failure retried exactly once", async () => {
  const { runWithInfraRetry } = await import("../extensions/goal-loop-core.ts");
  type R = { error?: string; approved: boolean; disapproved: boolean; output: string };
  const noSleep = () => Promise.resolve();
  // Fails once, then succeeds:
  let calls = 0;
  const flaky = async (): Promise<R> => (++calls === 1 ? { error: "stream error", approved: false, disapproved: false, output: "" } : { approved: true, disapproved: false, output: "ok" });
  const out1 = await runWithInfraRetry(flaky, { sleep: noSleep });
  assert.equal(out1.retriedOnce, true);
  assert.equal(out1.result.approved, true);
  assert.equal(calls, 2);
  // Both attempts fail → second result returned, still exactly one retry:
  calls = 0;
  const alwaysFails = async (): Promise<R> => { calls++; return { error: "stream error", approved: false, disapproved: false, output: "" }; };
  const out2 = await runWithInfraRetry(alwaysFails, { sleep: noSleep });
  assert.equal(out2.retriedOnce, true);
  assert.equal(calls, 2);
  assert.equal(out2.result.error, "stream error");
  // Verdict on first attempt → no retry:
  const verdict = async (): Promise<R> => ({ approved: false, disapproved: true, output: "no" });
  const out3 = await runWithInfraRetry(verdict, { sleep: noSleep });
  assert.equal(out3.retriedOnce, false);
  // Abort / no-model → no retry:
  const aborted = async (): Promise<R> => ({ error: "Auditor aborted.", approved: false, disapproved: false, output: "" });
  assert.equal((await runWithInfraRetry(aborted, { sleep: noSleep })).retriedOnce, false);
});

test("runWithInfraRetry: provider Retry-After does not suppress the uniform backoff", async () => {
  const { runWithInfraRetry } = await import("../extensions/goal-loop-core.ts");
  type R = { error?: string; approved: boolean; disapproved: boolean; output: string };
  const waits: number[] = [];
  let calls = 0;
  const run = async (): Promise<R> => (++calls === 1
    ? { error: "429 Too Many Requests\\nRetry-After: 37", approved: false, disapproved: false, output: "" }
    : { approved: true, disapproved: false, output: "ok" });
  const out = await runWithInfraRetry(run, { backoffMs: 5_000, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(out.retriedOnce, true);
  assert.deepEqual(waits, [5_000], "quota hints are diagnostic only; the eager retry stays uniform");
  assert.equal(calls, 2);
});

test("runWithInfraRetry: lifecycle guard prevents a second attempt", async () => {
  const { runWithInfraRetry } = await import("../extensions/goal-loop-core.ts");
  type R = { error?: string; approved: boolean; disapproved: boolean; output: string };
  let calls = 0;
  let live = true;
  const run = async (): Promise<R> => {
    calls++;
    return { error: "stream error", approved: false, disapproved: false, output: "" };
  };
  const out = await runWithInfraRetry(run, {
    sleep: async () => { live = false; },
    shouldRetry: () => live,
  });
  assert.equal(out.retriedOnce, false);
  assert.equal(calls, 1, "replacement during the retry wait must not call the old run again");
});

test("formatGoalAuditHistory: one line per verdict with elapsed", async () => {
  const { formatGoalAuditHistory } = await import("../extensions/goal-loop-core.ts");
  const goal = {
    id: "g1",
    auditHistory: [
      { at: "2026-07-25T20:00:00Z", approved: false, disapproved: true, model: "MiniMax-M3", report: "## Audit result\nno", durationMs: 5 * 60_000 },
      { at: "2026-07-25T21:30:00Z", approved: true, disapproved: false, model: "k3", report: "All pass." },
    ],
  };
  const lines = formatGoalAuditHistory(goal).split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^✖ 07-25 20:00 MiniMax-M3 · 5m — ## Audit result$/);
  assert.match(lines[1]!, /^✔ 07-25 21:30 k3 — All pass\.$/);
  assert.match(formatGoalAuditHistory({ id: "g2" }), /no audits on this goal yet/);
});
