// pi-goal-list-loop-audit — v0.38.3
// tests/auditor-transcript-widget.test.ts
//
// Goal 20260902085243-uzf6mx: pure-function tests for the auditor
// transcript surface. No worker spawn, no pi runtime — the loader reads
// synthesized JSON fixtures and the renderer is a pure projection of the
// resulting events. Covers:
//
//   * loadAuditorTranscript: reaped / empty / events (+ newest-dir resolve)
//   * renderAuditorTranscriptLines: header + bounded line projection
//   * detectVerdict (via the loader): all three verdict shapes
//   * terminal marker: ok vs error / infrastructureClass
//   * transcriptHint: behavior for the audit-card header

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadAuditorTranscript,
  newestAuditJobDir,
  renderAuditorTranscriptLines,
  resolveAuditJobDir,
  transcriptHint,
  auditJobDir,
  type LoadResult,
  type TranscriptEvent,
} from "../extensions/auditor-transcript.ts";

function withTempDir<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "glla-transcript-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeJob(root: string, attemptId: string, progress: unknown, result?: unknown): string {
  const dir = auditJobDir(root, attemptId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "progress.json"), JSON.stringify(progress));
  if (result !== undefined) {
    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  }
  return dir;
}

test("auditJobDir: joins .pi-glla/audit-jobs/<id> under root", () => {
  assert.equal(auditJobDir("/tmp/proj", "abc-123"), "/tmp/proj/.pi-glla/audit-jobs/abc-123");
});

// v0.38.3: an absent attemptId means "the most recent audit" (the
// post-completion surface, where the claim is already gone). With no job
// dirs at all there is nothing to show — reaped, so the card hides.
test("loadAuditorTranscript: undefined attemptId with no job dirs is reaped", () => {
  assert.deepEqual(loadAuditorTranscript("/tmp/whatever-nonexistent-glla-root", undefined), { kind: "reaped" });
});

test("newestAuditJobDir: picks the most recently modified dir, ignores stray files", () => {
  withTempDir((root) => {
    const older = join(root, ".pi-glla", "audit-jobs", "audit-old-a1-aaaaaaaa");
    const newer = join(root, ".pi-glla", "audit-jobs", "audit-new-b2-bbbbbbbb");
    writeJob(root, "audit-old-a1-aaaaaaaa", { protocolVersion: 1, phase: "running", elapsedMs: 0 });
    writeJob(root, "audit-new-b2-bbbbbbbb", { protocolVersion: 1, phase: "running", elapsedMs: 0 });
    // A stray FILE in the jobs root must never be mistaken for a job dir.
    writeFileSync(join(root, ".pi-glla", "audit-jobs", "stray.lock"), "{}" );
    const base = Date.now() - 120_000;
    utimesSync(join(older, "progress.json"), new Date(base), new Date(base));
    utimesSync(join(newer, "progress.json"), new Date(base + 60_000), new Date(base + 60_000));
    assert.equal(newestAuditJobDir(root), newer);
  });
});

test("newestAuditJobDir: null when the root is missing or empty", () => {
  withTempDir((root) => {
    assert.equal(newestAuditJobDir(root), null, "no .pi-glla/audit-jobs at all");
    mkdirSync(join(root, ".pi-glla", "audit-jobs"), { recursive: true });
    assert.equal(newestAuditJobDir(root), null, "empty root");
  });
});

test("loadAuditorTranscript: undefined attemptId reads the newest finished audit", () => {
  withTempDir((root) => {
    // Two finished audits; the newest dir's result must win — this is what
    // makes the just-completed audit readable after the slot is cleared.
    const older = writeJob(
      root,
      "audit-old-a1-aaaaaaaa",
      { protocolVersion: 1, phase: "complete", elapsedMs: 1000, toolCalls: [{ name: "read", argsPrefix: "old.txt", finishedAt: 1, ok: true }] },
      { protocolVersion: 1, ok: true, output: "work <approved/> done", model: "provider/old" },
    );
    const newer = writeJob(
      root,
      "audit-new-b2-bbbbbbbb",
      { protocolVersion: 1, phase: "complete", elapsedMs: 2000, toolCalls: [{ name: "bash", argsPrefix: "npm test", finishedAt: 1, ok: true }] },
      { protocolVersion: 1, ok: true, output: "work <approved/> done", model: "provider/new" },
    );
    const base = Date.now() - 120_000;
    // dirMtimeMs prefers progress.json — stamp BOTH files per dir.
    for (const f of ["progress.json", "result.json"]) {
      utimesSync(join(older, f), new Date(base), new Date(base));
      utimesSync(join(newer, f), new Date(base + 60_000), new Date(base + 60_000));
    }

    const loaded = loadAuditorTranscript(root, undefined);
    assert.equal(loaded.kind, "events");
    if (loaded.kind !== "events") return;
    assert.equal(loaded.model, "provider/new");
    assert.equal(loaded.terminal, true);
    const tools = loaded.events.filter((e) => e.kind === "tool_end").map((e) => (e as { name: string }).name);
    assert.deepEqual(tools, ["bash"], "only the newest audit's tool calls surface");
  });
});

test("loadAuditorTranscript: reaped when the job dir does not exist", () => {
  withTempDir((root) => {
    const loaded = loadAuditorTranscript(root, "missing-attempt");
    assert.equal(loaded.kind, "reaped");
  });
});

// v0.38.3: launch dirs are named `<logicalAttemptId>-<launchTime36>-<rand8>`
// (newDetachedAuditJobAttemptId), so the claim's stored attemptId never
// equals the dir name. The reader resolves by prefix + newest mtime.
test("resolves suffixed launch dirs and reads the newest one", () => {
  withTempDir((root) => {
    const logical = "audit-mtkq7q92-7fqw75";
    const older = join(root, ".pi-glla", "audit-jobs", `${logical}-a1-aaaaaaaa`);
    const newer = join(root, ".pi-glla", "audit-jobs", `${logical}-b2-bbbbbbbb`);
    writeJob(
      root,
      `${logical}-a1-aaaaaaaa`,
      { protocolVersion: 1, attemptId: `${logical}-a1-aaaaaaaa`, phase: "running", elapsedMs: 0, recentOutput: ["older launch line"] },
    );
    writeJob(
      root,
      `${logical}-b2-bbbbbbbb`,
      { protocolVersion: 1, attemptId: `${logical}-b2-bbbbbbbb`, phase: "running", elapsedMs: 0, recentOutput: ["newer launch line"] },
    );
    const base = Date.now() - 60_000;
    utimesSync(join(older, "progress.json"), new Date(base), new Date(base));
    utimesSync(join(newer, "progress.json"), new Date(base + 30_000), new Date(base + 30_000));

    assert.equal(resolveAuditJobDir(root, logical), newer);
    const loaded = loadAuditorTranscript(root, logical);
    assert.equal(loaded.kind, "events");
    if (loaded.kind !== "events") return;
    const streams = loaded.events.filter((e) => e.kind === "stream");
    assert.deepEqual(streams.map((e) => (e as { line: string }).line), ["newer launch line"]);
  });
});

test("resolveAuditJobDir: prefers the exact-name dir when it exists", () => {
  withTempDir((root) => {
    const id = "audit-exact-0000";
    const dir = writeJob(root, id, { protocolVersion: 1, attemptId: id, phase: "running" });
    assert.equal(resolveAuditJobDir(root, id), dir);
  });
});

test("resolveAuditJobDir: never matches a different logical attempt", () => {
  withTempDir((root) => {
    // A dir whose name merely CONTAINS the id is not a prefix match.
    writeJob(root, "x-audit-target-1111-a1-aaaaaaaa", { protocolVersion: 1, attemptId: "x-audit-target-1111-a1-aaaaaaaa" });
    writeJob(root, "audit-other-9999-a1-aaaaaaaa", { protocolVersion: 1, attemptId: "audit-other-9999-a1-aaaaaaaa" });
    assert.equal(resolveAuditJobDir(root, "audit-target-1111"), null);
  });
});

test("loadAuditorTranscript: empty when neither file is parseable/present", () => {
  withTempDir((root) => {
    writeJob(root, "a1", { protocolVersion: 1 });
    // corrupt result.json
    const dir = auditJobDir(root, "a1");
    writeFileSync(join(dir, "result.json"), "not json{");
    const loaded = loadAuditorTranscript(root, "a1");
    assert.equal(loaded.kind, "empty");
  });
});

test("loadAuditorTranscript: events assembled from toolCalls + recentOutput", () => {
  withTempDir((root) => {
    const now = 1_700_000_000_000;
    writeJob(
      root,
      "a2",
      {
        protocolVersion: 1,
        attemptId: "a2",
        phase: "producing_report",
        elapsedMs: 12_000,
        reportBytes: 42,
        lastActivityAt: now,
        toolCalls: [
          { name: "read", argsPrefix: "extensions/goal-loop-core.ts", finishedAt: now - 5_000, ok: true },
          { name: "grep", argsPrefix: "auditor", finishedAt: now - 1_000, ok: true },
        ],
        recentOutput: ["first streamed line", "second streamed line"],
      },
    );
    const loaded = loadAuditorTranscript(root, "a2");
    assert.equal(loaded.kind, "events");
    if (loaded.kind !== "events") return;
    // tool_end × 2 + stream × 2 = 4 events
    assert.equal(loaded.events.length, 4);
    const tools = loaded.events.filter((e) => e.kind === "tool_end");
    const streams = loaded.events.filter((e) => e.kind === "stream");
    assert.equal(tools.length, 2);
    assert.equal(streams.length, 2);
    assert.equal(tools[0]?.kind, "tool_end");
    if (tools[0]?.kind === "tool_end") {
      assert.equal(tools[0].name, "read");
      assert.equal(tools[0].target, "extensions/goal-loop-core.ts");
      assert.equal(tools[0].ok, true);
    }
    assert.equal(streams[0]?.kind, "stream");
    if (streams[0]?.kind === "stream") {
      assert.equal(streams[0].line, "first streamed line");
    }
  });
});

test("loadAuditorTranscript: result.json adds verdict + terminal", () => {
  withTempDir((root) => {
    writeJob(
      root,
      "a3",
      {
        protocolVersion: 1,
        attemptId: "a3",
        phase: "complete",
        elapsedMs: 30_000,
        toolCalls: [{ name: "bash", argsPrefix: "npm test", finishedAt: 1, ok: true }],
        recentOutput: ["done"],
      },
      {
        protocolVersion: 1,
        attemptId: "a3",
        ok: true,
        output: "all checks pass <approved/>",
        model: "anthropic/claude-opus-4",
        toolCalls: [],
      },
    );
    const loaded = loadAuditorTranscript(root, "a3");
    assert.equal(loaded.kind, "events");
    if (loaded.kind !== "events") return;
    const verdict = loaded.events.find((e) => e.kind === "verdict");
    const terminal = loaded.events.find((e) => e.kind === "terminal");
    assert.ok(verdict, "verdict event present");
    assert.ok(terminal, "terminal event present");
    assert.equal(verdict?.kind === "verdict" ? verdict.verdict : undefined, "approved");
    assert.equal(loaded.model, "anthropic/claude-opus-4");
    assert.equal(loaded.terminal, true);
    assert.equal(terminal?.kind === "terminal" ? terminal.ok : undefined, true);
  });
});

test("loadAuditorTranscript: terminal error surfaces infrastructureClass", () => {
  withTempDir((root) => {
    writeJob(
      root,
      "a4",
      { protocolVersion: 1, attemptId: "a4", phase: "tool_executing", elapsedMs: 600_000 },
      {
        protocolVersion: 1,
        attemptId: "a4",
        ok: false,
        output: "",
        error: "Auditor stalled 10m — no progress",
        infrastructureClass: "no-verdict",
        toolCalls: [],
      },
    );
    const loaded = loadAuditorTranscript(root, "a4");
    assert.equal(loaded.kind, "events");
    if (loaded.kind !== "events") return;
    const terminal = loaded.events.find((e) => e.kind === "terminal");
    assert.equal(terminal?.kind === "terminal" ? terminal.ok : undefined, false);
    assert.equal(terminal?.kind === "terminal" ? terminal.error : undefined, "Auditor stalled 10m — no progress");
    assert.equal(
      terminal?.kind === "terminal" ? terminal.infrastructureClass : undefined,
      "no-verdict",
    );
  });
});

test("loadAuditorTranscript: detects disapproved + impossible verdicts", () => {
  withTempDir((root) => {
    for (const [token, expected] of [
      ["<disapproved/> work is incomplete", "disapproved"],
      ["<impossible> requires human input", "impossible"],
    ] as const) {
      const id = `dis-${expected}`;
      writeJob(
        root,
        id,
        { protocolVersion: 1, attemptId: id, phase: "complete", elapsedMs: 1000 },
        { protocolVersion: 1, attemptId: id, ok: true, output: token, toolCalls: [] },
      );
      const loaded = loadAuditorTranscript(root, id);
      assert.equal(loaded.kind, "events", `expected events for ${expected}`);
      if (loaded.kind !== "events") continue;
      const v = loaded.events.find((e) => e.kind === "verdict");
      assert.equal(v?.kind === "verdict" ? v.verdict : undefined, expected);
    }
  });
});

test("loadAuditorTranscript: caps to MAX_TRANSCRIPT_EVENTS (30)", () => {
  withTempDir((root) => {
    const calls = Array.from({ length: 40 }, (_, i) => ({
      name: "read",
      argsPrefix: `file-${i}.ts`,
      finishedAt: 1_000 + i,
      ok: true,
    }));
    writeJob(root, "cap", {
      protocolVersion: 1,
      attemptId: "cap",
      phase: "producing_report",
      elapsedMs: 1,
      toolCalls: calls,
    });
    const loaded = loadAuditorTranscript(root, "cap");
    assert.equal(loaded.kind, "events");
    if (loaded.kind !== "events") return;
    assert.equal(loaded.events.length, 30, "kept the most recent 30 events");
  });
});

test("loadAuditorTranscript: malformed progress.json is treated as null (no crash)", () => {
  withTempDir((root) => {
    const dir = auditJobDir(root, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "progress.json"), "not json{");
    const loaded = loadAuditorTranscript(root, "broken");
    assert.equal(loaded.kind, "empty");
  });
});

test("renderAuditorTranscriptLines: emits header + bounded line projection", () => {
  const events: TranscriptEvent[] = [
    { kind: "tool_end", at: 1, name: "read", target: "core.ts", ok: true },
    { kind: "stream", at: 2, bytes: 5, line: "hi there" },
    { kind: "verdict", at: 3, verdict: "approved", line: "<approved/>" },
    { kind: "terminal", ok: true },
  ];
  const lines = renderAuditorTranscriptLines(events, { phaseLabel: "producing_report" });
  assert.ok(lines.length >= 5, "header + 4 events");
  assert.match(lines[0]!, /transcript: 4 events · producing_report/);
  assert.ok(lines.some((l) => l.includes("✓ read → core.ts")));
  assert.ok(lines.some((l) => l.includes("… hi there")));
  assert.ok(lines.some((l) => l.includes("⟡ approved")));
  assert.ok(lines.some((l) => l.includes("✓ terminal ok")));
});

test("renderAuditorTranscriptLines: terminal header swaps phase for ✓ done", () => {
  const lines = renderAuditorTranscriptLines(
    [{ kind: "terminal", ok: true }],
    { terminal: true, model: "claude-opus-4" },
  );
  assert.match(lines[0]!, /✓ done/);
  assert.match(lines[0]!, /claude-opus-4/);
});

test("renderAuditorTranscriptLines: terminal error surfaces the error string", () => {
  const lines = renderAuditorTranscriptLines(
    [{ kind: "terminal", ok: false, error: "transport lost" }],
    { terminal: true },
  );
  assert.ok(lines.some((l) => l.includes("✗ terminal") && l.includes("transport lost")));
});

test("transcriptHint: undefined when not-running", () => {
  assert.equal(transcriptHint({ kind: "not-running" }), undefined);
});

test("transcriptHint: explicit text for reaped and empty", () => {
  assert.equal(transcriptHint({ kind: "reaped" }), "transcript reaped — directory cleaned");
  assert.equal(transcriptHint({ kind: "empty" }), "transcript empty");
});

test("transcriptHint: events include the Ctrl+Shift+E invitation", () => {
  const loaded: LoadResult = {
    kind: "events",
    events: [{ kind: "tool_end", at: 1, name: "read", ok: true }],
    startedAt: 0,
  };
  const hint = transcriptHint(loaded);
  assert.ok(hint);
  assert.match(hint!, /Ctrl\+Shift\+E/);
  assert.match(hint!, /^transcript: 1 event/);
});
