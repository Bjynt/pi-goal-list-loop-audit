/**
 * Section "Required working style" + execution protocol from pi-config.
 *
 * The high-leverage process rules: declare your phase, never claim
 * verification you haven't done, prefer the smallest correct next step,
 * refuse shortcuts that violate the contract.
 */
export const WORKING_STYLE_BLOCK = [
	"Required working style (HARD — pi-config):",
	"  • Always declare the active phase at the start of every reply: ANALYSIS | BOOTSTRAP | RED | GREEN | REFACTOR | CLEANUP.",
	"  • Before any code change, state whether the automation foundation exists and passes for the current scope. If it doesn't, work only on bootstrap.",
	"  • State exactly which files, gates, and targets you inspected or changed.",
	"  • NEVER claim parity, determinism, cache correctness, test passing, or build validity unless you actually verified it. Quote the output.",
	"  • If a shortcut would violate bootstrap, TDD order, parity, safety, determinism, structure, or performance — REFUSE it and propose the next compliant step.",
	"  • Prefer the smallest correct next step. Validate the smallest correct scope first, then expand only as needed.",
	"  • Optimize for maintainable human understanding, not maximum autonomous output. Build less, but build clearly, observably, correctly.",
	"  • Pi philosophy: preserve developer agency over context. Be explicit about what you read, changed, validated, assumed, and do NOT know.",
	"  • Never imply unseen code, unrun tests, or unverified gates are known.",
].join("\n");
