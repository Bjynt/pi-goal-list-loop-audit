// pi-goal-list-loop-audit — v0.9.0
// tests/display.test.ts
//
// Unit tests for the live-TUI display builders: status line + widget lines.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import {
  buildStatusText,
  buildWidgetLines,
  meter,
  fmtElapsed,
  fmtTokens,
  truncate,
} from "../extensions/goal-loop-display.ts";
import type { Goal, State } from "../extensions/goal-loop-core.ts";
import type { LoopState } from "../extensions/goal-loop-forever.ts";

const NOW = Date.parse("2026-07-21T12:00:00Z");

function goalOf(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "20260721120000-abcdef",
    objective: "Create x.txt containing ok",
    status: "active",
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 12_400, tokensLimit: 1_000_000 },
    createdAt: "2026-07-21T11:57:00Z",
    updatedAt: "2026-07-21T11:57:00Z",
    ...overrides,
  };
}

// ---- formatters ----

test("fmtElapsed", () => {
  assert.equal(fmtElapsed(500), "0s");
  assert.equal(fmtElapsed(45_000), "45s");
  assert.equal(fmtElapsed(180_000), "3m 00s");
  assert.equal(fmtElapsed(3_900_000), "1h 05m");
});

test("fmtTokens", () => {
  assert.equal(fmtTokens(500), "500");
  assert.equal(fmtTokens(12_400), "12.4k");
  assert.equal(fmtTokens(1_000_000), "1000k");
});

test("truncate", () => {
  assert.equal(truncate("short", 10), "short");
  assert.equal(truncate("a much longer string", 8), "a much …");
});

// ---- buildStatusText ----

test("empty state → undefined (segment cleared)", () => {
  assert.equal(buildStatusText({ goal: null, list: [] }, null, NOW), undefined);
});

test("active goal shows pulse + elapsed", () => {
  const s = buildStatusText({ goal: goalOf(), list: [] }, null, NOW)!;
  assert.match(s, /glla: goal ●/);
  assert.match(s, /3m/);
});

test("active goal with tasks shows progress", () => {
  const g = goalOf({
    taskList: {
      version: 1,
      tasks: [
        { id: "1", title: "a", status: "complete" },
        { id: "2", title: "b", status: "pending" },
      ],
    },
  });
  assert.match(buildStatusText({ goal: g, list: [] }, null, NOW)!, /1\/2 tasks/);
});

test("widget truncation is width-aware (v0.22.2)", () => {
  const longObjective = "x".repeat(200);
  const g = goalOf({ objective: longObjective });
  // No width (tests/RPC): floor cap applies. v0.33.0: the head also carries
  // the status segments after the objective — assert the objective part is
  // floor-capped and the segments follow.
  const narrow = buildWidgetLines({ goal: g, list: [] }, null, NOW)![0]!;
  assert.match(narrow, /^● x{47}… · /); // icon + space + 47 chars + ellipsis, then segments
  // Wide terminal: the head uses the room instead of cutting at the floor.
  const wide = buildWidgetLines({ goal: g, list: [] }, null, NOW, undefined, 160)![0]!;
  assert.ok(wide.length > 100, `wide head should exceed 100 chars, got ${wide.length}`);
  // Narrow terminal: v0.33.1 — the objective budget shrinks to fit the
  // fixed segments (floor 16), so a tiny width yields a shorter head.
  const tiny = buildWidgetLines({ goal: g, list: [] }, null, NOW, undefined, 50)![0]!;
  assert.ok(tiny.length < narrow.length, `tiny (${tiny.length}) should be narrower than narrow (${narrow.length})`);
  assert.ok(tiny.length <= 70, `tiny head must stay near the terminal width, got ${tiny.length}`);
});

test("list policy footer: queued count, no duplicated 'list'", () => {
  const s = buildStatusText(
    { goal: goalOf({ policy: "list" }), list: [{ id: "x", objective: "y", addedAt: "z" }] },
    null,
    NOW,
  )!;
  // v0.24.7: was "glla: list ● 3m 00s · list 1" — policy label and queue
  // counter both said "list".
  assert.match(s, /^glla: list /);
  assert.match(s, /· 1 queued$/);
  assert.ok(!/list .+ list /.test(s), `no duplicated 'list … list': ${s}`);
});

test("goal policy footer says 'N queued' (v0.28.11 U10 — was the cryptic 'list N')", () => {
  const s = buildStatusText(
    { goal: goalOf(), list: [{ id: "x", objective: "y", addedAt: "z" }] },
    null,
    NOW,
  )!;
  assert.match(s, /^glla: goal /);
  assert.match(s, /· 1 queued$/);
});

test("widget names a list item as such and points at /list, not /goal", () => {
  const lines = buildWidgetLines(
    {
      goal: goalOf({ policy: "list", usage: undefined }),
      list: [
        { id: "a", objective: "one", addedAt: "z" },
        { id: "b", objective: "two", addedAt: "z" },
      ],
    },
    null,
    NOW,
  )!;
  assert.match(lines[0]!, /· list item · active · /); // v0.33.0: type named in the head segments
  assert.equal(lines[lines.length - 1], "└─ 2 queued · /list · /glla");
  assert.ok(!lines.some(l => l.includes("/goal status")), "list item must not hint /goal status");
});

test("widget list item, last in queue: no '0 queued'", () => {
  const lines = buildWidgetLines(
    { goal: goalOf({ policy: "list", usage: undefined }), list: [] },
    null,
    NOW,
  )!;
  assert.equal(lines[lines.length - 1], "└─ /list · /glla");
});

test("widget goal policy keeps /goal status hint + list N prefix", () => {
  const lines = buildWidgetLines(
    {
      goal: goalOf({ usage: undefined }),
      list: [{ id: "a", objective: "one", addedAt: "z" }],
    },
    null,
    NOW,
  )!;
  assert.match(lines[0]!, /^● Create x.txt containing ok · active · /); // v0.33.0: plain goal — icon + status in the head
  assert.equal(lines[lines.length - 1], "└─ 1 queued · /goal status · /glla");
});

test("paused shows the reason", () => {
  const g = goalOf({ status: "paused", pauseReason: "auditor disapproved: missing tests" });
  assert.match(buildStatusText({ goal: g, list: [] }, null, NOW)!, /paused ⏸ auditor disapproved/);
});

test("auditing shows the auditor's current tool", () => {
  const g = goalOf({ status: "auditing" });
  const s = buildStatusText({ goal: g, list: [] }, { currentTool: "read" }, NOW)!;
  assert.match(s, /auditing…/);
  assert.match(s, /read/);
});

test("complete goal clears the segment", () => {
  assert.equal(buildStatusText({ goal: goalOf({ status: "complete" }), list: [] }, null, NOW), undefined);
});

test("active loop shows iteration + best + stall", () => {
  const loop: LoopState = {
    target: "reduce TODOs",
    measureCmd: "grep -c TODO x",
    direction: "min",
    iteration: 12,
    maxIterations: 50,
    plateauWindow: 5,
    stallCount: 2,
    bestValue: 41,
    lastValue: 43,
    active: true,
    history: [],
    startedAt: "2026-07-21T11:00:00Z",
  };
  const s = buildStatusText({ goal: null, list: [], loop }, null, NOW)!;
  assert.match(s, /loop ↓ iter 12\/50/);
  assert.match(s, /best 41/);
  assert.match(s, /stall 2\/5/);
});

test("v0.29.15 — audit-loop widget names the metric instead of showing the raw grep (\"that weird line\")", () => {
  // The audit measure is orchestrator-owned shell (c=$(grep -cE ...) —
  // unreadable as widget furniture. kind:"audit" gets a friendly label;
  // user-authored measures keep showing raw.
  const auditLoop: LoopState = {
    target: "audit the project",
    measureCmd: "c=$(grep -cE '^- \\[[xX]\\]' .pi-glla/audit-loop/findings.md 2>/dev/null); echo ${c:-0}",
    direction: "max",
    iteration: 1,
    maxIterations: 0,
    plateauWindow: 5,
    stallCount: 0,
    bestValue: null,
    lastValue: 4,
    active: true,
    kind: "audit",
    history: [],
    startedAt: "2026-07-30T11:00:00Z",
  };
  const lines = buildWidgetLines({ goal: null, list: [], loop: auditLoop }, null, NOW)!;
  const joined = lines.join("\n");
  assert.match(joined, /metric: closed findings · \/loop stop/); // v0.33.0 slim footer
  assert.ok(!joined.includes("grep -cE"), "raw shell hidden for audit loops");
});

// ---- buildWidgetLines ----

test("widget: nothing supervised → undefined", () => {
  assert.equal(buildWidgetLines({ goal: null, list: [] }, null, NOW), undefined);
});

test("widget: goal lines include objective, status, tokens, footer", () => {
  const lines = buildWidgetLines({ goal: goalOf(), list: [] }, null, NOW)!;
  assert.match(lines[0]!, /● Create x.txt containing ok/);
  assert.match(lines[0]!, /12\.4k\/1000k ▰/); // v0.33.0: budget segment carries a meter
  assert.ok(lines.some((l) => l.includes("/goal status")));
});

test("widget: paused goal shows reason + suggestion", () => {
  const g = goalOf({
    status: "paused",
    pauseReason: "no tests found",
    pauseSuggestedAction: "add tests dir",
  });
  const lines = buildWidgetLines({ goal: g, list: [] }, null, NOW)!;
  assert.ok(lines.some((l) => l.includes("no tests found")));
  assert.ok(lines.some((l) => l.includes("add tests dir")));
});

test("widget: auditing shows auditor progress", () => {
  const g = goalOf({ status: "auditing" });
  const lines = buildWidgetLines({ goal: g, list: [] }, { label: "verifying contract", currentTool: "grep", elapsedMs: 42_000 }, NOW)!;
  assert.ok(lines.some((l) => l.includes("verifying contract")));
  assert.ok(lines.some((l) => l.includes("grep")));
  assert.ok(lines.some((l) => l.includes("42s")));
});

test("widget: loop lines include measure + metric state", () => {
  const loop: LoopState = {
    target: "reduce TODOs",
    measureCmd: "grep -c TODO src.txt | head -1",
    direction: "min",
    iteration: 3,
    maxIterations: 12,
    plateauWindow: 3,
    stallCount: 1,
    bestValue: 2,
    lastValue: 3,
    active: true,
    history: [],
    startedAt: "2026-07-21T11:00:00Z",
    branchName: "pi-glla-loop/20260721-reduce-todos",
  };
  const lines = buildWidgetLines({ goal: null, list: [], loop }, null, NOW)!;
  assert.ok(lines.some((l) => l.includes("reduce TODOs")));
  assert.ok(lines.some((l) => l.includes("iter 3/12")));
  assert.ok(lines.some((l) => l.includes("best 2")));
  assert.ok(lines.some((l) => l.includes("pi-glla-loop/20260721-reduce-todos")));
});

// ---- v0.28.17: held loops are always visible ----

function heldLoopOf(overrides: Partial<LoopState> = {}): LoopState {
  return {
    target: "improve search ranking",
    measureCmd: "bun test --score",
    direction: "max",
    iteration: 7,
    maxIterations: 0,
    plateauWindow: 5,
    stallCount: 0,
    bestValue: 88,
    lastValue: 85,
    active: false,
    stopReason: "held: restored in a fresh session",
    history: [],
    startedAt: "2026-07-21T10:00:00Z",
    ...overrides,
  };
}

test("held loop alone → status segment + widget card (before: BOTH vanished)", () => {
  const state = { goal: null, list: [], loop: heldLoopOf() };
  const s = buildStatusText(state, null, NOW)!;
  assert.match(s, /loop ⏸ held/);
  assert.match(s, /iter 7/);
  assert.match(s, /\/loop to resume/);
  const w = buildWidgetLines(state, null, NOW)!;
  assert.ok(w, "widget shows the held-loop card");
  assert.match(w[0]!, /improve search ranking/);
  assert.match(w[1]!, /loop held · iter 7/);
  assert.match(w[2]!, /restore gate/);
});

test("held loop + paused goal → both visible (status suffix + widget trailing line)", () => {
  const state = { goal: goalOf({ status: "paused", pauseReason: "user paused" }), list: [], loop: heldLoopOf() };
  const s = buildStatusText(state, null, NOW)!;
  assert.match(s, /paused/);
  assert.match(s, /loop⏸held/, "held-loop suffix rides the paused-goal status");
  const w = buildWidgetLines(state, null, NOW)!;
  assert.match(w.join("\n"), /loop held · iter 7 — \/loop to resume/);
});

test("held loop + active goal → status suffix present", () => {
  const state = { goal: goalOf(), list: [], loop: heldLoopOf() };
  const s = buildStatusText(state, null, NOW)!;
  assert.match(s, /goal ●/);
  assert.match(s, /loop⏸held/);
});

test("held loop + completed goal → held loop still shows (goal state clears)", () => {
  const state = { goal: goalOf({ status: "complete" }), list: [], loop: heldLoopOf() };
  assert.match(buildStatusText(state, null, NOW)!, /loop ⏸ held/);
  assert.ok(buildWidgetLines(state, null, NOW)!.length >= 2);
});

test("active loop unchanged; stopped loop stays invisible", () => {
  const active = { goal: null, list: [], loop: heldLoopOf({ active: true, stopReason: undefined }) };
  const s = buildStatusText(active, null, NOW)!;
  assert.match(s, /loop ↑ iter 7/, "active loop renders exactly as before");
  assert.doesNotMatch(s, /held/);
  const stopped = { goal: null, list: [], loop: heldLoopOf({ stopReason: "stopped by user (/loop stop)" }) };
  assert.equal(buildStatusText(stopped, null, NOW), undefined, "a genuinely stopped loop stays invisible");
  assert.equal(buildWidgetLines(stopped, null, NOW), undefined);
});

// ---- v0.28.22: pause-kind rendering (decision / error / wait) ----

test("decision pause: banner + numbered options + recommended flagged (widget + status)", () => {
  const g = goalOf({
    status: "paused",
    pauseKind: "decision",
    pauseReason: "The auditor disapproved completion — SUPERSEDED rows don't match the objective text.",
    pauseOptions: ["surgical Done when: clause", "deliver the missing polish (~2-3 hours)", "reword objective to accept SUPERSEDED"],
    pauseRecommended: 3,
    pauseSuggestedAction: "Pick one, then /goal resume.",
  });
  const state = { goal: g, list: [], loop: null };
  const w = buildWidgetLines(state as never)!;
  assert.ok(w.some((l) => l.includes("decision needed — your call unblocks this")), `decision banner: ${w.join("\n")}`);
  assert.ok(w.some((l) => l.includes("1. surgical Done when: clause")), "option 1 numbered");
  assert.ok(w.some((l) => l.includes("3. reword objective to accept SUPERSEDED ◂ recommended")), "recommended flagged");
  const s = buildStatusText(state as never)!;
  assert.ok(s.includes("decision needed"), `status: ${s}`);
  assert.ok(!s.includes("SUPERSEDED rows"), "status names the actionability, not the reason");
});

test("error pause: ACTION NEEDED banner, action line popped (widget + status)", () => {
  const g = goalOf({
    status: "paused",
    pauseKind: "error",
    pauseReason: "send-retry storm: 5m of 50ms re-arms — the session never went idle",
    pauseSuggestedAction: "Press Escape, then /goal resume.",
  });
  const state = { goal: g, list: [], loop: null };
  const w = buildWidgetLines(state as never)!;
  assert.ok(w.some((l) => l.includes("action needed — this won't fix itself")), `error banner: ${w.join("\n")}`);
  const s = buildStatusText(state as never)!;
  assert.ok(s.includes("action needed"), `status: ${s}`);
});

test("wait pause: quiet banner + resume countdown (widget + status)", () => {
  const g = goalOf({
    status: "paused",
    pauseKind: "wait",
    pauseReason: "auditor quota: rate limited",
    pauseResumeAt: new Date(Date.now() + 23 * 3600_000).toISOString(),
    pauseSuggestedAction: "Quota auto-retry — or /goal resume now",
  });
  const state = { goal: g, list: [], loop: null };
  const w = buildWidgetLines(state as never)!;
  assert.ok(w.some((l) => l.includes("waiting — nothing for you to do")), `wait banner: ${w.join("\n")}`);
  assert.ok(w.some((l) => /resumes .*\(in 23h/.test(l)), `countdown: ${w.join("\n")}`);
  const s = buildStatusText(state as never)!;
  assert.ok(s.includes("waiting") && s.includes("resumes"), `status: ${s}`);
});

test("legacy pause (no kind): flat card unchanged; error-regex still classifies the status line", () => {
  const g = goalOf({ status: "paused", pauseReason: "user paused for review", pauseSuggestedAction: "/goal resume" });
  const state = { goal: g, list: [], loop: null };
  const w = buildWidgetLines(state as never)!;
  assert.ok(!w.some((l) => l.includes("unblocks this") || l.includes("won't fix itself") || l.includes("nothing for you to do")), "no banner without a kind");
  const g2 = goalOf({ status: "paused", pauseReason: "token limit exceeded (10 > 5)" });
  const s2 = buildStatusText({ goal: g2, list: [], loop: null } as never)!;
  assert.ok(s2.includes("action needed"), `legacy error reason → action needed: ${s2}`);
});

test("v0.28.30: the widget card status line ALWAYS names the type (goal · / list item ·)", () => {
  // User note: "I don't always see the type — I'd need to scroll up to see
  // if goal/list/loop." Before, only list items were named on the card.
  const goalLines = buildWidgetLines({ goal: goalOf({}), list: [] }, null, NOW)!;
  assert.match(goalLines[0]!, /^● /); // goal card icon
  assert.match(goalLines[0]!, / · active · /);
  const listLines = buildWidgetLines({ goal: goalOf({ policy: "list" }), list: [] }, null, NOW)!;
  assert.match(listLines[0]!, /· list item · active · /); // v0.33.0: named in the head segments
  const SRC = fs.readFileSync("extensions/goal-loop-display.ts", "utf-8");
  assert.match(SRC, /if \(isList\) headSegs\.push\("list item"\);/);
});

test("v0.33.0: slim card — meter rounding guard, folded status segments, last-action line", () => {
  // Meter guard (command-code's rule): never empty unless 0, never full unless 1.
  assert.equal(meter(0), "▱▱▱▱▱");
  assert.equal(meter(1), "▰▰▰▰▰");
  assert.equal(meter(0.01), "▰▱▱▱▱");
  assert.equal(meter(0.99), "▰▰▰▰▱");
  assert.equal(meter(0.5), "▰▰▰▱▱"); // round(2.5)=3
  // Slim head: status + tasks meter fold into the head line as middot segments.
  const g = goalOf({ taskList: { version: 1, tasks: [
    { id: "t1", title: "done one", status: "complete" },
    { id: "t2", title: "fix the thing", status: "pending" },
    { id: "t3", title: "another", status: "pending" },
  ] } });
  const lines = buildWidgetLines({ goal: g, list: [] }, null, NOW, undefined, 120, {
    recent: [{ name: "edit", arg: "goal.ts", ms: 12_000, ok: true }],
  })!;
  assert.match(lines[0]!, / · active · /);
  assert.match(lines[0]!, /1\/3 ▰▰▱▱▱/); // round(1.67)=2
  // Last-action line: Claude's done-row format + the next pending task.
  assert.match(lines[1]!, /^├─ ✓ edit goal\.ts \(12s\) · next: fix the thing/);
  assert.match(lines[lines.length - 1]!, /^└─ /);
  // Failed action renders ✗; no ms → no time suffix.
  const failed = buildWidgetLines({ goal: g, list: [] }, null, NOW, undefined, 120, {
    recent: [{ name: "bash", arg: "bun test", ms: 0, ok: false }],
  })!;
  assert.match(failed[1]!, /^├─ ✗ bash bun test(?! \()/);
  // Slim loop card: ∞ icon + folded iter/meter segments + metricless footer.
  const loopLines = buildWidgetLines({ goal: null, list: [], loop: {
    active: true, target: "endless-td audit", iteration: 12, maxIterations: 100,
    stallCount: 0, plateauWindow: 5, startedAt: "2026-07-21T11:57:00Z", history: [],
  } as any }, null, NOW, undefined, 120, { recent: [{ name: "read", arg: "tiles.ts", ms: 8_000, ok: true }] })!;
  assert.match(loopLines[0]!, /^∞ endless-td audit · iter 12\/100 ▰▱▱▱▱ · /);
  assert.match(loopLines[1]!, /^├─ ✓ read tiles\.ts \(8s\)/);
  assert.match(loopLines[2]!, /^└─ metricless \(no plateau\) · \/loop stop · \/loop polish/);
  const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  assert.match(SRC, /noteToolCall\(event\); \/\/ v0\.33\.0/);
  assert.match(SRC, /noteToolResult\(event\); \/\/ v0\.33\.0/);
});

test("v0.33.1: audit-batch — sanitize, head fits width, last restored, flag lifecycle", () => {
  const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  // A1: tool args are control-char-stripped before reaching a widget line.
  assert.match(SRC, /\[\\x00-\\x1f\\x7f-\\x9f\]\/g/);
  // sweep-F1: a rebound session can go terminal again.
  assert.match(SRC, /staleTerminalDone = false; \/\/ v0\.33\.1/);
  // sweep-F2: the loop path's null-ctx re-arm probes + backs off (was a flat 50ms spin).
  assert.match(SRC, /if \(probeExtensionApiStale\(\)\) return;\s*\n\s*loopRearmStreak\+\+;/);
  // compact F1/F2 + sweep-F3: the compact debt/resync die with the goal/loop and on rebind.
  assert.match(SRC, /if \(!isSupervising\(\) && \(postCompactResumeOwed \|\| postCompactResyncPending\)\)/);
  assert.match(SRC, /postCompactResumeOwed = false; \/\/ v0\.33\.1: a compact from a previous session/);
  // compact-F3: builder throws are contained.
  assert.match(SRC, /try \{ resync = buildPostCompactResync\(\); \} catch/);
  // sweep-F6: per-goal module state resets at activation.
  assert.match(SRC, /countedTokenMessages\.clear\(\);\n  recentActions\.length = 0;/);
  // B1: the head fits the terminal — wide width yields a longer objective than narrow.
  const longObjective = "y".repeat(200);
  const g = goalOf({ objective: longObjective });
  const w100 = buildWidgetLines({ goal: g, list: [] }, null, NOW, undefined, 100)![0]!;
  const w160 = buildWidgetLines({ goal: g, list: [] }, null, NOW, undefined, 160)![0]!;
  assert.ok(w160.length > w100.length, "objective absorbs the extra width");
  assert.ok(w100.length <= 110, `head at width 100 stays near the terminal, got ${w100.length}`);
  // B3a: metric loops show best AND last again.
  const loopLines = buildWidgetLines({ goal: null, list: [], loop: {
    active: true, target: "audit", iteration: 3, maxIterations: 0, measureCmd: "m",
    bestValue: 4, lastValue: 5, stallCount: 2, plateauWindow: 5,
    startedAt: "2026-07-21T11:57:00Z", history: [], direction: "min",
  } as any }, null, NOW, undefined, 120)!;
  assert.match(loopLines[0]!, /best 4 · last 5 · stall 2\/5/);
  // sweep-F4: the auditor's abort listener is removed in finally.
  const AUD = fs.readFileSync("extensions/goal-loop-auditor.ts", "utf-8");
  assert.match(AUD, /removeEventListener\("abort", abort\)/);
});
