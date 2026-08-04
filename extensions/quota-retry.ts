// pi-goal-list-loop-audit — quota-aware recovery policy.
//
// Provider errors are messy: some expose HTTP 429, some return a JSON plan
// limit, some use a reset timestamp, and some only say "try again later".
// Keep recognition conservative and keep automatic probes bounded. A quota
// wall is a recovery signal, not permission to hammer a provider forever.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type QuotaSignal = "rate-limit" | "plan-quota" | "billing";

/** Never let an automatic quota probe schedule farther than five hours out. */
export const MAX_AUTOMATIC_QUOTA_RETRY_SEC = 5 * 60 * 60;
/** The default no-hint window remains one hour for compatibility/settings. */
export const DEFAULT_QUOTA_RETRY_SEC = 60 * 60;

export interface QuotaError {
  raw: string;
  /** Seconds until retry, from the upstream hint or the default. */
  retryAfterSec: number;
  /** True when retryAfterSec came from the upstream (header, JSON, prose, or reset timestamp). */
  fromUpstream: boolean;
  /** Absolute reset time when the provider supplied one. */
  resetAt?: string;
  /** The reason family used for user-facing classification. */
  signal?: QuotaSignal;
}

// Do not classify every "temporarily" or every 403 as a quota wall. Those
// patterns include ordinary outages and auth failures. These signals are
// deliberately explicit enough to survive provider wording changes without
// turning an arbitrary transient error into a week-long retry loop.
const RATE_LIMIT = /\b429\b|too many requests|rate[\s_-]*limit|throttl(?:e|ed|ing)|requests?\s+per\s+(?:second|minute)|\b(?:rpm|tpm)\b/i;
const PLAN_QUOTA = /(?:quota|usage[\s_-]*limit|token[\s_-]*plan|plan[\s_-]*limit|monthly\s+limit|daily\s+limit|weekly\s+limit|key\s+limit\s+exceeded|limit\s+(?:reached|exceeded|exhausted|depleted)).{0,80}(?:quota|usage|token|plan|limit|reached|exceeded|exhausted|depleted)?/i;
const PLAN_QUOTA_REVERSE = /(?:quota|usage|token[\s_-]*plan|plan|monthly|daily|weekly|key).{0,80}(?:limit\s+(?:reached|exceeded|exhausted|depleted)|exhausted|depleted)/i;
const BILLING = /insufficient\s+(?:credits?|balance|quota)|(?:credits?|balance)\s+(?:exhausted|depleted|used\s+up)|billing\s+(?:required|issue|failure)|payment\s+required|buy\s+credits?/i;

/** Return the strongest explicit provider signal, or undefined for an
 * ambiguous/transient message. Specific account/plan walls must win over a
 * generic 429/rate-limit match: MiniMax 2062, for example, says both
 * "Token Plan rate limit" and "rate limit", but asks the user to upgrade or
 * switch billing rather than retry a per-minute throttle. */
export function quotaSignal(error: string | undefined): QuotaSignal | undefined {
  if (!error) return undefined;
  if (BILLING.test(error)) return "billing";
  if (PLAN_QUOTA.test(error) || PLAN_QUOTA_REVERSE.test(error)) return "plan-quota";
  if (RATE_LIMIT.test(error)) return "rate-limit";
  return undefined;
}

export function isBillingError(error: string | undefined): boolean {
  return quotaSignal(error) === "billing";
}

/** Match recoverable provider rate/plan walls and explicit billing walls.
 * Ambiguous `temporarily unavailable`, ordinary 403s, and generic network
 * failures intentionally return false. */
export function isQuotaError(error: string | undefined): boolean {
  return quotaSignal(error) !== undefined;
}

function numericHint(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function absoluteReset(value: string | undefined, nowMs: number): { retryAfterSec: number; resetAt: string } | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value.trim());
  if (!Number.isFinite(ms)) return undefined;
  const retryAfterSec = Math.max(0, Math.ceil((ms - nowMs) / 1000));
  return { retryAfterSec, resetAt: new Date(ms).toISOString() };
}

/** Parse the retry window out of provider text/JSON. Understands:
 *  - `Retry-After: 5` and HTTP-date headers
 *  - JSON `retry_after`, `retryAfter`, `reset_at`, `resetAt`
 *  - `retry after 30 seconds`, `retry in 2h`, `retry in 1 week`
 *  - default 3600s when no hint (the historical contract). */
export function parseQuotaError(error: string, defaultRetryAfterSec = DEFAULT_QUOTA_RETRY_SEC, nowMs = Date.now()): QuotaError {
  const signal = quotaSignal(error);
  const fallback = Number.isFinite(defaultRetryAfterSec) && defaultRetryAfterSec >= 0
    ? Math.round(defaultRetryAfterSec)
    : DEFAULT_QUOTA_RETRY_SEC;

  let m = error.match(/retry-after:\s*(\d+(?:\.\d+)?)/i);
  const numeric = numericHint(m?.[1]);
  if (numeric !== undefined) return { raw: error, retryAfterSec: Math.round(numeric), fromUpstream: true, signal };

  // RFC 7231 Retry-After date. Keep this separate from the numeric match so
  // a comma in the HTTP date cannot consume the next line of the error.
  m = error.match(/retry-after:\s*([^\r\n]+)/i);
  const headerDate = absoluteReset(m?.[1], nowMs);
  if (headerDate) return { raw: error, ...headerDate, fromUpstream: true, signal };

  // Providers often serialize one of these fields inside a larger wrapper.
  m = error.match(/["'](?:retry_after|retryAfter|retry_after_seconds|reset_after|resetAfter)["']\s*:\s*(\d+(?:\.\d+)?)/i);
  const jsonSeconds = numericHint(m?.[1]);
  if (jsonSeconds !== undefined) return { raw: error, retryAfterSec: Math.round(jsonSeconds), fromUpstream: true, signal };

  m = error.match(/["'](?:reset_at|resetAt|resets_at|quota_reset_at)["']\s*:\s*["']([^"']+)["']/i);
  const jsonDate = absoluteReset(m?.[1], nowMs);
  if (jsonDate) return { raw: error, ...jsonDate, fromUpstream: true, signal };

  m = error.match(/retry\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours?|d|day|days|w|week|weeks?)/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    const mult = unit.startsWith("w") ? 7 * 24 * 3600
      : unit.startsWith("d") ? 24 * 3600
        : unit.startsWith("h") ? 3600
          : unit.startsWith("m") ? 60
            : 1;
    if (Number.isFinite(n) && n >= 0) return { raw: error, retryAfterSec: Math.round(n * mult), fromUpstream: true, signal };
  }

  m = error.match(/(?:reset|resets|available)\s+(?:at|on)\s+([0-9]{4}-[0-9]{2}-[0-9]{2}[^,;\n)]*)/i);
  const proseDate = absoluteReset(m?.[1], nowMs);
  if (proseDate) return { raw: error, ...proseDate, fromUpstream: true, signal };

  return { raw: error, retryAfterSec: fallback, fromUpstream: false, signal };
}

/** Clamp one automatic probe. A provider may claim a one-week reset; glla
 * will not hide a week-long timer or wake up blindly after it. Callers can
 * preserve the raw/reset hint and require an explicit resume instead. */
export function capQuotaRetrySeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_QUOTA_RETRY_SEC;
  return Math.min(Math.max(1, Math.round(seconds)), MAX_AUTOMATIC_QUOTA_RETRY_SEC);
}

/** Exponential automatic probe cadence, capped at five hours. */
export function quotaRetryDelaySeconds(attempt: number, baseMinutes = 60): number {
  const base = Number.isFinite(baseMinutes) && baseMinutes > 0 ? baseMinutes * 60 : DEFAULT_QUOTA_RETRY_SEC;
  return capQuotaRetrySeconds(base * 2 ** Math.max(0, attempt - 1));
}

let quotaRetryTimer: NodeJS.Timeout | null = null;

/** Test hook — is a quota retry currently scheduled? */
export function isQuotaRetryPending(): boolean {
  return quotaRetryTimer !== null;
}

/** Cancel any pending quota retry (e.g. the user resumed manually). */
export function cancelQuotaRetry(): void {
  if (quotaRetryTimer) {
    clearTimeout(quotaRetryTimer);
    quotaRetryTimer = null;
  }
}

/** Schedule a one-shot auto-resume after a bounded quota window. The fire
 * callback re-checks the goal is STILL paused for the quota reason before
 * resuming (contract item 10/12 — a user /goal pause during the window must
 * not be stomped). */
export function scheduleQuotaRetry(
  ctx: ExtensionContext,
  retryAfterSec: number,
  reason: string,
  fire: () => void,
  label = "Auditor quota exhausted — auto-retry",
): void {
  cancelQuotaRetry();
  const requestedSec = Number.isFinite(retryAfterSec) && retryAfterSec >= 0 ? Math.round(retryAfterSec) : DEFAULT_QUOTA_RETRY_SEC;
  const safeSec = capQuotaRetrySeconds(requestedSec);
  const capped = safeSec !== requestedSec;
  const ms = Math.max(1_000, safeSec * 1_000);
  quotaRetryTimer = setTimeout(() => {
    quotaRetryTimer = null;
    try {
      fire();
    } catch {
      /* session may be gone; session_start will re-evaluate */
    }
  }, ms);
  quotaRetryTimer.unref?.();
  ctx.ui.notify(
    `${label} in ${Math.round(safeSec / 60)}m${capped ? ` (provider requested ${Math.round(requestedSec / 3600)}h; automatic probes cap at 5h)` : ""} (${reason.slice(0, 80)}). /goal resume retries now.`,
    "info",
  );
}

/** v0.25.6: detect a SUBAGENT quota failure in a tool_result — the
 * pi-subagents#175 shape (Explore's upstream haiku pin 403s on shared
 * keys). Tool must be an Agent spawn and the payload a quota error. */
export function isSubagentQuotaResult(toolName: string, isError: boolean, payload: unknown): boolean {
  if (!isError) return false;
  if (toolName !== "Agent" && toolName !== "agent") return false;
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
  return isQuotaError(text);
}
