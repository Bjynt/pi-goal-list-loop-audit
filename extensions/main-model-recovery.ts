// pi-goal-list-loop-audit — main-session model recovery helpers.
//
// These helpers deliberately contain no pi runtime calls. The orchestration
// layer owns model switching and durable state; this module only normalizes
// configured candidates, classifies provider failures, and computes a
// bounded-but-persistent retry cadence.

import { isBillingError, isQuotaError, parseQuotaError, type QuotaSignal } from "./quota-retry.js";

export const MAIN_MODEL_MAX_RETRY_DELAY_MS = 5 * 60 * 60_000;
export const MAIN_MODEL_AUTO_RETRY_HORIZON_MS = 24 * 60 * 60_000;

export type MainModelFailureKind = "quota" | "billing" | "auth" | "transient" | "unknown" | "non-recoverable" | "context-overflow";

export interface MainModelFailure {
  kind: MainModelFailureKind;
  raw: string;
  retryAfterSec?: number;
  retryFromUpstream?: boolean;
  resetAt?: string;
  /** More specific quota family; plan walls must not be treated as generic 429s. */
  quotaSignal?: QuotaSignal;
}

/** Return a canonical provider/model reference for a pi model-like object. */
export function modelRef(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const m = model as { provider?: unknown; id?: unknown };
  return typeof m.provider === "string" && typeof m.id === "string" && m.provider && m.id
    ? `${m.provider}/${m.id}`
    : undefined;
}

/** Split at the first slash: model ids such as openrouter/a/b remain intact. */
export function splitModelRef(ref: string): { provider: string; id: string } | undefined {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

/** Normalize an ordered list from JSON settings or a comma/semicolon string. */
export function normalizeModelRefs(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,;]+/)
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const ref = item.trim().replace(/^['"]|['"]$/g, "");
    if (!ref || ref.toLowerCase() === "unset" || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

/**
 * Classify only provider failures. Context/output-token failures are
 * deterministic prompt-shape problems and must not trigger model rotation.
 *
 * v0.34.116: an override context — `isContextOverflow(raw)` — lets the
 * recovery caller (goal-recovery.ts::tryMainModelFallback / the
 * observeCompactFailure hook) distinguish a "the model is too small for the
 * prompt" failure from "the prompt is too big for any model". The override
 * is the dominant signal: when pi just told us the session_compact ALSO
 * failed and the prompt is STILL over the model's window, the prompt is
 * not the problem — the model is. Route through the fallback chain to a
 * larger-context ref. Without the override the classifier falls back to
 * the deterministic "non-recoverable" verb (a sample of a length cap
 * mid-stream MUST NOT silently rotate when the chain has no ref).
 */
export function classifyMainModelFailure(error: string | undefined, opts?: { isContextOverflow?: boolean }): MainModelFailure {
  const raw = typeof error === "string" ? error.trim() : "";
  const text = raw.toLowerCase();
  if (!raw) return { kind: "unknown", raw };
  if (/aborted|cancelled|canceled|user interrupt/.test(text)) {
    return { kind: "non-recoverable", raw };
  }
  if (/context|output[ -]?token|max_?tokens|length limit|too many tokens|prompt too large|context window/.test(text)) {
    return opts?.isContextOverflow
      ? { kind: "context-overflow", raw }
      : { kind: "non-recoverable", raw };
  }
  // Billing/credit exhaustion is not evidence of a future reset. It may be
  // solved by a configured backup, but with no backup it needs user action.
  if (isBillingError(raw)) return { kind: "billing", raw };
  // Quota/rate-limit errors are the important long-lived case. Preserve the
  // provider's hint when it exists; the orchestration layer caps the automatic
  // wait and the total recovery horizon.
  if (isQuotaError(raw)) {
    const parsed = parseQuotaError(raw);
    return {
      kind: "quota",
      raw,
      retryAfterSec: parsed.retryAfterSec,
      retryFromUpstream: parsed.fromUpstream,
      resetAt: parsed.resetAt,
      quotaSignal: parsed.signal,
    };
  }
  if (/401|403|unauthori[sz]ed|forbidden|invalid (?:api|access) key|authentication|no api key|credential/.test(text)) {
    return { kind: "auth", raw };
  }
  if (/5\d\d|overload|temporarily unavailable|service unavailable|timeout|timed? ?out|network|fetch failed|socket|econn|gateway|upstream|internal server/.test(text)) {
    return { kind: "transient", raw };
  }
  return { kind: "unknown", raw };
}

/** v0.34.116: detect when a length-context failure happened AFTER the
 * session_compact already failed. The classifier maps this to
 * `context-overflow` (rollback path: rotate to a larger-context ref). The
 * call site is `observeCompactFailure` in goal-recovery.ts: when the next
 * send throws a stale-ctx / "This extension ctx is stale" error AFTER our
 * best-effort compact-and-retry, the prompt is not the problem — the
 * current chosen model cannot serve it. The orchestrator wraps the failure
 * with `isContextOverflow: true` so the selector walks the chain. */
export function isContextOverflowError(error: string | undefined): boolean {
  if (!error) return false;
  const text = error.toLowerCase();
  return /context|output[ -]?token|max_?tokens|length limit|too many tokens|prompt too large|context window/.test(text);
}

/** v0.34.57: long-lived failure classes (quota/billing/auth) are durable
 * knowledge for a window: a send-wedge that follows one of them within the
 * window is almost certainly the same wall, so recovery engages in minutes
 * instead of the generic 15m storm threshold. Transient (5xx/timeout/stream)
 * failures are short-lived by definition and never record this signal. */
export const LONG_LIVED_FAILURE_KNOWLEDGE_MS = 30 * 60_000;
export const SEND_REARM_QUOTA_ESCALATE_MS = 3 * 60_000;
export const SEND_REARM_GENERIC_ESCALATE_MS = 15 * 60_000;

export function isLongLivedFailureKind(kind: MainModelFailureKind): boolean {
  return kind === "quota" || kind === "billing" || kind === "auth";
}

/** Storm-escalation threshold: fast (3m) inside a fresh long-lived-failure
 * knowledge window, generic (15m) otherwise. Pure — the orchestrator owns
 * the timestamp state. */
export function sendStormEscalateMs(lastLongLivedFailureAtMs: number, nowMs = Date.now()): number {
  return Number.isFinite(lastLongLivedFailureAtMs) && lastLongLivedFailureAtMs > 0
    && nowMs - lastLongLivedFailureAtMs < LONG_LIVED_FAILURE_KNOWLEDGE_MS
    ? SEND_REARM_QUOTA_ESCALATE_MS
    : SEND_REARM_GENERIC_ESCALATE_MS;
}

/** Return the next configured candidate that has not been attempted. */
export function nextUntriedModelRef(current: string | undefined, refs: string[], attempted: string[] = []): string | undefined {
  const tried = new Set(attempted);
  return refs.find((ref) => ref !== current && !tried.has(ref));
}

/**
 * Retry slowly rather than spin: 15m → 30m → 1h → 2h → 4h → 5h, then hold
 * after the 24h automatic window. v0.34.63: the failure-driven envelope is
 * hour-aligned (hourAlignedRetryDelayMs); this ladder survives as the
 * bounded fallback for the pathological no-model-ref probe path, and as the
 * knob for the mainModelRetryMinutes setting.
 */
export function mainModelRetryDelayMs(attempt: number, baseMinutes = 15): number {
  const base = Number.isFinite(baseMinutes) && baseMinutes > 0 ? baseMinutes : 15;
  const minutes = Math.min(base * 2 ** Math.max(0, attempt - 1), MAIN_MODEL_MAX_RETRY_DELAY_MS / 60_000);
  return Math.round(minutes * 60_000);
}

/** Return the durable end of one automatic recovery window. Manual resume
 * starts a fresh window; a week-long provider cap therefore cannot cause a
 * week of unattended probes. */
export function mainModelAutoRetryUntil(firstFailureAtMs = Date.now(), horizonMs = MAIN_MODEL_AUTO_RETRY_HORIZON_MS): string {
  const first = Number.isFinite(firstFailureAtMs) ? firstFailureAtMs : Date.now();
  const horizon = Number.isFinite(horizonMs) && horizonMs > 0 ? horizonMs : MAIN_MODEL_AUTO_RETRY_HORIZON_MS;
  return new Date(first + horizon).toISOString();
}

/**
 * v0.34.63: probe delays align to the next :00 of the LOCAL clock hour —
 * provider quota windows tend to reset on the hour, so a mid-hour probe is
 * a wasted attempt (field: 01:18 wall probed at 01:33 / 02:03 / 02:33 and
 * never once hit a fresh window). The ladder's job — bounded, slow probing
 * — is preserved: one probe per hour, still inside the 24h automatic
 * window and the 5h per-delay cap. Upstream Retry-After hints remain
 * factual facts and outrank the alignment (a per-minute RPM throttle says
 * so itself).
 */
export function hourAlignedRetryDelayMs(nowMs = Date.now()): number {
  const next = new Date(nowMs);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return Math.max(1_000, next.getTime() - nowMs);
}

/** v0.34.51: one uniform envelope for EVERY provider failure. Error text is
 * not trusted to pick a cadence — the only exception is the upstream
 * Retry-After hint, a factual provider fact, honored when it fits the
 * five-hour probe budget. Classification now serves display and the
 * no-retry class (context-length/aborted) only: billing, auth, transient,
 * and unknown all retry on the same bounded cadence, because a
 * miss-classified quota wall is the common case and "keep retrying" beats
 * confident stopping.
 * v0.34.63: the bounded cadence is the next :00 clock hour (see
 * hourAlignedRetryDelayMs) — kind-independent, hint-overridable, and never
 * farther out than one hour per probe. */
export function mainModelFailureDelayMs(failure: MainModelFailure, attempt: number, baseMinutes = 15, nowMs = Date.now()): number {
  if (failure.retryFromUpstream && Number.isFinite(failure.retryAfterSec)) {
    const hinted = Math.max(1_000, Math.round(failure.retryAfterSec! * 1_000));
    if (hinted <= MAIN_MODEL_MAX_RETRY_DELAY_MS) return hinted;
  }
  void attempt;
  void baseMinutes;
  return hourAlignedRetryDelayMs(nowMs);
}
