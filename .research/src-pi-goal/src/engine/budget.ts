/**
 * Budget 决策引擎 — 纯函数
 *
 * 零 Pi 依赖。import from "./types"。
 *
 * FR-6.5: tick 是纯函数（不调 Date.now，不查 status）
 * FR-6.2: checkBudgetOnTurnEnd 用 4 个独立 flag
 * FR-8.6: accumulateTokens token 累加算法
 */

import type { GoalRuntimeState } from "./types";

// ── 常量（engine 内部，保持自洽）──────────────────────

const RATIO_HIGH = 0.9;
const RATIO_LOW = 0.7;
const PERCENT_FACTOR = 100;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

// 加权系数（与 @zhushanwen/pi-subagent-workflow Budget.consume 对齐，ADR-030 token 口径统一）
const INPUT_WEIGHT = 1;
const CACHE_READ_WEIGHT = 0.02;
const OUTPUT_WEIGHT = 2;

// ── 类型 ────────────────────────────────────────────

export interface TokenUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	totalTokens?: number;
}

export interface TickResult {
	timeUsedSeconds: number;
	timeStartedAt: number;
}

export type BudgetDecision =
	| { type: "warning70"; dimension: "token" | "time" }
	| { type: "warning90"; dimension: "token" | "time" };

export interface BudgetCheckResult {
	terminal: { type: "exceeded"; dimension: "token" | "time" } | null;
	warnings: BudgetDecision[];
	shouldSendSteering: boolean;
}


// ── token 累加（FR-8.6）──────────────────────────────

export function accumulateTokens(currentTokensUsed: number, usage: TokenUsage): number {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	if (input > 0 || output > 0) {
		// 加权口径：input×1 + cacheRead×0.02 + output×2
		// 与 @zhushanwen/pi-subagent-workflow Budget.consume() 对齐（ADR-030 token 口径统一），
		// 修复旧公式 max(input-cacheRead,0)+output 在长 session 中 cacheRead>0 时低估预算消耗
		return currentTokensUsed + input * INPUT_WEIGHT + cacheRead * CACHE_READ_WEIGHT + output * OUTPUT_WEIGHT;
	}
	return currentTokensUsed + (usage.totalTokens ?? 0);
}

// ── 时间累计（FR-6.5 纯函数）──────────────────────────

export function tick(
	timeStartedAt: number,
	timeUsedSeconds: number,
	now: number,
	isRunning: boolean,
): TickResult {
	if (isRunning && timeStartedAt > 0) {
		const elapsed = (now - timeStartedAt) / MS_PER_SECOND;
		return { timeUsedSeconds: timeUsedSeconds + elapsed, timeStartedAt: now };
	}
	return { timeUsedSeconds, timeStartedAt: now };
}

// ── 百分比计算 ───────────────────────────────────────

export function getTokenUsagePercent(state: GoalRuntimeState): number {
	if (!state.budget.tokenBudget || state.budget.tokenBudget <= 0) return 0;
	return (state.tokensUsed / state.budget.tokenBudget) * PERCENT_FACTOR;
}

export function getTimeUsagePercent(state: GoalRuntimeState, timeUsedSeconds: number): number {
	if (!state.budget.timeBudgetMinutes || state.budget.timeBudgetMinutes <= 0) return 0;
	const budgetSeconds = state.budget.timeBudgetMinutes * SECONDS_PER_MINUTE;
	return (timeUsedSeconds / budgetSeconds) * PERCENT_FACTOR;
}

export function getBudgetColor(percent: number): "error" | "warning" | "muted" {
	if (percent >= RATIO_HIGH * PERCENT_FACTOR) return "error";
	if (percent >= RATIO_LOW * PERCENT_FACTOR) return "warning";
	return "muted";
}

// ── turn end 预算检查（FR-6.2 维度独立）───────────────

export function checkBudgetOnTurnEnd(state: GoalRuntimeState, timeUsedSeconds: number): BudgetCheckResult {
	const result: BudgetCheckResult = { terminal: null, warnings: [], shouldSendSteering: false };

	// token 维度
	// 注：token 终态需 budgetLimitSteeringSent=true（90% steering 已发），time 维度无此 gate。
	// 这是有意设计——token 有 90% steering 中间态（给 agent 收尾机会），需 steering 已发才确认
	// 「agent 已被提醒但未收尾」→ 终态合理；time 维度无 steering 中间态，超额直接终态。
	if (state.budget.tokenBudget) {
		const tokenPct = state.tokensUsed / state.budget.tokenBudget;
		if (tokenPct >= 1 && state.budgetLimitSteeringSent) {
			result.terminal = { type: "exceeded", dimension: "token" };
			return result;
		}
		if (tokenPct >= RATIO_HIGH && !state.budgetLimitSteeringSent) {
			result.shouldSendSteering = true;
		} else if (tokenPct >= RATIO_HIGH && !state.tokenWarning90Sent) {
			result.warnings.push({ type: "warning90", dimension: "token" });
		} else if (tokenPct >= RATIO_LOW && !state.tokenWarning70Sent) {
			result.warnings.push({ type: "warning70", dimension: "token" });
		}
	}

	// time 维度（FR-6.2: 独立 flag，不被 token 吞）
	if (state.budget.timeBudgetMinutes) {
		const budgetSeconds = state.budget.timeBudgetMinutes * SECONDS_PER_MINUTE;
		if (timeUsedSeconds >= budgetSeconds) {
			result.terminal = { type: "exceeded", dimension: "time" };
			return result;
		}
		const timePct = timeUsedSeconds / budgetSeconds;
		if (timePct >= RATIO_HIGH && !state.timeWarning90Sent) {
			result.warnings.push({ type: "warning90", dimension: "time" });
		} else if (timePct >= RATIO_LOW && !state.timeWarning70Sent) {
			result.warnings.push({ type: "warning70", dimension: "time" });
		}
	}

	return result;
}

// ── resume 预算重检 ──────────────────────────────────

export function checkBudgetOnResume(state: GoalRuntimeState): { type: "exceeded"; dimension: "token" | "time" } | null {
	if (state.budget.tokenBudget && state.tokensUsed >= state.budget.tokenBudget) {
		return { type: "exceeded", dimension: "token" };
	}
	if (state.budget.timeBudgetMinutes) {
		if (state.timeUsedSeconds >= state.budget.timeBudgetMinutes * SECONDS_PER_MINUTE) {
			return { type: "exceeded", dimension: "time" };
		}
	}
	return null;
}
