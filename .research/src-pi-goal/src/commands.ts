/**
 * /goal 命令定义和参数解析
 */

import { UPDATE_PREFIX_LENGTH } from "./constants";
import type { BudgetConfig } from "./engine/types";

export interface GoalCommandArgs {
	action: "set" | "status" | "pause" | "resume" | "clear" | "update" | "history";
	objective?: string;
	budget?: Partial<BudgetConfig>;
	/** update 的可选新 successCriteria（`/goal update <obj> --criteria <text>`）；undefined = 未提供，保留旧值 */
	criteria?: string;
}

export function parseGoalArgs(raw: string): GoalCommandArgs {
	const trimmed = raw.trim().toLowerCase();
	const fullRaw = raw.trim();

	// Subcommands without objective
	if (trimmed === "" || trimmed === "status") {
		return { action: "status" };
	}
	if (trimmed === "resume") {
		return { action: "resume" };
	}
	if (trimmed === "pause") {
		return { action: "pause" };
	}
	if (trimmed === "clear") {
		return { action: "clear" };
	}
	if (trimmed === "history") {
		return { action: "history" };
	}

	// /goal update <new objective> [--criteria <text>]
	if (trimmed.startsWith("update ")) {
		const rest = fullRaw.slice(UPDATE_PREFIX_LENGTH).trim();
		// --criteria 作分隔标记（要求两侧空白，避免误切 objective 内文本）
		const criteriaSep = rest.match(/\s--criteria\s+/);
		if (criteriaSep) {
			const sepStart = criteriaSep.index ?? 0;
			const objective = rest.slice(0, sepStart).trim();
			const criteria = rest.slice(sepStart + criteriaSep[0].length).trim();
			return { action: "update", objective, criteria: criteria || undefined };
		}
		return { action: "update", objective: rest };
	}
	// /goal update (without argument) → 报错
	if (trimmed === "update") {
		return { action: "update" };
	}

	// /goal <objective> [--tokens N] [--timeout N]
	// 只匹配已知 flag，避免误删 objective 中的 -- 文本
	const knownFlags = /--(?:tokens|timeout)\s+\d+/g;
	const objective = fullRaw.replace(knownFlags, "").trim();
	const budget: Partial<BudgetConfig> = {};

	const tokenMatch = fullRaw.match(/--tokens\s+(\d+)/);
	if (tokenMatch) {
		const val = parseInt(tokenMatch[1]!, 10);
		if (!isNaN(val) && val > 0) budget.tokenBudget = val;
	}

	const timeMatch = fullRaw.match(/--timeout\s+(\d+)/);
	if (timeMatch) {
		const val = parseInt(timeMatch[1]!, 10);
		if (!isNaN(val) && val > 0) budget.timeBudgetMinutes = val;
	}

	if (!objective) {
		return { action: "status" };
	}

	return { action: "set", objective, budget };
}
