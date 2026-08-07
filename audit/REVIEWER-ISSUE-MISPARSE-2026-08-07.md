# Reviewer "issue" misparse fix — note.md Screenshot_20260807_161539

2026-08-07 · triage item from note.md "# new" section · v0.34.83

## The complaint

note.md (Screenshot_20260807_161539, Decision 4 of 4 deferred-reviewer-parser-bug card):

> The reviewer at `loops/goal.ts:3493-3497 + reviewer.ts:177,342-346` misparses
> objectives containing trigger words (bug/regression/broken/issue/FIXME/TODO/fixme),
> which is why every recent goal's newObjective used trigger-word-free prose. The fix
> is out-of-scope for this goal plane.

This is the SAME bug shape the prior 0.26.2–0.26.4 hardening fixed for "architectural":
reviewer vocabulary self-matches into the source text it scans, producing junk findings
that get enqueued to `/list` and cascade-activated.

## The misfire (measured)

`extensions/reviewer.ts:81` — CLASS_PATTERNS bug branch:

```ts
{ class: "bug", re: /\bTODO\b|\bFIXME\b|\bbug\b|\bissue\b|regression|broken|\bfixme\b/i },
```

`\bissue\b` matched every literal "issue" mention:
- "GitHub issue #5" — a citation, NOT a bug
- "this issue is open" — prose, NOT a bug
- "issue tracker" — a noun, NOT a bug
- "gh-123" — a shorthand reference, NOT a bug

Every completion summary that referenced a GitHub issue (which is all of them after
v0.34.77, since the 4 closed issues are mentioned in every objective update) tripped
the regex. The reviewer fired → enqueued a `bug` finding with text like
"fixed in GitHub issue #5 (regression shield non-ASCII)" → the convert-findings-to-list
cascade activated it as a goal. The user-observed workaround was to strip all trigger
words from `newObjective` prose (note.md: "every recent goal's newObjective used
trigger-word-free prose").

The other words in the regex (`TODO`, `FIXME`, `bug`, `regression`, `broken`, `fixme`)
are specific enough that they only match real bug mentions. `\bissue\b` was the
outlier — too generic.

## The fix

`extensions/reviewer.ts:81` — drop `\bissue\b` from the bug regex:

```ts
{ class: "bug", re: /\bTODO\b|\bFIXME\b|\bbug\b|regression|broken|\bfixme\b/i },
```

`extensions/reviewer.ts:91` — add GitHub-issue / gh-N / issue-tracker shapes to
REVIEWER_VOCAB (defense in depth — even if `\bissue\b` comes back in a future regex,
GitHub-issue citations on any line skip classification):

```ts
const REVIEWER_VOCAB = /architectural-class|bug-class|refactor-class|strategic-class|reviewer found|cascade step|\*\*Mode\*\*|problems\s*\/\s*\(?(improvements|architectural)|\bgithub\s+issue\b|\bgh-\d+|\bissue\s+(tracker|board|queue)\b/i;
```

Real bug markers (`TODO`/`FIXME`/`bug`/`regression`/`broken`/`fixme`) still classify
unchanged. `\bissue\b` is the only removal.

## What this does NOT change

- The architectural / strategic / refactor classes — the 0.26.3 architectural-vocab
  guard already pinned those.
- The bare "issue" word alone in arbitrary prose — it now classifies to whatever
  the OTHER regexes match, which is usually `undefined` (no finding). A line
  containing both "issue" and "regression" (e.g. "this issue is a regression we
  shipped") still classifies as `bug` because "regression" is a real bug marker.
- The other self-match guards (SKIP_LINE for code/markdown, REVIEWER_VOCAB for
  reviewer-report vocabulary) — those still apply.

## Why this wasn't fixed earlier

The v0.26.2 architectural-self-match fix (PR-3) added `\bgithub\s+issue\b` to the
skip list and the bare-word patterns to the regex — but `\bissue\b` slipped through
because it's also a valid prose word. The 0.26.4 source-curation fix moved most
citation leakage to `stripCodeSpans` (so backticked citations don't match), but
plain prose citations still leaked. The 0.34.79 auditor-eager-retry work and the
0.34.81 list-subtasks work both surfaced many GitHub-issue mentions and tripped
the regex on each completion.

## Evidence

- `extensions/reviewer.ts:81` — bug regex (no `\bissue\b`)
- `extensions/reviewer.ts:91` — REVIEWER_VOCAB includes GitHub-issue branches
- `tests/reviewer-extraction-hardening.test.ts` (new tests):
  - "v0.34.83: the bare word 'issue' is REMOVED from the bug regex — GitHub issue
    references and prose don't classify as bugs" — pins that GitHub issue refs and
    "issue is open / in the issue tracker" prose don't classify; real bug markers
    still do.
  - "v0.34.83: a completion summary referencing GitHub issues enqueues zero bug
    findings through the curated pipeline" — drives `runReviewer` end-to-end with
    a GitHub-issue-citing source and asserts `bugs.length === 0` and
    `calls.enqueued.flat().length === 0`.
- Full suite: **1065 pass / 1 skip / 0 fail across 99 files** (was 1063/1/0 at
  v0.34.82).
- `npx tsc --noEmit` clean.

## Out of scope (deferred)

The note.md `# new` section also has 5 other findings (hourly retry cadence,
subagent hang detection, pause-state shows-while-working, auditor-looks-stuck,
auditor-almost-certainly-dead) and the `# pi did not start turn` finding in
"Remaining / working". These are queued as separate `/list` items — see note.md
"Triage 2026-08-07" for the full list.