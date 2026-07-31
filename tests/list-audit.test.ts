// v0.31.0: /list audit — collect-then-drain project audits (user design
// 2026-07-31: "run a project audit, collect a bunch of tasks, then do them
// all too"; "my audits don't seem to be making a list of actionables if
// found"). The collection item changes NO code; its completion fans every
// open finding out into the queue as its own audited fix item. DECIDE
// findings are presented, never queued — a decision is not a task.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import {
  AUDIT_FINDINGS_REL,
  GOAL_AUDIT_ONESHOT_MARKER,
  LOOP_AUDIT_MARKER,
  LIST_AUDIT_COLLECT_MARKER,
  auditTarget,
  projectAuditTarget,
  listAuditCollectTarget,
  listAuditFanoutItemText,
  parseAuditFindingsForFanout,
} from "../extensions/goal-loop-forever.ts";

const SRC = fs.readFileSync(new URL("../extensions/loops/goal.ts", import.meta.url), "utf-8");

// ---------- pure fan-out parsing (real behavior) ----------

test("parseAuditFindingsForFanout: open boxes actionable, [?] boxes decisions, checked boxes ignored", () => {
  const md = [
    "# Findings",
    "- [ ] FIX: HIGH: dock does not refresh (dock.ts:12)",
    "- [x] LOW: stale comment — fixed in abc123",
    "- [?] DECIDE: keep the legacy renderer or drop it (cost: X vs Y)",
    "- [ ] CRITICAL: eventLog frozen closure (sim.ts:88)",
    "",
  ].join("\n");
  const { open, decisions } = parseAuditFindingsForFanout(md);
  assert.equal(open.length, 2, "two open actionable findings");
  assert.equal(decisions.length, 1, "one decision");
  assert.match(decisions[0]!, /legacy renderer/, "DECIDE: prefix stripped from the decision text");
  assert.equal(open[0]!.text.startsWith("CRITICAL:"), true, "CRITICAL sorts before HIGH");
  assert.equal(open[1]!.text.startsWith("HIGH:"), true);
});

test("parseAuditFindingsForFanout: tolerates the /loop audit format (no FIX: prefix)", () => {
  const md = "- [ ] MEDIUM: unguarded parse (x.ts:1)\n- [ ] nit-level thing without severity\n";
  const { open, decisions } = parseAuditFindingsForFanout(md);
  assert.equal(open.length, 2, "both open boxes actionable even without FIX:");
  assert.equal(open[0]!.text.startsWith("MEDIUM:"), true, "severity sorts first");
  assert.equal(open[1]!.text, "nit-level thing without severity", "unclassified keeps file order after classified");
  assert.equal(decisions.length, 0);
});

test("parseAuditFindingsForFanout: empty / missing content yields nothing", () => {
  const { open, decisions } = parseAuditFindingsForFanout("");
  assert.equal(open.length, 0);
  assert.equal(decisions.length, 0);
});

test("listAuditFanoutItemText: checkable Done when tied to the findings file", () => {
  const t = listAuditFanoutItemText("HIGH: dock does not refresh (dock.ts:12)");
  assert.match(t, /Fix audit finding: HIGH: dock does not refresh/);
  assert.match(t, /Done when:/);
  assert.ok(t.includes(AUDIT_FINDINGS_REL), "the contract pins the findings file");
  assert.match(t, /fixed in <commit>/, "the box must be checked with the fix commit");
});

test("listAuditCollectTarget: collect-only — marker, no-fix law, honest-empty law, Done when", () => {
  const t = listAuditCollectTarget("the renderer");
  assert.ok(t.includes(LIST_AUDIT_COLLECT_MARKER), "restart-safe marker present");
  assert.match(t, /Scope: the renderer/);
  assert.match(t, /Change NOTHING/, "the collection pass fixes nothing — fixes are the follow-up items");
  assert.match(t, /the orchestrator raises them to the user as questions/, "v0.33.3: decisions are raised as questions, not queued");
  assert.match(t, /empty findings set is a success/, "honesty law against fabricated findings");
  assert.match(t, /Done when:/);
  assert.ok(t.includes(AUDIT_FINDINGS_REL));
  assert.match(listAuditCollectTarget(), /Scope: the whole project/, "default scope");
});

// ---------- orchestrator wiring pins ----------

test("/list audit route: builds the collect target and enqueues it", () => {
  assert.match(SRC, /if \(sub === "audit"\) \{/);
  assert.match(SRC, /const objective = listAuditCollectTarget\(rest \|\| undefined\);/);
  assert.match(SRC, /enqueueItems\(ctx, \[objective\], "\/list audit"\)/);
  assert.match(SRC, /CHANGES NO CODE/, "the route's notify states the collect-only contract");
});

test("completion fan-out: collect items fan out + suppress the list-complete noise", () => {
  assert.match(SRC, /const isListAuditCollect = goal\.objective\.includes\(LIST_AUDIT_COLLECT_MARKER\);/);
  assert.match(SRC, /if \(isListAuditCollect\) void fanOutListAuditFindings\(ctx\);/);
  assert.match(SRC, /if \(!advanced && !isListAuditCollect\) \{/, "no spurious 'List complete' while the fan-out is still Confirm-gated");
  assert.match(SRC, /async function fanOutListAuditFindings\(ctx: ExtensionContext\): Promise<void> \{/);
});

test("fan-out: dedupe vs the live queue, Confirm gate, decline keeps findings open", () => {
  assert.match(SRC, /!queuedText\.includes\(f\.text\.slice\(0, 60\)\)/, "60-char dedupe against queued items");
  assert.match(SRC, /ctx\.ui\.confirm\(`Queue \$\{fresh\.length\} audit finding\(s\) as list items\?`, preview\)/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "list_audit_fanout_declined", \{ findings: fresh\.length \}\)/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "list_audit_fanout", \{ queued: n, alreadyQueued, decisions: decisions\.length \}\)/);
  // v0.33.3: DECIDE findings raised to the user as real questions.
  assert.match(SRC, /DECIDE finding\(s\) need YOU — raising them as questions now \(not queued — a decision is not a task\)/);
  assert.match(SRC, /\[DECIDE FINDINGS — user decisions needed\]/, "the agent steer carries the full findings");
  assert.match(SRC, /ask_user_question — one question per finding/, "the raise protocol names the question tool");
  assert.match(SRC, /- \[x\] DECIDED: <what was chosen>/, "resolutions recorded so they stop re-surfacing");
  assert.match(SRC, /appendLedger\(ctx\.cwd, "list_audit_decisions_raised", \{ decisions: decisions\.length \}\)/);
  assert.ok(SRC.indexOf("list_audit_decisions_raised") < SRC.indexOf("list_audit_fanout_empty"), "decision-raising hoisted BEFORE the empty early-return");
});

test("help surface: /list audit appears in the command description + completions", () => {
  assert.match(SRC, /\/list audit \[focus\] \(collect findings, then drain them as items\)/);
  assert.match(SRC, /\["audit", "collect-then-drain: audit the project, queue every finding as its own item"\]/);
});

// ---------- v0.31.1: audit-initiative stacking guards ----------

test("markers: the built targets still contain what the guards match on", () => {
  assert.ok(projectAuditTarget().includes(GOAL_AUDIT_ONESHOT_MARKER), "one-shot marker in the one-shot target");
  assert.ok(auditTarget().includes(LOOP_AUDIT_MARKER), "loop marker in the audit-loop target");
});

test("/loop audit warns when a one-shot audit goal exists (paused or active)", () => {
  assert.match(SRC, /state\.goal && state\.goal\.objective\.includes\(GOAL_AUDIT_ONESHOT_MARKER\)/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "audit_stack_warn", \{ have: "goal", starting: "loop", goalStatus: state\.goal\.status \}\)/);
  assert.match(SRC, /the audit loop SUPERSEDES it \(one pass \+ fixes IS the loop's job\)/);
});

test("/goal audit + /list audit warn when an audit loop is already running", () => {
  assert.equal(SRC.match(/state\.loop\?\.active && state\.loop\.target\.includes\(LOOP_AUDIT_MARKER\)/g)!.length >= 2, true, "both routes check the live loop");
  assert.match(SRC, /appendLedger\(ctx\.cwd, "audit_stack_warn", \{ have: "loop", starting: "goal" \}\)/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "audit_stack_warn", \{ have: "loop", starting: "list" \}\)/);
  assert.match(SRC, /a one-shot \/goal audit duplicates its work/);
  assert.match(SRC, /\/list audit would double-hunt the same ground/);
});

test("restore-hold names the supersession in the widget surface", () => {
  assert.match(SRC, /const auditSuperseded =/);
  assert.match(SRC, /restored on session load — SUPERSEDED by the audit loop in this session/);
  assert.match(SRC, /\/goal cancel clears it \(the loop already owns the audit\)/);
});

test("v0.33.3: one-shot audit raises DECIDE findings as questions before completing", () => {
  const t = projectAuditTarget("the gods");
  assert.match(t, /ask_user_question BEFORE calling complete_goal/, "the one-shot agent raises questions itself (still in its turn)");
  assert.match(t, /- \[x\] DECIDED: <what was chosen>/);
  assert.match(t, /raised to the user and recorded as DECIDED\/DEFERRED/, "Done when: covers the raise + record");
});
