import { MISE_CLI_BLOCK, VERIFIABILITY_BLOCK } from "./strings";
import { STRUCTURAL_CONSTRAINTS_BLOCK } from "./structural-constraints";
import type { Phase } from "./types";

const tddBlock = [
	"",
	"TDD discipline:",
	"  • RED: failing production test first.",
	"  • GREEN: smallest change to pass.",
	"  • REFACTOR: structure/perf without behavior change.",
	"",
	VERIFIABILITY_BLOCK,
	"",
	MISE_CLI_BLOCK,
	"",
	STRUCTURAL_CONSTRAINTS_BLOCK,
	"",
	"Take the next concrete step. If the goal is complete, call `until_done_complete` with evidence (quote the verify-command output).",
	"If you are blocked or need user input, call `until_done_block` with the question.",
];

export const continuationMessage = (
	goal: string,
	doneCriteria: string,
	askBefore: string[],
	phase: Phase,
	verifyCommand: string | undefined,
): string => {
	const head = [
		"[Continuing toward your standing goal]",
		`Goal: ${goal}`,
		doneCriteria ? `Done when: ${doneCriteria}` : "",
		verifyCommand ? `Verify: ${verifyCommand}` : "",
		`Phase: ${phase}  (advance via until_done_progress {phase})`,
		askBefore.length ? `Ask first before: ${askBefore.join(", ")}` : "",
	];
	return [...head, ...tddBlock].filter(Boolean).join("\n");
};
