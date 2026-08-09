# note.md remaining-item triage — v0.34.119

User request: re-check `/home/dracon/chat/pi/note.md`, identify anything still unaddressed, and test each item. The note contains 13 actionable observations, including the newer rate-limit screenshot. On 2026-08-09 the source note was annotated in place with the status of every finding; this audit is the durable detailed record.

## Status matrix

| Note item | Current result | Evidence / action |
|---|---|---|
| Main-model fallback selector | **Fixed in v0.34.118** | Dedicated Backups tab; forbidden-aware picker; `tests/model-picker.test.ts`, `tests/settings-editors.test.ts`. |
| Better completion summaries (#2) | **Fixed/corrected in v0.34.119** | Existing recap rendering was already present. New capture ordering validates the summary BEFORE `beginCompletionAudit`, so the canonical warning reaches `pendingCompletion`, the detached auditor, retries, and archive. `tests/image1-list-stall-and-count-fix.test.ts` pins the order. |
| Auditor tool-name spam (#3) | **Not a glla history-spam bug in current HEAD** | Current widget exposes one current/last tool observation and silent final-only report mode. Existing `display.test.ts` / auditor tests pass. The referenced screenshot's repeated `π - <letter>` row is the host terminal's process/tab strip, not a rendered glla tool-call history. No safe plugin-side dedup change was invented. |
| “pi did not start a turn” (#4) | **Fixed** | Persisted dispatch proof, 30s timeout, one verbatim retry, then explicit stand-down. Behavioral orchestrator tests pass. |
| Slightly-over-context (#5) | **Fixed, with intentional strict gate** | Context-overflow classification only rotates after compaction has already been attempted; `context-overflow-recovery.test.ts` passes. Length caps remain non-recoverable by design. |
| Host session lost (#6, repeated screenshots) | **Partly fixed / pi API limitation documented** | Durable stale detection, ownership/rebind, host-loss tests, and terminal parking work. The public event `ExtensionContext` does not expose `newSession`; only `ExtensionCommandContext` does. v0.34.117 incorrectly cast `ExtensionAPI.newSession` (which does not exist) and therefore did not auto-create a session against the real SDK. v0.34.119 removes that false claim, checks the actual context capability, and gives truthful `/new` guidance. Fully automatic replacement requires a pi-side API change. |
| External Qwen/ChatGPT reviews (#7) | **Researched; Qwen blocked** | ChatGPT share was fetchable and praised completion integrity/detached auditing while criticizing maintainability; current `goal.ts` is 387 lines and the runtime is split. Qwen landing HTML was fetchable but its review API returned 401, so its content could not be independently retrieved. No actionable code critique remained beyond already-shipped architecture work. |
| Refresh icon spacing (#8) | **Not reproducible in current glla source** | Current status renderer uses ` · last stream ${age} ago`; existing display tests pin the spacing. No `↻` producer exists in this repository. The screenshot is from an older/host UI path; no source change was justified. |
| Multiple active threads (#9) | **Fixed at artifact level** | `autoArbitrateStackedState` retains the newest artifact and archives the loser. Behavioral tests cover goal-vs-loop stacked state and carryover. This is a one-active-artifact guarantee, not a promise that pi itself cannot have multiple session files. |
| “Goals never close” (#10) | **Fixed and now integration-tested** | Auditor approval archives terminal goals; list completion activates exactly one next item and leaves the final queue empty. New behavioral test asserts archive, `goal_archived(status=complete)`, next-item activation, and queue state. |
| `/glla cancel` semantics (#11) | **Fixed in v0.34.119** | `/glla cancel` now cancels the active objective: a list item plus all waiting list items; standalone goals and loops retain their distinct paths. New behavioral and source tests pin this. `/list cancel` remains the explicit list spelling; `/glla wipe` remains all-state destructive. |
| Stale ctx requiring `/new` (#12) | **Truthfully corrected, not magically solved** | `/reload` does not clear pi's cached stale context. Display guidance now says `/new`, and the recovery helper no longer claims `ExtensionAPI.newSession`. Automatic no-typing recovery is blocked by pi's public event-context API; this is filed as a pi-side limitation rather than hidden. |
| Rate-limit / Token Plan wall (#13) | **Fixed and tested** | `quota-retry.ts` recognizes plan-quota 429s; main-model recovery parks durably and walks the configured backup chain; v0.34.118 provides the selector. Existing quota recovery/display tests and new picker tests pass. |

## Tests added or updated

- `tests/image1-list-stall-and-count-fix.test.ts` — completion-summary canonicalization happens before the audit claim is persisted.
- `tests/behavioral-orchestrator.test.ts` — approved list completion archives the current item and activates exactly the next item; `/glla cancel` drops the full list objective.
- `tests/list-queue.test.ts` — source contract for whole-objective cancellation.
- `tests/fresh-session-auto-recovery.test.ts` — current SDK capability boundary; no false `ExtensionAPI.newSession` claim; `/new` guidance.
- `tests/stale-interrupt-resume.test.ts`, `tests/display.test.ts`, `tests/behavioral-orchestrator.test.ts` — stale guidance changed from misleading `/reload` to `/new`.

## Verification

```text
npx tsc --noEmit                       clean
bun test                               1202 pass / 1 skip / 0 fail across 107 files
focused recovery/display/closure/list tests pass
```

## Explicit remaining pi-side item

Pi must expose a safe session-replacement action to event handlers (or an equivalent host-level recovery hook) if glla is expected to create a fresh session automatically after a stale event-context error. The extension cannot safely manufacture a replacement `AgentSessionRuntime` from the public `ExtensionContext`; it can only preserve state, stop blind sends, and direct the user to `/new`.
