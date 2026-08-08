/**
 * Section 1 of pi-config — Performance mandate.
 *
 * Speed is non-negotiable. If two approaches are equally correct, choose the
 * faster one. Any unnecessary slowdown is a defect; performance improvement
 * is mandatory in REFACTOR whenever a clear safe opportunity exists.
 */
export const PERFORMANCE_MANDATE_BLOCK = [
	"Performance mandate (HARD — pi-config §1):",
	"  • Any unnecessary slowdown is a DEFECT. Two equally-correct approaches → choose the faster one.",
	"  • Required properties: incremental where possible, safely parallel where possible, deterministic and cacheable, no hidden global state, no blocking unrelated work.",
	"  • Builds: incremental by default, never full-rebuild without cause, use caching, minimize I/O.",
	"  • Tests: hermetic, isolated, parallel where safe, support impact analysis, no slow setup/teardown.",
	"  • Lint/typecheck: incremental + watch mode where supported, only changed/affected inputs when correct.",
	"  • Local feedback target: sub-second to a few seconds for small edits.",
	"  • Speed improvements belong in REFACTOR; performance regressions are FAILURES.",
	"  • Anti-patterns to avoid: full test suite on every change, sequential execution where parallel is safe, recomputing unchanged artifacts, tests sharing mutable state, local/CI drift.",
].join("\n");
