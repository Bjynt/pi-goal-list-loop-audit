// pi-goal-list-loop-audit — v0.38.25 (post-objective summary)
//
// Field failure 2026-09-07: goal `20260907131550-12ddoy` completed with a
// perfect six-label archive record, but the approval chat lines fired into a
// dead context (auditor verdict landed with no live turn) — record perfect,
// delivery silent. These pins cover the fix: ONE canonical builder for every
// approval surface (chat/transcript/external/persisted), the audit-goal
// counts line, persist-first delivery marking via the idle probe, and
// fire-once replay on the next live contact.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import type { Goal } from "../extensions/goal-loop-core.js";
import { ledgerPath } from "../extensions/goal-loop-core.js";
import {
  buildApprovalChatLines,
  buildAuditCountsLine,
  buildTerminalApprovalRender,
} from "../extensions/completion-summary.js";
import {
  approvalRenderStorePath,
  persistApprovalRender,
  replayUndeliveredApprovalRenders,
} from "../extensions/approval-render-store.js";
import { makeMockCtx, seedGoal, tmpCwd } from "./harness/mock-pi.js";

const SIX = [
  "Outcome: shipped the post-objective summary",
  "Changed: extensions/completion-summary.ts",
  "Evidence: commit abc123",
  "Tests: bun test — pass",
  "Unresolved: none",
  "Next: replay on next contact",
].join("\n");

function richGoal(): Goal {
  return seedGoal({
    id: "20260907-approval-render",
    objective: "ship the post-objective summary with persist and replay",
    completionSummary: SIX,
    telemetry: { turns: 42, fileWrites: 17, bashCalls: 23 },
    auditHistory: [
      { at: "2026-09-07T00:00:00.000Z", approved: true, disapproved: false, model: "auditor-model", report: "fine" },
    ],
  }) as unknown as Goal;
}

test("canonical render keeps the outcome-first voice with counts before the record", () => {
  const render = buildTerminalApprovalRender({
    goal: richGoal(),
    status: "complete",
    stopReason: "auditor auditor-model approved (detached)",
    archivePath: ".pi-glla/archive/20260907-approval-render.md",
    approval: "— auditor auditor-model approved on the provider retry.",
    record: "— record: .pi-glla/archive/20260907-approval-render.md",
  });
  assert.ok((render.chatLines[0] ?? "").startsWith("✓ done — "), "chat opens with the outcome");
  const approvalIdx = render.chatLines.findIndex((l) => l.startsWith("— auditor"));
  const countsIdx = render.chatLines.findIndex((l) => l.startsWith("— audit:"));
  const recordIdx = render.chatLines.findIndex((l) => l.startsWith("— record:"));
  assert.ok(approvalIdx > 0 && countsIdx > approvalIdx && recordIdx > countsIdx, "approval, then counts, then the record pointer stays last");
  assert.ok(!render.chatLines.some((l) => /^\s*Next\s*:/i.test(l)), "stale pre-verdict Next never reaches the chat");
  assert.ok(render.transcriptLines.includes("— auditor auditor-model approved on the provider retry."), "transcript keeps the approval trailer");
  assert.ok(!render.transcriptLines.some((l) => /^\s*Next\s*:/i.test(l)), "transcript strips the stale Next too");
  assert.ok(render.recap.length > 0, "external single line still produced");
  assert.equal(render.outcome, (render.chatLines[0] ?? "").replace(/^✓ done — /, ""), "outcome matches the chat lead");
});

test("counts line proofs the audit verdict from durable state only", () => {
  assert.equal(
    buildAuditCountsLine(richGoal()),
    "— audit: auditor approved (1 verdict).",
  );
  const two = richGoal();
  two.auditHistory = [...(two.auditHistory ?? []), { at: "2026-09-07T01:00:00.000Z", approved: false, disapproved: true, model: "m2" }];
  assert.match(buildAuditCountsLine(two), /auditor disapproved \(2 verdicts\)/, "latest verdict + plural count");
  const bare = seedGoal({ completionSummary: SIX }) as unknown as Goal;
  assert.equal(
    buildAuditCountsLine(bare),
    "— audit: no auditor verdict was recorded.",
    "absent facts named as absent, never invented",
  );
  assert.match(
    buildAuditCountsLine(richGoal(), "completed without audit (your choice)"),
    /completed without audit \(your choice\)/,
    "no-audit path says so honestly",
  );
});

test("buildApprovalChatLines stays backward compatible without counts", () => {
  const lines = buildApprovalChatLines({ outcome: "did it", details: ["Changed: x"], approval: "— approved.", record: "— record: p" });
  assert.deepEqual(lines, ["✓ done — did it", "Changed: x", "— approved.", "— record: p"]);
});

test("idle-persisted render replays once on the next live contact", () => {
  const cwd = tmpCwd();
  const chatLines = ["✓ done — shipped it", "— auditor m approved.", "— audit: auditor approved (1 verdict).", "— record: r"];
  assert.equal(persistApprovalRender(cwd, { goalId: "g1", objective: "ship it", chatLines }), true);
  const ctx = makeMockCtx(cwd, { idle: false });
  assert.equal(replayUndeliveredApprovalRenders(ctx, (entry) => { ctx.ui.notify(entry.chatLines.join("\n"), "info"); return true; }), 1, "confirmed delivery acknowledges the render");
  assert.equal(ctx.ui.notifies.length, 1, "exactly one notify goes out");
  assert.equal(ctx.ui.notifies[0]?.message, chatLines.join("\n"), "the persisted render arrives verbatim");
  assert.equal(replayUndeliveredApprovalRenders(ctx), 0, "fire-once: second contact replays nothing");
  assert.equal(ctx.ui.notifies.length, 1, "no duplicate notify");
  const stored = JSON.parse(fs.readFileSync(approvalRenderStorePath(cwd), "utf-8"));
  assert.equal((stored[0] as { deliveredAt?: string }).deliveredAt !== undefined, true, "replay marks delivered");
  const ledger = fs.readFileSync(ledgerPath(cwd), "utf-8");
  assert.match(ledger, /terminal_approval_render_persisted/, "persist is ledgered");
  assert.match(ledger, /terminal_approval_render_replayed/, "replay is ledgered");
});

test("render with confirmed delivery never replays", () => {
  const cwd = tmpCwd();
  persistApprovalRender(cwd, { goalId: "g2", objective: "live one", chatLines: ["✓ done — live"] });
  const ctx = makeMockCtx(cwd, { idle: false });
  assert.equal(replayUndeliveredApprovalRenders(ctx, () => true), 1);
  assert.equal(replayUndeliveredApprovalRenders(ctx), 0);
  assert.equal(ctx.ui.notifies.length, 0);
});

test("corrupt store degrades to zero replays, never throws", () => {
  const cwd = tmpCwd();
  fs.mkdirSync(`${cwd}/.pi-glla`, { recursive: true });
  fs.writeFileSync(approvalRenderStorePath(cwd), "{not json", "utf-8");
  const ctx = makeMockCtx(cwd, { idle: false });
  assert.equal(replayUndeliveredApprovalRenders(ctx), 0);
  const ledger = fs.readFileSync(ledgerPath(cwd), "utf-8");
  assert.match(ledger, /terminal_approval_render_store_invalid/, "corruption is ledgered, not thrown");
});

