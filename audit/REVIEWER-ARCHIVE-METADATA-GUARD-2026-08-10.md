# Reviewer archive-metadata guard — 2026-08-10

## Finding

A clean approved completion in an older runtime produced two bogus queue
items from the archived goal markdown:

- the Objective line was stripped at backtick/code spans and clause-capped,
  leaving a truncated new objective; and
- a verification-contract line became a separate refactor item with no
  contract of its own.

Raw evidence is preserved in the historical project state:
`.pi-glla/reviews/20260810065206-svceph-2026-08-10T07-20-05-248Z.md`.
The report labels both findings `(archive)`. This is not a continuation
placeholder-substitution failure: the persisted list items were already
corrupted before `continuationPrompt()` rendered them.

## Fix

Automatic postaudit source selection now excludes archived goal markdown.
Automatic review mines only curated auditor reports whose latest verdict is a
live `disapproved` or `error`. An explicit manual `/review` retains archive
access for inspection. This prevents Objective and verification-contract
metadata from becoming new list findings after an approved completion while
preserving genuine required-fix review paths.

The source helper is `buildReviewerSources()` in `extensions/reviewer.ts` and
its automatic caller is `fireReviewer()` in
`extensions/loops/goal-auditor-hooks.ts`.

## Regression coverage

`tests/reviewer-source-curation.test.ts` pins:

- automatic review excludes archive metadata;
- live disapproved reports remain mineable; and
- manual review can still inspect the archive.

```text
npx tsc --noEmit
TypeScript: No errors found

bun test tests/reviewer-source-curation.test.ts
8 pass / 0 fail
```

Pi core/session lifecycle behavior is unchanged. This is a plugin-side source
curation guard; no persisted goal schema or continuation protocol changed.
