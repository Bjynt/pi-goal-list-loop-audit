# Explore-session retention — 2026-08-19

## Current behavior

The installed pi-subagents implementation distinguishes three different kinds
of persistence:

1. **Pi session persistence:** `persist_session` defaults to `false`.
   `src/agent-runner.ts` therefore creates `SessionManager.inMemory(effectiveCwd)`
   for the normal Explore agent. An Explore run is not a normal resumable Pi
   session unless its agent configuration explicitly opts in with
   `persist_session: true`.
2. **Run transcript persistence:** `output_transcript` defaults to `true`.
   The subagent output is written as a JSON-lines transcript below the OS temp
   directory; the pi-subagents README says this is independent of
   `persist_session` and the temp tree is cleared on reboot. It can be disabled
   globally or per custom agent with `output_transcript: false`.
3. **glla provenance:** glla appends a small `subagent_session` record to
   `.pi-glla/active.jsonl` containing the spawn id, agent type, summary, goal
   correlation, and timestamp. This is deliberate durable recovery metadata,
   not a saved Pi conversation.

The referenced screenshot shows `Explore#...` rows, but those identifiers are
also how pi-subagents displays Agent records/FleetView. The visual alone does
not prove that the Explore conversations are present in Pi's normal
`~/.pi/agent/sessions/` picker. The source-level default and the configured
Explore agent (`/home/dracon/.pi/agent/agents/Explore.md`, with no
`persist_session` override) support the safer interpretation: the rows are
runtime/UI records and the run may have a temporary `.output` transcript, not a
retained Pi session.

Pi's own session documentation separately says that ordinary sessions are
JSONL files under `~/.pi/agent/sessions/`, and that `--no-session` is the
explicit ephemeral mode for a main Pi session. That distinction matters:
Explore's in-memory `SessionManager` is an agent-level choice and should not be
conflated with the host session's normal save policy.

## Recommendation: retain provenance, hide full history by default

Use a **retain-minimal / hide-full-session** policy:

- Keep the existing glla `subagent_session` ledger entries. They let a reload
  recover the fact that a worker was spawned and correlate later evidence to a
  goal without retaining the complete conversation.
- Keep Explore sessions in memory by default (`persist_session: false`), so
  they do not become ordinary `/resume` history. Let FleetView and the inline
  Agent result expose the active/just-completed run, then allow it to disappear
  with the pi-subagents UI lifecycle.
- Keep the temporary output transcript default for now because it is useful for
  diagnosing an audit and is bounded by the OS temp lifecycle. Users handling
  sensitive code or backups should set the existing project/global
  `outputTranscript: false` setting (or per-agent `output_transcript: false`).
- Make full session retention an explicit opt-in for a custom agent whose work
  must be resumed after a restart. Such an agent should also use a deliberate
  `session_dir`/labeling policy rather than silently adding every Explore run
  to the user's normal history.

This is preferable to archiving every Explore conversation. Archiving would
preserve the same privacy and disk-cost concerns while adding a second storage
lifecycle that glla does not need for recovery. It is also preferable to
silently deleting the durable glla spawn records: those records are the small
amount of history required to explain and recover orchestration state.

## Trade-offs

| Policy | Benefit | Cost/risk |
| --- | --- | --- |
| Retain full Pi sessions | Best restart/resume and later inspection | Session-list clutter, disk growth, and potentially sensitive prompts/tool output in normal history |
| In-memory sessions + temporary output (recommended default) | No normal `/resume` clutter; useful short-lived diagnostics | Full worker conversation is lost after restart/reboot; the glla ledger is only a reference |
| In-memory sessions + no output transcript | Strongest local privacy/minimal disk footprint | Harder to diagnose failed or disputed worker behavior |
| Archive every Explore session | Long-term forensic trail | Duplicates Pi/subagent storage, creates retention/deletion policy work, and increases exposure without helping normal recovery |

The recommended default deliberately favors safe recovery metadata over
forensic replay. A user can opt into the stronger retention mode when replay is
more valuable than privacy or history cleanliness.

## Implementation boundary

- **pi-subagents owns worker-session policy:** `persist_session`,
  `output_transcript`, `session_dir`, the FleetView, and the in-process agent
  registry. A future retention toggle or clearer “runtime record vs saved
  session” label belongs there (or in upstream Pi-subagents), not in glla's
  goal state.
- **Pi core owns session files and lifecycle:** normal session discovery,
  `/resume`, switching, deletion, and the semantics of
  `SessionManager.inMemory()`. glla must not scan, delete, or rewrite
  `~/.pi/agent/sessions/` to enforce its own policy.
- **glla owns orchestration provenance:** the append-only
  `.pi-glla/active.jsonl` spawn reference and any bounded cleanup/rollup policy
  for that ledger. It should not pretend that a `subagent_session` row is a
  resumable worker conversation, and it should not manufacture a Pi session
  successor from an event handler.

No glla source fix is supported by the current evidence. The relevant controls
already exist in pi-subagents, while the glla ledger behavior is covered by
`tests/subagent-session-ledger.test.ts`. A future change would need a concrete
retention failure (for example, an Explore run unexpectedly appearing in
normal Pi session discovery, or unbounded sensitive transcripts) before adding
a new setting, cleanup job, or regression.

## Evidence reviewed

- `/home/dracon/.npm-global/lib/node_modules/@tintinweb/pi-subagents/src/agent-runner.ts`
  — `persistSession ? SessionManager.create : SessionManager.inMemory`.
- `/home/dracon/.npm-global/lib/node_modules/@tintinweb/pi-subagents/src/types.ts`
  and `src/custom-agents.ts` — the `persist_session`, `output_transcript`, and
  `session_dir` configuration fields.
- `/home/dracon/.npm-global/lib/node_modules/@tintinweb/pi-subagents/README.md`
  — defaults and the independent `.output` transcript lifecycle.
- `extensions/goal-loop-auditor-process.ts` and
  `extensions/goal-loop-subagents.ts` — glla's worker/auditor integration.
- `tests/subagent-session-ledger.test.ts` — durable spawn-reference contract
  and restart-survival regression.
- `/home/dracon/Pictures/Screenshots/Screenshot_20260818_173403.png` — the
  `Explore#...` visual that prompted this review; it is not by itself storage
  evidence.
