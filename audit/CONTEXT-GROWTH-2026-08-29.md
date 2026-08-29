# Context-growth measurement — repeated GLLA continuation payloads

## Scope

This is the measurement pass for the `note.md` **Now — context bloat** item.
It does not claim to fix context growth yet. The next list item owns the
bounded checkpoint/resync implementation.

The probe uses the exact `continuationPrompt()` output that
`extensions/goal-continuation.ts` sends in a `customType: "goal-event"` follow-
up. It retains those messages in a synthetic effective history and measures
ordinary history separately from GLLA payloads. No provider request, session
write, or transcript mutation is performed.

## Evidence

Command:

```text
bun scripts/measure-context-growth.mjs
```

The deterministic fixture produced:

| Repeated continuations | GLLA messages | GLLA text chars | Text-token estimate* | Repeated payloads | Total serialized context |
|---:|---:|---:|---:|---:|---:|
| 0 | 0 | 0 | 0 | 0 | 183 B |
| 1 | 1 | 21,246 | 5,312 | 0 | 21,911 B |
| 5 | 5 | 106,230 | 26,558 | 4 | 108,823 B |
| 12 | 12 | 254,952 | 63,738 | 11 | 260,919 B |
| 25 | 25 | 531,150 | 132,788 | 24 | 543,383 B |

The one continuation's complete serialized message is 21,728 bytes. At 25
continuations, 521,472 serialized bytes are repeated occurrences after the
first payload group. The additional 11 messages from one to twelve add
260,736 bytes and 63,738 estimated text tokens. The ordinary two-message
baseline remains 183 bytes, so the measured growth is overwhelmingly the
repeated GLLA payload rather than the conversation fixture.

`tests/context-growth-measurement.test.ts` reproduces the same shape and
asserts that the payload is the real continuation prompt, repeated payloads
are grouped, and ordinary messages/failed turns remain separate metrics.

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

The token column is a diagnostic estimate (`text characters / 4`), not a
provider tokenizer count. This fixture proves the marginal cost and ownership
of the GLLA continuation payload; it is not a claim that every field session
has the same turn shape or that upstream context accounting is irrelevant.
A live `ctx.getContextUsage()` capture can be compared against this baseline
when validating the implementation.

## Verification

```text
bun test tests/context-growth-measurement.test.ts
npx tsc --noEmit
```

Both passed during this measurement pass. No runtime context projection was
changed here.
