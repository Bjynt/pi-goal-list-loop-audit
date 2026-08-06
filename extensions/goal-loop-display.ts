/**
 * pi-goal-list-loop-audit — v0.9.0
 * extensions/goal-loop-display.ts
 *
 * Pure display builders for the live TUI (status line + above-editor widget).
 * No pi imports — unit tests exercise these directly. The orchestrator calls
 * No RUNTIME imports at all: tests run under `node --experimental-strip-types`,
 * which does not rewrite `.js` → `.ts` specifiers — a value import from
 * ./goal-loop-core.js breaks the suite (type-only imports are erased, safe).
 * ctx.ui.setStatus/setWidget with whatever these return.
 */

import { truncateToWidth as tuiTruncateToWidth, visibleWidth as tuiVisibleWidth } from "@earendil-works/pi-tui";

import type { Goal, State } from "./goal-loop-core.js";
import { compactDisplayText, isPersistenceDegraded, lastPersistenceFailure, sanitizeDisplayText, stripThinkBlocks } from "./goal-loop-core.js";
import { HELD_ON_RESTORE, type LoopState } from "./goal-loop-forever.js";

/** v0.34.57 (OPEN-ISSUES bug #1.8 / tasklist item #2): the MAIN host is
 * NEVER detached — it is always SUPERVISING, regardless of any handle state.
 * The DETACHED label belongs exclusively to the AUDITOR worker (which runs
 * in a separate process). This constant is the one-line guard: every MAIN
 * host render in this module MUST use this label. See
 * DETACHED-WORKER-HUD-RECONCILIATION-2026-08-05.md §3 ("Current MAIN is not
 * detached"). */
export const MAIN_HOST_LABEL = "MAIN HOST · SUPERVISING";

/** v0.28.17: a loop parked by the session-restore gate (was active when the
 * last session ended). Held loops must stay VISIBLE — before, only
 * state.loop?.active rendered anything and a reload made the loop vanish
 * from the always-on UI (user report 2026-07-29: "loops are the most
 * immature"). Stopped loops (any other stopReason) stay invisible. */
function heldLoop(state: State): LoopState | undefined {
  const l = state.loop;
  return l && !l.active && l.stopReason === HELD_ON_RESTORE ? l : undefined;
}

// ---- formatters ----

export function fmtElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  // Seconds stay visible up to the hour: the elapsed counter is the
  // liveness signal — minute-only granularity looks frozen on a 1s tick.
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function truncate(s: string, max: number): string {
  const safe = compactDisplayText(s);
  return safe.length <= max ? safe : safe.slice(0, Math.max(0, max - 1)) + "…";
}

/** v0.33.1: painted strings measure by their terminal-cell width. */
function visibleLen(s: string): number {
  return tuiVisibleWidth(s);
}

/** v0.33.0: 5-cell meter with a rounding guard (command-code's rule — never
 * shows empty or full unless the value truly is 0 or 1). */
export function meter(frac: number, cells = 5): string {
  if (!Number.isFinite(frac) || frac <= 0) return "▱".repeat(cells);
  if (frac >= 1) return "▰".repeat(cells);
  let filled = Math.round(frac * cells);
  if (filled === 0) filled = 1;
  if (filled === cells) filled = cells - 1;
  return "▰".repeat(filled) + "▱".repeat(cells - filled);
}

/** v0.33.0: one finished tool call, for the slim card's "last action" line. */
export interface RecentActionDisplay {
  name: string;
  arg?: string;
  ms: number;
  ok: boolean;
}

/** v0.33.0: widget extras — the refire streak plus the recent-action feed. */
export type GoalDisplayActivity = "active" | "awaiting-first-turn" | "working" | "busy" | "queued" | "idle";

export interface WidgetExtras {
  stalls?: number;
  recent?: RecentActionDisplay[];
  /** Ephemeral host-session projection; never persisted as goal state. */
  activity?: GoalDisplayActivity;
  /** Last real host stream activity, excluding timer/UI ticks. */
  lastActivityAt?: number;
  /** Last stream event used as proof for the live-work indicator. */
  lastStreamActivityAt?: number;
}

/**
 * Word-wrap to `width`, capped at `maxLines` (v0.27.1). A pause is the one
 * state where the FULL text matters — the reason often carries a decision
 * the user must make (dedup choices, impossible-verdict narrowing), and a
 * 60-char truncate hid it. Over-long words are hard-split; when the cap
 * cuts content the last line ends with "…" (the pause-time notification
 * and /goal status always carry the full text).
 */
export function wrap(s: string, width: number, maxLines: number): string[] {
  const norm = compactDisplayText(s);
  const words = norm.split(" ").filter(Boolean);
  const all: string[] = [];
  let cur = "";
  for (let w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= width) { cur = next; continue; }
    if (cur) all.push(cur);
    while (w.length > width) { all.push(w.slice(0, width)); w = w.slice(width); }
    cur = w;
  }
  if (cur) all.push(cur);
  if (all.length === 0) all.push("");
  if (all.length <= maxLines) return all;
  const out = all.slice(0, maxLines);
  // The last kept line already fits within width — truncate() would leave it
  // unmarked, so force the ellipsis to signal "more in /goal status".
  out[maxLines - 1] = out[maxLines - 1]!.slice(0, Math.max(0, width - 1)) + "…";
  return out;
}

/**
 * Width-aware truncation budget (v0.22.2). The hardcoded caps are FLOORS for
 * narrow terminals; when the terminal is wider, lines may use the available
 * width instead of being cut at a fixed ~60 chars (pi-tasks truncates at
 * tui.terminal.columns — match that behavior). `prefixCols` is the visible
 * width of the static prefix on the line. String-array widgets are rendered by
 * pi's Text component with one cell of left and right padding, so reserve both
 * cells here; otherwise a final word can wrap onto an unexpected extra line.
 */
const WIDGET_HORIZONTAL_MARGIN = 2;

function budgetFor(width: number | undefined, prefixCols: number, floor: number): number {
  if (!width || width <= 0) return floor;
  return Math.max(floor, width - WIDGET_HORIZONTAL_MARGIN - prefixCols);
}

function sinceIso(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Date.now() - t : 0;
}

// ---- semantic colors (optional; tests call without a theme → plain strings) ----

export type DisplayColor = "accent" | "success" | "warning" | "error" | "muted" | "dim";
export interface DisplayTheme {
  fg(color: DisplayColor, text: string): string;
}
const paint = (theme: DisplayTheme | undefined, color: DisplayColor, text: string): string => (theme ? theme.fg(color, text) : text);

/**
 * A live-work capsule is only rendered in the persistent status bar when the
 * host/worker supplied real activity evidence. It is deliberately not tied
 * to elapsed time alone: a durable active state can outlive a dead or merely
 * queued turn. The stream age beside it is the evidence freshness signal.
 *
 * The pulse is a liveness accent, not a progress meter. It is only reachable
 * after real stream/tool evidence has been observed, and it never claims a
 * completion percentage or remaining-work estimate.
 */
const LIVE_SIGNAL_FRAMES = [
  "▁▂▄▆█▆",
  "▂▄▆█▆▄",
  "▄▆█▆▄▂",
  "▆█▆▄▂▁",
  "█▆▄▂▁▂",
  "▆▄▂▁▂▄",
  "▄▂▁▂▄▆",
  "▂▁▂▄▆█",
] as const;
const LIVE_SIGNAL_FRAME_MS = 750;

function liveSignalFrame(now: number): string {
  const index = Math.floor(Math.max(0, now) / LIVE_SIGNAL_FRAME_MS) % LIVE_SIGNAL_FRAMES.length;
  return LIVE_SIGNAL_FRAMES[index]!;
}

function paintLiveSignal(frame: string, theme?: DisplayTheme): string {
  if (!theme) return frame;
  return Array.from(frame).map((cell) => {
    const color: DisplayColor = cell === "█" ? "success" : cell === "▁" ? "muted" : "accent";
    return paint(theme, color, cell);
  }).join("");
}

function activityBadge(label: string, now: number, theme?: DisplayTheme): string {
  const parts = label.split(" · ").map((part) => {
    const color: DisplayColor = part === "LIVE" ? "success" : part === "WORKING" ? "accent" : "accent";
    return paint(theme, color, part);
  });
  const separator = paint(theme, "dim", " · ");
  const signal = paintLiveSignal(liveSignalFrame(now), theme);
  return `${paint(theme, "dim", "[")}${signal}${paint(theme, "dim", " ")}${parts.join(separator)}${paint(theme, "dim", "]")}`;
}
function activityStateBadge(label: string, theme: DisplayTheme | undefined, color: DisplayColor): string {
  return paint(theme, color, `[${label}]`);
}
function stateBadge(label: string, glyph: string, theme: DisplayTheme | undefined, color: DisplayColor): string {
  return paint(theme, color, `⟦${glyph} ${label}⟧`);
}

/** Pause reasons that mean "something broke", not "waiting on the user". */
const ERROR_PAUSE = /token limit|stalled|infra|auditor.*fail/i;
const pauseIsError = (g: Goal): boolean => ERROR_PAUSE.test(g.pauseReason ?? "");

/** v0.28.22: the rendering class of a pause — declared kind wins; legacy
 * pauses (no kind) fall back to the error-regex so old states still
 * classify sensibly. */
type PauseKind = "decision" | "error" | "wait" | "blocked";
const pauseKind = (g: Goal): PauseKind | undefined => g.pauseKind ?? (pauseIsError(g) ? "error" : undefined);

/** A released completion claim is infrastructure debt, not a semantic verdict.
 * Keep the MAIN/worker roles explicit so a dead detached auditor cannot make
 * the host look detached or leave the user staring at an indefinite wait. */
function isCompletionAuditNoVerdict(g: Goal): boolean {
  return g.status === "paused"
    && !!g.pendingCompletion
    && g.pendingCompletion.phase === "recovery-pending"
    && /audit|verdict/i.test(g.pauseReason ?? "");
}

/** A provider quota wall is an expected wait, not a generic failure. Keep
 * raw 429/JSON detail out of the visual card while preserving it in durable
 * state and the ledger. Local token-budget pauses intentionally do not match.
 */
function isQuotaWall(g: Goal): boolean {
  const reason = g.pauseReason ?? "";
  if (/token limit exceeded/i.test(reason)) return false;
  // `main model recovery` alone is not a quota proof: auth, billing, and
  // transient provider failures can use the same recovery machinery. Require
  // explicit classifier vocabulary in the durable reason instead.
  return /429|quota|rate.?limit|usage.?limit|token.?plan|plan.?limit|credits?\s+(?:exhausted|depleted|used\s+up)|insufficient\s+(?:credits?|balance)/i.test(reason);
}

function quotaWallDetail(g: Goal): string {
  const reason = g.pauseReason ?? "";
  if (/credits?|balance|billing/i.test(reason)) return "provider billing/credit limit";
  if (/token.?plan|plan.?limit/i.test(reason)) return "Token Plan usage limit";
  if (/rate.?limit|429/i.test(reason)) return "provider rate limit";
  return "provider quota wall";
}

function quotaResumeText(g: Goal, now: number): string {
  const ms = g.pauseResumeAt ? Date.parse(g.pauseResumeAt) - now : Number.NaN;
  if (!Number.isFinite(ms)) return "manual resume required";
  // v0.34.51: the pause is a WAIT for the durable probe — nothing retries at
  // render time, so a passed resumeAt says "resuming…" (the timer owns it),
  // never the old claim that a retry is happening this instant.
  return ms <= 0 ? "resuming…" : `next probe in ${fmtElapsed(ms)}`;
}

/** Active goals can carry an operational warning while the agent is being
 * re-engaged. Do not render those as an ordinary green `active` card: a
 * failed detached auditor is not progress, and a missing turn-start proof is
 * not work. A disapproval or regression-shield rejection is different:
 * the claim WAS evaluated, so never call either one "no verdict". */
interface ActiveAttention {
  label: string;
  color: DisplayColor;
  detail: string;
  /** A concise, durable excerpt survives when the continuation turn never starts. */
  feedback?: string;
}

interface LatestAuditFeedback {
  label: "auditor disapproved" | "regression shield";
  text: string;
}

function latestAuditFeedback(g: Goal): LatestAuditFeedback | undefined {
  const verdict = [...(g.auditHistory ?? [])].reverse().find((entry) =>
    (entry.disapproved || (entry.approved && entry.regressionShieldPassed === false))
    && typeof entry.report === "string"
    && entry.report.trim().length > 0,
  );
  if (!verdict?.report) return undefined;
  // Keep the actionable tail when the report has one. Verdict markers alone
  // are not feedback; naming that explicitly is better than rendering a
  // blank-looking disapproval card.
  const requiredFixes = verdict.report.match(/(?:^|\n)\s*(?:#{1,6}\s*)?required fixes\b[\s\S]*/i)?.[0];
  const report = sanitizeDisplayText(requiredFixes ?? verdict.report.slice(-320))
    .replace(/<\/?(?:approved|disapproved|impossible)(?:\s[^>]*)?\s*\/?>(?:\s*)/gi, "")
    .trim();
  if (!report) return undefined;
  return {
    label: verdict.disapproved ? "auditor disapproved" : "regression shield",
    text: truncate(report, 320),
  };
}

function activeAttention(g: Goal): ActiveAttention | undefined {
  if (g.status !== "active" || !g.pauseReason) return undefined;
  if (/regression shield/i.test(g.pauseReason)) {
    return {
      label: "regression shield — evidence gap",
      color: "error",
      detail: "auditor approved; regression shield found missing evidence",
      feedback: latestAuditFeedback(g)?.text,
    };
  }
  if (/auditor disapproved/i.test(g.pauseReason)) {
    return {
      label: "auditor disapproved — fix the gap",
      color: "error",
      detail: "auditor verdict: disapproved",
      feedback: latestAuditFeedback(g)?.text,
    };
  }
  if (/auditor|completion audit/i.test(g.pauseReason)) {
    return {
      label: "auditor blocked — no verdict",
      color: "error",
      detail: "completion claim was not evaluated",
    };
  }
  return {
    label: "attention needed",
    color: pauseIsError(g) ? "error" : "warning",
    detail: "the active work needs attention",
  };
}

/** v0.34.27: an accepted dispatch with no start proof is a trigger/queue
 * failure, not proof that the host session disappeared. Keep the red
 * interrupted presentation, but tell the user which recovery is safe. */
function interruptedForNoStart(g: Goal): boolean {
  return /continuation start acknowledgement timed out/i.test(g.interruptedReason ?? "");
}

/** A pending claim without the new `running` marker is a legacy or
 * replacement-interrupted audit. It must never render as an active auditor. */
function auditRecoveryPending(g: Goal): boolean {
  return g.status === "auditing" && !!g.pendingCompletion && g.pendingCompletion.phase !== "running";
}

/** v0.28.22: "06:40 UTC" from an ISO string (wait-pause countdown). */
const shortClock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 16) : d.toISOString().slice(11, 16) + " UTC";
};

// ---- status line (one-liner, always-on) ----

export interface AuditDisplayProgress {
  currentTool?: string;
  /** JSON-safe tool arguments from the detached worker; display only a safe target summary. */
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  label?: string;
  phase?: "starting" | "running" | "thinking" | "tool_executing" | "producing_report" | "complete";
  elapsedMs?: number;
  /** Latest non-verdict text observed from the worker's report stream. */
  recentOutput?: string[];
  /** Completed read-only calls retained by the worker for live context. */
  toolCalls?: Array<{ name: string; argsPrefix: string; finishedAt: number }>;
  /** v0.34.56: explicit counts of unmatched tool start/end telemetry facts
   * (events that provably never paired). Shown honestly — never hidden, and
   * never silently re-paired into the paired toolCalls list. */
  unmatchedToolStarts?: number;
  unmatchedToolEnds?: number;
  /** Parent-observed progress-file change; useful for legacy callers. */
  lastEventAt?: number;
  /** Worker-side activity, excluding parent polls and UI refreshes. */
  lastActivityAt?: number;
}

type AuditorDisplayPhase = "queued" | "running" | "quiet" | "blocked" | "awaiting-verdict";
const AUDITOR_QUIET_MS = 3 * 60_000;
const LIVE_ACTIVITY_MS = 15_000;

/** Use worker activity for liveness. Fall back to the parent event timestamp
 * for older callers/tests that only know when a progress file was observed. */
function auditorActivityAge(audit: AuditDisplayProgress | null | undefined, now: number): number | undefined {
  if (!audit) return undefined;
  // A detached progress record with a phase but no worker timestamp is the
  // pre-RPC/startup state. Do not turn the parent's poll time into fake
  // evidence that the worker has already done work. Keep the lastEventAt
  // fallback only for legacy callers that never supplied a phase.
  const at = audit.lastActivityAt ?? (audit.phase === undefined && audit.label !== "queued" ? audit.lastEventAt : undefined);
  if (at === undefined || !Number.isFinite(at)) return undefined;
  return Math.max(0, now - at);
}

function auditorLastActivity(audit: AuditDisplayProgress | null | undefined, now: number): string {
  if (!audit?.lastActivityAt || !Number.isFinite(audit.lastActivityAt)) return "";
  // v0.34.57 (H-code fix — DETACHED-WORKER-HUD-RECONCILIATION-2026-08-05):
  // a future timestamp (worker clock ahead / skew) is NOT a fresh heartbeat.
  // Returning "" suppresses the misleading "0s ago" suffix the old
  // `Math.max(0, ...)` clamp produced. The companion gate in
  // `auditorHasLiveEvidence` also rejects future timestamps so the LIVE
  // badge does not render.
  if (audit.lastActivityAt > now) return "";
  return ` · worker activity ${fmtElapsed(now - audit.lastActivityAt)} ago`;
}

/** Project the detached worker's raw progress into the five user-facing
 * phases. A durable running claim without an observed progress event is not
 * green proof of work: it is explicitly waiting for a verdict. */
function auditorDisplayPhase(g: Goal, audit: AuditDisplayProgress | null | undefined, now: number): AuditorDisplayPhase {
  const label = audit?.label?.toLowerCase() ?? "";
  if (label === "queued") return "queued";
  if (/infra|error|failed|blocked|no verdict/.test(label)) return "blocked";
  if (audit?.phase === "complete") return "awaiting-verdict";
  const age = auditorActivityAge(audit, now);
  if (age !== undefined && age > AUDITOR_QUIET_MS) return "quiet";
  if (!audit && g.pendingCompletion?.phase === "running") return "awaiting-verdict";
  return "running";
}

function auditorPhaseLabel(phase: AuditorDisplayPhase): string {
  switch (phase) {
    case "queued": return "queued";
    case "running": return "running";
    case "quiet": return "quiet";
    case "blocked": return "blocked";
    case "awaiting-verdict": return "awaiting verdict";
  }
}

/** Keep the broad liveness phase for compatibility, but expose the worker's
 * observed sub-phase so `running` does not look like a frozen icon/timer. */
function auditorObservedPhase(audit: AuditDisplayProgress | null | undefined, phase: AuditorDisplayPhase): string {
  if (phase !== "running") return auditorPhaseLabel(phase);
  switch (audit?.phase) {
    case "starting": return "starting";
    case "thinking": return "thinking";
    case "tool_executing": return "tool executing";
    case "producing_report": return "producing report";
    case "complete": return "awaiting verdict";
    default: return "running";
  }
}

function auditorPhaseForDisplay(audit: AuditDisplayProgress | null | undefined, phase: AuditorDisplayPhase, live: boolean): string {
  // Once a worker timestamp exists, a stale tool snapshot is historical
  // context, not a claim that the detached process is still in that call.
  if (!live && phase === "running" && audit?.lastActivityAt !== undefined && audit.currentTool) {
    return "last observed tool";
  }
  return auditorObservedPhase(audit, phase);
}

function auditorHasLiveEvidence(audit: AuditDisplayProgress | null | undefined, phase: AuditorDisplayPhase, now: number): boolean {
  if (phase !== "running" || audit?.lastActivityAt === undefined || !Number.isFinite(audit.lastActivityAt)) return false;
  // v0.34.57 (H-code fix): reject future timestamps. A lastActivityAt in the
  // future is clock-skew or a stuck worker, NOT a fresh heartbeat. The old
  // comparison `now - lastActivityAt <= LIVE_ACTIVITY_MS` treated any
  // non-positive age as live, so a future timestamp rendered LIVE + "0s ago"
  // forever.
  if (audit.lastActivityAt > now) return false;
  return now - audit.lastActivityAt <= LIVE_ACTIVITY_MS;
}

/** The worker's JSON argument prefix may contain a full command or path. Only
 * expose a basename-like target in the TUI; never dump arbitrary arguments. */
function auditorToolTarget(args: string | undefined): string | undefined {
  if (!args) return undefined;
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const value = parsed.path ?? parsed.file_path;
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const clean = compactDisplayText(value);
    const target = clean.split(/[\\/]/).filter(Boolean).at(-1);
    return target ? truncate(target, 32) : undefined;
  } catch {
    return undefined;
  }
}

/** Return one safe, compact report-stream line. Think blocks and verdict-only
 * markers are intentionally omitted: this is activity telemetry, not a
 * second verdict surface. Join the retained fragments before stripping so an
 * unterminated streamed `<think>` block suppresses its later fragments too. */
function latestAuditorOutput(audit: AuditDisplayProgress | null | undefined): string | undefined {
  const stream = stripThinkBlocks((audit?.recentOutput ?? []).join("\n"))
    .replace(/<\/?(?:approved|disapproved|impossible)(?:\s[^>]*)?\/?>(?:\s*)/gi, "");
  for (const entry of stream.split("\n").reverse()) {
    const clean = compactDisplayText(sanitizeDisplayText(entry)).trim();
    if (clean) return truncate(clean, 180);
  }
  return undefined;
}

function lastAuditorTool(audit: AuditDisplayProgress | null | undefined): string | undefined {
  const name = audit?.toolCalls?.at(-1)?.name;
  return typeof name === "string" && name.trim() ? truncate(name, 30) : undefined;
}

function goalDisplayActivity(g: Goal, extras?: WidgetExtras): GoalDisplayActivity {
  if (g.status !== "active") return "active";
  return extras?.activity ?? "active";
}

function hostLastActivity(extras: WidgetExtras | undefined, now: number): string {
  const at = extras?.lastActivityAt;
  if (at === undefined || !Number.isFinite(at)) return "";
  return ` · last activity ${fmtElapsed(Math.max(0, now - at))} ago`;
}

function hostLastStream(extras: WidgetExtras | undefined, now: number): string {
  const at = extras?.lastStreamActivityAt;
  if (at === undefined || !Number.isFinite(at)) return "";
  return ` · last stream ${fmtElapsed(Math.max(0, now - at))} ago`;
}

/**
 * One-line status for ctx.ui.setStatus("pi-glla", …).
 * Returns undefined when nothing is being supervised (clears the segment).
 */
export function buildStatusText(state: State, audit?: AuditDisplayProgress | null, now = Date.now(), theme?: DisplayTheme, extras?: WidgetExtras): string | undefined {
  if (state.loop?.active) {
    const l = state.loop;
    // v0.26.1: surface the refire streak — a spinning supervisor is the
    // zombie signature (hegemon incident: 619 refires, 0 turns).
    const stallSuffix = (extras?.stalls ?? 0) > 0 ? ` · ${paint(theme, "warning", `stalls:${extras!.stalls}`)}` : "";
    // v0.23.0: metricless spec loop — no arrow/best/stall, no plateau.
    if (!l.measureCmd) {
      return `glla: loop ${paint(theme, "accent", "∞")} iter ${l.iteration}${l.maxIterations > 0 ? `/${l.maxIterations}` : ""} · metricless${stallSuffix}`;
    }
    const arrow = paint(theme, "accent", l.direction === "min" ? "↓" : "↑");
    const stallText = `stall ${l.stallCount}/${l.plateauWindow}`;
    const stall = l.stallCount >= l.plateauWindow - 1 ? paint(theme, "warning", stallText) : stallText;
    return `glla: loop ${arrow} iter ${l.iteration}/${l.maxIterations > 0 ? l.maxIterations : "∞"} · best ${l.bestValue ?? "n/a"} · ${stall}${stallSuffix}`;
  }
  const g = state.goal;
  const held = heldLoop(state);
  // v0.28.17: a held loop rides every goal state as a compact suffix.
  const heldSuffix = held ? paint(theme, "warning", " · loop⏸held") : "";
  if (!g) {
    if (held) return `glla: loop ${paint(theme, "warning", "⏸ held")} · iter ${held.iteration} — /loop to resume`;
    return undefined;
  }
  if (g.status === "auditing") {
    const host = paint(theme, "accent", MAIN_HOST_LABEL);
    if (auditRecoveryPending(g)) {
      return `glla: ${host} · ${paint(theme, "warning", "audit recovery pending")}${heldSuffix}`;
    }
    const phase = auditorDisplayPhase(g, audit, now);
    const live = auditorHasLiveEvidence(audit, phase, now);
    const phaseText = `auditor ${auditorPhaseForDisplay(audit, phase, live)}`;
    const color = phase === "blocked" || phase === "quiet" ? "warning" : live ? "success" : "accent";
    const label = live
      ? `${paint(theme, "success", phaseText)} ${activityBadge("AUDITOR · DETACHED · LIVE", now, theme)}`
      : paint(theme, color, phaseText);
    const tool = phase === "running" && audit?.currentTool ? ` · ${truncate(audit.currentTool, 30)}` : "";
    return `glla: ${host} · ${label}${tool}${live ? auditorLastActivity(audit, now) : ""}${heldSuffix}`;
  }
  if (g.status === "paused") {
    // v0.28.22: the status line names the ACTIONABILITY, not the reason —
    // "decision needed" / "action needed" / "waiting" tell you at a glance
    // whether the session needs you. Legacy pauses keep the reason dump.
    // v0.34.1: the policy word leaves the status line — the widget's head
    // chip already names the type ("list item"), so "glla: list ⏸ …" doubled
    // it. Status line = state/actionability only.
    if (isCompletionAuditNoVerdict(g)) {
      // v0.34.57: MAIN host label uses the constant guard so it stays
      // SUPERVISING even when the AUDITOR is blocked. The MAIN host is not
      // detached — only the auditor is blocked.
      return `glla: ${paint(theme, "accent", MAIN_HOST_LABEL)} · ${paint(theme, "warning", "auditor blocked — no verdict")}${heldSuffix}`;
    }
    const kind = pauseKind(g);
    if (kind === "decision") return `glla: ${paint(theme, "accent", "⏸ decision needed")}${heldSuffix}`;
    if (kind === "error") return `glla: ${paint(theme, "error", `⏸ action needed — ${truncate(g.pauseReason ?? "", 30)}`)}${heldSuffix}`;
    if (kind === "wait" || kind === "blocked") {
      // v0.34.12: live countdown (the UI ticker keeps rendering through a
      // timed wait) — "resumes in 23m" beats a static clock time, and a
      // passed resumeAt says "resuming…" instead of lying about the past.
      // v0.34.44: quota walls get a distinct amber badge. The retry budget in
      // pi's current request is not the recovery plan; this label tells the
      // user that the durable probe owns the wait.
      if (isQuotaWall(g)) {
        const queued = state.list?.length ?? 0;
        const queue = queued > 0 ? ` · ${queued} queued` : "";
        return `glla: ${stateBadge(`QUOTA WALL · ${quotaResumeText(g, now)}`, "⏳", theme, "warning")}${queue}${heldSuffix}`;
      }
      if (kind === "blocked") return `glla: ${paint(theme, "warning", "⏸ action needed")}${heldSuffix}`;
      const rms = g.pauseResumeAt ? Date.parse(g.pauseResumeAt) - now : Number.NaN;
      const when = Number.isNaN(rms) ? "" : rms <= 0 ? " · resuming…" : ` · resumes in ${fmtElapsed(rms)}`;
      return `glla: ${paint(theme, "dim", `⏳ waiting${when}`)}${heldSuffix}`;
    }
    const label = `paused ⏸ ${truncate(g.pauseReason ?? "", 40)}`;
    return `glla: ${paint(theme, pauseIsError(g) ? "error" : "warning", label)}${heldSuffix}`;
  }
  if (g.status === "active") {
    // v0.28.1 (S1/S2): a stale-handle interrupt keeps the goal ACTIVE.
    // It outranks any older operational note on the same state snapshot.
    if (g.interruptedAt) {
      const label = interruptedForNoStart(g)
        ? "⚠ turn start not observed — automatic retry held"
        : "⚠ interrupted — stale handle · fresh session_start resumes";
      return `glla: ${paint(theme, "error", label)}${heldSuffix}`;
    }
    const attention = activeAttention(g);
    if (attention) {
      return `glla: ${paint(theme, attention.color, `⚠ ${attention.label}`)}${heldSuffix}`;
    }
    const activity = goalDisplayActivity(g, extras);
    if (activity === "awaiting-first-turn") {
      return `glla: ${activityStateBadge("AWAITING FIRST TURN", theme, "warning")}${heldSuffix}`;
    }
    if (activity === "idle") {
      const idleDetails = [
        fmtElapsed(now - Date.parse(g.createdAt)),
        hostLastActivity(extras, now).replace(/^ · /, ""),
        (state.list?.length ?? 0) > 0 ? `${state.list!.length} queued` : "",
      ].filter(Boolean);
      return `glla: ${activityStateBadge("IDLE", theme, "warning")}${idleDetails.length > 0 ? ` ${idleDetails.join(" · ")}` : ""}${heldSuffix}`;
    }
    // v0.34.39: distinguish durable state from evidence of a live host turn.
    // A spinner is reserved for recent stream/tool evidence; BUSY without
    // that evidence is deliberately static so a hung provider cannot look
    // like progress. Queued work is neither idle nor currently executing.
    if (activity === "busy") {
      const busyDetails = [
        fmtElapsed(now - Date.parse(g.createdAt)),
        g.taskList ? `${countDone(g)}/${countTotal(g)} tasks` : "",
        hostLastStream(extras, now).replace(/^ · /, ""),
        (state.list?.length ?? 0) > 0 ? `${state.list!.length} queued` : "",
      ].filter(Boolean);
      return `glla: ${activityStateBadge("BUSY", theme, "warning")}${busyDetails.length > 0 ? ` ${busyDetails.join(" · ")}` : ""}${heldSuffix}`;
    }
    // v0.34.16: a fresh session_start owns the handoff. A cold boot still
    // follows the global autoResume setting, so the widget names the actual
    // lifecycle rather than promising terminal keystroke recovery.
    // v0.24.7: list policy gets its own wording — a queue item is not a goal.
    // v0.28.11 (U10): goal policy joins it — "list 29" read as a command
    // fragment; "29 queued" says what the number IS. Both policies now
    // render "… · N queued".
    const n = state.list?.length ?? 0;
    const live = activity === "working";
    const queued = activity === "queued";
    const marker = live
      ? activityBadge("LIVE · WORKING", now, theme)
      : queued
        ? activityStateBadge("QUEUED", theme, "warning")
        : activityStateBadge("ACTIVE", theme, "accent");
    // Keep the screenshot-proven order: state, elapsed, freshness, then
    // queue/task context. It scans like a compact instrument readout and
    // remains useful when the above-editor card is hidden or scrolled away.
    const details = [
      fmtElapsed(now - Date.parse(g.createdAt)),
      g.taskList ? `${countDone(g)}/${countTotal(g)} tasks` : "",
      live ? hostLastStream(extras, now).replace(/^ · /, "") : "",
      n > 0 ? `${n} queued` : "",
    ].filter(Boolean);
    return `glla: ${marker}${details.length > 0 ? ` ${details.join(" · ")}` : ""}${heldSuffix}`;
  }
  // complete/aborted → clear — but a held loop still shows.
  if (held) return `glla: loop ${paint(theme, "warning", "⏸ held")} · iter ${held.iteration} — /loop to resume`;
  return undefined;
}

function countDone(g: Goal): number {
  let n = 0;
  const walk = (ts: Array<{ status: string; subtasks?: any[] }>) => {
    for (const t of ts) {
      if (t.status === "complete") n++;
      if (t.subtasks) walk(t.subtasks);
    }
  };
  walk(g.taskList?.tasks ?? []);
  return n;
}

function countTotal(g: Goal): number {
  let n = 0;
  const walk = (ts: Array<{ subtasks?: any[] }>) => {
    for (const t of ts) {
      n++;
      if (t.subtasks) walk(t.subtasks);
    }
  };
  walk(g.taskList?.tasks ?? []);
  return n;
}

// ---- above-editor widget (multi-line panel) ----

/**
 * Widget lines for ctx.ui.setWidget("pi-glla", lines).
 * Returns undefined when nothing is worth showing.
 */
export function buildWidgetLines(state: State, audit?: AuditDisplayProgress | null, now = Date.now(), theme?: DisplayTheme, width?: number, extras?: WidgetExtras): string[] | undefined {
  const inner = buildWidgetLinesInner(state, audit, now, theme, width, extras);
  // v0.28.6 (E1): a persistence failure outranks everything — first line,
  // on every render, until a write lands again.
  let lines: string[] | undefined = inner;
  if (inner && isPersistenceDegraded()) {
    const err = lastPersistenceFailure();
    lines = [paint(theme, "error", `⚠ persistence degraded — .pi-glla writes failing (${truncate(err?.error ?? "disk error", 40)}); state in RAM`), ...inner];
  }
  // String-array widgets are wrapped by pi-tui's Text component, whose
  // paddingX=1 consumes one cell on each side. Keep every emitted line inside
  // that content width so long detail/status strings never wrap a trailing
  // segment (for example, `50s`) into a stray next line.
  if (lines && width && width > 0) {
    const contentWidth = Math.max(1, width - WIDGET_HORIZONTAL_MARGIN);
    return lines.map((line) => tuiTruncateToWidth(line, contentWidth, "…"));
  }
  return lines;
}

function buildWidgetLinesInner(state: State, audit?: AuditDisplayProgress | null, now = Date.now(), theme?: DisplayTheme, width?: number, extras?: WidgetExtras): string[] | undefined {
  if (state.loop?.active) return loopLines(state.loop, now, theme, width, extras);
  const g = state.goal;
  const held = heldLoop(state);
  if (!g || g.status === "complete" || g.status === "aborted") {
    // v0.28.17: no visible goal — the held loop gets its own card.
    return held ? heldLoopLines(held, now, theme, width) : undefined;
  }
  const lines = goalLines(g, state, audit, now, theme, width, extras);
  // v0.28.17: a held loop rides the goal card as a trailing line.
  if (held) {
    lines.push(`${paint(theme, "warning", "⏸")} ${truncate(held.target, budgetFor(width, 3, 64))}`);
    lines.push(`└─ ${paint(theme, "dim", `loop held · iter ${held.iteration} — /loop to resume`)}`);
  }
  return lines;
}

/** v0.28.17: standalone card for a restore-held loop (no goal visible). */
function heldLoopLines(l: LoopState, now: number, theme?: DisplayTheme, width?: number): string[] {
  return [
    `${paint(theme, "warning", "⏸")} ${truncate(l.target, budgetFor(width, 3, 64))}`,
    `├─ loop held · iter ${l.iteration} · ${fmtElapsed(now - Date.parse(l.startedAt))} so far`,
    `└─ ${paint(theme, "dim", "held by the session-restore gate — /loop to resume, /loop stop to drop")}`,
  ];
}

// Branch lines sit flush-left (pi-tasks convention): pi's widget renderer
// adds its own one-space gutter, so any indent here doubles up.
function goalLines(g: Goal, state: State, audit: AuditDisplayProgress | null | undefined, now: number, theme?: DisplayTheme, width?: number, extras?: WidgetExtras): string[] {
  // Head glyph is ● (not ◆): U+25C6 renders as a color-emoji diamond in some
  // terminal fonts and ignores ANSI color; ● takes the paint everywhere.
  const interrupted = g.status === "active" && !!g.interruptedAt;
  const attention = activeAttention(g);
  const auditorPhase = g.status === "auditing" ? auditorDisplayPhase(g, audit, now) : undefined;
  const icon =
    interrupted
      ? paint(theme, "error", "⚠")
      : attention
        ? paint(theme, attention.color, "⚠")
        : g.status === "paused"
          ? paint(theme, pauseIsError(g) ? "error" : "warning", "⏸")
          : g.status === "auditing"
            ? paint(theme, "accent", "⟡")
            : paint(theme, "success", "●");
  // v0.24.7: a list item is named as such and points at /list — before,
  // the widget called it "active" and hinted "/goal status", reading as if
  // queue work were a standalone goal.
  const isList = g.policy === "list";
  const statusWord = interrupted
    ? paint(theme, "error", "interrupted")
    : attention
      ? paint(theme, attention.color, attention.label)
      : g.status === "active"
        ? paint(theme, "success", "active")
        : g.status;
  // v0.33.0: slim card — status folds INTO the head line as middot segments
  // (filter(Boolean).join, the universal CLI idiom). Line 2 is the live
  // "last action · next task" line; the footer stays the hint line.
  // v0.28.30: the type stays visible — v0.33.0 names it via the "list item"
  // header segment (list policy) and the distinct card icons (● goal,
  // ∞/↓/↑ loop, ⟡ auditing, ⏸ paused) + the type-named footer verbs.
  // Token segment only when a budget is set (v0.22.0): the guard is opt-in,
  // and "0/0 tok" carried no information when off.
  const tokenLimit = g.usage?.tokensLimit ?? 0;
  const headSegs: string[] = [];
  if (isList) headSegs.push("list item");
  headSegs.push(statusWord);
  headSegs.push(fmtElapsed(now - Date.parse(g.createdAt)));
  const taskTotal = countTotal(g);
  if (taskTotal > 0) headSegs.push(`${countDone(g)}/${taskTotal} ${paint(theme, "dim", meter(countDone(g) / taskTotal))}`);
  const tokUsed0 = g.usage?.tokensUsed ?? 0;
  if (tokenLimit > 0) headSegs.push(paint(theme, "dim", `${fmtTokens(tokUsed0)}/${fmtTokens(tokenLimit)} ${meter(tokUsed0 / tokenLimit)}`));
  else if (tokUsed0 > 0) headSegs.push(paint(theme, "dim", `${fmtTokens(tokUsed0)} tok`));
  // v0.28.30: the type stays visible — v0.33.0 names it via the "list item"
  // header segment (list policy) and the distinct card icons (● goal,
  // ∞/↓/↑ loop, ⟡ auditing, ⏸ paused) + the type-named footer verbs.
  // Token segment only when a budget is set (v0.22.0): the guard is opt-in,
  // and "0/0 tok" carried no information when off.
  // v0.33.1: the head must FIT the terminal — the segments are fixed, so
  // the objective absorbs whatever room is left (was: objective budgeted
  // alone, segments appended unbudgeted → 140-col heads at width 100).
  const segsText = headSegs.join(` ${paint(theme, "dim", "·")} `);
  const objBudget = width && width > 0
    ? Math.max(16, width - WIDGET_HORIZONTAL_MARGIN - 2 - 3 - visibleLen(segsText))
    : 48;
  const head = `${icon} ${truncate(g.objective.replace(/\s+/g, " "), objBudget)} ${paint(theme, "dim", "·")} ${segsText}`;
  const lines = [head];
  if (interrupted) {
    const resumeCmd = isList ? "/list resume" : "/goal resume";
    if (interruptedForNoStart(g)) {
      lines.push(`├─ ${paint(theme, "error", "continuation was accepted, but pi did not start a turn")}`);
    } else {
      lines.push(`├─ ${paint(theme, "error", "host session lost — waiting for fresh session_start")}`);
    }
    // Lifecycle interruption must not hide a semantic verdict that already
    // landed. The continuation may be gone, but auditHistory is durable and
    // its required-fixes excerpt is the work the user must act on next.
    const feedback = latestAuditFeedback(g);
    if (feedback) {
      const feedbackColor: DisplayColor = feedback.label === "auditor disapproved" ? "error" : "warning";
      lines.push(`├─ ${paint(theme, feedbackColor, `${feedback.label} — durable required fixes`)}`);
      wrap(`latest audit feedback: ${feedback.text}`, budgetFor(width, 3, 60), 3).forEach((w) => {
        lines.push(`│  ${paint(theme, feedbackColor, w)}`);
      });
    }
    const recovery = interruptedForNoStart(g)
      ? `automatic re-sends are stopped · ${resumeCmd} to retry once`
      : `/reload to rebind · ${resumeCmd} if it does not resume`;
    lines.push(`└─ ${paint(theme, "warning", recovery)}`);
    return lines;
  }
  // Activity is intentionally a single-surface HUD: the persistent status
  // bar owns LIVE/BUSY/QUEUED/IDLE and stream age. The card stays about the
  // goal and its durable recent action, avoiding the duplicated live badge
  // that made the above-editor panel look noisy.
  if (g.status === "auditing") {
    const host = paint(theme, "accent", MAIN_HOST_LABEL);
    if (auditRecoveryPending(g)) {
      lines.push(`├─ ${host} · auditor: ${paint(theme, "warning", "recovery pending — previous audit was interrupted")}`);
      lines.push(`└─ ${paint(theme, "dim", "stored completion claim is safe; a fresh session will retry it")}`);
      return lines;
    }
    const phase = auditorDisplayPhase(g, audit, now);
    const phaseLive = auditorHasLiveEvidence(audit, phase, now);
    const phaseLabel = auditorPhaseForDisplay(audit, phase, phaseLive);
    const detail = audit?.label && audit.label !== "queued" && audit.label !== "running"
      ? ` · ${truncate(audit.label, 30)}`
      : "";
    // The status bar is the single activity HUD. Keep the widget's audit line
    // factual and compact; the ⟡ head icon plus this phase identify the
    // detached verifier without repeating the animated status badge.
    lines.push(`├─ ${host} · auditor: ${phaseLabel}${detail}`);

    // Show observed worker facts, not a made-up percentage or semantic claim.
    // This is the difference between “the timer moved” and “I can see what
    // the detached worker last did.”
    const observations: string[] = [];
    // A stale progress snapshot must not keep presenting its old tool as
    // currently executing. Only fresh worker telemetry earns the present
    // tense; otherwise show it as the last observed tool and omit duration.
    if (phase === "running" && phaseLive && audit?.currentTool) {
      const target = auditorToolTarget(audit.currentToolArgs);
      const duration = audit.currentToolStartedAt !== undefined && Number.isFinite(audit.currentToolStartedAt)
        ? ` · ${fmtElapsed(now - audit.currentToolStartedAt)}`
        : "";
      observations.push(`tool: ${truncate(audit.currentTool, 30)}${target ? ` → ${target}` : ""}${duration}`);
    } else {
      const lastTool = lastAuditorTool(audit) ?? (audit?.currentTool ? truncate(audit.currentTool, 30) : undefined);
      if (lastTool) observations.push(`last tool: ${lastTool}`);
    }
    const latest = latestAuditorOutput(audit);
    if (latest) observations.push(`latest: ${latest}`);
    const unmatchedStarts = audit?.unmatchedToolStarts ?? 0;
    const unmatchedEnds = audit?.unmatchedToolEnds ?? 0;
    if (unmatchedStarts + unmatchedEnds > 0) {
      observations.push(`unmatched tool events: ${unmatchedStarts} start / ${unmatchedEnds} end — explicitly unpaired, never falsely matched`);
    }
    observations.forEach((observation, i) => {
      lines.push(`${i === 0 ? "├─" : "│ "} ${paint(theme, "dim", observation)}`);
    });

    const activity = auditorActivityAge(audit, now);
    const last = auditorLastActivity(audit, now);
    if (phase === "quiet") {
      const quietMs = activity ?? 0;
      lines.push(`└─ ${paint(theme, "warning", `auditor quiet ${fmtElapsed(quietMs)}${last} — may be stuck; /goal cancel discards the claim`)}`);
    } else if (phase === "blocked") {
      lines.push(`└─ ${paint(theme, "warning", `auditor blocked${audit?.label ? ` — ${truncate(audit.label, 44)}` : ""}${last}`)}`);
    } else if (phase === "awaiting-verdict") {
      lines.push(`└─ ${paint(theme, "dim", `waiting for detached verdict${last}`)}`);
    } else if (phase === "queued") {
      lines.push(`└─ ${paint(theme, "dim", "detached worker queued — completion claim is durable")}`);
    } else if (audit?.elapsedMs) {
      const firstEvent = audit.lastActivityAt === undefined ? " · waiting for first worker event" : "";
      lines.push(`└─ ${paint(theme, "dim", `${fmtElapsed(audit.elapsedMs)} in detached worker${firstEvent}${last}`)}`);
    } else {
      lines.push(`└─ ${paint(theme, "dim", `detached worker, read-only tools${last || " · waiting for first worker event"}`)}`);
    }
    return lines;
  }
  if (g.status === "paused" && g.pauseReason) {
    if (isCompletionAuditNoVerdict(g)) {
      lines.push(`├─ ${paint(theme, "error", "auditor: blocked — no verdict")}`);
      lines.push(`├─ ${paint(theme, "dim", "MAIN host remains attached; the completion claim was not evaluated")}`);
      lines.push(`└─ ${paint(theme, "warning", g.pauseSuggestedAction ?? `The claim is safe; ${isList ? "/list resume" : "/goal resume"} starts one fresh auditor.`)}`);
      return lines;
    }
    const kind = pauseKind(g);
    const isErr = kind === "error";
    const budget = budgetFor(width, 3, 60);
    // v0.28.22: actionability banner — a decision pause, an operational
    // failure, and a time-gated wait must not look alike (user report:
    // "if something actionable is going on it can be hard to tell").
    // v0.34.44: quota walls get a dedicated visual treatment. Do not dump
    // the provider's raw 429 JSON into the card; it remains in durable state
    // and the ledger while the user sees the recovery contract.
    if (kind === "decision") lines.push(`├─ ${paint(theme, "accent", "decision needed — your call unblocks this")}`);
    else if (kind === "error") lines.push(`├─ ${paint(theme, "error", "action needed — this won't fix itself")}`);
    else if ((kind === "wait" || kind === "blocked") && isQuotaWall(g)) {
      const queued = state.list?.length ?? 0;
      const queue = queued > 0 ? ` · ${queued} waiting in list` : "";
      lines.push(`├─ ${paint(theme, "warning", `QUOTA WALL · ${quotaWallDetail(g)}${queue}`)}`);
      lines.push(`├─ ${paint(theme, "dim", kind === "blocked" ? `automatic retries stopped · ${quotaResumeText(g, now)}` : `waiting — nothing for you to do · ${quotaResumeText(g, now)}`)}`);
    } else if (kind === "wait") lines.push(`├─ ${paint(theme, "dim", "waiting — nothing for you to do")}`);
    // v0.27.1: wrap reason + suggested action (see wrap()). v0.28.22:
    // decision/wait reasons cap at 2 lines — the options/countdown below
    // carry the actionable content; error reasons keep 3.
    const reasonPaint = isErr ? "error" : kind === "wait" ? "dim" : "warning";
    if (!((kind === "wait" || kind === "blocked") && isQuotaWall(g))) {
      wrap(g.pauseReason, budget, kind === "decision" || kind === "wait" ? 2 : 3).forEach((w, i) => {
        lines.push(`${i === 0 ? "├─" : "│ "} ${paint(theme, reasonPaint, w)}`);
      });
    }
    // v0.28.22: decision options — one numbered line each (Claude Code /
    // muselinn-Ask convention), the recommended one accented and flagged.
    if (kind === "decision" && g.pauseOptions && g.pauseOptions.length > 0) {
      g.pauseOptions.slice(0, 6).forEach((opt, i) => {
        const rec = g.pauseRecommended === i + 1;
        const text = `${i + 1}. ${truncate(opt, budget - 4)}${rec ? " ◂ recommended" : ""}`;
        lines.push(`│  ${paint(theme, rec ? "accent" : "dim", text)}`);
      });
      if (g.pauseOptions.length > 6) lines.push(`│  ${paint(theme, "dim", `… and ${g.pauseOptions.length - 6} more`)}`);
    }
    // v0.28.22: wait countdown — when the pause lifts on its own.
    if (kind === "wait" && g.pauseResumeAt && !isQuotaWall(g)) {
      const ms = Date.parse(g.pauseResumeAt) - now;
      const when = Number.isNaN(ms) ? g.pauseResumeAt : ms <= 0 ? "now" : `${shortClock(g.pauseResumeAt)} (in ${fmtElapsed(ms)})`;
      lines.push(`├─ ${paint(theme, "dim", `resumes ${when} — or ${isList ? "/list resume" : "/goal resume"} now`)}`);
    }
    // v0.27.1: what survives the pause — the first question at a pause is
    // "did I lose the work?". Answer it on the card.
    // v0.27.9: when the goal has no telemetry yet (restored-in-fresh-session
    // before the first turn), render "awaiting first turn" instead of "saved"
    // — the latter was misleading because no work was ever "saved" before the
    // session ended.
    const spent: string[] = [];
    const tokUsed = g.usage?.tokensUsed ?? 0;
    const audits = g.auditHistory?.length ?? 0;
    if (tokUsed > 0) spent.push(`${fmtTokens(tokUsed)} tok spent`);
    if (audits > 0) spent.push(`${audits} audit${audits === 1 ? "" : "s"}`);
    const hasTelemetry = spent.length > 0;
    const savedLine = hasTelemetry
      ? `saved — ${spent.join(" · ")} · resumes exactly here`
      : `awaiting first turn — resumes exactly here`;
    if (g.pauseSuggestedAction) {
      lines.push(`├─ ${paint(theme, "dim", truncate(savedLine, budget))}`);
      const wrapped = wrap(g.pauseSuggestedAction, budget, 3);
      // v0.28.22: for ACTION NEEDED pauses the action is the point — pop it.
      const actionPaint = kind === "error" ? "warning" : "dim";
      wrapped.forEach((w, i) => lines.push(`${i === wrapped.length - 1 ? "└─" : "│ "} ${paint(theme, actionPaint, w)}`));
    } else {
      lines.push(`└─ ${paint(theme, "dim", truncate(savedLine, budget))}`);
    }
    return lines;
  }
  if (attention) {
    const budget = budgetFor(width, 3, 60);
    lines.push(`├─ ${paint(theme, attention.color, attention.detail)}`);
    if (attention.feedback) {
      // The detached result may arrive after the host continuation has
      // stalled. Keep the actionable report on the always-visible card; do
      // not make the user rely on a turn that may never start.
      wrap(`latest audit feedback: ${attention.feedback}`, budget, 3).forEach((w) => {
        lines.push(`│  ${paint(theme, attention.color, w)}`);
      });
    } else {
      wrap(g.pauseReason!, budget, 3).forEach((w) => {
        lines.push(`│  ${paint(theme, attention.color, w)}`);
      });
    }
    if (g.pauseSuggestedAction) {
      wrap(g.pauseSuggestedAction, budget, 2).forEach((w, i, all) => {
        lines.push(`${i === all.length - 1 ? "└─" : "│ "} ${paint(theme, "warning", w)}`);
      });
    } else {
      lines.push(`└─ ${paint(theme, "dim", "inspect /goal status before continuing")}`);
    }
    return lines;
  }
  // v0.33.0: "last action · next task" — Claude's done-row format meets the
  // pending queue. Segments join with a dim middot; missing ones drop out.
  const act = extras?.recent?.[extras.recent.length - 1];
  const mid: string[] = [];
  if (act) {
    mid.push(`${paint(theme, act.ok ? "success" : "error", act.ok ? "✓" : "✗")} ${act.name}${act.arg ? ` ${paint(theme, "dim", truncate(act.arg, 24))}` : ""}${act.ms > 0 ? ` ${paint(theme, "dim", `(${fmtElapsed(act.ms)})`)}` : ""}`);
  }
  const next = nextPending(g);
  if (next) mid.push(`next: ${truncate(next, budgetFor(width, 9, 40))}`);
  if (mid.length > 0) lines.push(`├─ ${mid.join(` ${paint(theme, "dim", "·")} `)}`);
  const queue = state.list?.length ?? 0;
  // v0.34.43: a long-running list needs one concrete glimpse beyond the
  // counter. Keep it compact and truthful: state.list is the waiting queue,
  // so show only its immediate next item and how long it has waited. The
  // complete queue remains available through /list; this is a visual trail,
  // not a second queue surface.
  if (isList && queue > 0) {
    const nextItem = state.list?.[0];
    if (nextItem) {
      const added = Date.parse(nextItem.addedAt);
      const age = Number.isFinite(added) ? ` · waiting ${fmtElapsed(now - added)}` : "";
      const prefix = `↳ ${queue} waiting · up next: `;
      const objectiveBudget = budgetFor(width, visibleLen(`├─ ${prefix}`) + visibleLen(age), 40);
      lines.push(`├─ ${paint(theme, "accent", "↳")} ${queue} waiting · up next: ${truncate(nextItem.objective, objectiveBudget)}${paint(theme, "dim", age)}`);
    }
  }
  const footer = isList
    ? `${queue > 0 ? `${queue} queued · ` : ""}/list · /glla`
    : `${queue > 0 ? `${queue} queued · ` : ""}/goal status · /glla`;
  lines.push(`└─ ${paint(theme, "dim", footer)}`);
  return lines;
}

function loopLines(l: LoopState, now: number, theme?: DisplayTheme, width?: number, extras?: WidgetExtras): string[] {
  // v0.33.0: slim loop card — header icon names the kind (∞ metricless,
  // ↓/↑ metric), all state folds into middot segments; line 2 is the live
  // "last action" line; footer is hints. The old per-line "loop ∞ iter" /
  // "best/last/stall" rows collapse into the header.
  const stallNote = (extras?.stalls ?? 0) > 0 ? ` ${paint(theme, "dim", "·")} ${paint(theme, "warning", `stalls:${extras!.stalls}`)}` : "";
  const icon = !l.measureCmd ? paint(theme, "accent", "∞") : paint(theme, "accent", l.direction === "min" ? "↓" : "↑");
  const segs: string[] = [];
  segs.push(`iter ${l.iteration}${l.maxIterations > 0 ? `/${l.maxIterations} ${paint(theme, "dim", meter(l.iteration / l.maxIterations))}` : ""}`);
  segs.push(fmtElapsed(now - Date.parse(l.startedAt)));
  if (l.measureCmd) {
    segs.push(`best ${paint(theme, "success", `${l.bestValue ?? "n/a"}`)}`);
    segs.push(`last ${l.lastValue ?? "n/a"}`); // v0.33.1: a plateauing loop's current reading stays visible
    const stallText = `stall ${l.stallCount}/${l.plateauWindow}`;
    segs.push(l.stallCount >= l.plateauWindow - 1 ? paint(theme, "warning", stallText) : stallText);
  }
  const segsText = segs.join(` ${paint(theme, "dim", "·")} `);
  const targetBudget = width && width > 0
    ? Math.max(16, width - WIDGET_HORIZONTAL_MARGIN - 2 - 3 - visibleLen(segsText) - visibleLen(stallNote))
    : 44;
  const lines = [`${icon} ${truncate(l.target, targetBudget)} ${paint(theme, "dim", "·")} ${segsText}${stallNote}`];
  const act = extras?.recent?.[extras.recent.length - 1];
  if (act) {
    lines.push(`├─ ${paint(theme, act.ok ? "success" : "error", act.ok ? "✓" : "✗")} ${act.name}${act.arg ? ` ${paint(theme, "dim", truncate(act.arg, 24))}` : ""}${act.ms > 0 ? ` ${paint(theme, "dim", `(${fmtElapsed(act.ms)})`)}` : ""}`);
  }
  const footer = !l.measureCmd
    ? "metricless (no plateau) · /loop stop · /loop refine" // v0.33.2: the verb exists now
    : `${l.kind === "audit" ? "metric: closed findings" : truncate(l.measureCmd, budgetFor(width, 3, 30))} · /loop stop`;
  lines.push(`└─ ${paint(theme, "dim", footer)}`);
  if (l.branchName) lines.push(`⎇ ${paint(theme, "muted", truncate(l.branchName, budgetFor(width, 3, 50)))}`);
  return lines;
}

function nextPending(g: Goal): string | undefined {
  const tasks = g.taskList?.tasks ?? [];
  const queue = [...tasks];
  while (queue.length > 0) {
    const t = queue.shift()!;
    if (t.status === "pending") return t.title;
    if (t.subtasks) queue.push(...t.subtasks);
  }
  return undefined;
}
