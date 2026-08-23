// Tests for the v0.36.x commissar wiring (extensions/goal-commissar-hooks.ts):
// heartbeat gate conditions, single-flight, streak/threshold escalation,
// termination marker + abort, evidence digest, and the continuation-prompt
// RESTART directive. Real modules, injected dispatch — no real worker spawn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { state } from "../extensions/goal-state.ts";
import { appendLedger } from "../extensions/goal-loop-core.ts";
import type { Goal } from "../extensions/goal-loop-core.ts";
import {
  applyCommissarResult,
  buildCommissarEvidenceDigest,
  maybeFireCommissarCheck,
  resetCommissarRuntime,
} from "../extensions/goal-commissar-hooks.ts";
import { continuationPrompt } from "../extensions/goal-continuation.ts";

function activeGoal(): Goal {
  return {
    id: "g-comm-wiring",
    objective: "Ship the commissar feature.",
    status: "active",
    policy: "goal",
    autoContinue: false,
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function withGlobalSettings(
  values: Record<string, unknown>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-comm-settings-"));
  const file = path.join(dir, "settings.json");
  await writeFile(file, JSON.stringify(values));
  const prev = process.env.GLLA_GLOBAL_SETTINGS_PATH;
  process.env.GLLA_GLOBAL_SETTINGS_PATH = file;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.GLLA_GLOBAL_SETTINGS_PATH;
    else process.env.GLLA_GLOBAL_SETTINGS_PATH = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeCtx(): ExtensionContext & {
  aborts: number;
  notifications: string[];
} {
  const ctx = {
    cwd: process.cwd(),
    model: undefined,
    notifications: [] as string[],
    aborts: 0,
    abort() {
      ctx.aborts++;
    },
    ui: {
      notify(msg: string) {
        ctx.notifications.push(msg);
      },
    },
  };
  return ctx as never;
}

const ENABLED = {
  commissarEnabled: true,
  commissarIntervalMinutes: 1,
  commissarWantingThreshold: 2,
  auditorModel: "test/comm-model",
};

function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

// ---- gate conditions ----

test("gate: disabled by default → no check fires", async () => {
  await withGlobalSettings({}, async () => {
    resetCommissarRuntime();
    state.goal = activeGoal();
    const dispatched = maybeFireCommissarCheck(fakeCtx(), {
      dispatch: () => {
        throw new Error("must not spawn");
      },
    });
    assert.equal(dispatched, false);
  });
});

test("gate: no active goal → no check fires", async () => {
  await withGlobalSettings(ENABLED, async () => {
    resetCommissarRuntime();
    state.goal = null;
    assert.equal(maybeFireCommissarCheck(fakeCtx()), false);
    const pausedGoal = activeGoal();
    pausedGoal.status = "paused";
    state.goal = pausedGoal;
    assert.equal(maybeFireCommissarCheck(fakeCtx()), false);
  });
});

test("gate: null context → no check fires", async () => {
  await withGlobalSettings(ENABLED, async () => {
    resetCommissarRuntime();
    state.goal = activeGoal();
    assert.equal(maybeFireCommissarCheck(null), false);
  });
});

test("gate: enabled + active goal + interval elapsed → dispatches once (single-flight)", async () => {
  await withGlobalSettings(ENABLED, async () => {
    resetCommissarRuntime();
    state.goal = activeGoal();
    let calls = 0;
    const dispatch = (async () => {
      calls++;
      return {
        approved: true,
        disapproved: false,
        output: "<adherent/>",
        model: "m",
        commissar: { adherent: true, wanting: false },
      };
    }) as never;
    assert.equal(maybeFireCommissarCheck(fakeCtx(), { dispatch }), true);
    // Second call within the same tick is refused by the in-flight guard
    // until the promise chain settles.
    assert.equal(maybeFireCommissarCheck(fakeCtx(), { dispatch }), false);
    await settled();
    await settled();
    await settled();
    assert.equal(calls, 1);
  });
});

// ---- verdict application ----

test("apply: infra failure never escalates and never aborts", () => {
  resetCommissarRuntime();
  state.goal = activeGoal();
  const ctx = fakeCtx();
  applyCommissarResult(ctx, "g-comm-wiring", {
    infrastructureClass: "no-verdict",
    error: "no verdict marker",
    output: "",
  });
  assert.equal(ctx.aborts, 0);
  assert.equal(state.goal!.commissarRestart, undefined);
});

test("apply: adherent resets the wanting streak", () => {
  resetCommissarRuntime();
  state.goal = activeGoal();
  const ctx = fakeCtx();
  applyCommissarResult(ctx, "g-comm-wiring", {
    commissar: { adherent: false, wanting: true, reason: "stalled" },
  });
  applyCommissarResult(ctx, "g-comm-wiring", {
    commissar: { adherent: true, wanting: false },
  });
  // One WANTING then ADHERENT: below threshold (2) and streak cleared.
  assert.equal(ctx.aborts, 0);
  assert.equal(
    (state.goal as { commissarRestart?: unknown }).commissarRestart,
    undefined,
  );
});

test("apply: threshold reached → durable marker + abort; one wanting never does", () => {
  resetCommissarRuntime();
  state.goal = activeGoal();
  const updateCalls: Array<Partial<Goal>> = [];
  (globalThis as any).updateGoal = (patch: Partial<Goal>) => {
    updateCalls.push(patch);
    Object.assign(state.goal!, patch);
  };
  try {
    const ctx = fakeCtx();
    applyCommissarResult(ctx, "g-comm-wiring", {
      commissar: { adherent: false, wanting: true, reason: "nine idle turns" },
    });
    assert.equal(
      ctx.aborts,
      0,
      "one WANTING below threshold must not terminate",
    );
    applyCommissarResult(ctx, "g-comm-wiring", {
      commissar: { adherent: false, wanting: true, reason: "still idle" },
    });
    assert.equal(ctx.aborts, 1, "second consecutive WANTING terminates");
    assert.ok(
      updateCalls.some((p) => typeof p.commissarRestart?.reason === "string"),
    );
    assert.match(ctx.notifications[0] ?? "", /terminating the run/);
  } finally {
    delete (globalThis as any).updateGoal;
  }
});

test("apply: missing updateGoal bridge refuses to abort (fail-safe)", () => {
  resetCommissarRuntime();
  state.goal = activeGoal();
  delete (globalThis as any).updateGoal;
  const ctx = fakeCtx();
  applyCommissarResult(ctx, "g-comm-wiring", {
    commissar: { adherent: false, wanting: true, reason: "x" },
  });
  applyCommissarResult(ctx, "g-comm-wiring", {
    commissar: { adherent: false, wanting: true, reason: "y" },
  });
  assert.equal(ctx.aborts, 0, "no durable marker → no abort");
});

test("apply: stale goal id is refused", () => {
  resetCommissarRuntime();
  state.goal = activeGoal();
  applyCommissarResult(fakeCtx(), "some-other-goal", {
    commissar: { adherent: false, wanting: true, reason: "x" },
  });
  assert.equal(
    (state.goal as { commissarRestart?: unknown }).commissarRestart,
    undefined,
  );
});

// ---- evidence digest ----

test("digest: keeps this goal's recent events, drops other goals and junk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "glla-comm-ledger-"));
  try {
    appendLedger(dir, "goal_continuation_sent", { goalId: "g-a" });
    appendLedger(dir, "unrelated_event", {});
    appendLedger(dir, "commissar_verdict", {
      goalId: "g-comm-wiring",
      verdict: "wanting",
    });
    fs_appendForeignLine(dir);
    const digest = buildCommissarEvidenceDigest(dir, "g-comm-wiring");
    assert.match(digest, /commissar_verdict/);
    assert.doesNotMatch(digest, /goal_continuation_sent/);
    assert.doesNotMatch(digest, /torn-line/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** The ledger is JSONL; a torn line must not break the digest builder. */
function fs_appendForeignLine(cwd: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs") as typeof import("node:fs");
  fs.appendFileSync(
    require("node:path").join(cwd, ".pi-glla", "active.jsonl"),
    "torn-line\n",
  );
}

// ---- continuation prompt directive ----
// continuationPrompt lives behind createGoalContinuation(deps) (goal.ts
// owns the wiring), so these pins follow the completion-recap-shape.test.ts
// source-inspection pattern: assert the shipped function body carries the
// directive, the untrusted-reason delimiting, and the one-shot clearing.

function continuationPromptSource(): string {
  const fs = require("node:fs") as typeof import("node:fs");
  const src = fs.readFileSync("extensions/goal-continuation.ts", "utf-8");
  const fn = src.match(/export function continuationPrompt[\s\S]+?^}/m);
  assert.ok(fn, "continuationPrompt function found");
  return fn[0]!;
}

function sendContinuationSource(): string {
  const fs = require("node:fs") as typeof import("node:fs");
  const src = fs.readFileSync("extensions/goal-continuation.ts", "utf-8");
  const fn = src.match(
    /export function sendContinuation\([^\n]*\): void \{[\s\S]+?^}/m,
  );
  assert.ok(fn, "sendContinuation function found");
  return fn[0]!;
}

test("continuation prompt carries the COMMISSAR RESTART directive when marked", () => {
  const body = continuationPromptSource();
  assert.match(
    body,
    /goal\.commissarRestart/,
    "directive is gated on the durable marker",
  );
  assert.match(body, /COMMISSAR RESTART — YOU ARE THE FRESH RUN/);
  assert.match(
    body,
    /<commissar_reason>/,
    "the finding rides in its own untrusted block",
  );
  assert.match(
    body,
    /The objective is unchanged and remains the source of truth/,
  );
});

test("continuation prompt neutralizes forged closing tags in the reason", () => {
  const body = continuationPromptSource();
  const escapeChain = "replace(/<\\/commissar_reason>/gi";
  assert.ok(
    body.includes(escapeChain),
    "closing-tag escape must run before interpolation",
  );
});

test("sendContinuation clears the commissarRestart marker exactly once per dispatch", () => {
  const body = sendContinuationSource();
  assert.match(body, /commissarRestart: undefined/);
  assert.match(body, /commissar_restart_delivered/);
});
