# Audit — fresh project pass 2026-09-08 (v0.38.29 → v0.38.30)

Three parallel read-only scouts (lifecycle/recovery/continuation, auditor/display/
commands/settings UI, tests/docs/packaging/loop-forever), ~30-40 tool uses each,
~150-line report caps. Every candidate below was re-verified against the tree by the
orchestrator before recording in `.pi-glla/audit-loop/findings.md`. No finding
re-reports an existing box (checked against all 400 prior lines).

## FIX (9, all LOW, all shipped in v0.38.30)

1. **Replay before fence** (`extensions/loops/goal-activation.ts`, `extensions/loops/goal-session.ts`,
   `extensions/approval-render-store.ts`): every command wrapper replayed undelivered
   approval renders before the inner `warnIfStaleAtEntry` fence; `/loop status` is
   explicitly stale-allowed, so a superseded session mutated the shared sidecar +
   ledger and notified into a dead session. Fix: exported non-notifying
   `shouldSkipApprovalRenderReplay` (worker, owner-denied, handoff, rebind,
   stale-API; fail closed) guards all five wrapper replay calls. Live order unchanged.
2. **countDone grandchildren** (`extensions/goal-loop-display.ts`): closed parents added
   `1 + direct subtasks.length` while `countTotal` recurses; nested grandchildren
   under-read done. Fix: recursive descendant count. Head now shows 7/7 for the
   parent+child+5-grandchildren shape.
3. **ANSI truncator on plain-text surfaces** (`extensions/completion-summary.ts`,
   `extensions/loops/goal-settings-ui.ts`): width budgets used pi-tui `truncateToWidth`
   (ANSI-wrapped ellipsis) on notify/headless-select consumers. Fix: both route through
   ANSI-free `truncateCells`; painted TUI tables keep `truncateToWidth`.
4. **Width floors** (`extensions/goal-loop-display.ts`): `budgetFor` returned
   `max(floor, available)`, so at width 40 a floor-60 budget no-opped the inner
   truncate and the outer hard-cut sliced mid-token; recovery used fixed 48/56 with no
   width at all. Fix: available width wins with a floor-10 absolute minimum (floor
   applies only when width is unknown); `compactMainModelRecoveryLine` takes an
   optional width for its inner budgets.
5. **Objective strip** (`extensions/goal-loop-display.ts`): `displayObjective` removed
   only `**`, `__`, backticks while the compactness note claimed broader stripping.
   Fix: additionally strip `#` headers, `>` quotes, `[label](url)` links, `*em*`
   display-only. Mid-line `a > b` prose is preserved (only leading markers strip).
6. **Sidecar hardening** (`extensions/approval-render-store.ts`): corrupt reads ledgered
   on every command without repairing; `objective.slice(0,300)` split surrogates;
   `chatLines` unbounded behind the ~1KB comment. Fix: repair-after-ledger (valid
   subset or `[]`), code-point truncation, 60×1000 chat-line caps.
7. **Kind-blind card** (`extensions/goal-loop-display.ts`): the goal card showed the
   compact recovery row for any recovery kind and suppressed provenance whenever any
   recovery existed — loop episodes misattributed to the goal card; blank primary left
   no model fact. Fix: goal card owns `kind:goal` only (loop keeps parked/standalone
   cards); provenance returns when the compact line is undefined.
8. **topOpen strip** (`extensions/goal-loop-forever.ts`): finder accepted `[ \t]+` but
   the strip removed only single-space boxes, leaking `- [  ]` markup into the reprieve
   note. Fix: strip with the same character class.
9. **parseLoopStartArgs junk** (`extensions/goal-loop-forever.ts`): known keys with junk
   values were stripped from the target while silently falling back to defaults
   (`time=out` vanished). Fix: consume only valid per-key values (`direction` min/max,
   positive numerics, recognized booleans; `done` still teaches; `measure` any
   non-empty); junk stays in target prose.

## DECIDE (2, raised to the user, nothing changed)

- **D-A**: pre-v0.38.21 audit histories can argue settled objections as live once
  (migrate-on-read vs grandfather).
- **D-B**: findings.md indent convention (normalize counters vs enforce-flat).

Duplicate framings folded: UI narrow-width direction (D1) into FIX 4; plain-text
standard (D2) into FIX 3; indent-counter fix (F2) into DECIDE D-B. The lifecycle
FIX-3 candidate is recorded as DECIDE D-A (two reasonable answers exist).

## Evidence

- Scout outputs: `scout-lifecycle.md`, `scout-auditor-ui.md`, `scout-tests-docs.md`
  under the `eaaa1cf6` workflow artifact dir.
- Findings appended to `.pi-glla/audit-loop/findings.md` (9× `- [ ] FIX`, 2× `- [?] DECIDE`).
- Pins: `tests/audit-2026-09-08.test.ts` (11 tests); focused suites
  (display, goal-loop-display, loop-forever, terminal-approval-render,
  completion-summary-lines) 202 pass / 0 fail; `tsc --noEmit` clean.
- Explicitly checked and NOT reported (verified clean): `/loop pause` completions +
  parity pin, pause-wins recovery deletion semantics, 24h-horizon `!aggressive`
  bypass by design, `noteUserMessageForDispatch` window, terminal-notice fences,
  publish.yml scoping, smoke.sh waits, README package-contents disclosure,
  CHANGELOG single-heading, Bun runner docs, pack-smoke entry points, Goal-only
  schema by design.
