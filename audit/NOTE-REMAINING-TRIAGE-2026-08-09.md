# note.md remaining-item triage — v0.34.121

User request: re-check `/home/dracon/chat/pi/note.md`, identify anything still unaddressed, and test each item. The note now contains 15 finding headings, including the newer subagent-visual screenshot. On 2026-08-09 the source note was annotated in place with the status of every finding; this audit is the durable detailed record.

## Status matrix

| Note item | Current result | Evidence / action |
|---|---|---|
| Main-model fallback selector | **Fixed in v0.34.118** | Dedicated Backups tab; forbidden-aware picker; `tests/model-picker.test.ts`, `tests/settings-editors.test.ts`. |
| Better completion summaries (#2) | **Fixed/corrected in v0.34.119; auto-close completed in v0.34.120** | Existing recap rendering was already present. Capture ordering validates the summary BEFORE `beginCompletionAudit`, and approved/aborted archive paths now clear the live slot after preserving the recap. `tests/image1-list-stall-and-count-fix.test.ts` and behavioral lifecycle tests pin this. |
| Auditor tool-name spam (#3) | **Not a glla history-spam bug in current HEAD** | Current widget exposes one current/last tool observation and silent final-only report mode. Existing `display.test.ts` / auditor tests pass. The referenced screenshot's repeated `π - <letter>` row is the host terminal's process/tab strip, not a rendered glla tool-call history. No safe plugin-side dedup change was invented. |
| “pi did not start a turn” (#4) | **Fixed** | Persisted dispatch proof, 30s timeout, one verbatim retry, then explicit stand-down. Behavioral orchestrator tests pass. |
| Slightly-over-context (#5) | **Fixed, with intentional strict gate** | Context-overflow classification only rotates after compaction has already been attempted; `context-overflow-recovery.test.ts` passes. Length caps remain non-recoverable by design. |
| Host session lost (#6, repeated screenshots) | **Partly fixed / pi API limitation documented** | Durable stale detection, ownership/rebind, host-loss tests, and terminal parking work. The public event `ExtensionContext` does not expose `newSession`; only `ExtensionCommandContext` does. v0.34.117 incorrectly cast `ExtensionAPI.newSession` (which does not exist) and therefore did not auto-create a session against the real SDK. v0.34.119 removes that false claim, checks the actual context capability, and gives truthful `/new` guidance. Fully automatic replacement requires a pi-side API change. |
| External Qwen/ChatGPT reviews (#7) | **Researched; evidence archived; Qwen blocked** | ChatGPT share was fetched HTTP 200 and relevant raw excerpts are in `audit/EXTERNAL-REVIEWS-2026-08-09.md`; its old monolith-size criticism was rechecked against current `goal.ts` (388 lines) and sibling modules. Qwen landing HTML was fetched but its review API returned 401, so its content remains unverified. No actionable plugin critique remains beyond already-shipped architecture work. |
| Refresh icon spacing (#8) | **Not reproducible in current glla source** | Current status renderer uses ` · last stream ${age} ago`; existing display tests pin the spacing. No `↻` producer exists in this repository. The screenshot is from an older/host UI path; no source change was justified. |
| Multiple active threads (#9) | **Fixed at artifact level; start-time confirmation added in v0.34.120** | `autoArbitrateStackedState` retains the newest artifact and archives the loser. New goal/list/loop starts now explicitly offer update/replace/cancel instead of silently stacking or replacing. Behavioral tests cover goal-vs-loop conflicts and legacy stacked state. This is not a promise that pi itself cannot have multiple historical session files. |
| “Goals never close” (#10) | **Fixed and auto-closed in v0.34.120** | Auditor approval archives terminal goals, emits exactly one final recap notification, and clears the live slot; legacy terminal slots close on session start. List completion still activates exactly one next item and leaves the final queue empty. |
| `/glla cancel` semantics (#11) | **Fixed in v0.34.120/0.34.121** | `/glla cancel` cancels the active objective: a list item plus all waiting list items; an unrelated standalone live goal takes precedence over a waiting backlog, and an active loop is stopped before an unrelated waiting queue is considered. Abort happens after durable cleanup so the command does not require repetition. `/list cancel` remains the explicit list spelling; `/glla wipe` remains the all-state destructive reset. |
| Stale ctx requiring `/new` (#12) | **Truthfully corrected, not magically solved** | `/reload` does not clear pi's cached stale context. Display guidance now says `/new`, and the recovery helper no longer claims `ExtensionAPI.newSession`. Automatic no-typing recovery is blocked by pi's public event-context API; this is filed as a pi-side limitation rather than hidden. |
| Rate-limit / Token Plan wall (#13) | **Fixed and tested** | `quota-retry.ts` recognizes plan-quota 429s; main-model recovery parks durably and walks the configured backup chain; v0.34.118 provides the selector. Existing quota recovery/display tests and new picker tests pass. |

| Subagent transcript visuals (#15) | **Reviewed / pi limitation documented in v0.34.121** | MMX vision review of `Screenshot_20260809_220633.png` identifies pi's native subagent tree: expanded entries show metadata but no full transcript/diff or side-by-side scratchpad reveal. No glla-owned renderer or public host hook owns this surface; a full fix requires a pi-side transcript/reveal API and UI. |

## Tests added or updated

- `tests/image1-list-stall-and-count-fix.test.ts` — completion-summary canonicalization happens before the audit claim is persisted.
- `tests/behavioral-orchestrator.test.ts` — approved list completion archives the current item and activates exactly the next item; `/glla cancel` drops the full list objective.
- `tests/list-queue.test.ts` — source contract for whole-objective cancellation.
- `tests/fresh-session-auto-recovery.test.ts` — current SDK capability boundary; no false `ExtensionAPI.newSession` claim; `/new` guidance.
- `tests/stale-interrupt-resume.test.ts`, `tests/display.test.ts`, `tests/behavioral-orchestrator.test.ts` — stale guidance changed from misleading `/reload` to `/new`.
- `mmx vision describe --image /home/dracon/Pictures/Screenshots/Screenshot_20260809_220633.png ...` — confirms the new subagent-visual surface is pi-owned, not a glla display regression.

## Verification

```text
npx tsc --noEmit                       clean
bun test                               1209 pass / 1 skip / 0 fail across 107 files
focused recovery/display/closure/list tests pass
note status count                       15 (all finding headings explicitly annotated)
```

## Explicit remaining pi-side item

Pi must expose a safe session-replacement action to event handlers (or an equivalent host-level recovery hook) if glla is expected to create a fresh session automatically after a stale event-context error. The extension cannot safely manufacture a replacement `AgentSessionRuntime` from the public `ExtensionContext`; it can only preserve state, stop blind sends, and direct the user to `/new`.

Pi also owns the subagent transcript/reveal surface shown in the new screenshot. A glla extension cannot add the missing full-output/diff affordance to pi's native subagent tree without a host-level rendering or transcript API; glla records the limitation rather than claiming a plugin fix.
