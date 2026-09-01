/**
 * Goal stagnation supervisor (v0.37.0) — AVO-inspired long-horizon
 * supervision for goal mode.
 *
 * Source: NVIDIA's Agentic Variation Operators architecture (arXiv:2603.24517;
 * developer.nvidia.com blog 2026-08). AVO sustains multi-day autonomous runs
 * with a supervisor that watches the committed lineage for two failure modes:
 *
 *   - **Exhaustion** — the agent stays active (tools, analysis) but produces
 *     no commit: its current hypothesis is mined out and it needs a strategy
 *     reset.
 *   - **Cycling** — repeated near-identical attempts that never improve the
 *     score: unproductive edit loops.
 *
 * When either fires, the supervisor injects NON-prescriptive strategic
 * framing into the next variation prompt — it reviews the trajectory and
 * suggests fresh directions; it never prescribes a specific change.
 *
 * glla mapping: a goal's "lineage" is its committed progress (git commits,
 * completed tasks, file writes); each active turn appends one ProgressVector
 * to a bounded rolling window persisted on the goal. The existing stall
 * watchdog owns SILENCE (no tool calls); this module owns PRODUCTIVE-LOOKING
 * stagnation — turns full of activity with zero goal-progress. Like the
 * stall watchdog, provider-error/abort turns are exempt upstream (the wiring
 * skips them), because the model never got a say on those.
 *
 * Everything decision-shaped here is a pure function over plain data, mirroring
 * goal-loop-repetition.ts; goal-activation.ts owns observation and persistence.
 */

import { normalizeForPrint, trigramSimilarity } from "./goal-loop-repetition.js";

export const STAGNATION = {
	/** Consecutive ACTIVE turns with zero progress before exhaustion fires. */
	exhaustionAfter: 4,
	/** Consecutive near-duplicate replies before cycling fires. */
	cyclingAfter: 3,
	/** Jaccard similarity at which two consecutive replies count as near-duplicates. */
	similarityThreshold: 0.8,
	/** Minimum reply length before similarity checks apply (short acks repeat innocently). */
	minSimilarLength: 60,
	/** Rolling window cap for ProgressVectors kept on the goal. */
	windowCap: 16,
	/** Rolling reply-text window cap (normalized + clipped). */
	textCap: 6,
	/** Max characters of each reply retained for similarity comparison. */
	textClip: 600,
	/** After this many consecutive injections without progress, the supervisor stands down (bounded nagging). */
	maxConsecutiveInjections: 3,
} as const;

/** One observed turn's progress deltas, appended per active goal turn. */
export interface ProgressVector {
	/** ISO timestamp of the turn end. */
	at: string;
	/** Tool calls observed during the turn (all tools). */
	toolCalls: number;
	/** File write/edit tool calls. */
	fileWrites: number;
	/** Shell invocations. */
	bashCalls: number;
	/** 1 when HEAD moved during the turn (a commit landed), else 0. */
	gitCommits: number;
	/** Task-list items newly completed during the turn. */
	taskCompletions: number;
}

export type StagnationKind = "exhaustion" | "cycling";

export interface SupervisorDirective {
	kind: StagnationKind;
	/** Specific detector reason (why the supervisor fired). */
	reason: string;
	/** ISO timestamp of detection. */
	at: string;
	/** How many times this directive has been injected without intervening progress. */
	injections: number;
}

/** Persisted per-goal stagnation state (on `Goal.stagnation`). */
export interface GoalStagnation {
	/** Bounded rolling window of per-turn progress vectors (oldest first). */
	window: ProgressVector[];
	/** Rolling assistant-reply texts (normalized + clipped, most recent last).
	 * Real text, not fingerprints: cycling compares word-trigram shingles, and
	 * trigram Jaccard over a hash digest is noise. */
	recentTexts: string[];
	/** Consecutive active turns with zero committed progress. */
	exhaustedStreak: number;
	/** Pending directive rendered into subsequent continuation prompts. */
	directive?: SupervisorDirective;
	/** Wiring bookkeeping (goal-activation.ts): lifetime telemetry totals at
	 * the previous recorded turn end, for delta computation. */
	lastTotals?: { turns: number; fileWrites: number; bashCalls: number };
	/** Wiring bookkeeping: last observed git HEAD sha (per-turn commit detection). */
	lastHead?: string;
	/** Wiring bookkeeping: completed-task count at the previous recorded turn end. */
	completedTasks?: number;
}

export function emptyStagnation(): GoalStagnation {
	return { window: [], recentTexts: [], exhaustedStreak: 0 };
}

function pushCapped<T>(arr: T[], item: T, cap: number): T[] {
	const next = [...arr, item];
	return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Committed progress = durable lineage events: git commits, completed tasks,
 * or file writes. Tool calls and shell invocations alone are ACTIVITY, not
 * progress — that distinction is exactly what exhaustion detects.
 */
export function vectorHasProgress(v: ProgressVector): boolean {
	return v.gitCommits > 0 || v.taskCompletions > 0 || v.fileWrites > 0;
}

/** The turn was active: it did anything inspectable at all (or said something substantial). */
function turnWasActive(v: ProgressVector, assistantText: string | undefined): boolean {
	return (
		v.toolCalls > 0 ||
		v.bashCalls > 0 ||
		(assistantText !== undefined && assistantText.trim().length >= STAGNATION.minSimilarLength)
	);
}

/**
 * Cycling signature (AVO §3.3 "unproductive cycles"): the last `cyclingAfter`
 * replies (ending with `text`) are pairwise near-duplicates.
 */
function detectCycling(text: string, texts: string[]): string | undefined {
	if (text.length === 0) return undefined;
	const series = [...texts.slice(-(STAGNATION.cyclingAfter - 1)), text];
	if (series.length < STAGNATION.cyclingAfter) return undefined;
	for (let i = 1; i < series.length; i++) {
		if (trigramSimilarity(series[i]!, series[i - 1]!) < STAGNATION.similarityThreshold) return undefined;
	}
	return `${STAGNATION.cyclingAfter} consecutive near-duplicate replies`;
}

export interface TurnObservation {
	/** Per-turn progress deltas (already diffed by the caller). */
	vector: ProgressVector;
	/** This turn's assistant reply text, when available. */
	assistantText?: string;
}

export interface RecordTurnResult {
	/** Updated state (new object; input untouched). */
	next: GoalStagnation;
	/** Directive newly fired by THIS observation (not carried-over ones). */
	fired?: SupervisorDirective;
}

/**
 * Fold one finished turn into the stagnation state. Pure. Rules:
 * - progress → streak resets, any pending directive clears (supervisor satisfied);
 * - active-without-progress → streak grows; at exhaustionAfter an exhaustion
 *   directive fires once;
 * - cyclingAfter consecutive near-duplicate replies fire a cycling directive
 *   regardless of writes (cosmetic-churn guard: identical-looking output IS
 *   the failure signature even when files changed);
 * - a pending directive carried across maxConsecutiveInjections further
 *   stalled turns makes the supervisor stand down (delete it) — bounded nagging.
 */
export function recordTurnObservation(prev: GoalStagnation | undefined, obs: TurnObservation): RecordTurnResult {
	const st: GoalStagnation = prev
		? {
				window: [...prev.window],
				recentTexts: [...prev.recentTexts],
				exhaustedStreak: prev.exhaustedStreak,
				directive: prev.directive ? { ...prev.directive } : undefined,
				lastTotals: prev.lastTotals ? { ...prev.lastTotals } : undefined,
				lastHead: prev.lastHead,
				completedTasks: prev.completedTasks,
			}
		: emptyStagnation();

	st.window = pushCapped(st.window, obs.vector, STAGNATION.windowCap);

	let fired: SupervisorDirective | undefined;

	// Cycling FIRST: identical-looking output IS the failure signature even
	// when files changed (the cosmetic-churn guard — writes do not launder
	// repeated attempts). Progress still resets the streak below.
	const clippedText = obs.assistantText
		? normalizeForPrint(obs.assistantText).slice(0, STAGNATION.textClip)
		: "";
	const cycleReason =
		clippedText.length >= STAGNATION.minSimilarLength ? detectCycling(clippedText, st.recentTexts) : undefined;

	st.recentTexts = pushCapped(st.recentTexts, clippedText, STAGNATION.textCap);

	if (cycleReason) {
		fired = { kind: "cycling", reason: cycleReason, at: obs.vector.at, injections: 0 };
		st.directive = fired;
	}

	if (vectorHasProgress(obs.vector)) {
		st.exhaustedStreak = 0;
		if (!cycleReason) {
			delete st.directive;
			return { next: st };
		}
		return { next: st, fired };
	}

	if (turnWasActive(obs.vector, obs.assistantText)) {
		st.exhaustedStreak += 1;
	}

	if (!st.directive) {
		if (st.exhaustedStreak >= STAGNATION.exhaustionAfter) {
			fired = {
				kind: "exhaustion",
				reason: `${st.exhaustedStreak} consecutive active turns with no committed progress`,
				at: obs.vector.at,
				injections: 0,
			};
			st.directive = fired;
		}
	} else if (!fired) {
		// Bounded nagging: each further stalled turn is another injection
		// opportunity; past the cap the supervisor stands down entirely.
		st.directive.injections += 1;
		if (st.directive.injections > STAGNATION.maxConsecutiveInjections) {
			delete st.directive;
		}
	}

	return { next: st, fired };
}

/**
 * Render the pending directive as a continuation-prompt section.
 * Returns undefined when there is nothing pending. Non-prescriptive by
 * design (AVO §3.3): trajectory review + fresh strategic framing, never a
 * mandated change.
 */
export function supervisorDirectiveBlock(d: SupervisorDirective): string {
	const header = "## SUPERVISOR DIRECTIVE — STAGNATION REVIEW";
	const body =
		d.kind === "exhaustion"
			? `The stagnation supervisor detected EXHAUSTION: ${d.reason}. Your current line of work looks mined out — you keep working but nothing is landing as durable progress. Before continuing, review your own trajectory: name what you have tried recently and what class of obstacle keeps absorbing the effort, then pick a genuinely different direction (different subsystem, different technique, different granularity) rather than another iteration on the same idea.`
			: `The stagnation supervisor detected CYCLING: ${d.reason}. You are producing substantially the same output repeatedly without moving the goal. Step back and diagnose why your work keeps converging to the same attempt, then break the symmetry deliberately: question the assumption all those attempts share.`;
	const footer =
		"This is strategic framing, not an instruction to make one specific change — you stay in charge of the approach. If you believe real progress IS happening, demonstrate it this turn with a concrete committed artifact (commit, completed task, written file) and this notice clears.";
	return `${header}\n\n${body}\n\n${footer}`;
}
