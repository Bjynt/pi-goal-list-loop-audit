import type { Phase } from "../types";

export const WIDGET = {
	header: (status: string, glyph: string, phase: Phase) =>
		`/until-done · ${status} · ${glyph} ${phase}`,
	goal: (g: string) => `  goal: ${g}`,
	doneWhen: (c: string) => `  done when: ${c}`,
	verify: (v: string) => `  verify: ${v}`,
	askBefore: (list: string[]) => `  ask before: ${list.join(", ")}`,
	budget: (used: number, max: number) => `  budget: ${used}/${max}`,
	verdict: (kind: string, reason: string) =>
		`  last verdict: ${kind} — ${reason}`,
};

export const STATUS = {
	setup: (g: string) => `◇ until-done setup: ${g}`,
	planning: (g: string) => `◇ until-done planning: ${g}`,
	active: (turns: string, ph: string, counter: string, g: string) =>
		`◴ until-done ${turns} [${ph}]${counter}: ${g}`,
	paused: (turns: string, reason: string, g: string) =>
		`Ⅱ until-done ${turns} paused${reason}: ${g}`,
	blocked: (turns: string, g: string) => `? until-done ${turns} blocked: ${g}`,
	done: (g: string) => `✓ until-done done: ${g}`,
};

export const OVERLAY = {
	title: " /until-done contract ",
	close: "Press Escape to close",
	evidenceHeader: "evidence so far:",
	rowLabels: {
		status: "status",
		budget: "budget",
		goal: "goal",
		phase: "phase",
		doneWhen: "done when",
		verify: "verify",
		askBefore: "ask before",
		decisions: "decisions",
		lastVerdict: "last verdict",
	},
};
