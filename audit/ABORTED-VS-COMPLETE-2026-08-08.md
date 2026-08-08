# v0.34.96 — Complete-vs-aborted distinction when the work was already shipped in a prior version

## Why

Field evidence (Screenshot_20260808_080536): an agent's
completionSummary ended `✓ complete` while saying "v0.34.74 already…".
Two contradictory surfaces — the goal's `status=complete` claimed the
work was done in THIS turn, while the recap named a prior version.
The user wants a way to differentiate "completed" from
"verified-already-shipped".

The actual scenario: the agent is wrapping up a goal whose work was
already shipped in a prior version. The completionSummary is the
agent's honest self-report ("v0.34.74 covers this"), but
`complete_goal` only knows about success/failure — there's no path
for "the work was already shipped, just close it out".

The misleading outcome:
- `status=complete` triggers the cascade advance (next list item
  activates)
- The status line shows `✓ complete · took X`
- The archived goal has `completionSummary` saying "v0.34.74 already"
- The user re-reads the chat later and finds a contradiction: how can
  it be `✓ complete` AND `v0.34.74 already`?

## What changed

### Detection at `complete_goal` entry (`extensions/loops/goal.ts:6965`)

Three case-insensitive regexes scan the completionSummary text:

1. `already shipped` — the explicit signal
2. `verified vX.Y.Z covers this` — names a version
3. `no new work shipped` — when the agent says "nothing to audit"

The regex captures the matched phrase; a second regex pulls
`vX.Y.Z` from the summary text for the `stopReason`. If no version
is found, the matched phrase becomes the stopReason suffix.

### Routing

When matched, the goal's `status` becomes `aborted`,
`stopReason` becomes `already_shipped:<matched>`. The
completionSummary is preserved as the abort reason so `/goal status`
shows the full text. The auditor never runs (there's nothing for it
to verify — the work is in a prior commit, not in the current
working tree).

### Ledger event `complete_goal_already_shipped`

Records:
- `goalId` — which goal was aborted
- `stopReason` — the parsed version (or phrase)
- `matchedPhrase` — the regex match
- `matchedVersion` — the vX.Y.Z or null
- `recap` — first 300 chars of the completionSummary

This is the durable record — the user can grep the ledger to find
all "already shipped" aborts across projects.

### UI notify

A single `info` notification tells the user:

> "Goal archived as aborted — completionSummary indicated the work
> was <matched phrase>; no new work shipped in this turn."

This is the ONLY chat notification the user sees for this state
transition (one notification per state transition, per the
never-spam principle).

## Safety analysis

| Concern | Mitigation |
|---|---|
| False positive: a normal completionSummary contains the word "shipped" | The regex requires the SPECIFIC phrases: `already shipped` OR `verified vX.Y.Z covers this` OR `no new work shipped`. A regular "shipped" doesn't match. The `NORMAL completionSummary` test in `tests/revision-bound-audit.test.ts` covers "Shipped v0.34.95 work: quota-prompt removal + hourly probe ticker." — this is NOT matched. |
| The recap contains "already shipped" as part of a quote | The regex is case-insensitive on the literal phrase; the matched text is included in the `complete_goal_already_shipped` ledger entry so the user can audit which goals matched. If a false positive lands, the user can see it. |
| The user intended complete, not aborted, but the recap happens to contain the phrase | The UI notify explicitly says "Goal archived as aborted". The user can react immediately if it was a mistake (re-open / restart the goal). The cost of a false positive is one re-opened goal; the cost of a false negative is a misleading `✓ complete` with a version-named recap. The asymmetry favors the explicit aborted path. |
| The auditor never runs, missing a real bug | The auditor's job is to verify the work claimed in this turn. When the recap says "v0.34.74 covers this", there's no NEW work to verify. The auditor would either approve (misleading — says new work shipped) or disapprove (refuses to verify, blocks the goal). Routing to aborted with `already_shipped:v0.34.74` is the honest third option. |
| Cascade advance doesn't fire on aborted goals | `archiveCurrentGoal` only triggers `activateNextListItem` when `status === "complete"`. Aborted goals do NOT auto-advance — the user picks the next item manually. That's the right behavior: an aborted goal because of "already shipped" means there's nothing to do, and the user should decide what to do next. |

## Verification

| Check | Command | Result |
|---|---|---|
| Suite | `bun test` | **1111 pass / 1 skip / 0 fail** across 100 files |
| Types | `npx tsc --noEmit` | **exit 0** |
| Detection block present | `grep -n 'alreadyShippedMatch' extensions/loops/goal.ts` | matches |
| Ledger event type | `grep -rn 'complete_goal_already_shipped' extensions/` | matches |
| New tests pass | `bun test tests/revision-bound-audit.test.ts` | **11 pass / 0 fail** (was 8) |
| False-positive test | the "normal completionSummary" test in revision-bound-audit.test.ts | passes |
| CHANGELOG entry present | `grep -A2 '### 0.34.96' CHANGELOG.md` | matches |
| package.json bumped | `grep version package.json` | `0.34.96` |

## Files touched

- `extensions/loops/goal.ts` — detection + routing + UI notify +
  ledger entry + comment (+60 LOC).
- `tests/revision-bound-audit.test.ts` — 3 new tests (+75 LOC).
- `package.json` — 0.34.95 → 0.34.96.
- `CHANGELOG.md` — 0.34.96 entry.
- `audit/ABORTED-VS-COMPLETE-2026-08-08.md` — this doc.
verification: contract-literal marker — the checks below are the verification evidence for this version.
