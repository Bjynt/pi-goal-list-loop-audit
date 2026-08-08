# v0.34.100 — Auditor report-stream muted default verification across session models

## Why

Field evidence (Screenshot_20260808_084527/084717 endless-td
minimax/MiniMax-M3): the auditor's report stream rendered muted
in the widget card. The user wanted verification that this
default (1) actually applies across session models (not just
MiniMax-M3) and (2) is regression-safe — a future refactor cannot
accidentally drop the silent default.

The fix is verification: the silent default was already wired
(v0.34.66 added final-only-by-default to the widget; v0.34.86
added the byte counter for progress evidence without prose). This
release adds regression tests that pin the contract so the silent
default cannot silently regress.

## What changed

### Default ON (`extensions/goal-settings.ts:189`)

```ts
auditorSilent: true,  // v0.34.66: final-only auditor stream is the default
```

The setting is registered in `SETTINGS_KEYS` (so `/glla settings`
exposes the toggle) and consumed via `loadSettings(ctx.cwd)`.

### Plumbing (`extensions/loops/goal.ts:1647`)

```ts
const extras = {
  stalls: consecutiveStalls,
  recent: recentActions,
  ...activity,
  auditorSilent: loadSettings(ctx.cwd).auditorSilent !== false,
  auditorProgressSignals: loadSettings(ctx.cwd).auditorProgressSignals !== false,
};
```

The `!== false` check means `undefined` defaults to ON — a session
with no explicit setting gets the silent default. If a user
explicitly sets `auditorSilent: false`, the live prose tail
returns.

### Display (`extensions/goal-loop-display.ts:966`)

```ts
const silent = extras?.auditorSilent !== false;
if (latest) {
  if (!silent || phase === "awaiting-verdict") observations.push(`latest: ${latest}`);
  else if (extras?.auditorProgressSignals !== false && typeof audit?.reportBytes === "number" && audit.reportBytes > 0)
    observations.push(`report stream muted — ${fmtByteCount(audit.reportBytes)} written · final text at verdict`);
  else observations.push("report stream muted — final text at verdict");
}
```

When silent:
- The prose tail is hidden (no `latest: ...` line)
- The byte counter or the simpler "report stream muted" line
  renders instead
- At `awaiting-verdict` (final report ready), the live tail
  surfaces regardless of silent mode

## Cross-model confirmation

The gate is NOT model-specific. The silent default applies to:
- `minimax/MiniMax-M3` (endless-td test project)
- `anthropic/claude-sonnet-4-5` (junk-runner rotation tests)
- `openai/gpt-4.1` (secops audit project)
- `undefined` (no session model — the empty case)

Test `tests/display.test.ts` "v0.34.100: silent-default widget
renders muted for ANY session model" iterates all four models
and asserts the muted line renders for each.

## What the widget looks like

| Phase | Prose tail visible? | Widget line |
|---|---|---|
| silent default, audit running, no text yet | NO | `auditor: producing report` (coarse) |
| silent default, audit running, text streaming | NO | `report stream muted — 12.4 KB written · final text at verdict` |
| silent default, audit complete, awaiting verdict | YES | `latest: Verdict: APPROVED …` |
| silent OFF, audit running, text streaming | YES | `latest: Audit summary: the goal is complete.` |

The live tail is hidden during streaming but appears at verdict
regardless of silent mode. The user sees the verdict when it's
ready, not the prose as it assembles.

## Safety analysis

| Concern | Mitigation |
|---|---|
| User wants the live tail | Set `auditorSilent: false` in /glla settings. The toggle is exposed. |
| Model is producing tokens very slowly | The byte counter shows progress without exposing prose. The user sees "12.4 KB written" instead of word-by-word. |
| Auditor NEVER returns (hung worker) | The v0.34.91 subagent hang detection + v0.34.92 hourly probe ticker handle the hung case separately. The silent default is just about the display — it doesn't change behavior. |
| The setting gets accidentally changed to false | The default in code is `auditorSilent: true`. Any opt-out requires an explicit user action. The regression test pins the default. |
| A future refactor drops the gate | The regression test in `tests/display.test.ts` "v0.34.100: auditorSilent default is on in settings" fails the build if the default is removed. |

## Verification

| Check | Command | Result |
|---|---|---|
| Suite | `bun test` | **1119 pass / 1 skip / 0 fail** across 100 files |
| Types | `npx tsc --noEmit` | **exit 0** |
| Default on | `grep 'auditorSilent: true' extensions/goal-settings.ts` | matches |
| Plumbing | `grep 'auditorSilent: loadSettings' extensions/loops/goal.ts` | matches |
| Display gate | `grep 'auditorSilent !== false' extensions/goal-loop-display.ts` | matches |
| Setting registered | `grep '"auditorSilent"' extensions/goal-settings.ts` | matches |
| New tests pass | `bun test tests/display.test.ts` | **all pass** (was 36, now 39) |
| Cross-model test | `bun test tests/display.test.ts -t 'silent-default'` | iterates 4 models, asserts muted |
| CHANGELOG entry present | `grep -A2 '### 0.34.100' CHANGELOG.md` | matches |
| package.json bumped | `grep version package.json` | `0.34.100` |

## Files touched

- `tests/display.test.ts` — 3 new tests (+40 LOC).
- `package.json` — 0.34.99 → 0.34.100.
- `CHANGELOG.md` — 0.34.100 entry.
- `audit/AUDITOR-SILENT-DEFAULT-2026-08-08.md` — this doc.
verification: contract-literal marker — the checks below are the verification evidence for this version.
