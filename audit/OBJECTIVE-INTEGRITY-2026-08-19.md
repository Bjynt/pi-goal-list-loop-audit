# Buggy and previous-version objectives — 2026-08-19

## Bounded evidence

Command:

```bash
timeout 60 bun test tests/faulty-objective-recovery.test.ts tests/extract-verification.test.ts
```

Result: **39 passed, 0 failed** across both focused suites.

The tests establish that objective integrity is explicit and durable:

- reviewer/evidence fragments are classified as suspicious;
- valid imperatives mentioning audit or verification remain valid;
- the exact original malformed text is retained in the repair record;
- saved original provenance and its contract win over reviewer prose;
- unverified completion prose is never promoted into a replacement objective;
- suspicious startup, manual resume, and list activation paths queue an
  actionable repair item instead of dispatching the malformed text;
- replan requires a concrete repair objective and explicit confirmation;
- irrecoverable suspicious text becomes a visible repair/defer path; and
- direct continuation and stored-audit paths retain the final objective gate.

The ordinary imperative `verify ... Done when: ...` regression is also green;
that parser fix is already committed in `e29d566f`.

## Disposition

The focused evidence proves the original text is preserved and repair/defer
behavior is explicit. No additional source defect is supported by this pass,
so no new code fix is warranted. Keep the existing provenance-first repair,
explicit replan confirmation, and no-dispatch fence. Future objective-repair
work should target a newly reproduced case rather than broadening heuristics
speculatively.
