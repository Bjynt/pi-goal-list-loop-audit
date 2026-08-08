export const CI_LABELS = {
	headline: "/until-done · CI",
	failureHead: "[/until-done · CI failure on stop]",
	failureGuide:
		"One or more checks failed. Fix and re-run before calling `until_done_complete`.",
	pausedReason: "CI failed on stop event",
	failureReason: "ci_failure",
	skipped: (verb: string) => `· ${verb}: skipped`,
	passed: (verb: string, ms: number) => `✓ ${verb}: passed (${ms}ms)`,
	failed: (verb: string, exit: number | string, ms: number) =>
		`✗ ${verb}: failed exit=${exit} (${ms}ms)`,
	totalLine: (ms: number) => `total ${ms}ms`,
	failureBlock: (verb: string, command: string, ms: number, output: string) =>
		`### ${verb} (\`${command}\`) failed in ${ms}ms\n\n\`\`\`\n${output}\n\`\`\``,
};
