# Hourly Quota Probe — auditor retry envelope binds nextHourlyPromptMs

**Version:** v0.34.84
**Date:** 2026-08-07
**Goal:** list item "Hourly quota-retry cadence" (note.md Screenshots 160846/160925/160956/160958/160928/161010)

## Complaint

The auditor's durable quota-retry envelope (v0.34.79) schedules:
- attempt 1: 5s eager (no upstream hint) — mirror of the main thread's `runWithInfraRetry` 5s backoff;
- attempt 2+: exponential rungs `base · 2^(attempt-1)` (60m → 2h → 4h → …).

Field-observed on 2026-08-07 (note.md, six screenshots 16:08–16:10): the auditor sat
"Retrying (13/15) in 6232s–6367s" ≈ 1h44m between retries, while a SEPARATE shorter
"next probe in 32m–51m" timer ran in parallel. The exponential rungs don't align with the
provider's quota-reset boundary (most providers reset at top-of-hour or on a billing
cycle). The user's ask: **hourly probes that react when the quota resets** — never park
for 2h/4h when the reset may already have happened at the last top-of-hour.

## Fix

`extensions/loops/goal.ts` — `auditorQuotaRetryPlan` (the pure plan exported for tests).

```ts
const isQuota = quota.signal !== undefined;
const requestedSec = quota.fromUpstream
  ? quota.retryAfterSec
  : attempt === 1
    ? EAGER_AUDITOR_RETRY_SEC
    : isQuota
      ? Math.max(60, Math.round((nextHourlyPromptMs(now) - now) / 1000))
      : quotaRetryDelaySeconds(attempt, baseMinutes);
```

Routing rules (in priority order):

1. **Upstream hint wins.** `Retry-After` / `reset_at` / prose "retry in 2h" are the
   provider's own authority — unchanged.
2. **Attempt 1 stays eager (5s).** A transient glitch on the first probe shouldn't wait
   for the hour boundary. Unchanged from v0.34.79.
3. **Quota-shaped errors (attempts 2+): hour-aligned probe.** `quota.signal` is set when
   the error text matches the conservative `quotaSignal` patterns
   (`rate-limit` | `plan-quota` | `billing`). The probe lands at the next top-of-hour
   strictly after `now` (`nextHourlyPromptMs`, already exported from
   `extensions/goal-loop-core.ts:48`), floored at 60s so a stale boundary (e.g. we're
   inside the last minute of the hour) never produces a sub-minute cadence.
4. **Non-quota transient errors: exponential rungs unchanged.** No `signal` → the old
   `quotaRetryDelaySeconds` cadence. A stuck provider is not probed at every top-of-hour.

Why this doesn't weaken the v0.34.51 "error text is not trusted to pick quota vs other
failures" stance: that stance governs WHETHER the goal enters the durable bounded retry
plan (it still does, for ANY infra failure). The cadence choice here is an optimization,
not a safety gate — both branches auto-retry within the same 5-attempt / 5h horizon, and
`quotaSignal` is deliberately explicit (it rejects "temporarily unavailable", plain 403s,
and generic network failures). Worst case either way is bounded: a quota wall
mis-read as transient keeps the old exponential cadence; a transient mis-read as quota
probes hourly (faster, still capped).

## Files

- `extensions/loops/goal.ts` — `auditorQuotaRetryPlan` branches on `quota.signal`;
  `nextHourlyPromptMs` was already imported (no new import).
- `tests/auditor-eager-retry.test.ts` — 5 new tests (11 total, was 6):
  - quota-shaped (rate-limit) attempts 2+ land ≤ 60m and never at the 2h rung;
  - plan-quota and billing signals get the same hour-aligned treatment;
  - non-quota transient errors KEEP the 2h/4h exponential rungs (regression guard);
  - hour-aligned probes floor at 60s;
  - upstream Retry-After still wins over hour-aligned.
- `CHANGELOG.md` — Unreleased v0.34.84 entry. `package.json` → 0.34.84.

## What it does NOT change

- The first-attempt eager 5s probe (v0.34.79) is untouched.
- The 5-attempt automatic horizon and the 5h `MAX_AUTOMATIC_QUOTA_RETRY_SEC` cap are
  untouched — hour-aligned probes (max ~60m each) fit well inside both.
- The separate main-thread `nextHourlyPromptMs` timer (screenshot "next probe in
  32m–51m") is untouched; this fix makes the AUDITOR envelope itself hour-aligned, so
  the two timers now agree instead of fighting.
- User-visible wording (`fmtRetryDelay`, "Auto-retry in …") is unchanged and already
  seconds-aware; an hour-aligned probe at 30m renders as "30m".

## Evidence

- `timeout 60 bun test tests/auditor-eager-retry.test.ts` → 11 pass / 0 fail.
- Full suite: 1070 pass / 1 skip / 0 fail across 99 files.
- `npx tsc --noEmit` → exit 0.
