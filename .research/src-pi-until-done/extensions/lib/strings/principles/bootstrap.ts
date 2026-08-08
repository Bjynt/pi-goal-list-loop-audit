/**
 * Section 0 of pi-config — Mandatory minimal automation bootstrap.
 *
 * No production test, no production code, until the eight bootstrap items
 * exist and pass for the current scope. Bootstrap is mandatory but minimal:
 * it must evolve in lockstep with the system, never lag behind it.
 */
export const BOOTSTRAP_MANDATE_BLOCK = [
	"Mandatory automation bootstrap (HARD — pi-config §0):",
	"  • RED may begin only after bootstrap is complete for the current scope.",
	"  • Bootstrap = 8 items, all of which MUST exist and pass before any production test:",
	"    1. one canonical source of gates / rules / failure conditions",
	"    2. local developer validation suite (sub-second to a few seconds for small edits)",
	"    3. local release-readiness validation suite (full-repo, deterministic, slower OK)",
	"    4. changed-file / affected-target execution (or a documented safe fallback)",
	"    5. deterministic caching (or a documented deterministic no-cache fallback)",
	"    6. safe parallel execution where applicable",
	"    7. matching minimal GitHub Agentic Workflow (read-only agent, guarded write jobs)",
	"    8. verified local ↔ GitHub parity for the current scope",
	"  • Bootstrap may begin minimal but MUST evolve as production code evolves. Never let new capability outrun the automation that validates it.",
	"  • If you find yourself wanting to write a test or production code before the foundation exists, STOP. Bootstrap is the next task; write it as a bootstrap task and replan.",
].join("\n");
