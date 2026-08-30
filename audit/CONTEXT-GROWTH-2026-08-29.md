# Context-growth measurement — repeated GLLA continuation payloads

## Scope

This is the measurement and bounded-fix validation pass for the `note.md`
**Now — context bloat** item. The before rows reproduce the measured linear
GLLA growth; the bounded rows replay the same raw message shapes through the
new per-send checkpoint projection. The projection is intentionally
non-destructive: it does not rewrite the session transcript.

The structural probe uses the exact `continuationPrompt()` output that
`extensions/goal-loop.ts` sends in a `customType: "goal-event"` follow-up. It
retains those messages in a synthetic effective history and measures ordinary
history separately from GLLA payloads. The after rows pass that history through
`projectBoundedGllaContext()` with a checkpoint built from durable goal state.
The runtime path also supplies the active loop state, including for loop-only
sessions and paused-goal-plus-loop sessions. No provider request, session write,
or transcript mutation is performed by the offline probe.

## Follow-up fixture refresh — 2026-08-30

The continuation template subsequently gained the explicit
`record_goal_judgment` tool guidance. That is an intentional GLLA-owned prompt
change, so the deterministic size fixture was refreshed rather than weakening
its assertions. The current `continuationPrompt()` output is **22,158 UTF-16
characters / 22,260 UTF-8 bytes**. Current before-projection rows are:

| Repeated continuations | Messages | Serialized | GLLA chars | Estimated tokens | Repeated serialized bytes |
|---:|---:|---:|---:|---:|---:|
| 0 | 2 | 183 B | 0 | 13 | 0 B |
| 1 | 3 | 22,819 B | 22,158 | 5,553 | 0 B |
| 5 | 7 | 113,363 B | 110,790 | 27,711 | 90,544 B |
| 12 | 14 | 271,815 B | 265,896 | 66,487 | 248,996 B |
| 25 | 27 | 566,083 B | 553,950 | 138,501 | 543,264 B |

The authoritative checkpoint projection remains bounded: the current 5/12/25
rows each project to 4 messages and 24,036 serialized bytes. The original
before/after table below is retained as historical evidence from the prior
prompt version; the regression tests now pin this current fixture explicitly.

## Exact provider-token capture

The first completion attempt reported only a `textChars / 4` estimate. That
was insufficient for the contract. The measurement now has two explicit
provider-token paths:

1. `captureProviderTokenUsage()` in `extensions/context-growth.ts` reads the
   exact pi-ai `AssistantMessage.usage` fields (`input`, `output`,
   `cacheRead`, `cacheWrite`, and `totalTokens`). It rejects incomplete,
   negative, fractional, or non-finite values instead of filling them with
   guessed zeroes.
2. `extensions/loops/goal-activation.ts` captures the latest non-error
   assistant usage at every `agent_end` and writes only bounded numeric
   metadata to a `context_usage_sample` ledger record. The host's
   `ctx.getContextUsage()` value is stored separately and labeled as an
   estimate. Prompt text is never written to the ledger.

The offline probe's `provider` fields use a deterministic
`AssistantMessage.usage`-shaped fixture. These are raw provider fields used to
exercise the capture path, not fabricated live-provider evidence. A live
`agent_end` sample is captured by the production hook above; this report does
not pretend that the offline probe contacted a provider.

## Evidence

Commands:

```text
bun scripts/measure-context-growth.mjs
bun test tests/context-growth-measurement.test.ts tests/context-checkpoint.test.ts
npx tsc --noEmit
git diff --check
```

The original deterministic fixture produced the following before/after
structural and raw-field shape. `After messages/bytes` is the same input after
`projectBoundedGllaContext()`. The after projection retains one newest
`goal-event` and inserts one authoritative checkpoint when old payloads are
removed. The checkpoint was 1,112 characters for this fixture and the hard
builder bound is 8,192 characters.

| Repeated continuations | Before messages | Before serialized | Before GLLA chars | After messages | After serialized | After GLLA control messages | Removed old payloads | Retained payloads | After repeated payloads | Raw provider samples | Raw provider input sum | First → latest raw input |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 2 | 183 B | 0 | 2 | 183 B | 0 | 0 | 0 | 0 | 0 | 0 | — |
| 1 | 3 | 21,911 B | 21,246 | 3 | 21,911 B | 1 | 0 | 1 | 0 | 1 | 8,000 | 8,000 → 8,000 |
| 5 | 7 | 108,823 B | 106,230 | 4 | 23,128 B | 2 | 4 | 1 | 0 | 5 | 60,000 | 8,000 → 16,000 |
| 12 | 14 | 260,919 B | 254,952 | 4 | 23,128 B | 2 | 11 | 1 | 0 | 12 | 228,000 | 8,000 → 30,000 |
| 25 | 27 | 543,383 B | 531,150 | 4 | 23,128 B | 2 | 24 | 1 | 0 | 25 | 800,000 | 8,000 → 56,000 |

The after projection is bounded at four messages for this two-message
ordinary-history fixture, and its structural size is identical for 5, 12,
and 25 continuations. The complete raw provider fixture fields are pinned in
`tests/context-growth-measurement.test.ts` and emitted under each row's
`measurement.provider` object. For example, the 12-sample row is:

```json
{
  "sampleCount": 12,
  "inputTokens": 228000,
  "outputTokens": 1266,
  "cacheReadTokens": 660,
  "cacheWriteTokens": 12,
  "totalTokens": 229938,
  "firstInputTokens": 8000,
  "latestInputTokens": 30000,
  "inputTokenDelta": 22000,
  "incompleteSampleCount": 0
}
```

The one-continuation GLLA message serializes to 21,728 bytes and contains
21,246 text characters. At 25 continuations, 521,472 serialized bytes are
repeated occurrences after the first payload group. The ordinary two-message
baseline remains 183 bytes, so the measured structural growth is
predominantly repeated GLLA payload rather than the conversation fixture.

The 1→12 structural increment is **58,426** estimated text tokens
(`63,738 - 5,312` GLLA text-token estimates), not 63,738. The corresponding
GLLA serialized-byte increment is 260,736 bytes, and 11 additional messages
are retained.

## Regression coverage

`tests/context-growth-measurement.test.ts` continues to:

- pin the exact current continuation payload size (22,158 UTF-16 characters and
  22,260 UTF-8 bytes); the preceding 21,246/21,350 values belong to the
  historical prompt version documented above;
- pin the complete current 0/1/5/12/25 before-measurement shape, including
  message counts, serialized bytes, text counts, estimated counts,
  repeated-payload counts, and provider sample/input/output/cache/total values;
- verify exact provider usage extraction and rejection of partial/invalid
  usage; and
- keep failed error-only turns and ordinary conversation separate from GLLA
  payload metrics.

`tests/context-checkpoint.test.ts` additionally proves that the checkpoint
contains objective, verification contract, audit evidence, task state,
pending-audit lifecycle, owner/session-generation, and revision data; removes
old payloads without mutating the source list; retains the newest dispatch;
and records the integrated context-hook ledger event. The follow-up regressions
also cover an active loop with no goal and an active loop alongside a paused
goal: both retain the loop target in the authoritative checkpoint and bound
old `goal-event` payloads. The focused measurement and checkpoint regressions
passed **13/13 tests** and `npx tsc --noEmit` passed.

## Interpretation and ownership

The repeated payload is GLLA-owned: `prompts/goal-loop-continuation.md` is
about 16.6 KB before substitutions, and `continuationPrompt()` sends that
prompt again for each continuation. Existing context hygiene is still useful
but addresses different contributors: it removes old error-only assistant
turns and bounds inline image payloads. It does not remove repeated
continuation messages.

The result supports the implemented bounded authoritative checkpoint/resync.
`extensions/context-checkpoint.ts` retains one newest dispatch payload and,
when older `goal-event` payloads exist, inserts a bounded checkpoint derived
from current durable goal and/or active loop state. It carries the goal
objective, verification contract, task state, latest audit metadata/evidence
excerpt, pending audit lifecycle, owner/session-generation, revision, and
stop/pause state when a goal is present; an active loop additionally carries
its target, measure, iteration/progress, bounds, recent measurements, and loop
lifecycle. The runtime context hook now projects whenever a goal OR an active
loop exists, so a loop-only session cannot bypass the bound and a paused goal
cannot hide the active loop target. The projection runs at the existing
`context` chokepoint, so ordinary calls and recovery/compaction-adjacent calls
receive the same fence; stale-session and dispatch ownership checks remain in
the continuation path unchanged.

## Limits

The chars/4 column is a diagnostic estimate, not a provider tokenizer count.
The raw provider columns in the offline table are a deterministic fixture for
the exact pi-ai usage shape; they are not a live model run. The production
ledger hook is the source for real provider values in a live session. The
structural fixture proves marginal cost and ownership of the GLLA continuation
payload; it is not a claim that every provider or session has the same system
prompt, tokenizer, cache behavior, or turn shape.

The runtime projection is deliberately bounded but non-destructive. It does
not claim that provider token usage is identical across providers: the offline
raw provider columns remain deterministic fixtures. A live `agent_end` ledger
sample is still required for exact provider evidence. The projection bounds
repeated GLLA control-payload growth in the effective per-send context; the
session transcript and durable state remain the authorities for full history,
reports, and recovery.
