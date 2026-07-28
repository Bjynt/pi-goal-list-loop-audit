# Wrong-or-Not-Premium Audit — 2026-07-28

Scope: pi-goal-list-loop-audit v0.28.0. Four streams: stale-session handling
(orchestrator), error handling (subagent), UX polish (subagent), test gaps
(subagent). Every finding: verb-phrase title, file:line evidence, severity.

Naming per `pi-discipline/naming.md`: verb phrase first, IDs/codes trailing.

---

## Stream 1 — Stale-session handling (pi 0.82.x session replacement)

Live incident: goal `20260728095607-sraaal` created in the capture-anime-girls
pi at 09:56 — the session was stale (compaction → session replacement). The
goal persisted fine (`goal_created` in that project's jsonl), but the first
continuation send threw stale, `goStaleTerminal` paused it at 0s, and the
final jsonl event is `status=active pauseReason=None` — a zombie.

Rig context (why this severity): the rig runs long-lived pi processes —
`ps -eo pid,etime,cmd` shows two `pi` processes at 6d9h and 4d uptime. pi
0.82.x compaction replaces sessions on context-full, so multi-day sessions
are near-guaranteed to go stale eventually. capture-anime-girls has NO
`.pi-glla/settings.json` → default tri-state (HOLD on human loads) + no
autoresume → S2's stall is guaranteed after every stale event on this rig.

### S1 [HIGH] — Fix the silent-zombie goal after resume-in-stale-session

`extensions/loops/goal.ts:204` — `goStaleTerminal`'s anti-spam guard
(`if (extensionApiStale) return;`) skips the state correction on the SECOND
stale failure. Sequence: `/goal resume` in a stale session → `cmdResume`
(`:950-970`) sets `status:"active"` and notifies "Resumed goal …" →
`scheduleContinuation` → `sendContinuation` → send throws stale →
`goStaleTerminal` early-returns → **no re-pause, no warning**. The goal sits
active-in-ledger, widget says active, no send can ever land. Live evidence:
sraaal's last jsonl event is exactly this state.

Premium: on repeated stale sends, still correct the state (re-pause or keep
the interrupt marker) and rate-limit the notify instead of fully suppressing
the correction. Never leave ledger-state claiming "active" when the process
provably cannot run it.

### S2 [HIGH] — Auto-resume stale-interrupted goals after restart

`extensions/loops/goal.ts:213` — `goStaleTerminal` persists
`status:"paused"`. The restore gate (`:4032-4055`) only auto-resumes
`status==="active"` goals; NO branch handles paused goals. Result: even with
`autoresume=on`, a compaction-stale goal is dead until a human types
`/goal resume`. On an unattended rig every pi compaction = goal stalled until
human intervention. This is the user's "starts paused and stuck."

Premium: a stale interruption is not a user pause. Keep `status:"active"`
with an interrupt marker (`pauseReason` = stale text + restart guidance).
`sendContinuation`'s existing guard (`:527`) already prevents retry storms in
the doomed process. Fresh session_start → restore gate sees active →
auto-resumes (autoresume=on / reload / fork) or HOLDs with a clear notify
(human loads — tri-state design preserved). Restart becomes seamless
continuation, which is the whole point of an unattended-rig plugin.

Safety check for this fix (verified 2026-07-28): `status==="paused"` readers
are `cmdResume` (`:951`, no-op for active goals — correct), the widget
(`goal-loop-display.ts:135,196,223` — needs a small addition to surface the
interrupt marker on ACTIVE goals, since pauseReason only renders for paused
ones), and the auditor-quota resume branch (`:2150`, keyed on pauseReason
prefix, unaffected). The HOLD-on-human-load branch (`:4044-4055`) still
pauses interrupted goals with "held for explicit resume" — deliberate
tri-state preserved.

### S3 [MED] — Probe staleness at command entry

`extensions/loops/goal.ts:912` — `/goal` creation notifies "created —
starting now"; `:963-969` — `/goal resume` notifies "Resumed goal …". Both
are lies in a stale session (the "starting now" → 0s-pause whiplash; the
zombie "resumed"). `extensionApiStale` only becomes true AFTER a failed
send, so a freshly-compacted session with no send yet passes the flag check.

Premium: cheap probe at entry of cmdGoal/cmdResume/cmdList/critical commands
(flag OR a try/catch on a harmless api call). If stale: "this session's
extension handle is stale — restart pi (or /reload). State is safe in
.pi-glla/; the goal auto-resumes in the fresh session." Accept the state
change (fs works) but never claim it started.

### S4 [LOW] — End the creation whiplash

"Goal … created — starting now" immediately followed by "⏸ paused · 0s —
extension api stale" is whiplash. Falls out of S2+S3: with the interrupt
marker the display reads "created — will start when pi restarts (stale
session)" in one honest step.

---

## Stream 2 — Error handling (subagent)

PENDING

---

## Stream 3 — UX / premium polish (subagent)

PENDING

---

## Stream 4 — Test coverage gaps (subagent)

PENDING

---

## Queue plan

Actionable findings → `list_add` items, verb-phrase titles, severity-ordered.
S1+S2 combine into one fix goal (same function, same incident). S3 separate
(touches command surface). Subagent findings triaged below once reported.
