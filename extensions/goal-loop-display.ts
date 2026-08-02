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

import type { Goal, State } from "./goal-loop-core.js";
import { compactDisplayText, isPersistenceDegraded, lastPersistenceFailure, sanitizeDisplayText } from "./goal-loop-core.js";
import { HELD_ON_RESTORE, type LoopState } from "./goal-loop-forever.js";

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
  const safe = sanitizeDisplayText(s);
  return safe.length <= max ? safe : safe.slice(0, Math.max(0, max - 1)) + "…";
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
/** v0.33.1: painted strings measure by their VISIBLE width. */
function visibleLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
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
export interface WidgetExtras {
  stalls?: number;
  recent?: RecentActionDisplay[];
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
 * width of the static prefix on the line (branch glyph + pi's 1-col gutter).
 */
function budgetFor(width: number | undefined, prefixCols: number, floor: number): number {
  if (!width || width <= 0) return floor;
  return Math.max(floor, width - 1 - prefixCols);
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

/** Pause reasons that mean "something broke", not "waiting on the user". */
const ERROR_PAUSE = /token limit|stalled|infra|auditor.*fail/i;
const pauseIsError = (g: Goal): boolean => ERROR_PAUSE.test(g.pauseReason ?? "");

/** v0.28.22: the rendering class of a pause — declared kind wins; legacy
 * pauses (no kind) fall back to the error-regex so old states still
 * classify sensibly. */
type PauseKind = "decision" | "error" | "wait" | "blocked";
const pauseKind = (g: Goal): PauseKind | undefined => g.pauseKind ?? (pauseIsError(g) ? "error" : undefined);

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
  label?: string;
  elapsedMs?: number;
  /** v0.25.4: last progress-event time — the widget flags auditor-quiet
   * stalls when this goes stale while the audit is in flight. */
  lastEventAt?: number;
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
    if (auditRecoveryPending(g)) {
      return `glla: ${paint(theme, "warning", "audit recovery pending")}${heldSuffix}`;
    }
    const label = audit?.label === "queued" ? "auditor queued" : "auditor running";
    const tool = audit?.currentTool ? ` · ${audit.currentTool}` : "";
    return `glla: ${paint(theme, "accent", label)}${tool}${heldSuffix}`;
  }
  if (g.status === "paused") {
    // v0.28.22: the status line names the ACTIONABILITY, not the reason —
    // "decision needed" / "action needed" / "waiting" tell you at a glance
    // whether the session needs you. Legacy pauses keep the reason dump.
    // v0.34.1: the policy word leaves the status line — the widget's head
    // chip already names the type ("list item"), so "glla: list ⏸ …" doubled
    // it. Status line = state/actionability only.
    const kind = pauseKind(g);
    if (kind === "decision") return `glla: ${paint(theme, "accent", "⏸ decision needed")}${heldSuffix}`;
    if (kind === "error") return `glla: ${paint(theme, "error", `⏸ action needed — ${truncate(g.pauseReason ?? "", 30)}`)}${heldSuffix}`;
    if (kind === "wait") {
      // v0.34.12: live countdown (the UI ticker keeps rendering through a
      // timed wait) — "resumes in 23m" beats a static clock time, and a
      // passed resumeAt says "resuming…" instead of lying about the past.
      const rms = g.pauseResumeAt ? Date.parse(g.pauseResumeAt) - now : Number.NaN;
      const when = Number.isNaN(rms) ? "" : rms <= 0 ? " · resuming…" : ` · resumes in ${fmtElapsed(rms)}`;
      return `glla: ${paint(theme, "dim", `⏳ waiting${when}`)}${heldSuffix}`;
    }
    const label = `paused ⏸ ${truncate(g.pauseReason ?? "", 40)}`;
    return `glla: ${paint(theme, pauseIsError(g) ? "error" : "warning", label)}${heldSuffix}`;
  }
  if (g.status === "active") {
    // v0.28.1 (S1/S2): a stale-handle interrupt keeps the goal ACTIVE.
    // v0.34.16: a fresh session_start owns the handoff. A cold boot still
    // follows the global autoResume setting, so the widget names the actual
    // lifecycle rather than promising terminal keystroke recovery.
    if (g.interruptedAt) {
      return `glla: ${paint(theme, "error", "⚠ interrupted — stale handle · fresh session_start resumes")}${heldSuffix}`;
    }
    // v0.24.7: list policy gets its own wording — a queue item is not a goal.
    // v0.28.11 (U10): goal policy joins it — "list 29" read as a command
    // fragment; "29 queued" says what the number IS. Both policies now
    // render "… · N queued".
    const n = state.list?.length ?? 0;
    const queue = n === 0 ? "" : ` · ${n} queued`;
    const tasks = g.taskList ? ` ${countDone(g)}/${countTotal(g)} tasks ·` : "";
    // v0.34.1: no policy word here either — "glla: list ●" duplicated the
    // widget's "list item" chip (field screenshot 2026-08-01). The queue
    // suffix still hints list context when the widget is scrolled away.
    return `glla: ${paint(theme, "success", "●")}${tasks} ${fmtElapsed(now - Date.parse(g.createdAt))}${queue}${heldSuffix}`;
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
  if (inner && isPersistenceDegraded()) {
    const err = lastPersistenceFailure();
    return [paint(theme, "error", `⚠ persistence degraded — .pi-glla writes failing (${truncate(err?.error ?? "disk error", 40)}); state in RAM`), ...inner];
  }
  return inner;
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
  const icon =
    interrupted
      ? paint(theme, "error", "⚠")
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
  const objBudget = width && width > 0 ? Math.max(16, width - 1 - 2 - 3 - visibleLen(segsText)) : 48;
  const head = `${icon} ${truncate(g.objective.replace(/\s+/g, " "), objBudget)} ${paint(theme, "dim", "·")} ${segsText}`;
  const lines = [head];
  if (interrupted) {
    const resumeCmd = isList ? "/list resume" : "/goal resume";
    lines.push(`├─ ${paint(theme, "error", "host session lost — waiting for fresh session_start")}`);
    lines.push(`└─ ${paint(theme, "warning", `/reload to rebind · ${resumeCmd} if it does not resume`)}`);
    return lines;
  }
  if (g.status === "auditing") {
    if (auditRecoveryPending(g)) {
      lines.push(`├─ auditor: ${paint(theme, "warning", "recovery pending — previous audit was interrupted")}`);
      lines.push(`└─ ${paint(theme, "dim", "stored completion claim is safe; a fresh session will retry it")}`);
      return lines;
    }
    lines.push(`├─ auditor: ${audit?.label === "queued" ? "queued" : audit?.label ?? "running"}${audit?.currentTool ? ` · ${truncate(audit.currentTool, 30)}` : ""}`);
    // v0.25.4: auditor-quiet stall — progress events stopped arriving
    // while the audit is in flight (hung model call, stuck tool).
    const quietMs = audit?.lastEventAt !== undefined ? now - audit.lastEventAt : 0;
    if (quietMs > 3 * 60_000) {
      lines.push(`└─ ${paint(theme, "warning", `auditor quiet ${fmtElapsed(quietMs)} — may be stuck; /goal cancel discards the claim`)}`);
    } else if (audit?.elapsedMs) lines.push(`└─ ${paint(theme, "dim", `${fmtElapsed(audit.elapsedMs)} in detached worker`)}`);
    else lines.push(`└─ ${paint(theme, "dim", "detached worker, read-only tools")}`);
    return lines;
  }
  if (g.status === "paused" && g.pauseReason) {
    const kind = pauseKind(g);
    const isErr = kind === "error";
    const budget = budgetFor(width, 3, 60);
    // v0.28.22: actionability banner — a decision pause, an operational
    // failure, and a time-gated wait must not look alike (user report:
    // "if something actionable is going on it can be hard to tell").
    if (kind === "decision") lines.push(`├─ ${paint(theme, "accent", "decision needed — your call unblocks this")}`);
    else if (kind === "error") lines.push(`├─ ${paint(theme, "error", "action needed — this won't fix itself")}`);
    else if (kind === "wait") lines.push(`├─ ${paint(theme, "dim", "waiting — nothing for you to do")}`);
    // v0.27.1: wrap reason + suggested action (see wrap()). v0.28.22:
    // decision/wait reasons cap at 2 lines — the options/countdown below
    // carry the actionable content; error reasons keep 3.
    const reasonPaint = isErr ? "error" : kind === "wait" ? "dim" : "warning";
    wrap(g.pauseReason, budget, kind === "decision" || kind === "wait" ? 2 : 3).forEach((w, i) => {
      lines.push(`${i === 0 ? "├─" : "│ "} ${paint(theme, reasonPaint, w)}`);
    });
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
    if (kind === "wait" && g.pauseResumeAt) {
      const ms = Date.parse(g.pauseResumeAt) - now;
      const when = Number.isNaN(ms) ? g.pauseResumeAt : ms <= 0 ? "now" : `${shortClock(g.pauseResumeAt)} (in ${fmtElapsed(ms)})`;
      lines.push(`├─ ${paint(theme, "dim", `resumes ${when} — or /goal resume now`)}`);
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
  const targetBudget = width && width > 0 ? Math.max(16, width - 1 - 2 - 3 - visibleLen(segsText) - visibleLen(stallNote)) : 44;
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
