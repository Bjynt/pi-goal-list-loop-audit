/**
 * engine/budget.ts 测试
 */
import { describe, expect, it } from "vitest";

import {
	accumulateTokens,
	checkBudgetOnResume,
	checkBudgetOnTurnEnd,
	getBudgetColor,
	getTimeUsagePercent,
	getTokenUsagePercent,
	tick,
} from "../budget";
import type { GoalRuntimeState } from "../types";

const makeState = (overrides: Partial<GoalRuntimeState> = {}): GoalRuntimeState => ({
	goalId: "test",
	objective: "test",
	status: "active",
	tokensUsed: 0,
	timeStartedAt: 1000,
	timeUsedSeconds: 0,
	budget: {},
	lastProgressTurn: 0,
	budgetLimitSteeringSent: false,
	objectiveUpdatedAt: 1000,
	lastBlockerReason: null,
	tokenWarning70Sent: false,
	tokenWarning90Sent: false,
	timeWarning70Sent: false,
	timeWarning90Sent: false,
	lastTurnTokensUsed: 0,
	currentTurnIndex: 0,
	...overrides,
});

// ── accumulateTokens（FR-8.6）─────────────────────────

describe("accumulateTokens", () => {
	it("input/output 有 → 加权 input×1 + cacheRead×0.02 + output×2", () => {
		// 100×1 + 20×0.02 + 50×2 = 200.4；1000 + 200.4 = 1200.4
		expect(accumulateTokens(1000, { input: 100, output: 50, cacheRead: 20 })).toBe(1200.4);
	});
	it("cacheRead > input → 加权后 input 仍计全量（不折底为 0）", () => {
		// 50×1 + 100×0.02 + 30×2 = 112；1000 + 112 = 1112
		expect(accumulateTokens(1000, { input: 50, output: 30, cacheRead: 100 })).toBe(1112);
	});
	it("input=0 output=0 → fallback totalTokens", () => {
		expect(accumulateTokens(1000, { totalTokens: 200 })).toBe(1200);
	});
	it("全空 → 不累加", () => {
		expect(accumulateTokens(1000, {})).toBe(1000);
	});
	it("无 cacheRead → 视为 0（加权 100×1 + 0×0.02 + 50×2 = 200）", () => {
		expect(accumulateTokens(0, { input: 100, output: 50 })).toBe(200);
	});
});

// ── tick（FR-6.5 纯函数）──────────────────────────────

describe("tick", () => {
	// timeStartedAt 是 Date.now() 毫秒时间戳；timeUsedSeconds 是累计秒数
	it("isRunning=true → 累加 (now-start)/1000 到 timeUsedSeconds", () => {
		expect(tick(1000000, 0, 1600000, true)).toEqual({ timeUsedSeconds: 600, timeStartedAt: 1600000 });
	});
	it("isRunning=true → 叠加已有 timeUsedSeconds", () => {
		expect(tick(1000000, 100, 1600000, true)).toEqual({ timeUsedSeconds: 700, timeStartedAt: 1600000 });
	});
	it("isRunning=false → 不累加，但重置 timeStartedAt=now", () => {
		expect(tick(1000000, 500, 2000000, false)).toEqual({ timeUsedSeconds: 500, timeStartedAt: 2000000 });
	});
	it("纯函数：相同输入相同输出", () => {
		expect(tick(1000000, 50, 2000000, true)).toEqual(tick(1000000, 50, 2000000, true));
	});
});

// ── checkBudgetOnTurnEnd（FR-6.2 维度独立）────────────

describe("checkBudgetOnTurnEnd — 无预算", () => {
	it("无 token/time budget → ok", () => {
		const r = checkBudgetOnTurnEnd(makeState(), 0);
		expect(r.terminal).toBeNull();
		expect(r.warnings).toEqual([]);
		expect(r.shouldSendSteering).toBe(false);
	});
});

describe("checkBudgetOnTurnEnd — token 阈值", () => {
	it("token < 70% → 无预警", () => {
		const s = makeState({ tokensUsed: 600, budget: { tokenBudget: 1000 } });
		expect(checkBudgetOnTurnEnd(s, 0).warnings).toEqual([]);
	});
	it("token >= 70% 未发 → warning70 token", () => {
		const s = makeState({ tokensUsed: 700, budget: { tokenBudget: 1000 } });
		expect(checkBudgetOnTurnEnd(s, 0).warnings).toContainEqual({ type: "warning70", dimension: "token" });
	});
	it("token >= 70% 已发 → 不重复", () => {
		const s = makeState({ tokensUsed: 750, tokenWarning70Sent: true, budget: { tokenBudget: 1000 } });
		expect(checkBudgetOnTurnEnd(s, 0).warnings).not.toContainEqual({ type: "warning70", dimension: "token" });
	});
	it("token >= 90% 未发 steering → shouldSendSteering", () => {
		const s = makeState({ tokensUsed: 950, budget: { tokenBudget: 1000 } });
		expect(checkBudgetOnTurnEnd(s, 0).shouldSendSteering).toBe(true);
	});
	it("token >= 100% 已发 steering → terminal exceeded token", () => {
		const s = makeState({ tokensUsed: 1000, budgetLimitSteeringSent: true, budget: { tokenBudget: 1000 } });
		expect(checkBudgetOnTurnEnd(s, 0).terminal).toEqual({ type: "exceeded", dimension: "token" });
	});
});

describe("checkBudgetOnTurnEnd — time 阈值", () => {
	it("time < 70% → 无预警", () => {
		const s = makeState({ budget: { timeBudgetMinutes: 10 } });
		expect(checkBudgetOnTurnEnd(s, 300).warnings).toEqual([]);
	});
	it("time >= 70% → warning70 time", () => {
		const s = makeState({ budget: { timeBudgetMinutes: 10 } });
		expect(checkBudgetOnTurnEnd(s, 420).warnings).toContainEqual({ type: "warning70", dimension: "time" });
	});
	it("time >= 100% → terminal exceeded time", () => {
		const s = makeState({ budget: { timeBudgetMinutes: 10 } });
		expect(checkBudgetOnTurnEnd(s, 600).terminal).toEqual({ type: "exceeded", dimension: "time" });
	});
});

describe("checkBudgetOnTurnEnd — FR-6.2 维度独立（核心 bug 修复）", () => {
	it("token 已发 70%，time 到 70% 也独立发", () => {
		const s = makeState({
			tokensUsed: 750, tokenWarning70Sent: true,
			budget: { tokenBudget: 1000, timeBudgetMinutes: 10 },
		});
		const r = checkBudgetOnTurnEnd(s, 450); // time 75%
		expect(r.warnings).toContainEqual({ type: "warning70", dimension: "time" });
		expect(r.warnings).not.toContainEqual({ type: "warning70", dimension: "token" });
	});
	it("两个维度同时到 70% → 两个 warning70 都发", () => {
		const s = makeState({
			tokensUsed: 750,
			budget: { tokenBudget: 1000, timeBudgetMinutes: 10 },
		});
		const r = checkBudgetOnTurnEnd(s, 450);
		expect(r.warnings).toContainEqual({ type: "warning70", dimension: "token" });
		expect(r.warnings).toContainEqual({ type: "warning70", dimension: "time" });
	});
});

// ── checkBudgetOnResume ──────────────────────────────

describe("checkBudgetOnResume", () => {
	it("无预算 → null", () => expect(checkBudgetOnResume(makeState())).toBeNull());
	it("token 超额 → exceeded token", () => {
		const s = makeState({ tokensUsed: 1000, budget: { tokenBudget: 1000 } });
		expect(checkBudgetOnResume(s)).toEqual({ type: "exceeded", dimension: "token" });
	});
	it("time 超额 → exceeded time", () => {
		const s = makeState({ timeUsedSeconds: 700, budget: { timeBudgetMinutes: 10 } });
		expect(checkBudgetOnResume(s)).toEqual({ type: "exceeded", dimension: "time" });
	});
	it("未超额 → null", () => {
		const s = makeState({ tokensUsed: 500, budget: { tokenBudget: 1000 } });
		expect(checkBudgetOnResume(s)).toBeNull();
	});
});


// ── 百分比 + 颜色 ────────────────────────────────────

describe("getTokenUsagePercent / getTimeUsagePercent", () => {
	it("无 tokenBudget → 0", () => expect(getTokenUsagePercent(makeState())).toBe(0));
	it("50% token", () => {
		expect(getTokenUsagePercent(makeState({ tokensUsed: 500, budget: { tokenBudget: 1000 } }))).toBe(50);
	});
	it("无 timeBudgetMinutes → 0", () => expect(getTimeUsagePercent(makeState(), 100)).toBe(0));
	it("50% time", () => {
		expect(getTimeUsagePercent(makeState({ budget: { timeBudgetMinutes: 10 } }), 300)).toBe(50);
	});
});

describe("getBudgetColor", () => {
	it(">=90 → error", () => expect(getBudgetColor(90)).toBe("error"));
	it(">=70 → warning", () => expect(getBudgetColor(70)).toBe("warning"));
	it("<70 → muted", () => expect(getBudgetColor(69)).toBe("muted"));
});
