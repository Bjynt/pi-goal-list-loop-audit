import { REMINDER_HEADERS, REMINDER_LINES } from "./reminders";

export const REMINDER = {
	...REMINDER_HEADERS,
	...REMINDER_LINES,
};

export const CLEAN_END = {
	header: "[/until-done · clean-end check]",
	intro: "All planned tasks are marked done. Three paths from here, pick one:",
	cleanupCheck: [
		"0. CLEANUP scan first. Before declaring done, verify the diff has no debug",
		"   prints, scratch files, commented-out code, TODOs you added, lint disables,",
		"   or test-only hacks. The diff must be production-shaped.",
	].join("\n"),
	withVerify: (cmd: string) =>
		`1. Run \`${cmd}\`. If it passes — and only if — call \`until_done_complete\` with the quoted output as evidence. Do not accept proxy signals; uncertainty = not achieved.`,
	withoutVerify:
		'1. Verify the done-criteria are literally satisfied (no proxy signals, no "looks fine"), then call `until_done_complete` with evidence.',
	residual:
		"2. If residual work was discovered, call `until_done_replan` with reason='residual_work_discovered' and add the new tasks. Don't keep working without a planned task.",
	distillReminder:
		"After until_done_complete, call until_done_distill to compile the journey into a PRD the user can act on.",
	footer: "Do not invent new work outside the plan.",
};
