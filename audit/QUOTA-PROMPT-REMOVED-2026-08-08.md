# v0.34.92 — Drop quota-prompt chat spam; add opt-in hourly probe ticker

## Why

The v0.34.58 hourly quota-resume prompt was the wrong shape. The plugin
scheduled a `safeSteerUser("Provider quota wall — … run /list resume")`
at the next `:00` clock minute whenever main-model recovery parked —
but **quota text from providers is unreliable** (v0.34.64 established
this; different providers report "rate limit exceeded", "insufficient
quota", "Token Plan limit reached", "credits exhausted", and plain
5xx-shaped strings for the same underlying condition). So the plugin
was sending a chat message it couldn't reliably earn.

### Field evidence (2026-08-07)

- **Screenshot_20260807_231717** — *triage is spamming in the chat, in
  fat we should never spam in the chat*. Four identical
  "Provider quota wall — [TRIAGE-…]" messages in chat from peer
  sessions on one parked goal. The dedupe ledger keys were correct
  (goalId + episodeAt), but the cross-session ledger sent-dedupe in
  v0.34.90 didn't catch peer sessions that started AFTER the first
  prompt had fired: each peer session saw "I am the first to schedule
  this :00 slot" and scheduled its own copy.
- **Screenshot_20260807_160846 / 160925 / 160928 / 160956 / 160958 /
  161010** — 6232s–6367s ≈1h44m backoff between retries on the 13/15
  counter; the 1-prompt-per-parked-episode marker helped when it
  worked, but a fresh parked episode (a new wall hit minutes after the
  previous one resolved) re-armed immediately, so the user saw
  multiple "Provider quota wall" messages per day.
- **Screenshot_20260808_080150 / 080259 / 080443 / 080503 / 080518** —
  the prompt also dumped the FULL turn snapshot (`quotaPromptTurnContext`)
  into the chat: `goal: <objective> — main model quota: 429 rate limit: …`
  This was useful for debugging, awful for the user. The complaint was
  consistent: the prompt is too verbose, too frequent, too chatty.

### User direction (2026-08-07)

> "we also dont want to quota wall we cant check for it we jsut actively
> retry we also additionally retry after the start of every hour this
> can be an option to pick up faster"

Read literally: drop the prompt (we can't reliably detect quota, so we
shouldn't be promising detection), keep active retry (the existing
v0.34.79 eager first probe + v0.34.84 hour-aligned attempts 2+), and
add an hourly probe ticker as the "pick up faster" lever. The user
later confirmed the ticker should be **default ON** (not opt-in) —
quota windows tend to refresh at the top of the hour, and the ticker
gives the fastest pickup without spam.

## What changed

### Removed (the whole v0.34.58/v0.34.90 quota-prompt surface)

- `extensions/loops/goal.ts`:
  - 9 module vars (`quotaPromptTimer`, `quotaPromptScheduledFor`,
    `quotaPromptContext`, `quotaPromptCtx`, `quotaPromptFired`,
    `quotaPromptGoalId`, `quotaPromptEpisodeAt`,
    `quotaPromptClockOverride`)
  - 6 functions (`clearQuotaPromptTimer`, `quotaPromptEpisodeKey`,
    `quotaPromptAlreadyCovered`, `quotaPromptTurnContext`,
    `fireQuotaResumePrompt`, `scheduleQuotaResumePrompt`)
  - 4 `__testOnly*` hooks (`__testOnlySetQuotaPromptNow`,
    `__testOnlyResetQuotaPrompt`, `__testOnlyQuotaPromptState`,
    `__testOnlyFireQuotaPrompt`)
  - The `if (isQuotaWallError(failure.raw)) scheduleQuotaResumePrompt(...)`
    call site in `parkMainModelAfterFailure`
  - The `if (state.goal) updateGoal({ quotaPromptedAt: undefined }, ctx)`
    clears in `manuallyResumeMainModelRecovery` and in the cmdResume
    paused→active transition
  - The `safeSteerUser(ctx, "Provider quota wall — …")` chat copy
  - The `clearQuotaPromptTimer()` calls in `mainModelRecoverySucceeded`
    and `clearMainModelRecoveryTimer`
- `extensions/goal-loop-core.ts`: the `Goal.quotaPromptedAt` field
- Tests: `tests/quota-prompter.test.ts` (14.5K, 9 cases)
- Doc: `audit/QUOTA-PROMPT-DEDUPE-2026-08-07.md`

The plugin never says "Provider quota wall" in chat again.

### Added: opt-in hourly probe ticker (default ON)

- **New setting** `hourlyQuotaProbe: true` (default ON) in
  `extensions/goal-settings.ts`. Default ON per user direction: quota
  windows tend to refresh at the top of the hour, and the ticker is
  the fastest pickup the plugin can offer without spam. Opt-out: set
  `hourlyQuotaProbe: false` in `/glla` settings.
- **New helper** `nextHourlyProbeMs(now)` in
  `extensions/goal-loop-core.ts` — returns the next `:00:30` strictly
  after `now`. `:00:30` (not `:00:00`) gives the provider a 30s skew
  window to roll its quota counters; a probe at exactly `:00:00` can
  race the provider's reset. Kept the legacy `nextHourlyPromptMs`
  (returns `:00:00`) for any external caller that pins the old
  contract.
- **New ticker** in `extensions/loops/goal.ts`:
  - `scheduleHourlyProbe(ctx)` — arms a `:00:30` timer; re-arms itself
    after each fire as long as recovery is parked and the setting is
    on. No-op when no recovery is parked. Idempotent — calling twice
    does not double-schedule.
  - `fireHourlyProbe(ctx)` — invokes the same `probeMainModelRecovery`
    path the normal schedule uses. The probe is observed by the
    recovery envelope: a success clears `state.mainModelRecovery`
    (and the ticker stops because the guard on the next re-arm sees
    no recovery); a failure reschedules via the normal schedule
    (v0.34.79/v0.34.84), and the hourly ticker's next fire is already
    queued by the re-arm above.
  - `cancelHourlyProbe()` — clears the timer + the `fireAt` marker.
    Safe to call when no timer is pending.
  - 3 `__testOnly*` hooks for tests: clock override + reset + state
    read.
- **Lifecycle wiring**:
  - `parkMainModelAfterFailure` now calls `scheduleHourlyProbe(ctx)`
    immediately after `scheduleMainModelRecoveryTimer(ctx, delay)`.
  - `mainModelRecoverySucceeded` now calls `cancelHourlyProbe()`.
  - `clearMainModelRecoveryTimer` now also calls `cancelHourlyProbe()`
    in lockstep — session replacement / recovery reset must not leave
    an orphaned ticker firing against a dead generation.
  - `session_start` recovery-restored branch now also calls
    `scheduleHourlyProbe(ctx)` so the new session re-arms when
    recovery is still parked.
- **New menu entry** in `/glla` settings:
  `hourlyQuotaProbe` → "Hourly quota probe ticker — extra recovery
  probe at :00:30 every hour while main-model recovery is parked".
  Two options: "on — fire an extra probe at :00:30 every hour while
  parked (default)" / "off — rely on the normal retry cadence only".

### Co-resident with the normal retry schedule

The ticker is a strict ADDITIONAL probe slot — the existing retry
cadence is unaffected:

- **v0.34.79** — eager first probe (5s) after any infra failure.
- **v0.34.84** — hour-aligned cadence for attempts 2+ (uniform for all
  failures; we don't try to detect quota shape).
- **v0.34.92** — extra `:00:30` probe while parked (this release).

When `hourlyQuotaProbe` is on, all three run. When it's off (opt-out),
only v0.34.79 + v0.34.84 run. The retry schedule is not replaced; the
ticker is purely additive.

### Why this is better than the v0.34.90 chat prompt

- **The chat spam goes away by not sending the message.** No more
  `safeSteerUser("Provider quota wall — …")` — no more cross-session
  dedupe logic, no more `Goal.quotaPromptedAt` marker, no more
  `quota_prompt_scheduled`/`sent` ledger events, no more verbose
  `quotaPromptTurnContext` dump.
- **The retry cadence is unchanged.** v0.34.79 + v0.34.84 keep
  working. The ticker is a third channel that fires at a precise slot
  (`:00:30`) for faster pickup when quota windows refresh on the
  hour.
- **The 24h horizon still owns the wait.** Ticker fires until the
  recovery envelope ends automatic probes (kind-independent), so the
  user is never poked past the horizon.
- **Opt-out is one setting.** `hourlyQuotaProbe: false` in
  `/glla` → the ticker stops, everything else keeps running.

## Safety analysis

| Concern | Mitigation |
|---|---|
| Ticker fires forever, pings the provider every hour indefinitely | The 24h auto-retry horizon (`MAIN_MODEL_AUTO_RETRY_HORIZON_MS`) still ends automatic probes; the ticker stops when recovery clears or the horizon is reached. |
| Ticker probe succeeds → orchestrator resumes spuriously | The recovery envelope already gates on `state.mainModelRecovery`; a successful probe clears it, and the ticker stops via the `if (state.mainModelRecovery) scheduleHourlyProbe(fresh)` re-arm guard. |
| Session replacement fires the ticker against a dead generation | `clearMainModelRecoveryTimer` (called on session replacement / recovery reset) cancels the ticker in lockstep. The new session's `session_start` recovery-restored branch re-arms fresh against the new generation. |
| Ticker probes a forbidden model via fallback chain | The existing `tryMainModelFallback` (and the recovery-probe target resolution) still drive the probe — v0.34.92 doesn't add a new model-selection path. The v0.34.93 work item (separate) will add the `isForbiddenModel` gate to those paths; until then, a user's existing `forbiddenModels` setting still governs all model rotations the ticker participates in. |
| Multiple pi sessions on one project each schedule their own ticker | Per-session: each session's timer is in-memory and dies with the session. The ledger records `hourly_probe_scheduled` / `hourly_probe_fired` so a peer session can see another's fires (read-only dedupe; no suppress). Provider cost = one probe per session per hour — minimal. |
| Ticker at `:00:30` races the provider's reset | `:00:30` (not `:00:00`) deliberately adds a 30s skew buffer. If the provider resets later than `:30`, the probe sees the wall still up and the next ticker at the next `:00:30` catches it. If the provider resets earlier than `:30`, the probe succeeds — that's the whole point. |
| Concurrent ticker + normal schedule at `:00:30` | The normal `scheduleMainModelRecoveryTimer` computes its own delay (not `:00:30`-aligned — v0.34.84 hour-aligns attempts 2+ to `:00:00`, not `:00:30`). A collision is possible but harmless — both call `probeMainModelRecovery`, and the recovery envelope handles the result idempotently. The second probe sees recovery already cleared (from the first) and no-ops. |

## Verification

| Check | Command | Result |
|---|---|---|
| Suite | `bun test` | **1102 pass / 1 skip / 0 fail** across 100 files (74.62s) |
| Types | `npx tsc --noEmit` | **exit 0** |
| Quota-prompt machinery removed | `grep -rn 'quotaPrompt' extensions/ tests/` | **0 matches** |
| `Goal.quotaPromptedAt` field removed | `grep -rn 'quotaPromptedAt' extensions/` | **0 matches** (only the v0.34.92 explanatory comment remains) |
| `hourlyQuotaProbe` setting exists | `grep 'hourlyQuotaProbe' extensions/goal-settings.ts` | type, default ON, menu entry all present |
| `nextHourlyProbeMs` exported | `grep 'export function nextHourlyProbeMs' extensions/goal-loop-core.ts` | matches |
| `scheduleHourlyProbe` wired | `grep 'scheduleHourlyProbe' extensions/loops/goal.ts` | 6 matches (fn def, 2 call sites, 3 comments) |
| `tests/hourly-quota-probe.test.ts` passes | `bun test tests/hourly-quota-probe.test.ts` | **14 pass / 0 fail** |
| v0.34.58/v0.34.90 doc removed | `ls audit/QUOTA-PROMPT-DEDUPE-2026-08-07.md` | ENOENT |
| v0.34.90 test file removed | `ls tests/quota-prompter.test.ts` | ENOENT |
| CHANGELOG entry present | `grep -A2 '### 0.34.92' CHANGELOG.md` | matches |
| package.json bumped | `jq -r .version package.json` | `0.34.92` |

## Files touched

- `extensions/loops/goal.ts` — removed ~250 LOC of v0.34.58/v0.34.90
  machinery + comments; added ~90 LOC for `scheduleHourlyProbe` /
  `fireHourlyProbe` / `cancelHourlyProbe` + lifecycle wiring + 3
  `__testOnly*` hooks.
- `extensions/goal-loop-core.ts` — added `nextHourlyProbeMs` helper
  (+12 LOC).
- `extensions/goal-settings.ts` — added `hourlyQuotaProbe` setting
  (type + default ON + menu entry) (+15 LOC).
- `tests/hourly-quota-probe.test.ts` — new (14 tests).
- Removed: `tests/quota-prompter.test.ts` (14.5K), `audit/QUOTA-PROMPT-DEDUPE-2026-08-07.md`.

## Out of scope

- v0.34.93 (forbidden-models gate on main-model fallback) is a
  separate item.
- v0.34.94 (host-session-lost self-heal) is a separate item.
- The release of v0.34.82 → v0.34.92 to npm + tag + `gh release
  create` is a separate concern — package.json is bumped to 0.34.92
  but npm `latest` is still 0.34.80; release is user opt-in.
