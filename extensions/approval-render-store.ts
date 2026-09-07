import * as fs from "node:fs";
import * as path from "node:path";
import { appendLedger, ensureDirs, nowIso, piGlaDir, runPersistStep } from "./goal-loop-core.js";

/**
 * Persisted terminal-approval renders (v0.38.25, post-objective summary).
 *
 * Field failure 2026-09-07: goal `20260907131550-12ddoy` completed with a
 * perfect six-label archive record, but the approval chat lines fired into a
 * dead context (auditor verdict landed with no live turn) — record perfect,
 * delivery silent. The archive keeps facts; this sidecar keeps the RENDER.
 *
 * Contract: every terminal approval persists its human-sees lines here at
 * archive time. Renders persisted from a live turn are marked delivered at
 * once; renders persisted while the host is idle (`ctx.isIdle()`) stay
 * undelivered until `replayUndeliveredApprovalRenders` delivers them on the
 * next live contact (any user-invoked /goal /glla /review /list /loop
 * command) and marks them delivered. Late verdicts follow the same path:
 * persist first, deliver-or-replay — never silent.
 */

export interface PendingApprovalRender {
  goalId: string;
  objective: string;
  chatLines: string[];
  createdAt: string;
  deliveredAt?: string;
}

/** Cap: the sidecar is a spillway, not a log. Delivered renders are kept
 * briefly for inspection; undelivered ones are never dropped by the cap. */
const MAX_STORED_RENDERS = 20;
const MAX_REPLAY_PER_CONTACT = 5;

export function approvalRenderStorePath(cwd: string): string {
  return path.join(piGlaDir(cwd), "pending-approval-renders.json");
}

function isValidRender(entry: unknown): entry is PendingApprovalRender {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return typeof e.goalId === "string" && e.goalId.length > 0
    && typeof e.objective === "string"
    && Array.isArray(e.chatLines)
    && e.chatLines.every((line) => typeof line === "string")
    && typeof e.createdAt === "string"
    && (e.deliveredAt === undefined || typeof e.deliveredAt === "string");
}

function readRenders(cwd: string): PendingApprovalRender[] | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(approvalRenderStorePath(cwd), "utf-8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    const valid = parsed.filter(isValidRender);
    if (valid.length !== parsed.length) {
      appendLedger(cwd, "terminal_approval_render_store_invalid", {
        dropped: parsed.length - valid.length,
        kept: valid.length,
      });
    }
    return valid;
  } catch {
    appendLedger(cwd, "terminal_approval_render_store_invalid", { dropped: "all", kept: 0 });
    return [];
  }
}

function writeRenders(cwd: string, renders: PendingApprovalRender[]): boolean {
  const landed = runPersistStep("persistApprovalRender", () => {
    ensureDirs(cwd);
    fs.writeFileSync(approvalRenderStorePath(cwd), JSON.stringify(renders, null, 2), "utf-8");
    return true;
  });
  return landed === true;
}

/** Persist the rendered human-sees lines at archive time. `delivered`
 * must be true only when the render went out on a provably live turn
 * (callers pass `!ctx.isIdle()`); idle-persisted renders stay queued for
 * replay. Never throws into orchestrator handlers. */
export function persistApprovalRender(cwd: string, render: {
  goalId: string;
  objective: string;
  chatLines: string[];
  delivered: boolean;
}): boolean {
  const at = nowIso();
  const existing = readRenders(cwd) ?? [];
  const entry: PendingApprovalRender = {
    goalId: render.goalId,
    objective: render.objective.slice(0, 300),
    chatLines: render.chatLines,
    createdAt: at,
    ...(render.delivered ? { deliveredAt: at } : {}),
  };
  const undelivered = existing.filter((e) => !e.deliveredAt);
  const delivered = [...existing.filter((e) => e.deliveredAt), ...(render.delivered ? [entry] : [])]
    .slice(-(MAX_STORED_RENDERS - undelivered.length - (render.delivered ? 0 : 1)));
  const next = [...undelivered, ...(render.delivered ? [] : [entry]), ...delivered];
  if (!writeRenders(cwd, next.slice(-MAX_STORED_RENDERS))) return false;
  appendLedger(cwd, "terminal_approval_render_persisted", {
    goalId: render.goalId,
    delivered: render.delivered,
    lines: render.chatLines.length,
  });
  return true;
}

/** Deliver every undelivered render on a live contact, oldest first,
 * fire-once fenced via deliveredAt. Callers are user-invoked command
 * handlers — live by construction. Returns the replayed count; never
 * throws. */
export function replayUndeliveredApprovalRenders(ctx: { cwd: string; ui: { notify: (message: string, type?: "info" | "warning" | "error") => void } }): number {
  const renders = readRenders(ctx.cwd);
  if (!renders || renders.length === 0) return 0;
  const pending = renders.filter((e) => !e.deliveredAt).slice(0, MAX_REPLAY_PER_CONTACT);
  if (pending.length === 0) return 0;
  const at = nowIso();
  let replayed = 0;
  for (const entry of pending) {
    try {
      ctx.ui.notify(entry.chatLines.join("\n"), "info");
      entry.deliveredAt = at;
      replayed += 1;
      appendLedger(ctx.cwd, "terminal_approval_render_replayed", {
        goalId: entry.goalId,
        createdAt: entry.createdAt,
      });
    } catch {
      // Leave undelivered for the next live contact; never break the
      // command that triggered the replay.
      break;
    }
  }
  if (replayed > 0) writeRenders(ctx.cwd, renders);
  return replayed;
}

/** Liveness probe for delivery marking. Unknown/throwing ⇒ idle ⇒
 * undelivered ⇒ replayed on the next live contact. The safe direction is
 * never-silent: a duplicate render on the next command beats a lost one. */
export function isApprovalContextIdle(ctx: { isIdle?: () => boolean }): boolean {
  try {
    return ctx.isIdle?.() ?? true;
  } catch {
    return true;
  }
}

/** Test-only reset for store isolation. */
export function __testOnlyResetApprovalRenderStore(): void {
  // No module-level cache — isolation is via cwd-scoped files.
}
