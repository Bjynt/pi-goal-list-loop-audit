# Over-cap strategy — the three rungs in order (2026-09-03)

The user question: over cap, current model can't compress — what now?
There are three rungs, and they fire in a fixed order. Each rung's failure
falls through to the next; no failure is silent.

## Rung 2 fires first (free, always-on): cut, then compact

Every `context` event passes through the projection in
`loops/goal-activation.ts` (`pi.on("context")`): failed error-only turns
dropped (v0.35.52 — polis hit 122.7% on error entries alone), only the
newest GLLA payload retained plus one bounded ≤8k checkpoint (v0.36.2),
image payloads evicted. So when the user runs `/compact`, pi compacts the
already-trimmed projection — and v0.38.5's marker-only sends (45 chars,
not 23k) stop GLLA re-bloating it. Ledger: `context_checkpoint_projection`.
Nothing to configure; nothing to click.

## Rung 1 fires on compact failure (cheap, if a bigger model exists)

`observeCompactFailure` (`goal-recovery.ts`) catches the
length-context exception after a compaction attempt and
`recoverFromContextOverflow` walks `mainModelFallbackRefs` to a
larger-context ref. Guarded: the only call site checks
`sinceLastCompactMs < COMPACTION_GRACE_MS && chain.length > 0`, so the
"walking the fallback chain" claim can never lie and an empty chain
falls straight through. Success notifies "rotated to a larger-context
backup model". Ledger: `compact_failure_observed`.

## Rung 3 is the backstop (always viable): /new + resume

Any failure path lands on the starvation ladder banner: skip-stale-retry
(v0.38.9 — a compact that failed inside 90s is never re-advised),
larger-context model, `/new` + resume. Viability ranking, answered
directly: **/new wins exactly when no model can compress**, because the
goal/tasks/verdicts/audits are durable on disk and the post-compact
resync re-anchors a fresh session with zero summarization — transcript
is disposable, state is not. The 0.38.7 recovery banner proves it on
arrival. **Switching wins when a bigger model exists** — one rotation,
no session surgery. Trim wins always because it costs nothing.

## Verification (v0.38.9)

- `tests/overcap-strategy.test.ts`: ladder skip-shape pin; **behavioral**
  failed-compact + chain → rotation notify + `setModel` crossed, no
  ladder; **behavioral** failed-compact + empty chain → ladder names
  rung 3, walk never claimed, no rotation attempt.
- Pre-existing pins cover the trim (context-checkpoint) and the guarded
  call site (context-overflow-recovery). Full suite green.
