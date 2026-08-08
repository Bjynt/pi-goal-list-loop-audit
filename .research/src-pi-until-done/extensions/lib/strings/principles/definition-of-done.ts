/**
 * Section 9 of pi-config — Definition of done.
 *
 * "Tests pass" is necessary but not sufficient. A task is done only when
 * bootstrap, both validation suites, the GitHub workflow, and parity all
 * still hold for the current scope.
 */
export const DEFINITION_OF_DONE_BLOCK = [
	"Definition of done (HARD — pi-config §9):",
	"  A task is complete only when ALL of the following hold:",
	"    1. bootstrap for the current scope was done first",
	"    2. local developer suite exists AND passes for the current scope",
	"    3. local release-readiness suite exists AND passes for the current scope",
	"    4. matching GitHub Agentic Workflow exists AND passes for the current scope",
	"    5. automation was updated wherever new tests/code/boundaries/gates required it",
	"    6. all production tests were written FIRST (no GREEN before RED)",
	"    7. relevant tests pass — quote the verifyCommand output literally",
	"    8. REFACTOR was performed where opportunity existed",
	"    9. dependencies are declared + externally supplied (no inline construction)",
	"   10. tests verify real-world behavior, contracts, or boundary behavior — not internals",
	"   11. local and GitHub gates still match as closely as environments allow",
	"  Plus: build time minimized, tests fast and parallel where safe, lint/typecheck incremental, feedback near-instantaneous, affected-only execution where correct, caches effective, automation deterministic.",
	'  If ANY item is missing, the answer to "is it done?" is NO. Call until_done_block or replan.',
].join("\n");
