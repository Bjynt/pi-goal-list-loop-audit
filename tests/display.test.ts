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

test("display projections remove terminal and zero-width control characters without changing stored state", () => {
  const hostile = "safe\u001b[31m\nspoof\u0007\u202Ehidden\u200B";
  assert.equal(truncate(hostile, 200), "safe spoof hidden");
  const g = goalOf({ objective: hostile, pauseReason: hostile });
  const lines = buildWidgetLines({ goal: g, list: [] }, null, NOW)!;
  const rendered = lines.join("\n");
  const controls = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
  assert.ok(!lines.some((line) => controls.test(line)));
  assert.ok(!rendered.includes("\u001b"));
  assert.equal(g.objective, hostile, "display rendering must not mutate persisted objective data");
});

// ---- buildStatusText ----

test("empty state → undefined (segment cleared)", () => {
  assert.equal(buildStatusText({ goal: null, list: [] }, null, NOW), undefined);
});

test("active goal shows a compact state capsule + elapsed", () => {
  const s = buildStatusText({ goal: goalOf(), list: [] }, null, NOW)!;
  assert.match(s, /glla: \[ACTIVE\] 3m/);
  assert.doesNotMatch(s, /glla: goal/, 'v0.34.1: the status line drops the policy word — the widget owns type naming');
});

test("active status does not make first-turn or long-idle gaps look green", () => {
  const state = { goal: goalOf(), list: [] };
  const awaiting = buildWidgetLines(state, null, NOW, undefined, undefined, { activity: "awaiting-first-turn" })!;
  assert.match(buildStatusText(state, null, NOW, undefined, { activity: "awaiting-first-turn" })!, /AWAITING FIRST TURN/);
  assert.ok(awaiting.some((line) => line.includes("· active ·")));
  assert.doesNotMatch(awaiting.join("\n"), /AWAITING FIRST TURN|LIVE WORK/);

  const idle = buildWidgetLines(state, null, NOW, undefined, undefined, { activity: "idle", lastActivityAt: NOW - 2 * 60_000 })!;
  assert.match(buildStatusText(state, null, NOW, undefined, { activity: "idle", lastActivityAt: NOW - 2 * 60_000 })!, /IDLE/);
  assert.ok(idle.some((line) => line.includes("· active ·")));
  assert.doesNotMatch(idle.join("\n"), /IDLE|last activity 2m/);
});

test("stream-proven work uses one compact status-bar HUD; the card stays quiet", () => {
  const state = {
    goal: goalOf({ policy: "list", createdAt: "2026-07-21T11:58:51Z" }),
    list: [1, 2, 3].map((id) => ({ id: `next-${id}`, objective: `next ${id}`, addedAt: "z" })),
  };
  const stream = { activity: "working" as const, lastStreamActivityAt: NOW - 11_000 };
  const status = buildStatusText(state, null, NOW, undefined, stream)!;
  assert.match(status, /^glla: \[[▁▂▄▆█]{6} LIVE · WORKING\] 1m 09s · last stream 11s ago · 3 queued$/);
  const lines = buildWidgetLines(state, null, NOW, undefined, undefined, stream)!;
  assert.match(lines[0]!, /^● /);
  assert.match(lines[0]!, /· active ·/);
  assert.doesNotMatch(lines.join("\n"), /LIVE WORK|last stream 11s ago/);

  const busy = buildStatusText(state, null, NOW, undefined, { activity: "busy", lastStreamActivityAt: NOW - 20_000 })!;
  assert.match(busy, /glla: \[BUSY\] 1m 09s · last stream 20s ago · 3 queued/);
  assert.doesNotMatch(busy, /WORKING/);

  const queued = buildStatusText(state, null, NOW, undefined, { activity: "queued" })!;
  assert.match(queued, /glla: \[QUEUED\] 1m 09s · 3 queued/);
  assert.doesNotMatch(queued, /WORKING/);

  const goldenQueued = {
    goal: goalOf({ createdAt: "2026-07-21T11:59:16Z" }),
    list: Array.from({ length: 18 }, (_, i) => ({ id: `queued-${i}`, objective: "queued", addedAt: "z" })),
  };
  assert.equal(
    buildStatusText(goldenQueued, null, NOW, undefined, { activity: "queued" }),
    "glla: [QUEUED] 44s · 18 queued",
  );
});

test("live capsule shows a compact animated signal and truthful freshness text", () => {
  const state = { goal: goalOf(), list: [] };
  const first = buildStatusText(state, null, NOW, undefined, {
    activity: "working",
    lastStreamActivityAt: NOW - 1_000,
  })!;
  const next = buildStatusText(state, null, NOW + 751, undefined, {
    activity: "working",
    lastStreamActivityAt: NOW - 249,
  })!;
  assert.match(first, /glla: \[[▁▂▄▆█]{6} LIVE · WORKING\]/);
  assert.match(next, /glla: \[[▁▂▄▆█]{6} LIVE · WORKING\]/);
  assert.notEqual(first.slice(0, first.indexOf(" LIVE")), next.slice(0, next.indexOf(" LIVE")), "the signal visibly advances while live");
  assert.match(first, /last stream 1s ago/);
  assert.doesNotMatch(first, /%|complete|progress/i, "the signal is not a fake completion meter");
});

test("live capsule keeps semantic colors without decorative noise", () => {
  const calls: string[] = [];
  const theme = {
    fg(color: string, text: string) {
      calls.push(`${color}:${text}`);
      return `<${color}>${text}</${color}>`;
    },
  };
  const status = buildStatusText(
    { goal: goalOf(), list: [] },
    null,
    NOW,
    theme,
    { activity: "working", lastStreamActivityAt: NOW - 1_000 },
  )!;
  assert.match(status, /<dim>\[<\/dim>(?:<muted>[▁]<\/muted>|<accent>[▂▄▆]<\/accent>|<success>[█]<\/success>){6}<dim> <\/dim><success>LIVE<\/success><dim> · <\/dim><accent>WORKING<\/accent><dim>\]<\/dim>/);
  assert.ok(calls.some((call) => call.startsWith("success:LIVE")), "LIVE remains semantically highlighted");
  assert.ok(calls.some((call) => call.startsWith("accent:WORKING")), "WORKING remains semantically highlighted");
  assert.ok(calls.some((call) => call.startsWith("success:█")), "the signal peak is semantically highlighted");
  assert.ok(calls.some((call) => call.startsWith("accent:▆")), "the signal body remains visible");
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

test("stale interrupted goal is visibly orphaned, not normally active", () => {
  const g = goalOf({
    policy: "list",
    interruptedAt: "2026-07-21T11:59:00Z",
    interruptedReason: "extension api stale (heartbeat probe)",
  });
  const status = buildStatusText({ goal: g, list: [{ id: "next", objective: "next", addedAt: "z" }] }, null, NOW)!;
  assert.match(status, /interrupted — stale handle/);
  const lines = buildWidgetLines({ goal: g, list: [{ id: "next", objective: "next", addedAt: "z" }] }, null, NOW)!;
  assert.match(lines[0]!, /⚠ .* · interrupted · /);
  assert.ok(lines.some((line) => line.includes("host session lost — waiting for fresh session_start")));
  assert.ok(lines.some((line) => line.includes("/reload to rebind") && line.includes("/list resume")));
  assert.ok(!lines.some((line) => /· active ·/.test(line)), "stale work must not look normally active");
});

test("accepted continuation without a turn-start proof is not mislabeled as a lost host session", () => {
  const g = goalOf({
    policy: "list",
    interruptedAt: "2026-07-21T11:59:00Z",
    interruptedReason: "continuation start acknowledgement timed out (dispatch-1)",
  });
  const status = buildStatusText({ goal: g, list: [] }, null, NOW)!;
  assert.match(status, /turn start not observed — automatic retry held/);
  assert.doesNotMatch(status, /stale handle/);
  const lines = buildWidgetLines({ goal: g, list: [] }, null, NOW)!;
  assert.ok(lines.some((line) => line.includes("continuation was accepted, but pi did not start a turn")));
  assert.ok(lines.some((line) => line.includes("automatic re-sends are stopped") && line.includes("/list resume")));
  assert.ok(!lines.some((line) => line.includes("host session lost")), "trigger failure must not claim the host disappeared");
});

test("lifecycle interruption keeps durable auditor disapproval feedback visible", () => {
  const report = "## Required fixes\n- preserve this required-fixes excerpt after lifecycle failure\n<disapproved/>";
  for (const [interruptedReason, lifecycleText] of [
    ["continuation start acknowledgement timed out (dispatch-1)", "continuation was accepted, but pi did not start a turn"],
    ["extension api stale (heartbeat probe)", "host session lost — waiting for fresh session_start"],
  ] as const) {
    const g = goalOf({
      interruptedAt: "2026-07-21T11:59:00Z",
      interruptedReason,
      pauseReason: "auditor disapproved",
      auditHistory: [{
        at: "2026-07-21T11:58:30Z",
        approved: false,
        disapproved: true,
        model: "auditor",
        report,
      }],
    });
    const widget = buildWidgetLines({ goal: g, list: [] }, null, NOW)!;
    const rendered = widget.join("\\n");
    assert.ok(rendered.includes(lifecycleText), `lifecycle marker missing: ${rendered}`);
    assert.ok(rendered.includes("auditor disapproved — durable required fixes"), rendered);
    assert.ok(rendered.includes("required-fixes excerpt after lifecycle failure"), rendered);
    assert.ok(rendered.includes("/goal resume"), rendered);
  }
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

test("widget lines reserve pi-tui's horizontal padding", () => {
  const g = goalOf({
    status: "auditing",
    policy: "list",
    objective: "x".repeat(240),
    createdAt: "2026-07-21T11:59:10Z",
  });
  const lines = buildWidgetLines(
    { goal: g, list: [] },
    { phase: "running", label: "running", currentTool: "bash" },
    NOW,
    undefined,
    80,
  )!;
  // pi wraps string-array widget lines inside Text(paddingX=1), so the
  // extension must keep every source line within width - 2.
  assert.ok(lines.every((line) => line.length <= 78), lines.join("\\n"));
  assert.match(lines[0]!, / · list item · auditing · 50s/);
  assert.ok(!lines.includes("50s"), "elapsed segment must not wrap onto its own line");
});

test("list policy footer: queued count, no duplicated 'list'", () => {
  const s = buildStatusText(
    { goal: goalOf({ policy: "list" }), list: [{ id: "x", objective: "y", addedAt: "z" }] },
    null,
    NOW,
  )!;
  // v0.24.7: was "glla: list ● 3m 00s · list 1" — policy label and queue
  // counter both said "list".
  assert.match(s, /^glla: /);
  assert.doesNotMatch(s, /^glla: list /, 'v0.34.1: policy word dropped — no list/list-item doubling with the widget chip');
  assert.match(s, /· 1 queued$/);
  assert.ok(!/list .+ list /.test(s), `no duplicated 'list … list': ${s}`);
});

test("goal policy footer says 'N queued' (v0.28.11 U10 — was the cryptic 'list N')", () => {
  const s = buildStatusText(
    { goal: goalOf(), list: [{ id: "x", objective: "y", addedAt: "z" }] },
    null,
    NOW,
  )!;
  assert.match(s, /^glla: /);
  assert.doesNotMatch(s, /^glla: goal /, 'v0.34.1: policy word dropped');
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

test("long-running list card shows a truthful queue trail and immediate next item", () => {
  const lines = buildWidgetLines(
    {
      goal: goalOf({ policy: "list", usage: undefined }),
      list: [
        { id: "a", objective: "write the next focused improvement", addedAt: "2026-07-21T11:55:00Z" },
        { id: "b", objective: "later item", addedAt: "2026-07-21T11:58:00Z" },
      ],
    },
    null,
    NOW,
  )!;
  assert.ok(lines.some((line) => line.includes("↳ 2 waiting · up next: write the next focused improvement")));
  assert.ok(lines.some((line) => line.includes("waiting 5m")), "valid queue timestamps get a wait age");
  assert.equal(lines[lines.length - 1], "└─ 2 queued · /list · /glla");
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
  assert.match(s, /auditor running/);
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
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-1" } });
  const lines = buildWidgetLines({ goal: g, list: [] }, { label: "verifying contract", currentTool: "grep", elapsedMs: 42_000 }, NOW)!;
  assert.ok(lines.some((l) => l.includes("verifying contract")));
  assert.ok(lines.some((l) => l.includes("grep")));
  assert.ok(lines.some((l) => l.includes("42s")));
  assert.match(buildStatusText({ goal: g, list: [] }, { currentTool: "grep" }, NOW)!, /auditor running · grep/);
});

test("widget: interrupted completion claims render recovery-pending, not auditor-running", () => {
  const claim = { at: "2026-07-21T11:59:00Z", completionSummary: "done" };
  const g = goalOf({ status: "auditing", pendingCompletion: claim }); // legacy claim has no phase
  const state = { goal: g, list: [] };
  const status = buildStatusText(state, null, NOW)!;
  assert.match(status, /audit recovery pending/);
  assert.doesNotMatch(status, /auditing…/);
  const lines = buildWidgetLines(state, null, NOW)!;
  assert.ok(lines.some((l) => l.includes("recovery pending — previous audit was interrupted")));
  assert.ok(lines.some((l) => l.includes("stored completion claim is safe")));
  assert.ok(!lines.some((l) => l.includes("auditor: running")));
});

test("widget: a durable running claim without observed progress says awaiting verdict", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-2" } });
  const state = { goal: g, list: [] };
  const lines = buildWidgetLines(state, null, NOW)!;
  assert.ok(lines.some((l) => l.includes("auditor: awaiting verdict")));
  assert.ok(lines.some((l) => l.includes("waiting for detached verdict")));
  assert.match(buildStatusText(state, null, NOW)!, /auditor awaiting verdict/);
  assert.ok(!lines.some((l) => l.includes("recovery pending")));
});

test("auditor progress phases are explicit and retain worker activity", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-3" } });
  const queued = buildWidgetLines({ goal: g, list: [] }, { label: "queued" }, NOW)!;
  assert.ok(queued.some((l) => l.includes("MAIN HOST · SUPERVISING · auditor: queued")));
  assert.ok(queued.some((l) => l.includes("completion claim is durable")));

  const running = buildWidgetLines({ goal: g, list: [] }, {
    phase: "tool_executing",
    currentTool: "grep",
    elapsedMs: 42_000,
    lastActivityAt: NOW - 30_000,
  }, NOW)!;
  assert.ok(running.some((l) => l.includes("auditor: last observed tool")));
  assert.ok(running.some((l) => l.includes("tool: grep")));
  assert.ok(running.some((l) => l.includes("worker activity 30s ago")));

  const quiet = buildWidgetLines({ goal: g, list: [] }, {
    phase: "thinking",
    elapsedMs: 600_000,
    lastActivityAt: NOW - 7 * 60_000,
  }, NOW)!;
  assert.ok(quiet.some((l) => l.includes("auditor: quiet")));
  assert.ok(quiet.some((l) => l.includes("auditor quiet 7m") && l.includes("worker activity 7m")));

  const blocked = buildStatusText({ goal: g, list: [] }, { label: "infra error — retrying once" }, NOW)!;
  assert.match(blocked, /auditor blocked/);
});

test("auditor widget shows concrete worker observations without exposing think blocks", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-live" } });
  const lines = buildWidgetLines({ goal: g, list: [] }, {
    phase: "tool_executing",
    currentTool: "read",
    currentToolArgs: JSON.stringify({ path: "/repo/README.md", command: "do not display this" }),
    currentToolStartedAt: NOW - 2_000,
    recentOutput: ["<think>private reasoning</think>", "inspected README.md"],
    toolCalls: [{ name: "grep", argsPrefix: "{}", finishedAt: NOW - 3_000 }],
    elapsedMs: 42_000,
    lastActivityAt: NOW - 1_000,
  }, NOW)!;
  const joined = lines.join("\n");
  assert.match(joined, /auditor: tool executing/);
  assert.match(joined, /tool: read → README\.md/);
  assert.match(joined, /latest: inspected README\.md/);
  assert.doesNotMatch(joined, /private reasoning|do not display this/);
  assert.match(joined, /worker activity 1s ago/);

  const cumulativeReport = buildWidgetLines({ goal: g, list: [] }, {
    phase: "producing_report",
    recentOutput: ["Audit summary: checked", "Next line now"],
    elapsedMs: 42_000,
    lastActivityAt: NOW - 1_000,
  }, NOW)!;
  assert.match(cumulativeReport.join("\\n"), /latest: Next line now/);
  assert.doesNotMatch(cumulativeReport.join("\\n"), /latest: (?:checked|:)/);

  const liveAuditStatus = buildStatusText({ goal: g, list: [] }, {
    phase: "tool_executing",
    currentTool: "read",
    lastActivityAt: NOW - 1_000,
  }, NOW)!;
  assert.match(liveAuditStatus, /MAIN HOST · SUPERVISING/);
  assert.match(liveAuditStatus, /auditor tool executing \[[▁▂▄▆█]{6} AUDITOR · DETACHED · LIVE\] · read/);

  const streamedThink = buildWidgetLines({ goal: g, list: [] }, {
    phase: "thinking",
    recentOutput: ["<think>", "private streamed reasoning"],
    elapsedMs: 42_000,
    lastActivityAt: NOW - 1_000,
  }, NOW)!;
  assert.doesNotMatch(streamedThink.join("\n"), /private streamed reasoning/);
});

test("v0.34.56: unmatched tool-event counts render ONLY with evidence (never a zero-fact observation)", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-gate" } });
  const base = {
    phase: "tool_executing" as const,
    currentTool: "read",
    currentToolStartedAt: NOW - 2_000,
    recentOutput: ["inspected README.md"],
    toolCalls: [{ name: "grep", argsPrefix: "{}", finishedAt: NOW - 3_000 }],
    elapsedMs: 42_000,
    lastActivityAt: NOW - 1_000,
  };
  // Evidence present: both counts surface exactly.
  const withFacts = buildWidgetLines({ goal: g, list: [] }, {
    ...base,
    unmatchedToolStarts: 2,
    unmatchedToolEnds: 1,
  }, NOW)!.join("\n");
  assert.match(withFacts, /unmatched tool events: 2 start \/ 1 end — explicitly unpaired, never falsely matched/);
  // No evidence: the observation must not exist at all — zero is not a fact.
  for (const audit of [
    { ...base },                        // fields absent (old worker protocol)
    { ...base, unmatchedToolStarts: 0, unmatchedToolEnds: 0 },
  ]) {
    const joined = buildWidgetLines({ goal: g, list: [] }, audit, NOW)!.join("\n");
    assert.doesNotMatch(joined, /unmatched tool events/, `no invented fact for ${JSON.stringify(audit)}`);
  }
  // Start-only facts still count as evidence (an orphaned start is a fact).
  const startOnly = buildWidgetLines({ goal: g, list: [] }, { ...base, unmatchedToolStarts: 3, unmatchedToolEnds: 0 }, NOW)!.join("\n");
  assert.match(startOnly, /unmatched tool events: 3 start \/ 0 end/);
});

test("stale auditor snapshots show the last tool, not a fake current tool", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-stale" } });
  const lines = buildWidgetLines({ goal: g, list: [] }, {
    phase: "tool_executing",
    currentTool: "read",
    currentToolArgs: JSON.stringify({ path: "/repo/README.md" }),
    currentToolStartedAt: NOW - 20_000,
    lastActivityAt: NOW - 20_000,
  }, NOW)!;
  const joined = lines.join("\n");
  assert.match(joined, /auditor: last observed tool/);
  assert.match(joined, /last tool: read/);
  assert.doesNotMatch(joined, /tool: read → README\.md/);
  assert.doesNotMatch(joined, /READ-ONLY · LIVE/);
});

test("auditor startup does not claim worker activity before the first RPC event", () => {
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-starting" } });
  const lines = buildWidgetLines({ goal: g, list: [] }, { phase: "starting", elapsedMs: 2_000 }, NOW)!;
  const joined = lines.join("\n");
  assert.match(joined, /auditor: starting/);
  assert.match(joined, /waiting for first worker event/);
  assert.doesNotMatch(joined, /last activity|worker activity/);
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
  assert.match(s, /glla: \[ACTIVE\]/); // v0.34.1: policy word dropped from the status line
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

test("active auditor infrastructure failure is visible as blocked, not green progress", () => {
  const g = goalOf({
    status: "active",
    pauseReason: "auditor infrastructure (retried once): pi exited without an agent_settled RPC event",
    pauseSuggestedAction: "Fix the auditor model, then /goal resume.",
  });
  const state = { goal: g, list: [], loop: null };
  const w = buildWidgetLines(state as never)!;
  assert.match(w[0]!, /auditor blocked — no verdict/);
  assert.ok(w.some((l) => l.includes("completion claim was not evaluated")), `widget: ${w.join("\n")}`);
  assert.ok(w.some((l) => l.includes("Fix the auditor model")), `action: ${w.join("\n")}`);
  const s = buildStatusText(state as never)!;
  assert.match(s, /auditor blocked — no verdict/);
  assert.doesNotMatch(s, /glla: ●/);
});

test("released auditor no-verdict state names the attached MAIN host", () => {
  const g = goalOf({
    status: "paused",
    pauseKind: "blocked",
    pauseReason: "completion audit blocked — no verdict: silent host successor",
    pauseSuggestedAction: "The completion claim is stored; /goal resume starts exactly one fresh auditor.",
    pendingCompletion: {
      at: "2026-07-21T11:59:00Z",
      phase: "recovery-pending",
      attemptId: "audit-no-verdict",
      completionSummary: "stored claim",
    },
  });
  const state = { goal: g, list: [], loop: null };
  const widget = buildWidgetLines(state as never)!;
  assert.ok(widget.some((line) => line.includes("auditor: blocked — no verdict")), widget.join("\\n"));
  assert.ok(widget.some((line) => line.includes("MAIN host remains attached")), widget.join("\\n"));
  assert.ok(widget.some((line) => line.includes("/goal resume")), widget.join("\\n"));
  const status = buildStatusText(state as never)!;
  assert.match(status, /MAIN HOST · auditor blocked — no verdict/);
  assert.doesNotMatch(status, /DETACHED · LIVE/);
});

test("MAIN activity is never represented as detached — the detached marker belongs only to the live auditor badge", () => {
  // MAIN actively working (status active, no audit in flight): no detached
  // representation anywhere — the host stays attached and unnamed as such.
  const active = goalOf({ status: "active", objective: "active main work — done when pinned" });
  const activeState = { goal: active, list: [], loop: null };
  const activeWidget = buildWidgetLines(activeState as never)!;
  const activeStatus = buildStatusText(activeState as never)!;
  assert.doesNotMatch(activeWidget.join("\n"), /DETACHED|detached/, "MAIN activity never renders as detached (widget)");
  assert.doesNotMatch(activeStatus, /DETACHED|detached/, "MAIN activity never renders as detached (status)");

  // Auditing MAIN: the ONLY detached marker in the whole projection is the
  // live auditor activity badge; the host projection is MAIN HOST · SUPERVISING.
  const g = goalOf({ status: "auditing", pendingCompletion: { at: "2026-07-21T11:59:00Z", phase: "running", attemptId: "audit-host-invariant" } });
  const state = { goal: g, list: [], loop: null };
  const status = buildStatusText(state as never, { phase: "tool_executing", currentTool: "read", lastActivityAt: NOW - 1_000 }, NOW)!;
  assert.match(status, /MAIN HOST · SUPERVISING/);
  const detachedCount = (status.match(/DETACHED/g) ?? []).length;
  assert.equal(detachedCount, 1, `exactly one detached marker, inside the auditor badge: ${status}`);
  const badgeIndex = status.indexOf("AUDITOR · DETACHED · LIVE");
  const hostIndex = status.indexOf("MAIN HOST · SUPERVISING");
  assert.ok(hostIndex >= 0 && badgeIndex > hostIndex, "the host names MAIN first; the detached auditor badge follows");
});

test("active auditor verdicts never masquerade as infrastructure no-verdict", () => {
  const shield = goalOf({
    status: "active",
    pauseReason: "regression shield: auditor approved, but evidence never referenced 1 contract item(s)",
    pauseSuggestedAction: "Call complete_goal again with evidence for the missing item.",
  });
  const shieldState = { goal: shield, list: [], loop: null };
  const shieldWidget = buildWidgetLines(shieldState as never)!;
  assert.match(shieldWidget[0]!, /regression shield — evidence gap/);
  assert.ok(shieldWidget.some((l) => l.includes("auditor approved; regression shield found missing evidence")), `shield: ${shieldWidget.join("\\n")}`);
  assert.doesNotMatch(shieldWidget.join("\\n"), /no verdict|claim was not evaluated/);
  assert.match(buildStatusText(shieldState as never)!, /regression shield — evidence gap/);

  const disapproved = goalOf({
    status: "active",
    pauseReason: "auditor disapproved",
    pauseSuggestedAction: "Inspect auditor feedback and fix the actual gap before calling complete_goal again",
    auditHistory: [{
      at: "2026-07-21T11:59:30Z",
      approved: false,
      disapproved: true,
      model: "auditor",
      report: "## Required fixes\n- update assets-manifest to v1.0.0-image-regen\n<disapproved/>",
    }],
  });
  const disapprovalState = { goal: disapproved, list: [], loop: null };
  const disapprovalWidget = buildWidgetLines(disapprovalState as never)!;
  assert.match(disapprovalWidget[0]!, /auditor disapproved — fix the gap/);
  assert.ok(disapprovalWidget.some((l) => l.includes("auditor verdict: disapproved")), `disapproval: ${disapprovalWidget.join("\\n")}`);
  assert.ok(disapprovalWidget.some((l) => l.includes("v1.0.0-image-regen")), `feedback: ${disapprovalWidget.join("\\n")}`);
  assert.doesNotMatch(disapprovalWidget.join("\\n"), /no verdict|claim was not evaluated/);
  assert.match(buildStatusText(disapprovalState as never)!, /auditor disapproved — fix the gap/);
});

test("quota wait gets a distinct recovery HUD without raw provider JSON", () => {
  const g = goalOf({
    status: "paused",
    policy: "list",
    pauseKind: "wait",
    pauseReason: 'main model recovery — retrying in 15m (main model quota: 429 {"message":"Token Plan usage limit reached"})',
    pauseResumeAt: new Date(Date.now() + 23 * 3600_000).toISOString(),
    pauseSuggestedAction: "The provider/quota wall is being retried automatically; /list resume retries immediately.",
  });
  const state = { goal: g, list: [{ id: "next", objective: "later", addedAt: "z" }], loop: null };
  const w = buildWidgetLines(state as never)!;
  assert.ok(w.some((l) => l.includes("QUOTA WALL · Token Plan usage limit · 1 waiting in list")), `quota banner: ${w.join("\n")}`);
  assert.ok(w.some((l) => l.includes("waiting — nothing for you to do") && l.includes("next probe in")), `countdown: ${w.join("\n")}`);
  assert.ok(w.some((l) => l.includes("saved —")), `saved state: ${w.join("\n")}`);
  assert.doesNotMatch(w.join("\n"), /main model quota: 429|Token Plan usage limit reached.*message/, "raw provider JSON stays out of the card");
  const s = buildStatusText(state as never)!;
  assert.match(s, /QUOTA WALL/);
  assert.match(s, /1 queued/);
});

test("ambiguous provider recovery is not mislabeled as a quota wall", () => {
  const g = goalOf({
    status: "paused",
    pauseKind: "wait",
    pauseReason: "main model recovery — retrying in 15m (main model transient: 503 temporarily unavailable)",
    pauseResumeAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  const state = { goal: g, list: [], loop: null };
  const w = buildWidgetLines(state as never)!;
  assert.doesNotMatch(w.join("\\n"), /QUOTA WALL/);
  assert.match(buildStatusText(state as never)!, /waiting/);
});

test("quota manual hold stays distinct and does not show raw provider detail", () => {
  const g = goalOf({
    status: "paused",
    pauseKind: "blocked",
    pauseReason: "main model recovery — automatic probes stopped (provider supplied a reset beyond the 5h automatic probe budget) · main model quota: 429 reset in 1 week",
    pauseSuggestedAction: "Check the provider reset, then /goal resume to start a fresh bounded window.",
  });
  const state = { goal: g, list: [], loop: null };
  const w = buildWidgetLines(state as never)!;
  assert.ok(w.some((l) => l.includes("QUOTA WALL")), `quota hold: ${w.join("\\n")}`);
  assert.ok(w.some((l) => l.includes("manual resume required")), `manual action: ${w.join("\\n")}`);
  assert.doesNotMatch(w.join("\\n"), /automatic probes stopped \(provider supplied/);
});

test("v0.34.51: a passed quota resumeAt says resuming…, never the old 'retrying now'", () => {
  const g = goalOf({
    status: "paused",
    pauseKind: "wait",
    pauseReason: "main model recovery — retrying in 15m (main model quota: 429 Token Plan usage limit)",
    pauseResumeAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  });
  const state = { goal: g, list: [], loop: null };
  const s = buildStatusText(state as never)!;
  assert.match(s, /resuming…/);
  assert.doesNotMatch(s, /retrying now/);
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
  assert.match(loopLines[2]!, /^└─ metricless \(no plateau\) · \/loop stop · \/loop refine/); // v0.33.2: /loop refine is a real verb now
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

test("v0.33.2: loop proactiveness + respec machinery", () => {
  const SRC = fs.readFileSync("extensions/loops/goal.ts", "utf-8");
  // Reprieve names the top open finding, not just the count.
  assert.match(SRC, /topOpenAuditFinding\(ctx\.cwd\)/);
  assert.match(SRC, /Top open: \$\{topFinding\}/);
  // Saturated metric → the loop suggests propose_loop_refine itself.
  assert.match(SRC, /flat at best — if the spec no longer captures 'better'/);
  // Hypothesis feedback closes the loop into the next prompt.
  assert.match(SRC, /Last iteration you predicted: /);
  assert.match(SRC, /loop\.lastHypothesis = hypothesis;/);
  // /loop refine is a real subcommand (the footer's verb exists).
  assert.match(SRC, /if \(sub === "refine" \|\| sub === "polish"\)/);
  assert.match(SRC, /state\.loop!\.refineHint = hint\.slice\(0, 300\);/);
  // propose_loop_refine carries specText/specAppend; the orchestrator owns the write.
  assert.match(SRC, /specText: Type\.Optional/);
  assert.match(SRC, /fs\.writeFileSync\(loop\.specFile/);
  // Spec drift detection + checkbox progress emission (spec_item_progress is now emitted).
  assert.match(SRC, /appendLedger\(ctx\.cwd, "spec_updated", \{ via: "external"/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "spec_item_progress", \{ iteration: loop\.iteration, newlyChecked/);
  // LoopState carries the spec + feedback fields.
  const FOREVER = fs.readFileSync("extensions/goal-loop-forever.ts", "utf-8");
  assert.match(FOREVER, /specFile\?: string;/);
  assert.match(FOREVER, /hypothesisFeedback\?: string;/);
  assert.match(FOREVER, /refineHint\?: string;/);
  // Cosmetic-churn detection in the write-exemption (metricless doorknob leak).
  const REP = fs.readFileSync("extensions/goal-loop-repetition.ts", "utf-8");
  assert.match(REP, /cosmetic churn: wrote files but the reply is ~/);
  // Prompts carry the new placeholders.
  const METRIC = fs.readFileSync("prompts/goal-loop-forever.md", "utf-8");
  assert.match(METRIC, /\$\{HYPOTHESIS_NOTE\}/);
  assert.match(METRIC, /\$\{REFINE_HINT\}/);
  const ML = fs.readFileSync("prompts/goal-loop-forever-metricless.md", "utf-8");
  assert.match(ML, /\$\{HYPOTHESIS_NOTE\}/);
  assert.match(ML, /\$\{REFINE_HINT\}/);
});
