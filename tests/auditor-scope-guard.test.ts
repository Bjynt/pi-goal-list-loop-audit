import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildGoalAuditorPrompt } from "../extensions/goal-loop-auditor.ts";
import { isOutsideScopeFinding, runReviewer, DEFAULT_REVIEWER_CONFIG } from "../extensions/reviewer.ts";
import { seedGoal } from "./harness/mock-pi.ts";

describe("auditor scope guard — project at hand only", () => {
  test("auditor prompt contains outside-scope guard", () => {
    const goal = seedGoal({ objective: "fix bug", verificationContract: "one" });
    const prompt = buildGoalAuditorPrompt(goal as any, "claim", "verify");
    assert.match(prompt, /SCOPE GUARD — PROJECT AT HAND ONLY/);
    assert.match(prompt, /outside findings are informational only/i);
    assert.match(prompt, /Outside Scope/i);
  });

  test("outside-scope findings are recorded but not auto-queued", () => {
    const cfg = { ...DEFAULT_REVIEWER_CONFIG, maxFindingsPerReview: 10, mode: "on" as const };
    const ledger: any[] = [];
    let enqueued: string[] = [];
    const deps = {
      cwd: "/tmp/test",
      nowMs: Date.now(),
      ledgerEntries: [],
      sources: [{ name: "audit", text: "- bug: outside scope fix the world in other repo\n- bug: TODO fix local broken handler\n" }],
      enqueueListItems: (items: string[]) => { enqueued.push(...items); },
      proposeGoal: () => true,
      notify: () => {},
      ledger: (type: string, value: any) => ledger.push({ type, value }),
    };
    const outcome = runReviewer(cfg, { kind: "goal", goalId: "20260829-aaaaaa", objective: "done", terminal: "goal-complete" }, deps as any);
    assert.equal(outcome.fired, true);
    // outside finding should be in report
    assert.equal(outcome.report!.findings.length, 2);
    assert.equal(isOutsideScopeFinding("outside scope fix the world"), true);
    assert.equal(isOutsideScopeFinding("TODO fix local broken handler"), false);
    // but only in-scope bug enqueued
    assert.equal(enqueued.length, 1);
    assert.match(enqueued[0]!, /TODO fix local/);
    // ledger records outside
    assert.ok(ledger.some((e) => e.type === "reviewer_outside_scope"));
  });
});
