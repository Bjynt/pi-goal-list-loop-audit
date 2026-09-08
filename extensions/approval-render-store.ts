import * as fs from "node:fs";
import * as path from "node:path";
import { appendLedger, ensureDirs, nowIso, piGlaDir, runPersistStep } from "./goal-loop-core.js";

/** Durable terminal-summary outbox. A toast or a live host is not delivery:
 * only a confirmed visible session message acknowledges a render. */

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
// v0.38.30 audit: bound the sidecar behind the "each is ~1KB" comment — a
// long approval trailer used to grow the 20-entry file without bound.
const MAX_RENDER_CHAT_LINES = 60;
const MAX_RENDER_LINE_CHARS = 1000;

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

function readRenders(cwd: string): PendingApprovalRender[] {
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
      // v0.38.30 audit: repair the file after ledgering once — otherwise
      // every user command re-appended the same ledger while the file
      // stayed corrupt. Best-effort; a failed rewrite simply ledgers again.
      writeRenders(cwd, valid);
    }
    return valid;
  } catch {
    appendLedger(cwd, "terminal_approval_render_store_invalid", { dropped: "all", kept: 0 });
    writeRenders(cwd, []);
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

/** Persist before attempting delivery. `delivered` is retained for old callers;
 * production callers always enqueue false and acknowledge through replay. */
export function persistApprovalRender(cwd: string, render: {
  goalId: string;
  objective: string;
  chatLines: string[];
  delivered: boolean;
}): boolean {
  const at = nowIso();
  const existing = readRenders(cwd);
  if (existing.some((entry) => entry.goalId === render.goalId)) return true;
  const entry: PendingApprovalRender = {
    goalId: render.goalId,
    // v0.38.30 audit: code-point truncation (char slice split surrogate
    // pairs) + bounded chat lines (the 20-entry cap never bound bytes).
    objective: [...render.objective].slice(0, 300).join(""),
    chatLines: render.chatLines.slice(0, MAX_RENDER_CHAT_LINES).map((line) => [...line].slice(0, MAX_RENDER_LINE_CHARS).join("")),
    createdAt: at,
    ...(render.delivered ? { deliveredAt: at } : {}),
  };
  // The cap trims DELIVERED history only: undelivered renders are never
  // dropped (each is ~1KB and any user command replays them, so the
  // undelivered tail is self-draining in practice).
  const undelivered = existing.filter((e) => !e.deliveredAt);
  const delivered = [...existing.filter((e) => e.deliveredAt), ...(render.delivered ? [entry] : [])];
  const deliveredBudget = Math.max(0, MAX_STORED_RENDERS - undelivered.length - (render.delivered ? 0 : 1));
  const next = [...undelivered, ...(render.delivered ? [] : [entry]), ...(deliveredBudget > 0 ? delivered.slice(-deliveredBudget) : [])];
  if (!writeRenders(cwd, next)) return false;
  appendLedger(cwd, "terminal_approval_render_persisted", {
    goalId: render.goalId,
    delivered: render.delivered,
    lines: render.chatLines.length,
  });
  return true;
}

/** Replay oldest first through the ownership-fenced sender. A queued, refused,
 * or unconfirmed send stays pending. Session identity deduplicates retries
 * even when writing deliveredAt fails after the message landed. */
export function replayUndeliveredApprovalRenders(
  ctx: { cwd: string },
  deliver: (entry: PendingApprovalRender) => boolean = () => false,
): number {
  const renders = readRenders(ctx.cwd);
  if (renders.length === 0) return 0;
  const pending = renders.filter((e) => !e.deliveredAt).slice(0, MAX_REPLAY_PER_CONTACT);
  if (pending.length === 0) return 0;
  const at = nowIso();
  let replayed = 0;
  for (const entry of pending) {
    try {
      if (!deliver(entry)) break;
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
