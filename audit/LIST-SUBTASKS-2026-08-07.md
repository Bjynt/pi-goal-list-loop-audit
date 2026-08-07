# v0.34.81 — LIGHT parent/child for list items (Subtask of: …)

**Date:** 2026-08-07
**Version:** 0.34.81
**Status:** Shipped (code + 16 tests, audit doc, CHANGELOG pending)

## Problem

The /list queue was a flat column — items were "presumably related based on distance" (adjacency), with no real linking structure. The user asked for hierarchical items: subtasks (and possibly subgoals). The `parallelSafe` metadata (shipped v0.34.76) was the only per-item metadata; no parent/child link.

The parked design (`audit/DESIGN-LIST-PARALLEL-2026-08-07.md`) laid out a full sub-goal tree (focus/unfocus, per-subtree audit) as one option. That work is **deferred** — it costs focus/unfocus in the runtime and per-subtree audit accounting, neither of which exist yet. The light shape (option A) was approved:

> "Light parent/child (Recommended)" — `parentId` + order; parent is a grouping item, not activatable while it has open children; last child completing cascades to auto-complete the parent; children run one at a time (one-active-slot unchanged); declaration via "Subtask of: <parent objective>" marker; flat audit model per child unchanged.

## Shape

- **One level only.** A parent that is itself a subtask is refused at enqueue.
- **Declaration syntax:** `Subtask of: <parent objective> — <child objective>` on the first line of the item text. The marker is line-start + case-insensitive. The parent objective runs to the first spaced `—/–/-` separator (so "Fix A-B" with no spaces does NOT split — only spaced dashes do). The marker is consumed; subsequent lines + text after the separator form the child objective, which carries its own `Parallel:` and `Done when:` clauses as normal.
- **Resolution:** by objective match. Earlier items in the SAME batch win (so `parent first, then children in one bulk-add`); fall back to the existing queue. Comparison is `normalizeObjective` (lowercase + whitespace-collapsed, ids stripped). A typo / undeclared parent is refused loudly with the reason in the ledger; nesting is refused; empty-objective children are refused.
- **Lifecycle:**
  - Auto-advance (cascade + bulk-add + session_start) **silently skips** a queue item that has open children — the scan finds the first non-group item, which is the first open child of the head group (children are queued right after the parent).
  - Explicit picks (`/list next <n>`, `list_activate` tool) on a group **refuse loudly** so the user is not confused by a silent jump to a child.
  - When the LAST child completes, the cascade in `archiveCurrentGoal` removes the parent from the queue, deletes its disk sidecar, ledger-records `list_group_closed { parentId, parentObjective, closedVia }`, and notifies. No synthetic goal archive md is written for the group — the child IS the audit unit; the ledger is the durable trace.
- **Rendering:** `/list show` and `list_status` render the parent as `N. <objective> [group: N open]` with children as `N.1`, `N.2` indented underneath. PAGE limits apply to top-level entries; a parent at the boundary still shows all of its children so the block stays coherent.

## Where it lives

| Layer | File / location | Change |
|---|---|---|
| Type | `extensions/goal-loop-core.ts:520-540` | `ListItem.parentId?` |
| Type | `extensions/goal-loop-core.ts:253-260` | `Goal.parentId?` |
| Parse | `extensions/goal-loop-core.ts:1256-1290` | `SUBTASK_MARKER` + `extractSubtaskParent` |
| Parse | `extensions/goal-loop-core.ts:1320-1340` | `parseListItemDeclaration` returns `parentObjective` |
| Sidecar | `extensions/goal-loop-core.ts:802-810` | `readQueueFromDisk` round-trips `parentId` |
| Wiring | `extensions/loops/goal.ts:4247-4260` | `groupOpenChildren(groupId)` helper |
| Wiring | `extensions/loops/goal.ts:4252-4300` | `activateNextListItem(ctx, n, opts?: { explicit? })` — scan-skip for `!explicit && n===1`; refuse for `explicit && groupOpenChildren > 0` |
| Wiring | `extensions/loops/goal.ts:4316-4320` | carry `next.parentId` onto the active goal |
| Wiring | `extensions/loops/goal.ts:5047-5085` | `enqueueItems` parse step + parent resolution + refusals + `itemsToWrite` |
| Wiring | `extensions/loops/goal.ts:3600-3620` | `archiveCurrentGoal` cascade close BEFORE the advance |
| Wiring | `extensions/loops/goal.ts:5445` | `/list next <n>` passes `{ explicit: true }` |
| Wiring | `extensions/loops/goal.ts:7765` | `list_activate` tool passes `{ explicit: true }` |
| Render | `extensions/loops/goal.ts:5237-5265` | `/list show` group + sub-number rendering |
| Render | `extensions/loops/goal.ts:7830-7860` | `list_status` tool group + sub-number rendering |

## Decisions

### Why parent resolution is in goal.ts, not core

The `extractSubtaskParent` parse lives in core (single source of truth for the marker regex; pure function). The resolve step (binding the parent OBJECTIVE to a queue-item ID by match) lives in `enqueueItems` where the queue context — same-batch items, existing queue, normalise-the-parent-existing-items dance — already exists. Splitting the resolve into core would require shipping the queue into the parse API (leak).

### Why one-level only

The "full sub-goal tree" option (focus/unfocus, per-subtree audit) is parked because the runtime has no focus/unfocus primitive. Without it, a tree is a UI affordance with no underlying control surface. The light shape keeps the queue flat (one-active-slot invariant) — children are real list items that share the same audit/telemetry/nudge accounting; only the `parentId` and cascade-close are new.

### Why auto-advance silently skips vs refuses

The auto path runs in three contexts (cascade, bulk-add, session_start) where the user has already committed to "next item". If the head is a group with children queued right after, the scan lands on the first child — the natural next work. A refusal here would force the user to type `/list next 2` after every parent — friction with no upside. The EXPLICIT paths (`/list next <n>`, `list_activate`) refuse loudly because the user picked a specific number — silently jumping to a different item is confusing.

### Why no synthetic goal archive md for closed groups

The group is not a goal. It is a queue item. Its close is recorded by `list_group_closed` in the ledger (parentObjective, closedVia) and by the queue removal. Writing an archived-goal `.md` would imply the group was an audited unit — it wasn't. The child IS the audit unit; the reviewer's source curation reads the child's archive + the parent-close ledger entry.

### Why the durable goal .md does not carry parentId

`renderGoalMarkdown` is a whitelist of human-readable fields; parentId is an internal cross-reference. Persisting it in `state.json` (which already round-trips the full goal object) keeps the cascade working across restarts. The `.md` is a render projection; if a crash-restart somehow drops parentId from `state.json` too, the group becomes a plain queue item — visible, not silently mis-handled.

## Tests (tests/list-subtasks.test.ts — 16)

### Pure tier
- `SUBTASK_MARKER` line-start + case-insensitive; mid-sentence not a declaration
- `extractSubtaskParent` — em/en/hyphen separator; hyphen WITHOUT spaces does not split; no separator → empty child; multi-line child survives strip
- `parseListItemDeclaration` — child keeps its own `Parallel:` and `Done when:`; no marker → undefined parent
- `parentId` round-trips through `writeQueueItemFile` → `readQueueFromDisk`
- `readQueueFromDisk` drops malformed `parentId` (non-string)
- Source pins: parse in core, resolve/refuse/cascade in goal.ts

### Behavioral tier
- Bulk-add with parent + 2 children + unrelated: both children bound with `parentId === parent.id`; parent keeps its own `parallelSafe: true`; no refusals
- Bulk-add with child referencing a non-existent parent: only the real parent written; `list_subtask_refused` ledger carries the reason
- Explicit `/list next 1` on a head group (parent + 1 queued child in state.list): `list_group_activation_refused` ledger fires (refuses loudly)
- Bulk-add parent + 2 children with NO active blocker: auto-advance scans, skips the parent group, activates child one; `state.goal.parentId === parent.id`; queue holds `[parent, child two]`

## Edge cases covered

- **Hyphen-without-spaces** ("Fix A-B") does NOT split — parent stays as "Fix A-B"
- **Existing queue + same-call parent** — parent declared earlier in batch wins; fall back to existing queue
- **No separator** — parent captured, child empty → refused (empty objective)
- **Nested** — child of a child refused with "one level only"
- **Activation sidecar delete** — `deleteQueueItemFile` runs for the activated child; the parent's sidecar survives; the second child's sidecar survives
- **Crash restart mid-child** — `state.json` round-trips `goal.parentId`; cascade close still works
- **Race with active goal slot** — active blocker prevents auto-activate so a test can inspect the queue unchanged; production uses the same logic

## Tradeoffs accepted

- **No sub-goal focus.** A user cannot "focus on group X" — the parent stays in the queue while its children run, but the queue still shows other unrelated items. Accepted because focus/unfocus is parked behind a runtime feature that doesn't exist.
- **One level.** Accepted as part of the chosen shape; revisit when focus/unfocus lands.
- **Render-only group label.** The `[group: N open]` tag is informative but not interactive — no click-to-expand. Accepted because no focus primitive exists; the group is a queue item, not a UI element.

## Not changed

- `parallelSafe` (v0.34.76) — per-item metadata; ortho to parentId. A parallel-safe parent still carries the tag; a parallel-safe child does too. The declaration `Subtask of: X — Y. Parallel: yes. Done when: …` parses both.
- The full sub-goal tree (focus/unfocus) — still parked.
- Audit semantics per item — children are flat list items with the same audit/telemetry/nudge accounting. No per-group audit rollup.
- `addSingleItem` (single `/list add "X"` with no newline) — does NOT support subtask binding (it's a single-item direct path; subtasks belong to bulk-import).

## Release

Shipped as v0.34.81 (commit pending at time of writing). CHANGELOG entry pending in the `## Unreleased` block.