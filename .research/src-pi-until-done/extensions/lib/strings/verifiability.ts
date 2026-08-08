/**
 * Verifiability discipline — adapted from Codex /goal's per-turn injection.
 *
 * Two anchors keep the loop honest:
 *   1. "Do not accept proxy signals." Pi must not treat compile-success,
 *      test-skips, lint-clean, or self-assertion as proof the goal is met.
 *      Only the verifyCommand passing (or all done-criteria literally satisfied)
 *      counts.
 *   2. "Treat uncertainty as not achieved." If Pi is unsure whether a criterion
 *      holds, the answer is "not yet" — call until_done_block or run more
 *      checks. Never call until_done_complete on vibes.
 */
export const VERIFIABILITY_BLOCK = [
	"Verifiability discipline (HARD):",
	'  • Do NOT accept proxy signals. "It compiled", "the test I added passes", "lint is clean", "the diff looks right" — none of these prove the goal is done. Only the verifyCommand passing (or every done-criterion literally satisfied with quoted evidence) counts.',
	'  • Treat uncertainty as NOT ACHIEVED. If you are unsure whether a criterion holds, the answer is "not yet". Run more checks, gather more evidence, or call `until_done_block` with the question. Never call `until_done_complete` on vibes.',
	"  • Quote command output as evidence. When you run the verifyCommand, paste the actual stdout/stderr in `until_done_complete.evidence` — not a paraphrase, not a summary, the bytes.",
	"  • Cleanup before completing. Strip debug prints, scratch files, commented-out blocks, TODOs you added, and any `// eslint-disable` you slipped in. The diff must be production-shaped before complete.",
].join("\n");
