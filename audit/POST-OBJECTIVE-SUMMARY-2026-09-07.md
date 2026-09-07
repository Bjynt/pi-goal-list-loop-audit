# Post-Objective Summary — cross-harness survey + chosen shape (2026-09-07)

Goal grill (2026-09-07): Survey scope = **external survey first**; Late verdict
= **persist + replay**; Summary shape = check others first, but the human-sees
render is the hard constraint; Release = **ship patch**.

Field failure that motivated this: goal `20260907131550-12ddoy` completed with a
perfect six-label archive record, but `buildApprovalChatLines` fired into a dead
context (verdict landed with no live turn) — record perfect, delivery silent.

## Survey table (evidence-quoted, no inference)

| Harness | End-of-run shape | Stats line | Persistent record | Follow-up / resume |
|---|---|---|---|---|
| Codex CLI `0.147.0` | Agent-authored final Markdown; **no fixed template** — "Codex does not impose a fixed summary template or mandatory section order." Stable structure is only activity → final message → token report. Rigid shape is caller-defined (`--output-schema`). | Aggregate "tokens used"; **no currency-cost footer** observed. | Sessions persisted by default (UUID/name, resume/archived/fork/delete); `--ephemeral` opt-out; `--output-last-message <FILE>` saves the last agent message. | Agent-authored next steps; `resume [--last]`, `--include-non-interactive`. |
| Claude Code (direct CLI inspection) | Agent's final message ends the run; **no fixed end-summary template** in `--help`. Machine shape only: `--output-format text\|json\|stream-json` + `--json-schema`. | No cost/usage flag in `--help` output (usage surfaces in-session, not as an end footer). | `~/.claude/transcripts/ses_*.jsonl` — event-sourced (`user`/`tool_use`/`tool_result`, 185-line specimen has **no summary-footer object**); per-project dirs; `-c/--continue`, `--resume`, `--fork-session`; `--no-session-persistence` opt-out mirrors Codex `--ephemeral`. | Agent-authored; resume/continue/fork flags. |
| pi-goal-x `v0.26.1` (in-repo source) | **Fixed** `buildCompletionReport` order: `Goal audit approved.` → `Auditor approval:` + raw output → `Goal complete.` → `Task summary:` → full `detailedSummary`; plus `GOAL_AUDIT_ENTRY` phase cards (start/approve/reject/skip) and a `Goal archived.\nFile: <path>` notify at `turn_end`. | `usageLines`: `Time spent: …`, `Tokens used: …` + `Tasks: X/Y complete`; dashboard footer `goal: running [49h 19M] - <objective>`. | Per-goal markdown (`active_goal_*.md` → archived) + append-only `goal_events.jsonl` (`completion_requested`, `audit_result`, `goal_completed`, `goal_archived`) + in-memory `goalDetails`. | Escape-bypass trailing ask ("Provide a final summary of what was accomplished."); turn-stop rule forces "brief summary and yield". |
| GLLA `v0.38.24` (self) | `buildApprovalChatLines`: `✓ done — outcome` + ≤2 details (stale `Next:` stripped) + approval trailer + record pointer. Sibling screenshots (`Screenshot_20260907_153747/154742.png`) confirm outcome-first + ≤2 + approval + record is the right human shape. | Six-label archive record (Outcome/Changed/Evidence/Tests/Unresolved/Next); telemetry turns/file-writes/bash in facts-fallback. | Archive markdown + `active.jsonl` + ledger (`goal_archived`, `audit_verdict_*`). **Gap: the rendered human summary is NOT persisted** — hence silent when the verdict lands between turns. | Auditor verdict + `/goal` continuation; **gap: no replay** of an undelivered approval render. |

Full scout briefs: `subagent-artifacts/outputs/summary-survey/codex.md` (workflow
`8d81a972` nest), `…/summary-survey/antigravity.md` (pi-goal-x in-repo survey),
Claude leg closed by direct inspection (below).

## What the survey teaches

1. **Nobody templates the human summary.** Codex and Claude both leave the final
   message to the agent and standardize only usage reporting, session
   persistence + resume, and machine-readable shape. pi-goal-x is the outlier
   with a fixed report builder — and its fixed order (verdict → complete →
   task summary → full detail) validates GLLA's outcome-first instinct.
2. **Everybody persists the session; nobody persists the render.** Codex keeps
   sessions + last-message files; Claude keeps event transcripts; pi-goal-x
   keeps goal files + ledger. GLLA already keeps the record — the missing piece
   everywhere (and the field failure here) is the **rendered human summary as a
   durable artifact with replay**.
3. **Resume is a first-class verb** (`resume`, `--continue`, `--fork-session`).
   GLLA's equivalent is replay-on-next-live-contact: the persisted render must
   surface whenever the human next sees GLLA output.

## Chosen shape (human-sees constraint wins)

Keep the proven `✓ done — outcome` + ≤2 informing details + approval trailer +
record pointer (matches sibling close-out evidence AND the Codex/Claude
agent-final-message pattern), with two additions:

1. **Audit-goal counts line** (contract requirement): `N/M audited this run`
   style counts (pass/skip/fail + findings fixed/decided) ride the render so a
   goal whose work was verification carries its proof in one glanceable line.
2. **One canonical builder**: every surface (chat notify, transcript notice,
   external notify, archive render) calls the same builder — no more scattered
   ad-hoc construction that can drift or fire into dead contexts unnoticed.

## Delivery guarantee (persist + replay, per grill)

- At archive time, persist the **rendered** approval lines (not just the
  six-label facts) into durable goal state.
- Any approval render attempted with no live turn is marked **undelivered**,
  not dropped.
- On the next live contact (any command/status/widget render with a live
  context), replay the undelivered render once, then mark delivered.
- Late verdicts (auditor lands after completion) follow the same path:
  persist first, deliver-or-replay — never silent.

## Coverage notes (honesty)

- Antigravity web survey: **blocked** — no `web_search`/`fetch` tools in the
  scout runtime; per supervisor direction no inference-based Antigravity claims
  were written. The ≥3-harness bar is met by Codex + Claude + pi-goal-x.
- Claude scout path failed twice (first surveyed the GLLA repo instead of the
  CLI; second emitted a plan file instead of executing) and was closed by
  direct main-agent inspection of `claude --help`, `~/.claude/`, and transcript
  JSONL — all quoted above, all read-only.
- pi-goal-x source is v0.26.1 while the comparison audit used v0.30.5; exact
  current upstream wording should be re-verified if it ever matters.
