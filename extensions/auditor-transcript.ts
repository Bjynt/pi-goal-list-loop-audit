// pi-goal-list-loop-audit — v0.38.3
// extensions/auditor-transcript.ts
//
// Goal 20260902085243-uzf6mx: surface the detached auditor's session in the
// main agent TUI so a long-running audit no longer feels like a black box.
// The user accepted the simpler inline path over a separate window/tab, so
// this module renders an expandable block below the existing audit card.
//
// Source of truth:
//   * live: `.pi-glla/audit-jobs/<attemptId>/progress.json` while the worker
//     is still running
//   * terminal: `.pi-glla/audit-jobs/<attemptId>/result.json` once the worker
//     exits (progress.json is also kept on disk for replay).
//
// Launch dirs are named `<attemptId>-<launchTime36>-<rand8>` (one unique
// suffix per launch), so `resolveAuditJobDir` resolves the claim's logical
// attemptId by prefix + newest mtime rather than exact name.
//
// The job dir is reaped `AUDIT_JOB_CLEANUP_MIN_AGE_MS` after the worker
// dies, so a transcript request for a long-reaped attempt is graceful —
// we render a single "transcript reaped" line instead of crashing the
// widget.
//
// No pi imports, no live state — all functions are pure so tests can
// exercise the renderer and the loader with synthesized JSONL without
// spawning a worker.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { truncate } from "./goal-loop-display.js";

/** Where the parent writes per-attempt scratch for a detached audit. */
export function auditJobDir(root: string, attemptId: string): string {
  return join(root, ".pi-glla", "audit-jobs", attemptId);
}

/** v0.38.3: resolve the on-disk job dir for a LOGICAL attempt id.
 *
 * The parent names each launch dir `<logicalAttemptId>-<launchTime36>-<rand8>`
 * (`newDetachedAuditJobAttemptId`), so the claim's stored attemptId never
 * equals the dir name. Try the exact name first (cheap, future-proof), else
 * scan the bounded `audit-jobs/` root for dirs prefixed `<attemptId>-` and
 * pick the most recently modified one (the live/latest launch wins). Returns
 * null when nothing matches (reaped or never ran). */
export function resolveAuditJobDir(cwd: string, attemptId: string): string | null {
  const jobsRoot = join(cwd, ".pi-glla", "audit-jobs");
  const exact = join(jobsRoot, attemptId);
  if (existsSync(exact)) return exact;
  let entries: string[] = [];
  try {
    entries = readdirSync(jobsRoot);
  } catch {
    return null;
  }
  const prefix = `${attemptId}-`;
  let best: { dir: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const dir = join(jobsRoot, name);
    const mtimeMs = dirMtimeMs(dir);
    if (best === null || mtimeMs > best.mtimeMs) best = { dir, mtimeMs };
  }
  return best?.dir ?? null;
}

/** Newest observable mtime inside a job dir — progress.json while live,
 * result.json once terminal, the dir itself as fallback. */
function dirMtimeMs(dir: string): number {
  for (const f of ["progress.json", "result.json"]) {
    try {
      return statSync(join(dir, f)).mtimeMs;
    } catch {
      // try next
    }
  }
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

/** A single observable fact from the worker's session, in the order it was
 * captured on disk. The renderer projects each variant into a TUI line. */
export type TranscriptEvent =
  | { kind: "tool_start"; at: number; name: string; target?: string }
  | { kind: "tool_end"; at: number; name: string; target?: string; ok: boolean }
  | { kind: "stream"; at: number; bytes: number; line: string }
  | { kind: "verdict"; at: number; verdict: "approved" | "disapproved" | "impossible"; line: string }
  | { kind: "terminal"; ok: boolean; error?: string; infrastructureClass?: string };

/** v0.38.3: a worker caps the streamed report at MAX_RECENT_OUTPUT_ITEMS
 * (8) lines × MAX_RECENT_OUTPUT_ITEM_CHARS (240) chars. The transcript is
 * the union of recentOutput lines + finished tool calls; the parser never
 * needs to fold a stream of text deltas since the worker only appends
 * to recentOutput on newline. We bound the rendered section to a fixed
 * cap so the card never grows unbounded across a multi-hour audit. */
export const MAX_TRANSCRIPT_EVENTS = 30;
/** v0.38.3: every text line is truncated to this width for the card. */
const MAX_TRANSCRIPT_LINE_CHARS = 100;
/** v0.38.3: most-recent events go at the BOTTOM (chronological) — audit
 * history reads top-to-bottom, and the latest observation is what the
 * user wants to see. */
const TOOL_TARGET_MAX = 60;

export type LoadResult =
  | { kind: "events"; events: TranscriptEvent[]; model?: string; startedAt: number; terminal?: boolean }
  | { kind: "reaped" }
  | { kind: "not-running" }
  | { kind: "empty" };

interface RawProgressFile {
  protocolVersion?: number;
  attemptId?: string;
  requestHash?: string;
  phase?: string;
  elapsedMs?: number;
  reportBytes?: number;
  lastActivityAt?: number;
  recentOutput?: string[];
  toolCalls?: Array<{ name?: string; argsPrefix?: string; finishedAt?: number; ok?: boolean }>;
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
}

interface RawResultFile {
  protocolVersion?: number;
  attemptId?: string;
  requestHash?: string;
  ok?: boolean;
  output?: string;
  model?: string;
  thinkingLevel?: string;
  toolCalls?: Array<{ name?: string; argsPrefix?: string; finishedAt?: number; ok?: boolean }>;
  error?: string;
  infrastructureClass?: string;
}

/** v0.38.3: read the live + terminal transcript for an attempt. The
 * function is synchronous because the widget already runs on the UI
 * ticker — adding async would mean a second re-paint and a stale reading.
 * Synchronous read of a 1-2 KB JSON file is cheap. */
export function loadAuditorTranscript(cwd: string, attemptId: string | undefined): LoadResult {
  if (!attemptId) return { kind: "not-running" };
  const dir = resolveAuditJobDir(cwd, attemptId);
  if (!dir) return { kind: "reaped" };

  const progressPath = join(dir, "progress.json");
  const resultPath = join(dir, "result.json");

  let progress: RawProgressFile | null = null;
  let result: RawResultFile | null = null;
  try {
    if (existsSync(progressPath)) {
      progress = JSON.parse(readFileSync(progressPath, "utf-8")) as RawProgressFile;
    }
  } catch {
    progress = null;
  }
  try {
    if (existsSync(resultPath)) {
      result = JSON.parse(readFileSync(resultPath, "utf-8")) as RawResultFile;
    }
  } catch {
    result = null;
  }

  if (!progress && !result) return { kind: "empty" };

  const events: TranscriptEvent[] = [];
  const startedAt = Date.now() - (progress?.elapsedMs ?? 0);

  // 1. tool calls (chronological — the worker appends in finish order)
  for (const call of progress?.toolCalls ?? []) {
    if (!call || typeof call.name !== "string") continue;
    const target = safeTarget(call.argsPrefix);
    const at = typeof call.finishedAt === "number" ? call.finishedAt : startedAt;
    events.push({
      kind: "tool_end",
      at,
      name: call.name,
      target,
      ok: call.ok !== false,
    });
  }

  // 2. streamed report lines (already newline-bucketed by the worker)
  for (const line of progress?.recentOutput ?? []) {
    if (typeof line !== "string") continue;
    if (line.length === 0) continue;
    // Each line is appended with a worker-side activity timestamp; the
    // worker does not persist that timestamp per-line, so we anchor the
    // whole block at lastActivityAt. The card does not need per-line
    // timestamps.
    events.push({
      kind: "stream",
      at: progress?.lastActivityAt ?? startedAt,
      bytes: line.length,
      line,
    });
  }

  // 3. terminal verdict (from result.json only)
  if (result) {
    const output = typeof result.output === "string" ? result.output : "";
    const verdict = detectVerdict(output);
    if (verdict) {
      events.push({
        kind: "verdict",
        at: progress?.lastActivityAt ?? startedAt,
        verdict: verdict.kind,
        line: verdict.line,
      });
    }
    events.push({
      kind: "terminal",
      ok: result.ok === true,
      error: typeof result.error === "string" ? result.error : undefined,
      infrastructureClass: typeof result.infrastructureClass === "string" ? result.infrastructureClass : undefined,
    });
  }

  if (events.length === 0) return { kind: "empty" };

  return {
    kind: "events",
    events: events.slice(-MAX_TRANSCRIPT_EVENTS),
    model: result?.model ?? undefined,
    startedAt,
    terminal: !!result,
  };
}

/** v0.38.3: render the loaded events as widget lines (no leading `├─` —
 * the caller prefixes a header). The block is bounded to keep the widget
 * stable across long audits. Lines that are still streaming are stamped
 * with their trimmed text. */
export function renderAuditorTranscriptLines(
  events: TranscriptEvent[],
  opts: { width?: number; phaseLabel?: string; model?: string; terminal?: boolean } = {},
): string[] {
  const width = Math.max(40, Math.floor(opts.width ?? 80) - 6);
  const out: string[] = [];
  const stamp = (() => {
    if (opts.terminal) return "✓ done";
    if (opts.phaseLabel) return `· ${truncate(opts.phaseLabel, 30)}`;
    return "· live";
  })();
  const headModel = opts.model ? ` · ${opts.model}` : "";
  out.push(`transcript: ${events.length} events ${stamp}${headModel}`);

  const slice = events.slice(-MAX_TRANSCRIPT_EVENTS);
  for (const ev of slice) {
    out.push("│ " + renderEvent(ev, width));
  }
  return out;
}

function renderEvent(ev: TranscriptEvent, width: number): string {
  switch (ev.kind) {
    case "tool_start":
      return `▶ ${truncate(ev.name, 20)}${ev.target ? ` → ${truncate(ev.target, TOOL_TARGET_MAX)}` : ""}`;
    case "tool_end":
      return `${ev.ok ? "✓" : "✗"} ${truncate(ev.name, 20)}${ev.target ? ` → ${truncate(ev.target, TOOL_TARGET_MAX)}` : ""}`;
    case "stream":
      return `… ${truncate(ev.line, Math.min(width - 4, MAX_TRANSCRIPT_LINE_CHARS))}`;
    case "verdict":
      return `⟡ ${ev.verdict} · ${truncate(ev.line, width - 18)}`;
    case "terminal":
      if (ev.ok) return `✓ terminal ok`;
      return `✗ terminal — ${truncate(ev.error ?? ev.infrastructureClass ?? "failed", width - 14)}`;
  }
}

function safeTarget(argsPrefix: string | undefined): string | undefined {
  if (typeof argsPrefix !== "string" || argsPrefix.length === 0) return undefined;
  // The worker trims to MAX_TOOL_ARGS_CHARS already, but be defensive
  // for older or hand-written progress.json fixtures.
  return truncate(argsPrefix.replace(/\s+/g, " "), TOOL_TARGET_MAX);
}

function detectVerdict(output: string): { kind: "approved" | "disapproved" | "impossible"; line: string } | undefined {
  // The worker checks the same regex on the joined output and refuses
  // silently-faked verdicts. We mirror that contract here.
  const match = output.match(/<(approved\/|disapproved\/|impossible>)/i);
  if (!match) return undefined;
  const token = match[0].toLowerCase();
  if (token.startsWith("<approved")) return { kind: "approved", line: "<approved/>" };
  if (token.startsWith("<disapproved")) return { kind: "disapproved", line: "<disapproved/>" };
  return { kind: "impossible", line: "<impossible>" };
}

/** v0.38.3: a short, single-line status that the widget can render in
 * the audit card header (e.g. "transcript: 12 events, latest: ...").
 * Used when the toggle is OFF so the user always knows a transcript is
 * available and how to open it. */
export function transcriptHint(loaded: LoadResult): string | undefined {
  if (loaded.kind === "reaped") return "transcript reaped — directory cleaned";
  if (loaded.kind === "not-running") return undefined;
  if (loaded.kind === "empty") return "transcript empty";
  return `transcript: ${loaded.events.length} event${loaded.events.length === 1 ? "" : "s"} — Ctrl+Shift+E`;
}
