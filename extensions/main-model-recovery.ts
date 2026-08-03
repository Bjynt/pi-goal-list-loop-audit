// pi-goal-list-loop-audit — main-session model recovery helpers.
//
// These helpers deliberately contain no pi runtime calls. The orchestration
// layer owns model switching and durable state; this module only normalizes
// configured candidates, classifies provider failures, and computes a
// bounded-but-persistent retry cadence.

import { isBillingError, isQuotaError, parseQuotaError } from "./quota-retry.js";

export const MAIN_MODEL_MAX_RETRY_DELAY_MS = 5 * 60 * 60_000;
export const MAIN_MODEL_AUTO_RETRY_HORIZON_MS = 24 * 60 * 60_000;

export type MainModelFailureKind = "quota" | "billing" | "auth" | "transient" | "unknown" | "non-recoverable";

export interface MainModelFailure {
  kind: MainModelFailureKind;
  raw: string;
  retryAfterSec?: number;
  retryFromUpstream?: boolean;
  resetAt?: string;
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
 */
export function classifyMainModelFailure(error: string | undefined): MainModelFailure {
  const raw = typeof error === "string" ? error.trim() : "";
  const text = raw.toLowerCase();
  if (!raw) return { kind: "unknown", raw };
  if (/aborted|cancelled|canceled|user interrupt/.test(text)) {
    return { kind: "non-recoverable", raw };
  }
  if (/context|output[ -]?token|max_?tokens|length limit|too many tokens|prompt too large|context window/.test(text)) {
    return { kind: "non-recoverable", raw };
  }
  // Billing/credit exhaustion is not evidence of a future reset. It may be
  // solved by a configured backup, but with no backup it needs user action.
  if (isBillingError(raw)) return { kind: "billing", raw };
  // Quota/rate-limit errors are the important long-lived case. Preserve the
  // provider's hint when it exists; the orchestration layer caps the automatic
  // wait and the total recovery horizon.
  if (isQuotaError(raw)) {
    const parsed = parseQuotaError(raw);
    return { kind: "quota", raw, retryAfterSec: parsed.retryAfterSec, retryFromUpstream: parsed.fromUpstream, resetAt: parsed.resetAt };
  }
  if (/401|403|unauthori[sz]ed|forbidden|invalid (?:api|access) key|authentication|no api key|credential/.test(text)) {
    return { kind: "auth", raw };
  }
  if (/5\d\d|overload|temporarily unavailable|service unavailable|timeout|timed? ?out|network|fetch failed|socket|econn|gateway|upstream|internal server/.test(text)) {
    return { kind: "transient", raw };
  }
  return { kind: "unknown", raw };
}

/** Return the next configured candidate that has not been attempted. */
export function nextUntriedModelRef(current: string | undefined, refs: string[], attempted: string[] = []): string | undefined {
  const tried = new Set(attempted);
  return refs.find((ref) => ref !== current && !tried.has(ref));
}

/**
 * Retry slowly rather than spin: 15m → 30m → 1h → 2h → 4h → 5h, then hold
 * after the 24h automatic window. A quota that returns within that window is
 * observed without a manual resume, while a week-long cap requires an
 * explicit resume instead of hidden unattended probes.
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

/** Honor an explicit provider hint when it fits the five-hour probe budget;
 * otherwise use glla's bounded exponential cadence. */
export function mainModelFailureDelayMs(failure: MainModelFailure, attempt: number, baseMinutes = 15): number {
  if (failure.kind === "quota" && failure.retryFromUpstream && Number.isFinite(failure.retryAfterSec)) {
    const hinted = Math.max(1_000, Math.round(failure.retryAfterSec! * 1_000));
    if (hinted <= MAIN_MODEL_MAX_RETRY_DELAY_MS) return hinted;
  }
  return mainModelRetryDelayMs(attempt, baseMinutes);
}
