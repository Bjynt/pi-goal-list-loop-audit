/**
 * pi-goal-list-loop-audit — v0.1.0
 * extensions/goal-loop-backoff.ts
 *
 * Backoff and self-watchdog constants for goal/loop scheduling, plus the
 * pure stall/nudge/heartbeat/wedge/pending-latch/auditor decisions.
 *
 * v0.35.4: the old "hard 5-minute ceiling — beyond it the orchestrator
 * pauses the loop and notifies the user" contract (backoffMs /
 * shouldPauseAfterBackoff / humanMs) had zero production call sites: the
 * stall ladder and pause decisions moved into goal-loop.ts, the heartbeat
 * and goal-loop-core, leaving the promise unenforced. Those functions and
 * the unused BACKOFF_HARD_CAP_MS / BACKOFF_ERROR_* constants are removed;
 * the live scheduling constants remain below.
 */

export const BACKOFF_IDLE_RETRY_MS = 50;     // when adding another iter to queue

// =================================================================
// Heartbeat self-watchdog (v0.5.0)
//
// Replaces the external pi-compaction-continue plugin FOR OUR LOOPS. A goal
// loop that dies silently (compaction-eaten turn, dropped message, stale ctx)
// is a hole in this plugin, not something to outsource. One precise check
// covers every stall cause: supervising + idle + nothing scheduled + quiet
// for too long → re-fire the continuation ourselves.
// =================================================================

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_STALL_MS = 60_000;
export const HEARTBEAT_MAX_NUDGES = 3;
/** v0.23.2: default wall-clock wedge threshold — a busy session with no
 * activity for this long is almost always a hung unbounded command
 * (test suite / dev server) holding the whole goal hostage. The
 * turn-based watchdogs are blind to it (it's ONE long turn); only the
 * wall clock sees it. 0 in settings = off.
 * v0.23.3: 45 → 30. The alert is notification-only, so a false positive
 * costs one notification while a false negative costs hours — that
 * asymmetry argues tight. (pi-goal-x, the cautionary tale, had NO wall
 * clock at all: a wedged session was silent forever.) */
export const WEDGE_ALERT_DEFAULT_MINUTES = 30;
/** v0.23.3: hard cap on one measure command. An unbounded measure is the
 * same wedge shape as an unbounded test suite — it freezes the loop tick
 * forever. Timeout → measure failure (null) → stall path → plateau stop,
 * never a silent hang. Matches pi-loop-mode's --check-timeout default. */
export const MEASURE_TIMEOUT_MS = 10 * 60_000;
/** v0.23.3: auditor inactivity abort. The auditor legitimately runs the
 * project's own verification (test suites!), so the bound is on
 * INACTIVITY (no session events at all), not wall time. An auditor with
 * no events for this long is wedged — abort and report an error, never
 * disapprove, never hang the completion gate forever. */
export const AUDITOR_STALL_MS = 10 * 60_000;
/** v0.34.21: inactivity is not enough when a single auditor tool is
 * legitimately running. Keep a hard wall bound and per-tool bound so a
 * provider/tool pair can never hold completion forever, while the normal 10m
 * inactivity guard still catches a dead stream much sooner. */
export const AUDITOR_WALL_TIMEOUT_MS = 30 * 60_000;

export type AuditorWatchdogAction = "none" | "inactivity" | "wall";

/** Pure watchdog decision used by the isolated auditor and its regressions.
 * A running auditor tool suppresses only the inactivity branch; the per-tool
 * and wall deadlines always win. */
export function auditorWatchdogAction(input: {
  nowMs: number;
  startedAtMs: number;
  lastEventAtMs: number;
  toolActive: boolean;
  inactivityMs?: number;
  wallTimeoutMs?: number;
}): AuditorWatchdogAction {
  const inactivity = input.inactivityMs ?? AUDITOR_STALL_MS;
  const wall = input.wallTimeoutMs ?? AUDITOR_WALL_TIMEOUT_MS;
  if (input.nowMs - input.startedAtMs >= wall) return "wall";
  if (!input.toolActive && input.nowMs - input.lastEventAtMs > inactivity) return "inactivity";
  return "none";
}

/** v0.26.5: pending-latch watchdog threshold. Field-observed failure: a
 * continuation sent right at compaction was ACCEPTED by pi (sendMessage
 * returned) but the turn trigger was dropped — pi's pending-message flag
 * then stayed set forever. sessionIdle (= isIdle && !hasPendingMessages)
 * never went true, so the heartbeat refire path AND the stall escalation
 * were both suppressed: 22 minutes of total silence until a manual nudge.
 * The wedge alert was blind too (22m < 30m threshold, and its "hung
 * command" framing would be wrong anyway). This watchdog owns that
 * shape: idle + pending + silent >= threshold = the latch is stuck. */
export const PENDING_LATCH_STUCK_MS = 3 * 60_000;

export interface PendingLatchInput {
  /** A goal is active (autoContinue) or a loop is running. */
  supervising: boolean;
  /** ctx.isIdle() — the session is NOT mid-turn. */
  idle: boolean;
  /** ctx.hasPendingMessages() — pi believes a message is still queued. */
  pending: boolean;
  /** A continuation or loop timer is already scheduled. */
  timerPending: boolean;
  /** Milliseconds since the last observed agent activity. */
  silentMs: number;
  /** Threshold in ms; 0 disables the watchdog. */
  thresholdMs: number;
}

/** Should the pending-latch watchdog count a stall right now? It never
 * re-sends: the message is ALREADY queued pi-side, and the hegemon
 * zombie proved re-sends don't unstick a dropped trigger (619 sends,
 * zero turns). Count + notify + escalate to a loud stop instead. */
export function shouldFirePendingLatchWatchdog(input: PendingLatchInput): boolean {
  if (!input.supervising) return false;
  if (!input.idle || !input.pending) return false;
  if (input.timerPending) return false;
  if (input.thresholdMs <= 0) return false;
  return input.silentMs >= input.thresholdMs;
}

export interface WedgeInput {
  /** A goal is active (autoContinue) or a loop is running. */
  supervising: boolean;
  /** Session is BUSY (mid-turn). An idle quiet session is the
   *  heartbeat's job, not the wedge alert's. */
  sessionBusy: boolean;
  /** Milliseconds since the last observed agent activity. */
  silentMs: number;
  /** Milliseconds since the last wedge alert fired (throttle). */
  msSinceLastAlert: number;
  /** Threshold in ms; 0 disables the alert entirely. */
  thresholdMs: number;
}

/** Should the wedge alert fire right now? Alerts at most once per
 *  threshold interval while the wedge persists; any activity re-arms. */
export function shouldWedgeAlert(input: WedgeInput): boolean {
  if (!input.supervising) return false;
  if (!input.sessionBusy) return false;
  if (input.thresholdMs <= 0) return false;
  if (input.silentMs < input.thresholdMs) return false;
  return input.msSinceLastAlert >= input.thresholdMs;
}

export interface HeartbeatInput {
  /** A goal is active (autoContinue) or a loop is running. */
  supervising: boolean;
  /** ctx.isIdle() && !ctx.hasPendingMessages() */
  sessionIdle: boolean;
  /** A continuation or loop timer is already scheduled. */
  timerPending: boolean;
  /** Milliseconds since the last observed agent activity. */
  msSinceActivity: number;
  stallMs?: number;
  /** v0.28.25: consecutive stall refires so far — spaces refires exponentially. */
  consecutiveStalls?: number;
}

/** Should the heartbeat re-fire the continuation right now? */
export function shouldHeartbeatRefire(input: HeartbeatInput): boolean {
  if (!input.supervising) return false;
  if (!input.sessionIdle) return false;
  if (input.timerPending) return false;
  // v0.28.25: exponential spacing between stall refires — 1m, 2m, 4m, 8m
  // (cap 8×). Field-observed in junk-runner: the flat 60s gate burned all
  // 5 refires in ~4 minutes into a just-compacted session, pausing a
  // resumable goal instead of giving the provider/queue time to recover.
  // noteActivity() runs at each refire, so msSinceActivity measures the
  // silence SINCE the last refire — scaling the threshold scales the gap.
  const stallMs = input.stallMs ?? HEARTBEAT_STALL_MS;
  const scale = 2 ** Math.min(input.consecutiveStalls ?? 0, 3);
  return input.msSinceActivity >= stallMs * scale;
}

/**
 * v0.27.3: the pure nudge detector and richer accounting. A supervising turn
 * is a nudge (no real progress) iff it has NO tool calls AND its text is
 * either short (< DEFAULT_STALL_SHORT_WORDS words) OR highly similar to
 * the prior assistant turn (3-gram Jaccard > DEFAULT_STALL_SIM_THRESHOLD).
 * Substantive analytical replies (≥ 15 words, novel) reset the counter
 * even with no tool calls — the polis-session incident ("3 consecutive
 * turns with no tool calls" tripped the brake on real investigation work,
 * screenshot 2026-07-27) showed the simple tool-only check is too coarse.
 *
 * Word-count rather than char-count: "Working…" (1 word) is a nudge;
 * "state-pump-dom.ts has zero references to hud." (8 words, one sentence)
 * is not. A paragraph with at least one real sentence is > 15 words.
 *
 * Pure: no side effects, no state. Safe to unit-test with crafted inputs.
 */
export const DEFAULT_STALL_SHORT_WORDS = 15;
export const DEFAULT_STALL_SIM_THRESHOLD = 0.6;

export function trigramSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const grams = (s: string) => {
    const g = new Map<string, number>();
    const t = s.toLowerCase();
    for (let i = 0; i <= t.length - 3; i++) {
      const k = t.slice(i, i + 3);
      g.set(k, (g.get(k) ?? 0) + 1);
    }
    return g;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  let uni = 0;
  const keys = new Set([...ga.keys(), ...gb.keys()]);
  for (const k of keys) {
    const va = ga.get(k) ?? 0;
    const vb = gb.get(k) ?? 0;
    inter += Math.min(va, vb);
    uni += Math.max(va, vb);
  }
  return uni === 0 ? 0 : inter / uni;
}

export function isNudgeTurn(opts: {
  toolCalls: number;
  text: string;
  priorText: string;
  shortWords?: number;
  simThreshold?: number;
}): boolean {
  if (opts.toolCalls > 0) return false;
  const shortThr = opts.shortWords ?? DEFAULT_STALL_SHORT_WORDS;
  const simThr = opts.simThreshold ?? DEFAULT_STALL_SIM_THRESHOLD;
  const wordCount = (opts.text.trim().match(/\S+/g) ?? []).length;
  if (wordCount < shortThr) return true;
  if (!opts.priorText) return false; // first turn in a streak — no similarity to compare to
  return trigramSimilarity(opts.text, opts.priorText) > simThr;
}

export function accountTurnForNudgesRich(
  opts: {
    toolCalls: number;
    text: string;
    priorText: string;
    shortWords?: number;
    simThreshold?: number;
  },
  currentNudges: number,
): number {
  return isNudgeTurn(opts) ? currentNudges + 1 : 0;
}

// =================================================================
// v0.35.17 — zero-stream abort auto-retry streak decision
 // =================================================================
// Field (note.md Next §1, screenshot 20260821_152311): turns dispatched by
// ACCEPTING a Confirm dialog hang with zero provider stream activity often
// enough that users repeatedly return to "action needed - this won't fix
// itself" parks. The watchdog's abort is correct; the missing half is ONE
// bounded automatic re-dispatch per silence streak. This pure decision is
// the one-retry bound; the timer that consumes it lives in goal-activation.ts.

export const ZOMBIE_RETRY_DELAY_MS = 90_000;

export interface ZombieRetryStreak {
  key: string;
  count: number;
  /** The stream-clock value observed at the streak's most recent abort. */
  lastAbortStreamAt: number;
}

/** A new owner key OR stream activity newer than the recorded abort point
 * starts a fresh streak; otherwise the streak deepens and the SECOND
 * consecutive silence is refused (no retry storm). A retried turn that
 * actually streams advances lastStreamActivityAt past the previous abort's
 * observation point, so any LATER independent hang earns its own single
 * retry. */
export function zombieRetryDecision(
  observedStreamAt: number,
  key: string,
  prev: ZombieRetryStreak,
): { retry: boolean; streak: ZombieRetryStreak } {
  const sameEpisode = key === prev.key && observedStreamAt <= prev.lastAbortStreamAt;
  const streak: ZombieRetryStreak = sameEpisode
    ? { key, count: Math.min(prev.count + 1, 2), lastAbortStreamAt: observedStreamAt }
    : { key, count: 1, lastAbortStreamAt: observedStreamAt };
  return { retry: streak.count === 1, streak };
}

// =================================================================
// v0.35.18 — canonical runner resolution for mechanical checks
// =================================================================
// Field (2026-08-21 fourth audit round): a verification contract that names a
// RAW RUNNER in prose ("passes under `bun test`") made the deterministic
// pre-audit execute `bun test` BARE — ignoring the project's own required
// configuration, which lives in its package.json scripts (here:
// --parallel=1 --max-concurrency=1 --timeout; this suite shares module state
// process-wide BY DESIGN and serializes deliberately). The bare invocation
// failed 6 tests + 5 nested-test errors while the canonical gate was green
// twice — a spurious fast-fail of finished work.
//
// Resolution rule (pure, unit-testable): if the contract command is exactly a
// runner invocation that some package.json script WRAPS (script value starts
// with the same program+subcommand), run the SCRIPT instead — the project's
// declared way to invoke that runner with its required flags. Anything else
// passes through untouched.
export function resolveCanonicalRunnerCommand(
  command: string,
  scripts: Record<string, string>,
): { program: string; args: string[] } {
  const tokens = command.trim().split(/[ \t]+/);
  const runner = `${tokens[0]} ${tokens[1] ?? ""}`.trim();
  // Only raw runner invocations are candidates — never rewrite npm/npx/pnpm
  // (already project-aware), and never a narrower deliberate run like
  // `bun test tests/foo.test.ts` (extra positional args disqualify).
  const isRawRunner = (runner === "bun test" || runner === "vitest" || runner === "jest")
    && tokens.length <= 2;
  if (!isRawRunner) {
    const [program = "", ...args] = tokens;
    return { program, args };
  }
  for (const [name, value] of Object.entries(scripts)) {
    const scriptTokens = value.trim().split(/[ \t]+/);
    if (scriptTokens[0] === tokens[0] && (scriptTokens[1] ?? "") === (tokens[1] ?? "")) {
      return { program: "npm", args: ["run", name] };
    }
  }
  const [fallbackProgram = "", ...fallbackArgs] = tokens;
  return { program: fallbackProgram, args: fallbackArgs };
}
