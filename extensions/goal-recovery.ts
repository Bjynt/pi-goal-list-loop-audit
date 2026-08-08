/**
 * goal-recovery.ts — Recovery machinery: compat sidecar + main-model
 * recovery + completion-audit recovery.
 *
 * Decomposition step 3 (v0.34.111): extracted from extensions/loops/goal.ts.
 * - ZERO behavior change: moved bodies are byte-identical except module-level
 *   flag references rewritten to `flags.<name>` accessors.
 * - One-way imports: this module never imports from goal.ts or goal-commands.ts.
 * - Module-level mutable state stays OWNED by goal.ts (mainModelRecoveryTimer,
 *   mainModelSwitchInFlight, mainModelAbortForRecovery, lastMainModelFailure,
 *   completionAuditRecoveryArmed, hourlyProbeTimer, hourlyProbeFireAt,
 *   sessionGeneration, extensionApi, extensionApiStale,
 *   continuationDispatchStoodDown, lastLongLivedFailureAt); this module
 *   observes them through the RecoveryFlags accessor object (the same
 *   mirror-lets pattern as goal-loop.ts's flags).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { state } from "./goal-state.js";
import { appendLedger, nowIso, piGlaDir, isForbiddenModel, isStaleApiError, nextHourlyProbeMs, type Goal, type MainModelRecovery, type PendingCompletion } from "./goal-loop-core.js";
import { cancelDetachedGoalCompletionAuditor } from "./goal-loop-auditor-process.js";
import { classifyMainModelFailure, isLongLivedFailureKind, mainModelAutoRetryUntil, mainModelFailureDelayMs, mainModelRetryDelayMs, MAIN_MODEL_AUTO_RETRY_HORIZON_MS, modelRef, nextUntriedModelRef, normalizeModelRefs, splitModelRef, type MainModelFailure } from "./main-model-recovery.js";
import { loadGlobalSettings, loadSettings } from "./goal-settings.js";
import { clearLoopTimer, scheduleLoopTick } from "./goal-loop.js";

/* ------------------------------------------------------------------ */
/* Cluster A — compat sidecar marker (single-use, freshness-bounded)   */
/* ------------------------------------------------------------------ */

const RECOVERY_RESUME_MARKER = "recovery-resume.json";
const RECOVERY_RESUME_FRESH_MS = 300_000;

/** v0.34.13: consume the sidecar marker on session restore. Single-use,
 * freshness-bounded — a stale marker from an abandoned recovery must not
 * surprise-resume a later session. */
export function consumeRecoveryResume(cwd: string): boolean {
  try {
    const p = path.join(piGlaDir(cwd), RECOVERY_RESUME_MARKER);
    if (!fs.existsSync(p)) return false;
    const raw = fs.readFileSync(p, "utf-8");
    fs.unlinkSync(p);
    const at = Date.parse((JSON.parse(raw) as { at?: string }).at ?? "");
    return !Number.isNaN(at) && Date.now() - at < RECOVERY_RESUME_FRESH_MS;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Cluster C — completion-audit recovery (durable claim rehydration)  */
/* ------------------------------------------------------------------ */

export function markCompletionAuditRecoveryPending(ctx: ExtensionContext, reason: string): boolean {
  const goal = state.goal;
  const claim = goal?.pendingCompletion;
  if (!goal || goal.status !== "auditing" || !claim) {
    // A legacy/corrupt in-memory audit can still hold the process latch even
    // when its durable claim is absent. Fail closed for the MAIN as well.
    if (goal?.status === "auditing") clearDetachedAuditRuntime();
    return false;
  }
  const pending: PendingCompletion = {
    ...claim,
    phase: "recovery-pending",
    recoveryAt: nowIso(),
    recoveryReason: reason,
  };
  // Kill any child still owned by this process before releasing the durable
  // claim. Its late result is rejected by the attempt/generation checks, and
  // it must not keep the user-facing state looking like an active audit.
  if (claim.attemptId) cancelDetachedGoalCompletionAuditor(ctx.cwd, claim.attemptId);
  clearDetachedAuditRuntime();
  updateGoal({
    status: "paused",
    pendingCompletion: pending,
    pauseKind: "blocked",
    pauseResumeAt: undefined,
    pauseReason: `completion audit blocked — no verdict: ${reason}`,
    pauseSuggestedAction: `The completion claim is stored and was not judged. Fix the auditor/session issue, then ${activeGoalSurfaceCommand("resume")} to start exactly one fresh audit.`,
    pauseOptions: undefined,
    pauseRecommended: undefined,
  }, ctx);
  appendLedger(ctx.cwd, "audit_recovery_pending", {
    goalId: goal.id,
    attemptId: claim.attemptId,
    reason,
    mainReleased: true,
    verdict: "none",
  });
  return true;
}

export function isCompletionAuditRecoveryPending(goal: Goal | null | undefined): boolean {
  return !!goal?.pendingCompletion && goal.pendingCompletion.phase !== "running";
}

/* ------------------------------------------------------------------ */
/* Cluster B — main-model recovery + hourly quota probe               */
/* ------------------------------------------------------------------ */

/* The module flags stay owned by goal.ts (they're read by goal.ts
 * watchdogs, cmdResume, the loop, etc.) and are observed here through the
 * RecoveryFlags accessor object. */
export interface RecoveryFlags {
  get completionAuditRecoveryArmed(): boolean;
  set completionAuditRecoveryArmed(v: boolean);
  get mainModelRecoveryTimer(): NodeJS.Timeout | null;
  set mainModelRecoveryTimer(v: NodeJS.Timeout | null);
  get mainModelSwitchInFlight(): boolean;
  set mainModelSwitchInFlight(v: boolean);
  get mainModelAbortForRecovery(): boolean;
  set mainModelAbortForRecovery(v: boolean);
  get lastMainModelFailure(): MainModelFailure | null;
  set lastMainModelFailure(v: MainModelFailure | null);
  get hourlyProbeTimer(): NodeJS.Timeout | null;
  set hourlyProbeTimer(v: NodeJS.Timeout | null);
  get hourlyProbeFireAt(): number | null;
  set hourlyProbeFireAt(v: number | null);
  get sessionGeneration(): number;
  set sessionGeneration(v: number);
  get extensionApi(): ExtensionAPI | null;
  set extensionApi(v: ExtensionAPI | null);
  get extensionApiStale(): boolean;
  set extensionApiStale(v: boolean);
  get continuationDispatchStoodDown(): boolean;
  set continuationDispatchStoodDown(v: boolean);
  get lastLongLivedFailureAt(): number;
  set lastLongLivedFailureAt(v: number);
}

export interface RecoveryDeps {
  // cluster C
  activeGoalSurfaceCommand: (command: string) => string;
  clearDetachedAuditRuntime: () => void;
  updateGoal: (patch: Partial<Goal>, ctx: ExtensionContext) => void;
  // cluster B — goal.ts-owned functions (continuation/loop machinery still
  // lives in goal.ts until decomposition step 5 moves it)
  clearContinuationTimer: () => void;
  freshCtxForGeneration: (generation: number) => ExtensionContext | null;
  isSupervising: () => boolean;
  notifyExternal: (ctx: ExtensionContext, message: string) => void;
  persistState: (ctx: ExtensionContext) => void;
  recoverySurfaceCommand: (kind: "goal" | "loop", command: string) => string;
  scheduleContinuation: (ctx: ExtensionContext, force?: boolean, delayMs?: number) => void;
  scheduleSessionTimeout: (callback: () => void, delayMs: number) => NodeJS.Timeout;
}

let flags: RecoveryFlags;
let activeGoalSurfaceCommand: RecoveryDeps["activeGoalSurfaceCommand"];
let clearDetachedAuditRuntime: RecoveryDeps["clearDetachedAuditRuntime"];
let updateGoal: RecoveryDeps["updateGoal"];
// cluster B — goal.ts-owned function deps
let clearContinuationTimer: RecoveryDeps["clearContinuationTimer"];
let freshCtxForGeneration: RecoveryDeps["freshCtxForGeneration"];
let isSupervising: RecoveryDeps["isSupervising"];
let notifyExternal: RecoveryDeps["notifyExternal"];
let persistState: RecoveryDeps["persistState"];
let recoverySurfaceCommand: RecoveryDeps["recoverySurfaceCommand"];
let scheduleContinuation: RecoveryDeps["scheduleContinuation"];
let scheduleSessionTimeout: RecoveryDeps["scheduleSessionTimeout"];

export function createGoalRecovery(flagsArg: RecoveryFlags, d: RecoveryDeps): void {
  flags = flagsArg;
  activeGoalSurfaceCommand = d.activeGoalSurfaceCommand;
  clearDetachedAuditRuntime = d.clearDetachedAuditRuntime;
  updateGoal = d.updateGoal;
  clearContinuationTimer = d.clearContinuationTimer;
  freshCtxForGeneration = d.freshCtxForGeneration;
  isSupervising = d.isSupervising;
  notifyExternal = d.notifyExternal;
  persistState = d.persistState;
  recoverySurfaceCommand = d.recoverySurfaceCommand;
  scheduleContinuation = d.scheduleContinuation;
  scheduleSessionTimeout = d.scheduleSessionTimeout;
}

/* ------------------------------------------------------------------ */
/* Cluster B — moved functions (byte-identical bodies, module flags   */
/* via RecoveryFlags accessor)                                         */
/* ------------------------------------------------------------------ */

export function mainModelRecoveryActive(): boolean { return !!state.mainModelRecovery?.retryAt; }

export function mainModelRecoveryKind(): "goal" | "loop" { return state.loop?.active ? "loop" : "goal"; }

export function mainModelRecoveryReason(failure: MainModelFailure): string {
  const detail = failure.raw.replace(/\s+/g, " ").trim().slice(0, 180);
  return `main model ${failure.kind}${detail ? `: ${detail}` : " failure"}`;
}

export function withMainModelRecoveryWindow(recovery: MainModelRecovery, now = Date.now()): MainModelRecovery {
  const firstMs = recovery.firstFailureAt ? Date.parse(recovery.firstFailureAt) : Number.NaN;
  const firstFailureAt = Number.isFinite(firstMs) ? recovery.firstFailureAt : new Date(now).toISOString();
  const untilMs = recovery.autoRetryUntil ? Date.parse(recovery.autoRetryUntil) : Number.NaN;
  const autoRetryUntil = Number.isFinite(untilMs) && untilMs > (Number.isFinite(firstMs) ? firstMs : now)
    ? recovery.autoRetryUntil
    : mainModelAutoRetryUntil(Number.isFinite(firstMs) ? firstMs : now, MAIN_MODEL_AUTO_RETRY_HORIZON_MS);
  return { ...recovery, firstFailureAt, autoRetryUntil };
}

export function clearMainModelRecoveryTimer(): void {
  if (flags.mainModelRecoveryTimer) {
    clearTimeout(flags.mainModelRecoveryTimer);
    flags.mainModelRecoveryTimer = null;
  }
  // v0.34.92: clear the hourly probe ticker in lockstep — session
  // replacement / recovery reset must not leave an orphaned ticker firing
  // against a dead generation. The new session's session_start will
  // re-arm via scheduleHourlyProbe() if recovery is still parked.
  cancelHourlyProbe();
}

export function mainModelFallbackRefs(ctx: ExtensionContext): string[] {
  try { return normalizeModelRefs(loadGlobalSettings().mainModelFallbacks); } catch { return []; }
}

export function holdMainModelRecovery(ctx: ExtensionContext, recovery: MainModelRecovery, why: string): void {
  const normalized = withMainModelRecoveryWindow(recovery);
  clearMainModelRecoveryTimer();
  clearContinuationTimer();
  clearLoopTimer();
  flags.continuationDispatchStoodDown = true;
  state.mainModelRecovery = { ...normalized, retryAt: undefined, manualResumeRequired: true };
  const resumeCmd = recoverySurfaceCommand(normalized.kind, "resume");
  const quotaMarker = /quota|rate.?limit|usage.?limit|token.?plan|plan.?limit/i.test(normalized.reason) ? ` · ${normalized.reason}` : "";
  const pauseReason = `main model recovery — automatic probes stopped (${why})${quotaMarker}`;
  const action = `No automatic provider probes remain. Check the provider reset/billing state or switch /model, then ${resumeCmd} to start a fresh recovery window; ${activeGoalSurfaceCommand("cancel")} stops it.`;
  if (normalized.kind === "goal" && state.goal) {
    updateGoal({
      status: "paused",
      pauseKind: "blocked",
      pauseResumeAt: undefined,
      pauseReason,
      pauseSuggestedAction: action,
    }, ctx);
  } else if (normalized.kind === "loop" && state.loop) {
    state.loop = { ...state.loop, active: false, stopReason: `${pauseReason}; ${resumeCmd} to retry manually` };
    persistState(ctx);
  } else {
    persistState(ctx);
  }
  appendLedger(ctx.cwd, "main_model_recovery_manual_hold", {
    kind: normalized.kind,
    attempts: normalized.attempts,
    autoRetryUntil: normalized.autoRetryUntil,
    resetAt: normalized.resetAt,
    why,
  });
  ctx.ui.notify(`Main-model recovery stopped automatic probes: ${why}. Work is saved; check the provider or switch /model, then ${resumeCmd}.`, "warning");
  notifyExternal(ctx, `Main-model recovery requires manual resume: ${why}.`);
}

/** Resolve a configured provider/model using only the public registry API. */
export function resolveMainModel(ctx: ExtensionContext, ref: string): any | undefined {
  const parts = splitModelRef(ref);
  if (!parts) return undefined;
  try { return ctx.modelRegistry?.find?.(parts.provider, parts.id) as any; } catch { return undefined; }
}

/** Select one configured backup before pi's own agent-level retry continues. */
export async function tryMainModelFallback(ctx: ExtensionContext, failure: MainModelFailure): Promise<boolean> {
  if (flags.mainModelSwitchInFlight || failure.kind === "non-recoverable") return false;
  const refs = mainModelFallbackRefs(ctx);
  if (refs.length === 0) return false;
  const current = modelRef(ctx.model);
  if (!current) return false;
  const generation = flags.sessionGeneration;
  const existing = state.mainModelRecovery;
  const recovery: MainModelRecovery = withMainModelRecoveryWindow(existing ?? {
    primary: current,
    active: current,
    attempted: [current],
    attempts: 0,
    reason: mainModelRecoveryReason(failure),
    resetAt: failure.resetAt,
    kind: mainModelRecoveryKind(),
  });
  if (!recovery.attempted.includes(current)) recovery.attempted.push(current);
  for (;;) {
    const candidateRef = nextUntriedModelRef(current, refs, recovery.attempted);
    if (!candidateRef) {
      state.mainModelRecovery = { ...recovery, active: current, reason: mainModelRecoveryReason(failure) };
      persistState(ctx);
      return false;
    }
    recovery.attempted.push(candidateRef);
    // v0.34.93: forbidden-models gate on main-model fallback. The auditor
    // chain (resolveAuditorModel) consults isForbiddenModel; this path did
    // not. Without the gate the recovery envelope can rotate onto a
    // forbidden model (expensive default, vision assist forbidden), briefly
    // set it via flags.extensionApi.setModel, then observeModelChange reverts it
    // — but one wasted provider call and a misleading forbidden_model_switch
    // ledger event happen first. Screenshot_20260808_083612 (endless-td):
    // the session rotated to Anthropic during recovery when no allowed
    // backup existed; user: "this could be a very costly importu decision.
    // I think it should be disallowed." Silent skip + clearer ledger event;
    // the loop continues to the next candidate. If no allowed candidate
    // exists, the recovery fails-closed below (no allowed backup).
    if (isForbiddenModel(candidateRef, loadSettings(ctx.cwd).forbiddenModels)) {
      appendLedger(ctx.cwd, "forbidden_model_fallback_blocked", {
        ref: candidateRef,
        reason: "candidate is in the forbidden list",
        from: current,
      });
      continue;
    }
    const candidate = resolveMainModel(ctx, candidateRef);
    if (!candidate) {
      appendLedger(ctx.cwd, "main_model_fallback_unavailable", { ref: candidateRef, reason: "not in the configured model registry" });
      continue;
    }
    flags.mainModelSwitchInFlight = true;
    try {
      const accepted = await flags.extensionApi?.setModel(candidate);
      if (generation !== flags.sessionGeneration || !freshCtxForGeneration(generation)) return false;
      if (!accepted) {
        appendLedger(ctx.cwd, "main_model_fallback_unavailable", { ref: candidateRef, reason: "no configured auth" });
        continue;
      }
      recovery.active = candidateRef;
      recovery.reason = mainModelRecoveryReason(failure);
      recovery.kind = mainModelRecoveryKind();
      state.mainModelRecovery = recovery;
      persistState(ctx);
      appendLedger(ctx.cwd, "main_model_failover", { from: current, to: candidateRef, reason: failure.kind });
      ctx.ui.notify(`Main session model failover: ${current} → ${candidateRef}. The next turn will use the backup; a successful turn clears recovery.`, "warning");
      return true;
    } catch (err) {
      appendLedger(ctx.cwd, "main_model_fallback_unavailable", { ref: candidateRef, reason: err instanceof Error ? err.message : String(err) });
      if (isStaleApiError(err)) flags.extensionApiStale = true;
    } finally {
      flags.mainModelSwitchInFlight = false;
    }
  }
}

export function setMainModelRecoveryPause(ctx: ExtensionContext, recovery: MainModelRecovery, delayMs: number): boolean {
  const normalized = withMainModelRecoveryWindow(recovery);
  const now = Date.now();
  const deadlineMs = normalized.autoRetryUntil ? Date.parse(normalized.autoRetryUntil) : Number.NaN;
  const requestedDelayMs = Math.max(1_000, delayMs);
  if (normalized.manualResumeRequired || (Number.isFinite(deadlineMs) && (now >= deadlineMs || now + requestedDelayMs > deadlineMs))) {
    holdMainModelRecovery(ctx, normalized, Number.isFinite(deadlineMs) && now >= deadlineMs
      ? "the 24h automatic recovery horizon was reached"
      : "the automatic recovery horizon would be exceeded");
    return false;
  }
  const retryAt = new Date(now + requestedDelayMs).toISOString();
  const minutes = Math.max(1, Math.round(requestedDelayMs / 60_000));
  state.mainModelRecovery = { ...normalized, retryAt, manualResumeRequired: undefined };
  clearMainModelRecoveryTimer();
  clearContinuationTimer();
  clearLoopTimer();
  flags.continuationDispatchStoodDown = true;
  const resumeCmd = recoverySurfaceCommand(normalized.kind, "resume");
  if (normalized.kind === "goal" && state.goal) {
    updateGoal({
      status: "paused",
      pauseKind: "wait",
      pauseResumeAt: retryAt,
      pauseReason: `main model recovery — retrying in ${minutes}m (${normalized.reason})`,
      pauseSuggestedAction: `The provider/quota wall is being retried automatically; configured backup models are tried in order. ${resumeCmd} retries immediately; ${activeGoalSurfaceCommand("cancel")} stops it.`,
    }, ctx);
  } else if (normalized.kind === "loop" && state.loop) {
    state.loop = { ...state.loop, active: false, stopReason: `main model recovery — retrying in ${minutes}m (${normalized.reason}); /loop resume retries immediately` };
    persistState(ctx);
  } else {
    persistState(ctx);
  }
  appendLedger(ctx.cwd, "main_model_recovery_wait", { kind: normalized.kind, retryAt, attempts: normalized.attempts, autoRetryUntil: normalized.autoRetryUntil, resetAt: normalized.resetAt, reason: normalized.reason });
  ctx.ui.notify(`Main model recovery: ${normalized.reason}. Trying again in ${minutes}m; work is saved and will not be abandoned.`, "warning");
  notifyExternal(ctx, `Main model recovery scheduled in ${minutes}m — work remains saved.`);
  return true;
}

export function scheduleMainModelRecoveryTimer(ctx: ExtensionContext, delayMs: number): void {
  const generation = flags.sessionGeneration;
  clearMainModelRecoveryTimer();
  flags.mainModelRecoveryTimer = scheduleSessionTimeout(() => {
    flags.mainModelRecoveryTimer = null;
    const fresh = freshCtxForGeneration(generation);
    if (!fresh || !state.mainModelRecovery) return;
    void probeMainModelRecovery(fresh).catch((err) => { if (isStaleApiError(err)) flags.extensionApiStale = true; });
  }, Math.max(1_000, delayMs));
  void ctx;
}

// =================================================================
// v0.34.92: hourly quota probe ticker — opt-in (default ON) extra probe at
// :00:30 every hour while main-model recovery is parked. Quota windows tend
// to refresh at the top of the hour; the ticker gives the fastest pickup
// the plugin can offer without spamming chat (no chat message — just an
// extra probe). Co-resident with the normal retry schedule (v0.34.79 eager
// 5s first probe + v0.34.84 hour-aligned attempts 2+); the ticker is
// strictly an ADDITIONAL probe slot at :00:30. When the user opts out, the
// normal retry cadence is unaffected — only the ticker stops.
// =================================================================


/** Schedule the next :00:30 probe. Re-arms itself after each fire as long
 * as recovery is parked and the setting is on. Safe to call when already
 * scheduled (no duplicate schedules). */
export function scheduleHourlyProbe(ctx: ExtensionContext): void {
  if (loadGlobalSettings().hourlyQuotaProbe !== true) return;
  if (!state.mainModelRecovery) return; // nothing to recover — silent no-op
  if (flags.hourlyProbeTimer) return; // already pending
  const now = Date.now();
  const fireAt = nextHourlyProbeMs(now);
  const generation = flags.sessionGeneration;
  flags.hourlyProbeFireAt = fireAt;
  appendLedger(ctx.cwd, "hourly_probe_scheduled", {
    fireAt: new Date(fireAt).toISOString(),
    at: new Date(now).toISOString(),
  });
  flags.hourlyProbeTimer = scheduleSessionTimeout(() => {
    flags.hourlyProbeTimer = null;
    flags.hourlyProbeFireAt = null;
    const fresh = freshCtxForGeneration(generation);
    if (!fresh) return;
    fireHourlyProbe(fresh);
    // Re-arm if still parked after the probe — the ticker is continuous
    // until the user / list resume or recovery succeeds.
    if (state.mainModelRecovery) scheduleHourlyProbe(fresh);
  }, Math.max(1_000, fireAt - now));
}

/** Fire one :00:30 probe — invoke the same recovery probe path the normal
 * schedule uses. The probe is observed by the recovery envelope: a success
 * clears state.mainModelRecovery (and the ticker stops because the guard
 * on the next re-arm sees no recovery); a failure reschedules via the
 * normal schedule (v0.34.79/v0.34.84), and the hourly ticker's next fire
 * is already queued by the re-arm above. */
export function fireHourlyProbe(ctx: ExtensionContext): void {
  if (!state.mainModelRecovery) return; // wall already lifted — silent no-op
  appendLedger(ctx.cwd, "hourly_probe_fired", {
    at: new Date().toISOString(),
  });
  void probeMainModelRecovery(ctx).catch((err) => { if (isStaleApiError(err)) flags.extensionApiStale = true; });
}

/** Cancel the hourly ticker — called on session replacement, recovery
 * success, and user resume. Safe to call when no ticker is pending. */
export function cancelHourlyProbe(): void {
  if (flags.hourlyProbeTimer) {
    clearTimeout(flags.hourlyProbeTimer);
    flags.hourlyProbeTimer = null;
  }
  flags.hourlyProbeFireAt = null;
}

// v0.34.108: the hourly-ticker test-only hooks (__testOnlySetHourlyProbeNow /
// __testOnlyResetHourlyProbe / __testOnlyHourlyProbeState) were dead —
// hourly-quota-probe.test.ts is source-pin only and never called them.
// Removed with the v0.34.108 dead-code sweep.

/** An explicit resume is consent to start a fresh automatic window after the
 * five-hour/24-hour safety hold. It does not silently reset the window during
 * reload or heartbeat recovery. */
export function manuallyResumeMainModelRecovery(ctx: ExtensionContext): boolean {
  const recovery = state.mainModelRecovery;
  if (!recovery?.manualResumeRequired) return false;
  const current = modelRef(ctx.model);
  const now = Date.now();
  state.mainModelRecovery = {
    ...recovery,
    active: current ?? recovery.active,
    attempted: current ? [current] : [],
    attempts: 0,
    firstFailureAt: new Date(now).toISOString(),
    autoRetryUntil: mainModelAutoRetryUntil(now, MAIN_MODEL_AUTO_RETRY_HORIZON_MS),
    retryAt: undefined,
    manualResumeRequired: undefined,
    resumeCurrent: undefined,
  };
  clearMainModelRecoveryTimer();
  flags.continuationDispatchStoodDown = false;
  persistState(ctx);
  ctx.ui.notify("Manual resume starts a fresh bounded main-model recovery window — one provider probe, then configured backups if needed.", "info");
  void probeMainModelRecovery(ctx);
  return true;
}

export async function probeMainModelRecovery(ctx: ExtensionContext): Promise<void> {
  const generation = flags.sessionGeneration;
  const recovery = state.mainModelRecovery;
  if (!recovery) return;
  const current = modelRef(ctx.model);
  const refs = [recovery.primary, ...mainModelFallbackRefs(ctx)];
  if (recovery.resumeCurrent && current) {
    state.mainModelRecovery = { ...recovery, active: current, attempted: [current], retryAt: undefined, resumeCurrent: undefined };
    flags.continuationDispatchStoodDown = false;
    if (recovery.kind === "goal" && state.goal?.status === "paused" && (state.goal.pauseReason ?? "").startsWith("main model recovery")) {
      updateGoal({ status: "active", pauseResumeAt: undefined, pauseReason: undefined, pauseSuggestedAction: undefined }, ctx);
      scheduleContinuation(ctx, true, 1_000);
    } else if (recovery.kind === "loop" && state.loop && !state.loop.active && (state.loop.stopReason ?? "").startsWith("main model recovery")) {
      state.loop = { ...state.loop, active: true, stopReason: undefined };
      persistState(ctx);
      scheduleLoopTick(ctx);
    }
    appendLedger(ctx.cwd, "main_model_probe", { from: current, to: current, attempts: recovery.attempts, mode: "resume-backup" });
    ctx.ui.notify(`Main model recovery probe: continuing on ${current}; primary will be tested after this supervised turn.`, "info");
    return;
  }
  // v0.34.93: pick the first target that is neither the current model nor
  // a forbidden ref. Without the gate the probe rotates to a forbidden
  // model (e.g. when the user has both Anthropic and a non-Anthropic
  // configured but the primary rotation lands on Anthropic).
  const forbiddenList = loadSettings(ctx.cwd).forbiddenModels;
  const target = refs.find((ref) => ref !== current && !isForbiddenModel(ref, forbiddenList));
  if (target) {
    const skipped = refs.find((ref) => ref !== current && isForbiddenModel(ref, forbiddenList));
    if (skipped) appendLedger(ctx.cwd, "forbidden_model_fallback_blocked", { ref: skipped, reason: "recovery probe target was forbidden; skipping to next allowed", from: current });
  }
  if (!target) {
    if (!current) {
      const delay = mainModelRetryDelayMs(recovery.attempts + 1, loadGlobalSettings().mainModelRetryMinutes);
      if (setMainModelRecoveryPause(ctx, { ...withMainModelRecoveryWindow(recovery), attempts: recovery.attempts + 1, attempted: [] }, delay)) {
        scheduleMainModelRecoveryTimer(ctx, delay);
      }
      return;
    }
    // No backup is configured (or every backup has already been tried):
    // retry the currently selected model itself. This is the critical probe
    // that notices a quota window returning after an otherwise quiet hour.
    state.mainModelRecovery = { ...recovery, active: current, attempted: [current], retryAt: undefined, resumeCurrent: undefined };
    flags.continuationDispatchStoodDown = false;
    if (recovery.kind === "goal" && state.goal?.status === "paused" && (state.goal.pauseReason ?? "").startsWith("main model recovery")) {
      updateGoal({ status: "active", pauseResumeAt: undefined, pauseReason: undefined, pauseSuggestedAction: undefined }, ctx);
      scheduleContinuation(ctx, true, 1_000);
    } else if (recovery.kind === "loop" && state.loop && !state.loop.active && (state.loop.stopReason ?? "").startsWith("main model recovery")) {
      state.loop = { ...state.loop, active: true, stopReason: undefined };
      persistState(ctx);
      scheduleLoopTick(ctx);
    }
    appendLedger(ctx.cwd, "main_model_probe", { from: current, to: current, attempts: recovery.attempts });
    ctx.ui.notify(`Main model recovery probe: retrying ${current} without rotating models.`, "info");
    return;
  }
  const candidate = resolveMainModel(ctx, target);
  if (!candidate) {
    appendLedger(ctx.cwd, "main_model_fallback_unavailable", { ref: target, reason: "recovery probe not in registry" });
    const delay = mainModelRetryDelayMs(recovery.attempts + 1, loadGlobalSettings().mainModelRetryMinutes);
    if (setMainModelRecoveryPause(ctx, { ...withMainModelRecoveryWindow(recovery), attempts: recovery.attempts + 1, attempted: [...(current ? [current] : []), target] }, delay)) {
      scheduleMainModelRecoveryTimer(ctx, delay);
    }
    return;
  }
  flags.mainModelSwitchInFlight = true;
  try {
    const accepted = await flags.extensionApi?.setModel(candidate);
    if (generation !== flags.sessionGeneration || !freshCtxForGeneration(generation)) return;
    if (!accepted) throw new Error(`no configured auth for ${target}`);
    state.mainModelRecovery = { ...recovery, active: target, attempted: current ? [current, target] : [target], retryAt: undefined };
    persistState(ctx);
    appendLedger(ctx.cwd, "main_model_probe", { from: current, to: target, attempts: recovery.attempts });
    flags.continuationDispatchStoodDown = false;
    if (recovery.kind === "goal" && state.goal?.status === "paused" && (state.goal.pauseReason ?? "").startsWith("main model recovery")) {
      updateGoal({ status: "active", pauseResumeAt: undefined, pauseReason: undefined, pauseSuggestedAction: undefined }, ctx);
      scheduleContinuation(ctx, true, 1_000);
    } else if (recovery.kind === "loop" && state.loop && !state.loop.active && (state.loop.stopReason ?? "").startsWith("main model recovery")) {
      state.loop = { ...state.loop, active: true, stopReason: undefined };
      persistState(ctx);
      scheduleLoopTick(ctx);
    }
    ctx.ui.notify(`Main model recovery probe: ${target} selected; sending one supervised probe.`, "info");
  } catch (err) {
    appendLedger(ctx.cwd, "main_model_probe_failed", { ref: target, error: err instanceof Error ? err.message : String(err) });
    const failure = classifyMainModelFailure(err instanceof Error ? err.message : String(err));
    // v0.34.51: no billing special case — every provider failure retries on
    // the uniform durable envelope (credits can be topped up; a miss-classified
    // quota wall must not become a manual-action stop).
    const next = withMainModelRecoveryWindow({ ...recovery, attempts: recovery.attempts + 1, attempted: [...(current ? [current] : []), target], reason: mainModelRecoveryReason(failure), resetAt: failure.resetAt ?? recovery.resetAt });
    // v0.34.58: no quota-only parking — an over-budget upstream reset hint
    // never holds the goal for a manual resume; the bounded envelope owns
    // the wait (mainModelFailureDelayMs falls back to the bounded cadence
    // when the hint exceeds the 5h probe budget).
    const delay = mainModelFailureDelayMs(failure, next.attempts, loadGlobalSettings().mainModelRetryMinutes);
    if (setMainModelRecoveryPause(ctx, next, delay)) scheduleMainModelRecoveryTimer(ctx, delay);
  } finally {
    flags.mainModelSwitchInFlight = false;
  }
}

export function parkMainModelAfterFailure(ctx: ExtensionContext, failure: MainModelFailure): void {
  if (!isSupervising() || mainModelRecoveryActive()) return;
  const current = modelRef(ctx.model);
  if (!current) return;
  const existing = withMainModelRecoveryWindow(state.mainModelRecovery ?? {
    primary: current,
    active: current,
    attempted: [current],
    attempts: 0,
    reason: mainModelRecoveryReason(failure),
    resetAt: failure.resetAt,
    kind: mainModelRecoveryKind(),
  } satisfies MainModelRecovery);
  const nextRecovery = withMainModelRecoveryWindow({
    ...existing,
    active: current,
    attempts: existing.attempts + 1,
    reason: mainModelRecoveryReason(failure),
    resetAt: failure.resetAt ?? existing.resetAt,
  });
  // v0.34.58: uniform envelope even for over-budget upstream hints — the
  // goal never parks on a quota-only manual hold; the bounded cadence owns
  // the wait and the 24h horizon ends automatic probes (kind-independent).
  const delay = mainModelFailureDelayMs(failure, nextRecovery.attempts, loadGlobalSettings().mainModelRetryMinutes);
  if (!setMainModelRecoveryPause(ctx, nextRecovery, delay)) return;
  flags.mainModelAbortForRecovery = true;
  try { ctx.abort(); } catch { /* abort is best effort; the recovery guard prevents re-send storms */ }
  scheduleMainModelRecoveryTimer(ctx, delay);
  // v0.34.92: no quota-prompt schedule — quota walls are not detected
  // (provider text is unreliable; v0.34.64 established the principle).
  // Active retry (v0.34.79 eager first probe + v0.34.84 hour-aligned
  // attempts 2+) is the recovery. An opt-in hourly probe ticker
  // (scheduleHourlyProbe) gives faster pickup at :00:30 when
  // hourlyQuotaProbe is enabled (default ON).
  scheduleHourlyProbe(ctx);
}

export async function recoverMainModelFromSendStorm(ctx: ExtensionContext, kind: "continuation" | "loop"): Promise<void> {
  if (!isSupervising() || mainModelRecoveryActive()) return;
  const failure = classifyMainModelFailure("429 rate limit: pi held the provider retry with no stream activity");
  flags.lastLongLivedFailureAt = Date.now();
  const switched = await tryMainModelFallback(ctx, failure);
  if (switched) {
    const current = modelRef(ctx.model);
    if (!current) return;
    const recovery = state.mainModelRecovery;
    if (!recovery) return;
    if (setMainModelRecoveryPause(ctx, { ...recovery, kind: kind === "loop" ? "loop" : "goal", active: current, resumeCurrent: true }, 1_000)) {
      flags.mainModelAbortForRecovery = true;
      try { ctx.abort(); } catch { /* best effort; recovery guard prevents re-send storms */ }
      scheduleMainModelRecoveryTimer(ctx, 1_000);
    }
    return;
  }
  parkMainModelAfterFailure(ctx, failure);
}

export function mainModelRecoverySucceeded(ctx: ExtensionContext): void {
  const recovery = state.mainModelRecovery;
  if (!recovery) return;
  clearMainModelRecoveryTimer();
  cancelHourlyProbe(); // v0.34.92: wall lifted — ticker stops
  // v0.34.92: clearQuotaPromptTimer() call removed — the quota-prompt
  // timer was deleted with the rest of v0.34.58/v0.34.90. Recovery now
  // clears only its own timer (above).
  state.mainModelRecovery = undefined;
  flags.lastMainModelFailure = null;
  flags.mainModelAbortForRecovery = false;
  flags.continuationDispatchStoodDown = false;

  // A pi-core retry can succeed after glla has already parked the goal. The
  // old code cleared only the recovery record, leaving the goal durably
  // paused (the next screenshot then looked like a stale QUOTA WALL). Resume
  // only our own recovery wait — never a user decision/error pause.
  // v0.34.64: also auto-clear a blocked pause whose reason indicates a quota
  // / rate-limit / billing cause. autoResume:true honors "keep going" — when
  // the underlying condition (the quota wall) has resolved, we un-park and
  // re-engage, instead of leaving the goal stuck on an agent-initiated
  // block that was authored in response to the wall. Decision/error pauses
  // (intentional user-action) are still NOT touched.
  const isQuotaPauseReason = (r: string | undefined): boolean =>
    !!r && /^(main model recovery|quota|provider quota|provider rate limit|rate limit|Token Plan|insufficient|credits?|billing)/i.test(r);
  const recoveryPause = state.goal
    && state.goal.status === "paused"
    && (state.goal.pauseKind === "wait" || state.goal.pauseKind === "blocked")
    && isQuotaPauseReason(state.goal.pauseReason);
  const recoveryLoop = state.loop
    && !state.loop.active
    && (state.loop.stopReason ?? "").startsWith("main model recovery —");
  const resumed = recovery.kind === "goal" && recoveryPause
    ? "goal"
    : recovery.kind === "loop" && recoveryLoop
      ? "loop"
      : undefined;
  appendLedger(ctx.cwd, "main_model_recovered", { model: modelRef(ctx.model), attempts: recovery.attempts, resumed });
  if (resumed === "goal") {
    updateGoal({ status: "active", pauseKind: undefined, pauseResumeAt: undefined, pauseReason: undefined, pauseSuggestedAction: undefined }, ctx);
    scheduleContinuation(ctx, true, 1_000);
  } else if (resumed === "loop") {
    state.loop = { ...state.loop!, active: true, stopReason: undefined };
    persistState(ctx);
    scheduleLoopTick(ctx);
  } else {
    persistState(ctx);
  }
  ctx.ui.notify(`Main session model recovered on ${modelRef(ctx.model) ?? "the active model"}; automatic recovery is cleared${resumed ? ` and the ${resumed} is resuming` : ""}.`, "info");
}

/** Handle a provider error before loop/goal bookkeeping can mistake it for
 * an unproductive turn. Returns true when recovery owns this agent_end. */
