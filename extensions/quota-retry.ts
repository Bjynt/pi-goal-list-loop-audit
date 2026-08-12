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

export type ProviderErrorSurface = "recovery" | "completion" | "main";

/** A provider failure has two deliberately separate projections: `diagnostic`
 * is durable for forensics, while `display` and `action` are safe to put in
 * chat, notifications, cards, or tool results. Never interpolate `diagnostic`
 * into a user-facing string. */
export interface ProviderErrorPresentation {
  diagnostic: string;
  display: string;
  action: string;
  fingerprint: string;
  signal?: QuotaSignal;
  sensitive: boolean;
}

// Provider payloads frequently contain account names, request ids, nested JSON,
// and raw HTTP text. These markers identify text that must not cross a display
// boundary verbatim. Keep the detector broader than quotaSignal: a provider
// may say "Token Plan" or expose a bare HTTP 429 without enough surrounding
// prose for classification.
const PROVIDER_WALL_MARKER = /\b429\b|token[\s_-]*plan|rate[\s_-]*limit|too many requests|usage[\s_-]*limit|quota|insufficient[\s_-]+(?:credits?|balance)|key[\s_-]*limit|retry[\s_-]*after/i;

function providerFingerprintText(error: string): string {
  return error
    .toLowerCase()
    .replace(/retry[\s_-]*(?:after|in)[^\s,;)}\]]+/gi, "retry-hint")
    .replace(/(?:reset|available|renews?)[\s_-]*(?:at|on|in)[^\s,;)}\]]+/gi, "reset-hint")
    .replace(/\brequest[_ ]id[^a-z0-9]+[a-z0-9-]+/gi, "request-id")
    .replace(/\b(?:0x)?[a-f0-9]{8,}\b/gi, "id")
    .replace(/\b\d+(?:\.\d+)?\b/g, "number")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bretry hint\b/g, "")
    .replace(/\brequest id (?:[a-z]+ )?number\b/g, "request-id")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

/** Stable logical identity for per-recovery-episode notice deduplication.
 * Retry-after values, counters, timestamps, and request ids are intentionally
 * removed so the same provider wall does not produce a new notice each time
 * the upstream changes a number. */
export function providerErrorFingerprint(error: string | undefined): string {
  const raw = typeof error === "string" ? error : "";
  return `${quotaSignal(raw) ?? "provider"}:${providerFingerprintText(raw) || "unknown"}`;
}

function providerWallLabel(signal: QuotaSignal | undefined, sensitive: boolean): string {
  if (signal === "billing") return "provider billing/credit wall";
  if (signal === "plan-quota") return "provider account/usage wall";
  if (signal === "rate-limit") return "provider request-rate wall";
  return sensitive ? "provider infrastructure wall" : "provider infrastructure error";
}

/** Convert untrusted provider text into safe action/display copy while
 * retaining a bounded diagnostic projection for durable ledger/archive state. */
export function providerErrorPresentation(error: string | undefined, surface: ProviderErrorSurface = "recovery"): ProviderErrorPresentation {
  const diagnostic = typeof error === "string" ? error.slice(0, 4_000) : "";
  const signal = quotaSignal(diagnostic);
  const sensitive = PROVIDER_WALL_MARKER.test(diagnostic) || signal !== undefined;
  const display = providerWallLabel(signal, sensitive);
  const action = surface === "completion"
    ? "The stored completion claim is safe; fix the provider/model, then resume to retry the auditor."
    : surface === "main"
      ? "Automatic recovery remains bounded; wait for the provider window or switch to a configured backup model."
      : "Automatic recovery remains bounded; wait for the provider window or switch models if needed.";
  return {
    diagnostic,
    display,
    action,
    fingerprint: providerErrorFingerprint(diagnostic),
    ...(signal ? { signal } : {}),
    sensitive,
  };
}

/** Display projection for legacy pause/recovery strings that were persisted
 * before provider diagnostics were separated from user-facing copy. */
export function sanitizeProviderDisplayText(value: string): string {
  const presentation = providerErrorPresentation(value, "recovery");
  if (!presentation.sensitive) return value;
  if (/completion audit timed out/i.test(value)) return "completion audit timed out — no verifier verdict was produced";
  if (/auditor retry/i.test(value)) return `auditor retry — ${presentation.display}`;
  if (/main model recovery.*automatic probes stopped/i.test(value)) {
    const match = value.match(/^main model recovery — automatic probes stopped \(([^)]*)\)/i);
    const why = match?.[1]?.trim() ?? "provider recovery horizon reached";
    const safeWhy = PROVIDER_WALL_MARKER.test(why) ? presentation.display : why;
    return `main model recovery — automatic probes stopped (${safeWhy}) · ${presentation.display}`;
  }
  if (/main model recovery/i.test(value)) {
    const safePrefix = value.match(/^main model recovery — [^(]*/i)?.[0]?.trim();
    return safePrefix ? `${safePrefix} (${presentation.display})` : `main model recovery — ${presentation.display}`;
  }
  if (/consecutive errors|output[ -]?token/i.test(value)) return `provider recovery — ${presentation.display}`;
  return presentation.display;
}

// Do not classify every "temporarily" or every 403 as a quota wall. Those
// patterns include ordinary outages and auth failures. These signals are
// deliberately explicit enough to survive provider wording changes without
// turning an arbitrary transient error into a week-long retry loop.
const RATE_LIMIT = /\b429\b|too many requests|rate[\s_-]*limit|throttl(?:e|ed|ing)|requests?\s+per\s+(?:second|minute)|\b(?:rpm|tpm)\b/i;
const PLAN_QUOTA = /(?:quota|usage[\s_-]*limit|token[\s_-]*plan|plan[\s_-]*limit|monthly\s+limit|daily\s+limit|weekly\s+limit|key\s+limit\s+exceeded|limit\s+(?:reached|exceeded|exhausted|depleted)).{0,80}(?:quota|usage|token|plan|limit|reached|exceeded|exhausted|depleted)?/i;
const PLAN_QUOTA_REVERSE = /(?:quota|usage|token[\s_-]*plan|plan|monthly|daily|weekly|key).{0,80}(?:limit\s+(?:reached|exceeded|exhausted|depleted)|exhausted|depleted)/i;
const BILLING = /insufficient[\s_-]+(?:credits?|balance|quota)|(?:credits?|balance)\s+(?:exhausted|depleted|used\s+up)|billing\s+(?:required|issue|failure)|payment\s+required|buy\s+credits?/i;
// v0.34.125: explicitly-TEMPORARY quota wording (note.md 2026-08-10 "we
// received some quota message that would have been temporary but we gave up
// and waited for a bigger reset"). "temporarily over quota" / "temporarily
// unavailable due to a rate limit" are retryable short windows, NOT
// long-lived walls — and plain "temporarily unavailable" stays ambiguous
// (ordinary outage) so we never turn a random transient into a quota wall.
const TEMPORARY_QUOTA = /temporar(?:y|ily)[^.\n]{0,60}(?:quota|limit|throttl|too many requests)/i;

/** Return the strongest explicit provider signal, or undefined for an
 * ambiguous/transient message. Specific account/plan walls must win over a
 * generic 429/rate-limit match: MiniMax 2062, for example, says both
 * "Token Plan rate limit" and "rate limit", but asks the user to upgrade or
 * switch billing rather than retry a per-minute throttle. */
export function quotaSignal(error: string | undefined): QuotaSignal | undefined {
  if (!error) return undefined;
  if (BILLING.test(error)) return "billing";
  // Explicitly-temporary wording wins over the generic plan-wall pattern:
  // "temporarily over quota" is a short retry window, not a plan wall.
  if (TEMPORARY_QUOTA.test(error)) return "rate-limit";
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

  // Capture one complete Retry-After header value before deciding whether it
  // is delta-seconds or a date. The numeric form must be whole-value matched:
  // an ISO reset such as `Retry-After: 2026-08-10T12:00:00Z` starts with digits
  // but is an absolute date, not a ~34-minute delta.
  let m = error.match(/retry-after:\s*([^\r\n]+)/i);
  const headerValue = m?.[1]?.trim();
  const numeric = numericHint(headerValue && /^\d+(?:\.\d+)?$/.test(headerValue) ? headerValue : undefined);
  if (numeric !== undefined) return { raw: error, retryAfterSec: Math.round(numeric), fromUpstream: true, signal };

  // RFC 7231 Retry-After date. Keep this separate from the numeric match so
  // a comma in the HTTP date cannot consume the next line of the error.
  const headerDate = absoluteReset(headerValue, nowMs);
  if (headerDate) return { raw: error, ...headerDate, fromUpstream: true, signal };

  // Providers often serialize one of these fields inside a larger wrapper.
  m = error.match(/["'](?:retry_after|retryAfter|retry_after_seconds|reset_after|resetAfter)["']\s*:\s*(\d+(?:\.\d+)?)/i);
  const jsonSeconds = numericHint(m?.[1]);
  if (jsonSeconds !== undefined) return { raw: error, retryAfterSec: Math.round(jsonSeconds), fromUpstream: true, signal };

  m = error.match(/["'](?:reset_at|resetAt|resets_at|quota_reset_at)["']\s*:\s*["']([^"']+)["']/i);
  const jsonDate = absoluteReset(m?.[1], nowMs);
  if (jsonDate) return { raw: error, ...jsonDate, fromUpstream: true, signal };

  m = error.match(/retry\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours?|d|day|days|w|week|weeks?)/i);
  const prose = retryWindow(m);
  if (prose !== undefined) return { raw: error, retryAfterSec: prose, fromUpstream: true, signal };

  m = error.match(/(?:reset|resets|available)\s+(?:at|on)\s+([0-9]{4}-[0-9]{2}-[0-9]{2}[^,;\n)]*)/i);
  const proseDate = absoluteReset(m?.[1], nowMs);
  if (proseDate) return { raw: error, ...proseDate, fromUpstream: true, signal };

  // v0.34.125: short-window prose (note.md 2026-08-10 — a temporary quota
  // message must not park until the hour-aligned "bigger reset"). Providers
  // phrase short windows as "try again in 30 seconds" / "please wait 1
  // minute" / "rate limit resets in 15 seconds" / "available again in 2
  // minutes" — the same factual Retry-After claim, just prose.
  m = error.match(/\b(?:try again|retry|available again|try back|come back)\s+in\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours?|d|day|days|w|week|weeks?)/i);
  const again = retryWindow(m);
  if (again !== undefined) return { raw: error, retryAfterSec: again, fromUpstream: true, signal };

  m = error.match(/\b(?:wait|back off|pause|hold|sleep)\b\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours?|d|day|days|w|week|weeks?)/i);
  const waited = retryWindow(m);
  if (waited !== undefined) return { raw: error, retryAfterSec: waited, fromUpstream: true, signal };

  m = error.match(/\b(?:resets?|refreshes?|renews?|recovers?|available)\s+(?:again\s+)?in\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours?|d|day|days|w|week|weeks?)/i);
  const resetIn = retryWindow(m);
  if (resetIn !== undefined) return { raw: error, retryAfterSec: resetIn, fromUpstream: true, signal };

  return { raw: error, retryAfterSec: fallback, fromUpstream: false, signal };
}

/** Convert a "N <unit>" prose match to seconds, or undefined when the match
 * or unit is missing. Units: s / m / h / d / w (weeks/days included for
 * completeness; the 5h probe cap in mainModelFailureDelayMs still applies). */
function retryWindow(m: RegExpMatchArray | null): number | undefined {
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const mult = unit.startsWith("w") ? 7 * 24 * 3600
    : unit.startsWith("d") ? 24 * 3600
      : unit.startsWith("h") ? 3600
        : unit.startsWith("m") ? 60
          : 1;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * mult) : undefined;
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
let lastQuotaRetryNoticeKey: string | null = null;

export interface QuotaRetryScheduleOptions {
  /** Stable persisted recovery episode identity, if the caller has one. */
  episodeKey?: string;
  /** Stable notice identity; excludes changing retry-after/counter values. */
  noticeKey?: string;
  /** Caller already applied a durable per-episode notice fence. */
  suppressNotice?: boolean;
}

/** Test hook — reset process-local notice deduplication between isolated rigs. */
export function resetQuotaRetryNoticeDedup(): void {
  lastQuotaRetryNoticeKey = null;
}

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
  options: QuotaRetryScheduleOptions = {},
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
  const presentation = providerErrorPresentation(reason, "recovery");
  const noticeKey = options.noticeKey
    ?? `${options.episodeKey ?? "session"}:${presentation.fingerprint}:${label}`;
  if (!options.suppressNotice && noticeKey !== lastQuotaRetryNoticeKey) {
    lastQuotaRetryNoticeKey = noticeKey;
    ctx.ui.notify(
      `${label} in ${Math.round(safeSec / 60)}m${capped ? ` (provider hint capped at ${Math.round(safeSec / 3600)}h; automatic probes cap at 5h)` : ""} (${presentation.display}). /goal resume retries now.`,
      "info",
    );
  }
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
