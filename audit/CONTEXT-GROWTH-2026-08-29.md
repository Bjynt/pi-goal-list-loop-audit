# Context-growth measurement — repeated GLLA continuation payloads

## Scope

This is the measurement pass for the `note.md` **Now — context bloat** item.
It does not claim to fix context growth yet. The next list item owns the
bounded checkpoint/resync implementation.

The structural probe uses the exact `continuationPrompt()` output that
`extensions/goal-loop.ts` sends in a `customType: "goal-event"` follow-up. It
retains those messages in a synthetic effective history and measures ordinary
history separately from GLLA payloads. No provider request, session write, or
transcript mutation is performed by the offline probe.

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
bun test tests/context-growth-measurement.test.ts
npx tsc --noEmit
```

The deterministic fixture produced the following structural and raw-field
shape:

| Repeated continuations | Context messages | GLLA text chars | chars/4 estimate* | Repeated payloads | Serialized context | Raw provider samples | Raw provider input sum | First → latest raw input |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 2 | 0 | 13 total | 0 | 183 B | 0 | 0 | — |
| 1 | 3 | 21,246 | 5,325 total | 0 | 21,911 B | 1 | 8,000 | 8,000 → 8,000 |
| 5 | 7 | 106,230 | 26,571 total | 4 | 108,823 B | 5 | 60,000 | 8,000 → 16,000 |
| 12 | 14 | 254,952 | 63,751 total | 11 | 260,919 B | 12 | 228,000 | 8,000 → 30,000 |
| 25 | 27 | 531,150 | 132,801 total | 24 | 543,383 B | 25 | 800,000 | 8,000 → 56,000 |

The complete raw provider fixture fields are pinned in
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

`tests/context-growth-measurement.test.ts` now:

- pins the exact continuation payload size (21,246 UTF-16 characters and
  21,350 UTF-8 bytes);
- pins the complete 0/1/5/12/25 checkpoint shape, including message counts,
  serialized bytes, text counts, estimated counts, repeated-payload counts,
  and provider sample/input/output/cache/total values;
- verifies exact provider usage extraction and rejection of partial/invalid
  usage; and
- keeps failed error-only turns and ordinary conversation separate from GLLA
  payload metrics.

The focused regression passed **4/4 tests** and `npx tsc --noEmit` passed.

## Interpretation and ownership

The repeated payload is GLLA-owned: `prompts/goal-loop-continuation.md` is
about 16.6 KB before substitutions, and `continuationPrompt()` sends that
prompt again for each continuation. Existing context hygiene is still useful
but addresses different contributors: it removes old error-only assistant
turns and bounds inline image payloads. It does not remove repeated
continuation messages.

The result supports implementing a bounded authoritative checkpoint/resync in
the follow-up item, while retaining enough current objective/contract/task
state for safe continuation and preserving lifecycle, owner, revision, and
audit fences.

## Limits

The chars/4 column is a diagnostic estimate, not a provider tokenizer count.
The raw provider columns in the offline table are a deterministic fixture for
the exact pi-ai usage shape; they are not a live model run. The production
ledger hook is the source for real provider values in a live session. The
structural fixture proves marginal cost and ownership of the GLLA continuation
payload; it is not a claim that every provider or session has the same system
prompt, tokenizer, cache behavior, or turn shape.

No runtime context projection or checkpoint/resync reduction was changed in
this measurement pass.
