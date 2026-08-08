import type { GoalState } from "../types";

const RECENT_EVIDENCE_KEEP = 6;
const RECENT_LEARNINGS_KEEP = 8;

const headline = (s: GoalState): string =>
	`/until-done active — goal: "${s.goal}" (${s.turnsUsed}/${s.maxTurns} turns, phase=${s.phase})`;

const verifyLine = (s: GoalState): string =>
	s.verifyCommand
		? `verify: \`${s.verifyCommand}\``
		: "verify: (none — research/doc goal)";

const surfacesLine = (s: GoalState): string => {
	if (!s.surfaces.length) return "";
	const list = s.surfaces.map((x) => `${x.kind}@${x.location}`).join("; ");
	return `surfaces: ${list}`;
};

const currentTaskLine = (s: GoalState): string => {
	const t = s.tasks.find((x) => x.id === s.currentTaskId);
	if (!t) return "";
	return `current task: ${t.id} — ${t.title} (${t.status})`;
};

const recentEvidence = (s: GoalState): string[] => {
	if (!s.evidence.length) return [];
	const slice = s.evidence.slice(-RECENT_EVIDENCE_KEEP);
	return [
		"recent evidence (preserve verbatim):",
		...slice.map((e) => `  - ${e}`),
	];
};

const recentLearnings = (s: GoalState): string[] => {
	const acc: string[] = [];
	for (const t of s.tasks) {
		for (const l of t.learnings) acc.push(`${t.id}: ${l}`);
	}
	const tail = acc.slice(-RECENT_LEARNINGS_KEEP);
	if (!tail.length) return [];
	return [
		"recent learnings (preserve verbatim):",
		...tail.map((l) => `  - ${l}`),
	];
};

/**
 * Compaction annotation that grows the thread's signal-to-noise ratio. When
 * the loop runs long, the bytes most worth keeping are: the goal, the verify
 * command, surfaces, the current task, the most recent evidence, and the
 * most recent learnings. Lossy compaction will toss everything else.
 */
export const compactionAnnotation = (s: GoalState): string => {
	const lines: string[] = [
		"",
		"[/until-done · compaction context — preserve everything below verbatim]",
		headline(s),
		verifyLine(s),
	];
	const surfaces = surfacesLine(s);
	if (surfaces) lines.push(surfaces);
	const current = currentTaskLine(s);
	if (current) lines.push(current);
	lines.push(...recentEvidence(s));
	lines.push(...recentLearnings(s));
	return lines.join("\n");
};
