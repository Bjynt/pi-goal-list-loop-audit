# Long-running philosophy — glla

**Status**: parked (recorded for future re-prioritization). Source: glla
chat thread, 2026-07-27. This is the parking-lot design doc — not active
work in the queue.

## Why this exists

We confirmed the three modes are NOT redundant — each has a distinct
source of long-running-ness:

| Mode | Source of long-running-ness | Typical lifetime |
|---|---|---|
| `/goal` | Scope (one big multi-hour task) | Hours |
| `/list` | Queue depth (N short items × minutes) | Hours → weeks |
| `/loop` | Bounds (1 metric × infinite polish) | Until plateau/stop/finish |

The modes are **peers, not nestable**. A project doesn't have a loop
inside a goal — it might run all three as sidecars, or shift between
them across phases, but no mode nests inside another.

(That table was corrected: the original draft said goal = "hours" as if
that was its defining property; the correct distinguishing axis is
**scope** — "one thing," not "short time.")

## Parked cards (not shipped, not forgotten)

These were discussed and deferred. Re-prioritize when a project outgrows
the modes' current scope.

### Sub-goal tree (parent + children)

A goal can own N child goals. Each child has its own lifecycle / audit /
objective. Parent completes when its contract holds AND all required
children are terminal. Optional / replacing semantics to follow.

**Minimum viable v0.29**: parent + children data model + `/goal status`
tree view + a `decisions.md` carry-over (parent has one, every child
reads it on activate, post-audit appends to it). No focus/unfocus yet,
no nested children.

### Spec evolution under long goals

Two-layer spec: **axioms** (hard, never change — e.g. "make Half-Life 3
in three.js") and **claims** (soft, evolve by reviewer/auditor-decision
— e.g. "the tone is X" can shift to "the tone is Y" if 30 sessions of
work reveal X doesn't fit). Reviewer can propose spec amendments;
user accepts / rejects / amends. Decision trail needed (git history of
SPEC.md plus inline annotations on each amendment).

### Post-goal / post-list auditor modes

Reframe the existing "reviewer" as a **post-completion auditor** that
fires after goal/list terminates. Surface it to interactive users
(written files are currently silent). Modes:

- `off` — no post-audit
- `on` (default) — write the report, surface to user
- `auto` — on + auto-enqueue any tasks it produces into `/list`
- `aggressive` — auto + auto-relaunch goal if it proposes one

First ship = `on` default surfacing (0.27.5). The other modes follow
after we see what real post-audit output looks like.

## Open threads

- Spec evolution needs YAML frontmatter or section markers for axiom/claim distinction — open question.
- Sub-goals: does a child ever inherit a parent's audit-suppression state, or does each child get a fresh auditor? Open.
- "List abuse for staged work" — currently some users (not you, yet) push multi-stage project work into lists because there's no sub-goal tree. Once v0.29 ships, lists should re-grill those seeds.
