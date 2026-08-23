// pi-goal-list-loop-audit — v0.36.x
// extensions/goal-commissar-hooks.ts
//
// Commissar watchdog wiring: fires detached adherence checks on the ACTIVE
// goal from the heartbeat cadence, and — when consecutive WANTING verdicts
// reach the configured threshold — terminates the main agent run and lets
// the continuation engine start a fresh run on the SAME objective.
//
// Dependency direction (mirrors goal-heartbeat.ts): this module NEVER
// imports from extensions/loops/goal.ts. The one orchestrator-owned
// primitive it needs (updateGoal) is consumed through the runtime-globals
// bridge with a loud degrade if the bridge is absent.
//
// Safety invariants:
//   - Opt-in: does nothing unless settings.commissarEnabled is true.
//   - Single-flight: never two concurrent commissar workers.
//   - Infrastructure failures NEVER count toward the wanting streak and
//     NEVER terminate anything (a broken auditor model must not kill runs).
//   - Termination requires streak >= commissarWantingThreshold (default 2):
//     one WANTING verdict only records the finding.

import * as fs from "node:fs";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { state } from "./goal-state.js";
import {
  appendLedger,
  ledgerPath,
  nowIso,
  supervisorPaused,
} from "./goal-loop-core.js";
import type { Goal } from "./goal-loop-core.js";
import { modelRef } from "./main-model-recovery.js";
import { loadSettings } from "./goal-settings.js";
import {
  buildCommissarPrompt,
  normalizeCommissarIntervalMinutes,
  normalizeCommissarWantingThreshold,
} from "./goal-commissar.js";
import {
  runDetachedGoalCompletionAuditor,
  type AuditorModel,
} from "./goal-loop-auditor-process.js";
import { mainModelRecoveryActive } from "./goal-recovery.js";

/** Wall-clock bound for ONE adherence check. A commissar that hangs is worse
 * than no commissar; the transport's own wedged-worker watchdogs still apply
 * inside this budget. Deliberately far below the completion-audit wall. */
export const COMMISSAR_WALL_TIMEOUT_MS = 5 * 60_000;

/** Ledger tail fed to the worker as the evidence digest. */
const DIGEST_MAX_EVENTS = 40;

interface CommissarRuntimeState {
  /** A detached check is running — no second one may start. */
  inFlight: boolean;
  /** Last dispatch time (ms epoch); 0 = never. */
  lastCheckAt: number;
  /** Consecutive WANTING verdicts across checks (infra failures reset nothing
   * but add nothing; ADHERENT resets to 0). */
  wantingStreak: number;
}

const runtime: CommissarRuntimeState = {
  inFlight: false,
  lastCheckAt: 0,
  wantingStreak: 0,
};

/** Test seam + session-reset hook: forget all cadence/streak memory. */
export function resetCommissarRuntime(): void {
  runtime.inFlight = false;
  runtime.lastCheckAt = 0;
  runtime.wantingStreak = 0;
}

/** Build the orchestrator-digested evidence summary: the last ledger events
 * for THIS goal, compacted to one line each. Bounded read; any failure yields
 * an empty digest (the worker then relies on raw repo/ledger inspection). */
export function buildCommissarEvidenceDigest(
  cwd: string,
  goalId: string,
): string {
  try {
    const file = ledgerPath(cwd);
    if (!fs.existsSync(file)) return "";
    const lines = fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .slice(-200);
    const relevant: string[] = [];
    for (
      let i = lines.length - 1;
      i >= 0 && relevant.length < DIGEST_MAX_EVENTS;
      i--
    ) {
      try {
        const parsed = JSON.parse(lines[i]!) as {
          type?: unknown;
          at?: unknown;
          value?: unknown;
        };
        const value =
          typeof parsed.value === "object" && parsed.value !== null
            ? (parsed.value as Record<string, unknown>)
            : {};
        if (value.goalId !== undefined && value.goalId !== goalId) continue;
        relevant.push(
          `${parsed.at ?? "?"} ${parsed.type ?? "?"} ${JSON.stringify(value).slice(0, 160)}`,
        );
      } catch {
        // Skip torn/corrupt lines without failing the digest.
      }
    }
    return relevant.reverse().join("\n");
  } catch {
    return "";
  }
}

/** Dispatch signature seam so bounded tests can inject a fake detached
 * runner instead of spawning a real pi worker. */
export type CommissarDispatcher = typeof runDetachedGoalCompletionAuditor;

/**
 * Heartbeat gate: fire one detached adherence check when everything aligns.
 * Sync function; async work is fire-and-forget behind the in-flight guard.
 * Returns true when a check was dispatched (observable in tests/HUD).
 */
export function maybeFireCommissarCheck(
  ctx: ExtensionContext | null,
  opts: {
    completionAuditInFlight?: boolean;
    /** Test seam: replaces the real detached transport. */
    dispatch?: CommissarDispatcher;
  } = {},
): boolean {
  if (!ctx) return false;
  let settings: ReturnType<typeof loadSettings>;
  try {
    settings = loadSettings(ctx.cwd);
  } catch {
    return false;
  }
  if (settings.commissarEnabled !== true) return false;
  // Manual pause freezes every automatic side-effect (v0.35.15 semantics).
  if (supervisorPaused(state)) return false;
  // Only an actively-executing goal has adherence to check. Auditing/paused/
  // complete goals are other machinery's business.
  const goal: Goal | null = state.goal;
  if (!goal || goal.status !== "active") return false;
  if (runtime.inFlight || opts.completionAuditInFlight) return false;
  // Provider-recovery owns the plane — do not pile a watchdog on top.
  if (mainModelRecoveryActive()) return false;
  const intervalMs =
    normalizeCommissarIntervalMinutes(settings.commissarIntervalMinutes) *
    60_000;
  const now = Date.now();
  if (runtime.lastCheckAt !== 0 && now - runtime.lastCheckAt < intervalMs)
    return false;

  const model: AuditorModel | undefined =
    (settings.auditorModel?.trim()
      ? settings.auditorModel.trim()
      : undefined) ?? modelRef(ctx.model);
  if (!model) return false;

  runtime.inFlight = true;
  runtime.lastCheckAt = now;
  appendLedger(ctx.cwd, "commissar_check_start", {
    goalId: goal.id,
    model: typeof model === "string" ? model : modelRef(model),
  });

  const dispatch = opts.dispatch ?? runDetachedGoalCompletionAuditor;
  void dispatch({
    cwd: ctx.cwd,
    goal,
    role: "commissar",
    prompt: buildCommissarPrompt(
      goal,
      buildCommissarEvidenceDigest(ctx.cwd, goal.id),
    ),
    model,
    thinkingLevel: settings.auditorThinkingLevel ?? "medium",
    runtime: { wallTimeoutMs: COMMISSAR_WALL_TIMEOUT_MS },
  })
    .catch((err: unknown) => {
      appendLedger(ctx.cwd, "commissar_infra", {
        goalId: goal.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    })
    .then((result) => {
      runtime.inFlight = false;
      if (!result) return;
      applyCommissarResult(ctx, goal.id, result);
    });
  return true;
}

/** Apply one finished check. Exported for focused tests; production callers
 * go through maybeFireCommissarCheck. */
export function applyCommissarResult(
  ctx: ExtensionContext,
  goalId: string,
  result: {
    approved?: boolean;
    disapproved?: boolean;
    infrastructureClass?: string;
    error?: string;
    output?: string;
    commissar?: { adherent: boolean; wanting: boolean; reason?: string };
  },
): void {
  // Stale-goal guard: the verdict belongs to whatever goal is active NOW.
  const goal: Goal | null = state.goal;
  if (!goal || goal.id !== goalId || goal.status !== "active") {
    appendLedger(ctx.cwd, "commissar_verdict_stale_refused", { goalId });
    return;
  }
  // Infrastructure noise: ledger it, never escalate on it.
  if (result.infrastructureClass || !result.commissar) {
    appendLedger(ctx.cwd, "commissar_infra", {
      goalId,
      class: result.infrastructureClass,
      error: result.error?.slice(0, 240),
    });
    return;
  }
  if (result.commissar.adherent) {
    runtime.wantingStreak = 0;
    appendLedger(ctx.cwd, "commissar_verdict", { goalId, verdict: "adherent" });
    return;
  }
  runtime.wantingStreak += 1;
  const streak = runtime.wantingStreak;
  const reason = result.commissar.reason ?? "unspecified dereliction";
  appendLedger(ctx.cwd, "commissar_verdict", {
    goalId,
    verdict: "wanting",
    reason,
    streak,
  });

  const settings = loadSettings(ctx.cwd);
  const threshold = normalizeCommissarWantingThreshold(
    settings.commissarWantingThreshold,
  );
  if (streak < threshold) {
    appendLedger(ctx.cwd, "commissar_threshold_pending", {
      goalId,
      streak,
      threshold,
    });
    return;
  }

  terminateMainRunForDereliction(ctx, goal, reason);
}

/** The termination path: mark the goal durably, abort the main run, and let
 * the agent_end "aborted" handler recognize the intentional termination via
 * goal.commissarRestart and restart the chain instead of standing down. */
export function terminateMainRunForDereliction(
  ctx: ExtensionContext,
  goal: Goal,
  reason: string,
): void {
  runtime.wantingStreak = 0;
  const at = nowIso();
  const updateGoal = (globalThis as any).updateGoal as
    | ((patch: Partial<Goal>, ctx: ExtensionContext) => void)
    | undefined;
  if (typeof updateGoal !== "function") {
    // Loud degrade: never abort without the durable marker — an abort
    // WITHOUT commissarRestart would be misread as a user Esc stand-down.
    appendLedger(ctx.cwd, "commissar_terminate_refused", {
      goalId: goal.id,
      reason: "updateGoal bridge unavailable",
    });
    return;
  }
  updateGoal({ commissarRestart: { at, reason } }, ctx);
  appendLedger(ctx.cwd, "commissar_terminate", { goalId: goal.id, reason });
  try {
    ctx.ui.notify(
      `glla commissar: terminating the run — ${reason}. A fresh run continues the same objective.`,
      "warning",
    );
  } catch {
    /* notification is best-effort; the ledger + marker carry the decision */
  }
  try {
    ctx.abort();
  } catch (err) {
    appendLedger(ctx.cwd, "commissar_abort_failed", {
      goalId: goal.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
