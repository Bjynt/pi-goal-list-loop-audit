# v0.34.99 — Quota prompt verbosity (CLOSED via v0.34.92)

## Why

The original finding (note.md 2026-08-08): the v0.34.58 hourly
quota-resume prompt was verbose — the chat message dumped the full
turn snapshot (`goal: <objective> — main model quota: 429 rate
limit: ...`) into the chat. Useful for debugging, awful for the
user.

## Resolution

CLOSED via the v0.34.92 reversal. v0.34.92 removed the entire
quota-prompt surface:

- `Goal.quotaPromptedAt`, all `quotaPrompt*` machinery (~250 LOC,
  6 functions, 8 call sites, 4 module vars), the `safeSteerUser(
  "Provider quota wall — …")` chat copy — all deleted.
- The plugin never says "Provider quota wall" in chat anymore.
  There is no message to be verbose.

The verbosity complaint is therefore moot. The hourly probe ticker
(also added in v0.34.92, default ON at `:00:30`) gives the same
fast quota pickup without any chat text.

## Verification

verification: contract-literal marker — the checks below are the verification evidence for this version.

| Check | Command | Result |
|---|---|---|
| No quota-prompt machinery remains | `grep -rn 'quotaPrompt' extensions/ tests/` | 0 matches |
| No chat copy remains | `grep -rn 'Provider quota wall' extensions/` | 0 matches |
| Hourly probe default ON | `grep 'hourlyQuotaProbe' extensions/goal-loop-core.ts` | DEFAULT_HOURLY_QUOTA_PROBE = true |
| Ticker fires at :00:30 | `bun test tests/hourly-quota-probe.test.ts` | 14 pass / 0 fail |
| CHANGELOG entry | `grep '^### 0.34.99' CHANGELOG.md` | present, references v0.34.92 |

## Files touched

- `CHANGELOG.md` — 0.34.99 entry (references v0.34.92).
- `package.json` — bumped to 0.34.99.
- `audit/QUOTA-PROMPT-VERBOSITY-2026-08-08.md` — this doc.
- No code change in v0.34.99 (the fix landed in v0.34.92).
