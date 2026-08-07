# Auditor retry eagerness — note.md 112555 / OPEN-ISSUES 1.10

2026-08-07 · item 3 of the "note.md newer ones" batch · v0.34.79

## The complaint

note.md (Screenshot_20260807_112555):
> "auditor likely stuck, i think the quota may have expired in the middle and
> we are not retrying the auditor as eagerly as the do the main thread"

(OPEN-ISSUES 1.10's "auditor blocked" screenshots 051501/183955 are the
EXTERNAL `/advisor` dependency — provider/credential, no glla-side fix,
documented in ADVISOR-BLOCKER-2026-08-05.md. This item is the glla-side
auditor — the detached goal-loop-auditor-process worker.)

## The asymmetry (measured)

| Path | First retry after an infra failure | Mechanism |
|---|---|---|
| Main thread | **5 seconds** | `runWithInfraRetry` (goal-loop-core.ts:1775) — default `backoffMs: 5000`, retriable-infra errors (429 etc.) retry once immediately |
| Auditor | **60 minutes** | `auditorQuotaRetryPlan` — `quotaRetryDelaySeconds(1, 60)` = `60·2⁰` minutes (default `quotaRetryMinutes`), unless the provider gave a Retry-After hint |

So a quota that expired mid-audit parked the goal paused/wait for the base
window (default 60m) before the FIRST probe — while the main thread would
have retried within seconds. The user's read was exactly right.

## The fix

`extensions/loops/goal.ts` (v0.34.79):

- **`EAGER_AUDITOR_RETRY_SEC = 5`** — the first no-hint attempt now retries
  in 5s, mirroring `runWithInfraRetry`'s default backoff for the main
  thread. `auditorQuotaRetryPlan` selects:
  `upstream hint ? retryAfterSec : attempt === 1 ? 5 : exponential(base)`
  — the provider's own Retry-After still wins (authoritative), later
  attempts keep the exponential minute-scale rungs (2h, 4h, …), and the
  attempt streak is unchanged (the eager probe counts as attempt 1; a stuck
  provider does not get hammered every 5s).
- **Seconds-aware wording**: both dispatch sites' pause reason / suggested
  action / notify / tool result now say `auto-retry in 5s` (via
  `fmtRetryDelay`) instead of a rounded `1m` for sub-minute windows.
- **`auditorQuotaRetryPlan` is exported** (pure) so the schedule is unit-
  pinned instead of source-pinned.
- **Ledger**: unchanged record shape — `goal_paused` with
  `reason: "auditor retry: retry in <sec>s (stored-claim retry)"` +
  attempt/autoRetryUntil, and `auditor_retry_capped` at horizon end. The
  eager attempt shows as `retry in 5s` in the ledger.

## Policy stance

Consistent with v0.34.51's "dumb retry" doctrine: error text is NOT
classified to pick a retry class — EVERY non-timeout infra failure gets the
eager first probe; the bounded durable envelope (5 attempts, 24h horizon)
is unchanged. The 5s probe is one shot, not a storm.

## Evidence

- `tests/auditor-eager-retry.test.ts` (6, new): first no-hint attempt = 5s
  automatic; later attempts = 2h/4h exponential; upstream hint wins; bounded
  by horizon; the eager probe counts toward the streak; source pins
  (constant + `fmtRetryDelay` at both sites + the mirror comment).
- Full suite: **1040 pass / 1 skip / 0 fail across 97 files** (was
  1034/1/0 at v0.34.78), `npx tsc --noEmit` clean.
