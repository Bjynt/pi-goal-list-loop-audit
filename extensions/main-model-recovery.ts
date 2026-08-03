// pi-goal-list-loop-audit — main-session model recovery helpers.
//
// These helpers deliberately contain no pi runtime calls. The orchestration
// layer owns model switching and durable state; this module only normalizes
// configured candidates, classifies provider failures, and computes a
// bounded-but-persistent retry cadence.

import { isQuotaError } from "./quota-retry.js";

export type MainModelFailureKind = "quota" | "auth" | "transient" | "unknown" | "non-recoverable";

export interface MainModelFailure {
  kind: MainModelFailureKind;
  raw: string;
  retryAfterSec?: number;
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
  // Quota/rate-limit errors are the important long-lived case. The runtime
  // supplies the exact retry window when it can; the caller owns the timer.
  if (isQuotaError(raw)) return { kind: "quota", raw };
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
 * Retry slowly rather than spin: 15m → 30m → 60m, then hourly forever.
 * A quota that returns two hours later is therefore observed without a
 * manual resume, while a dead provider is not hammered every few seconds.
 */
export function mainModelRetryDelayMs(attempt: number, baseMinutes = 15): number {
  const base = Number.isFinite(baseMinutes) && baseMinutes > 0 ? baseMinutes : 15;
  const minutes = Math.min(base * 2 ** Math.max(0, attempt - 1), 60);
  return Math.round(minutes * 60_000);
}
