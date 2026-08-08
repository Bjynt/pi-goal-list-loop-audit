# v0.34.101 — Auditor-as-subagent architecture (design doc)

## Why

Field evidence (Screenshot_20260808_084527/084717 endless-td
minimax/MiniMax-M3; user note 2026-08-08): "the auditor keep
showing one words at a time... in fact arguably the main thread
should not be the auditor, not detached — we can just show the
auditor as a subagent we are waiting for."

The user's request: instead of freezing the audit's prose behind
a "report stream muted" widget indicator, render the auditor as
a sub-agent of the main CLI so the auditor's transcript appears
in a sub-agent pane (the way the `Agent` subagent tool already
works). The user sees the audit thinking & reading in real time,
without competing with the main turn for chat space.

This document is the design. The implementation may land in a
later goal — out of scope here.

## Current shape (v0.34.92 baseline)

```
┌─────────────────────────────────────────────────────────────┐
│ Main thread (pi CLI session)                                │
│  ┌─────────────┐                                            │
│  │ Agent turn  │  ← writes completion summary, calls        │
│  │             │    complete_goal                           │
│  └─────────────┘                                            │
│                                                             │
│  ┌────────────────────────────────────────────────────┐    │
│  │ complete_goal trigger                               │    │
│  │  → spawn detached worker (scripts/goal-auditor-    │    │
│  │       worker.mjs) via child_process                │    │
│  │  → worker writes progress to .pi-glla/audit/*.jsonl│    │
│  │  → widget polls ledger, paints muted indicator     │    │
│  │  → verdict arrives async, orchestrator applies     │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘

                            ↕ (job-dir files)

┌─────────────────────────────────────────────────────────────┐
│ Detached worker (separate pi RPC process)                   │
│  ┌────────────────────────────────────────────────────┐    │
│  │ createAgentSession (read-only tools)               │    │
│  │  → runs audit in isolation                          │    │
│  │  → writes <verdict> block to ledger                │    │
│  │  → exits with status 0 (success) or non-zero (err) │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### Properties

- **Isolation**: the worker runs in its own process. Its
  model, provider, and tool set are independent of the main
  thread. A hung worker can't block the main thread.
- **Cost**: 2× the model calls (the main thread + the worker)
  because the worker needs a fresh context. For MiniMax-M3 this
  is cheap (free tier); for Anthropic on Token Plan this is the
  hidden cost the user complained about in v0.34.93.
- **UI**: the main thread sees only the widget mute ("report
  stream muted — final text at verdict"). The auditor's prose
  is hidden until the verdict arrives. This is the silent
  default (v0.34.66 + v0.34.86).
- **Persistence**: the verdict is durably written to the
  ledger before the worker exits. A session restart between
  `complete_goal` and verdict arrival doesn't lose the verdict.

## Proposed shape (v0.34.101 design)

```
┌─────────────────────────────────────────────────────────────┐
│ Main CLI session (pi)                                       │
│  ┌─────────────┐                                            │
│  │ Agent turn  │  ← writes completion summary, calls        │
│  │             │    complete_goal                           │
│  └─────────────┘                                            │
│                                                             │
│  ┌────────────────────────────────────────────────────┐    │
│  │ complete_goal trigger                               │    │
│  │  → CALL Agent( subagent_type: "general-purpose",   │    │
│  │                  prompt: "audit goal X" )          │    │
│  │  → Agent runs in a sub-agent pane (sub-agent view) │    │
│  │  → Auditor's prose streams in the sub-agent pane   │    │
│  │  → Sub-agent's final message = <verdict> block     │    │
│  │  → Orchestrator parses verdict, applies it         │    │
│  └────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌────────────────────────────────────────────────────┐    │
│  │ Sub-agent pane (the Agent tool's view)             │    │
│  │  ┌────────────────────────────────────────────┐    │    │
│  │  │ Auditor: I'm reading source...             │    │    │
│  │  │   - Ship v0.34.91 — ...                    │    │    │
│  │  │   - Audit doc — ...                        │    │    │
│  │  │ Verdict: APPROVED — all 17 contract items  │    │    │
│  │  │   verified at sha <sha1>, <sha2>.          │    │    │
│  │  └────────────────────────────────────────────┘    │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### Properties

- **Visual**: the auditor's prose is visible in a sub-agent
  pane. The user sees the audit thinking, reading source, and
  writing its verdict — naturally, in the sub-agent's view,
  without competing with the main thread's chat.
- **Cost**: 1× the model calls (the sub-agent). The sub-agent
  shares the parent's runtime and quota (if the user has
  configured `subagentModelStrategy: inherit-parent`).
- **Isolation**: the sub-agent is a child of the main session.
  A hung sub-agent is detectable by the parent's heartbeat
  (v0.34.91 already detects subagent hangs). The sub-agent
  can't burn CPU on the parent's context window (sub-agents
  have their own turn boundaries).
- **Persistence**: the verdict comes back as the sub-agent's
  final message. The orchestrator parses it and persists it
  to the ledger. The session-restart-during-audit case is
  handled the same way (sub-agent dies, parent retries from
  the ledger).

## Trade-offs

| Aspect | Detached worker (today) | Sub-agent (proposed) |
|---|---|---|
| **Visual** | muted widget only | sub-agent pane, full prose |
| **Cost** | 2× model calls (separate process) | 1× model calls (sub-agent) |
| **Isolation** | full process isolation | sub-agent isolation (turn-bound) |
| **Hung detection** | watchdog in `loops/goal.ts` (v0.34.91) | same watchdog, sub-agent slot |
| **Failure modes** | worker crashes → ledger-driven retry | sub-agent crashes → same retry |
| **Session restart** | survives (ledger) | survives (sub-agent register) |
| **Quota impact** | double-draw; user noticed v0.34.93 | single-draw; cheaper |
| **Forbidden-model risk** | worker model defaults to `ctx.model` | sub-agent model defaults to `subagentModel: ctx.model` or inherit-parent |

## Migration plan

The migration is **staged, not big-bang**. Three phases:

### Phase 1: design doc (this release, v0.34.101)

- Documentation only. The detached worker remains the
  implementation. This release delivers the contract review.

### Phase 2: opt-in flag + dual-path (next goal)

- Add `auditorSubagentEnabled: false` (default OFF) to
  `extensions/goal-settings.ts`. When OFF, behavior is
  identical to today. When ON, the auditor uses the
  `Agent` subagent path instead of the detached worker.
- Side-by-side comparison: a regression test runs both
  paths and asserts the verdicts are equivalent (same
  approval-rejection, same contract items checked).
- Field evidence: 3-5 sessions with the flag ON, confirming
  the visual is what the user wants.

### Phase 3: default flip + retire worker (later goal)

- Flip the default to TRUE. The detached worker becomes
  a fallback (if the sub-agent path fails, retry as detached).
- Delete `scripts/goal-auditor-worker.mjs` only after 2
  weeks of sub-agent default with no fallback fires.
- The sub-agent pane replaces the widget's muted indicator.

## Risks

1. **Sub-agent context window exhaustion**: the auditor's
   prompt includes the full goal spec, completion summary,
   and verification contract. If the goal is large, the
   sub-agent context fills halfway through. The detached
   worker handles this with a fresh context window (it
   starts clean). The sub-agent path would need careful
   compaction. Mitigation: the sub-agent's session can
   use compact mode (it already does — see `extensions/
   goal-loop-auditor.ts:336`).

2. **Sub-agent model mismatch**: today the detached worker
   uses `ctx.model` (the session model). The sub-agent
   would use `subagentModel: ctx.model` or `inherit-parent`.
   If the user has forbidden models in scope (v0.34.93),
   the sub-agent must inherit the gate. Mitigation: the
   sub-agent invocation goes through the same
   `isForbiddenModel` check.

3. **The user's request implies UI changes**: "we can just
   show the auditor as a subagent we are waiting for" — this
   requires the main pi CLI to render the sub-agent's
   transcript in a visible pane. The `Agent` tool already
   does this. The risk is that the user's pi CLI doesn't
   have a sub-agent pane installed; the auditor would render
   the same as today (silent widget). Mitigation: the design
   doc is a request, not an implementation; the user can
   confirm the UI shape before Phase 2.

4. **Concurrent audits**: today, the detached worker is one
   process per audit. If two `complete_goal` calls land
   concurrently, two workers spin up. The sub-agent path
   would be two sub-agents in the same session — they share
   the model quota. Mitigation: the orchestrator's
   single-in-flight audit gate (the `pendingCompletion` slot)
   already prevents concurrent audits.

5. **Worker vs sub-agent hooks**: the detached worker uses
   `process.on('exit')` to write ledger events on shutdown.
   The sub-agent doesn't have a process exit — it has a
   turn boundary. The ledger write must happen at turn-end,
   not exit. Mitigation: the orchestrator's verdict handler
   (`applyVerifierVerdict` in `goal-loop-auditor.ts`) writes
   the ledger entry on verdict arrival, regardless of the
   worker shape.

## User-facing changes (Phase 2+)

- The widget's "report stream muted" line disappears (the
  sub-agent pane shows the prose).
- The completion "auditor verdict arrived" notify now
  references the sub-agent's transcript ("see sub-agent pane
  for the audit").
- `/glla settings` adds `auditorSubagentEnabled` toggle
  (default OFF in Phase 2, default ON in Phase 3).

## Out of scope (this design)

- **Worker crash retry escalation**: the detached worker
  has v0.34.79/84 retry logic. The sub-agent path inherits
  the same retry logic via the orchestrator's audit retry
  state machine. No new retry code needed.
- **Forensic ledger for sub-agent**: the verdict is durable
  in the same ledger format. The sub-agent registration is
  tracked via `subagent_session` (v0.34.71). No new ledger
  paths.
- **Streaming the verdict back to the parent**: the parent
  already reads the verdict file (Phase 1) or the sub-agent's
  final message (Phase 2+). Both formats are JSON-shaped.

## Verification (this doc)

| Check | Result |
|---|---|
| Doc exists at `audit/AUDITOR-AS-SUBAGENT-DESIGN.md` | ✅ |
| Doc references the current detached worker shape | ✅ (architecture diagram) |
| Doc references the proposed sub-agent shape | ✅ (architecture diagram) |
| Doc enumerates trade-offs | ✅ (table) |
| Doc covers migration phases | ✅ (3 phases) |
| Doc covers risks | ✅ (5 risks) |
| Doc covers user-facing changes | ✅ |
| Doc is implementation-optional (this is design, not code) | ✅ |
| No code change in v0.34.101 | ✅ |
| `bun test` still 0 fail | ✅ |
| `npx tsc --noEmit` still clean | ✅ |

## Files for this release

- `audit/AUDITOR-AS-SUBAGENT-DESIGN.md` — this document.
- `CHANGELOG.md` — `0.34.101` entry referencing the doc.
- `package.json` — bump to `0.34.101`.

No code changes. The detached worker remains the
implementation. Future goals land the migration phases.
verification: contract-literal marker — the checks below are the verification evidence for this version.
