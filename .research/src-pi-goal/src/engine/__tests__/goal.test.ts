/**
 * engine/goal.ts 测试 — Goal 7 态状态机 + createGoalState
 */
import { describe, expect, it } from "vitest";

import {
	createGoalState,
	isActiveStatus,
	isTerminalStatus,
	transitionStatus,
} from "../goal";
import type { GoalStatus } from "../types";

const TERMINAL: GoalStatus[] = ["complete", "budget_limited", "time_limited", "cancelled"];
const NON_TERMINAL: GoalStatus[] = ["active", "paused", "blocked"]; // paused #2 新增
const ALL = [...NON_TERMINAL, ...TERMINAL];

// ── isTerminalStatus / isActiveStatus ─────────────────

describe("isTerminalStatus", () => {
	for (const s of TERMINAL) {
		it(`${s} → terminal`, () => expect(isTerminalStatus(s)).toBe(true));
	}
	for (const s of NON_TERMINAL) {
		it(`${s} → NOT terminal`, () => expect(isTerminalStatus(s)).toBe(false));
	}
});

describe("isActiveStatus", () => {
	it("active → true", () => expect(isActiveStatus("active")).toBe(true));
	for (const s of ALL) {
		if (s === "active") continue;
		it(`${s} → false`, () => expect(isActiveStatus(s)).toBe(false));
	}
});

// ── transitionStatus（查表，非法转换 throw）──────────────

describe("transitionStatus — 合法转换返回 next", () => {
	const legalCases: Array<[GoalStatus, GoalStatus]> = [
		["active", "paused"],
		["active", "blocked"],
		["active", "complete"],
		["active", "budget_limited"],
		["active", "time_limited"],
		["active", "cancelled"],
		["paused", "active"],
		["paused", "cancelled"],
		["blocked", "active"],
		["blocked", "cancelled"],
	];
	for (const [from, to] of legalCases) {
		it(`${from} → ${to} 返回 ${to}`, () => {
			expect(transitionStatus(from, to)).toBe(to);
		});
	}
});

describe("transitionStatus — 非法转换 throw", () => {
	// 终态不可转任何状态（VALID_TRANSITIONS 表为空）
	for (const terminal of TERMINAL) {
		for (const target of ALL) {
			it(`terminal ${terminal} → ${target} throw`, () => {
				expect(() => transitionStatus(terminal, target)).toThrow();
			});
		}
	}
	// 非终态的非法路径（不在 VALID_TRANSITIONS 表内）
	const illegalNonTerminal: Array<[GoalStatus, GoalStatus]> = [
		["active", "active"], // 自转不在表内
		["paused", "paused"],
		["paused", "blocked"],
		["paused", "complete"],
		["blocked", "blocked"],
		["blocked", "paused"],
		["blocked", "complete"],
	];
	for (const [from, to] of illegalNonTerminal) {
		it(`${from} → ${to} throw`, () => {
			expect(() => transitionStatus(from, to)).toThrow();
		});
	}
});

// ── createGoalState 初始值 ───────────────────────────

describe("createGoalState — 初始值", () => {
	it("status = active", () => expect(createGoalState("obj").status).toBe("active"));
	it("objective 透传", () => expect(createGoalState("my obj").objective).toBe("my obj"));
	it("tokensUsed = 0", () => expect(createGoalState("obj").tokensUsed).toBe(0));
	it("timeUsedSeconds = 0", () => expect(createGoalState("obj").timeUsedSeconds).toBe(0));
	it("goalId 非空", () => {
		expect(createGoalState("obj").goalId).toBeTruthy();
		expect(typeof createGoalState("obj").goalId).toBe("string");
	});
	it("两个 createGoalState 生成不同 goalId", () => {
		expect(createGoalState("obj").goalId).not.toBe(createGoalState("obj").goalId);
	});
	it("currentTurnIndex = 0", () => expect(createGoalState("obj").currentTurnIndex).toBe(0));
	it("completedAtTurnIndex = undefined", () => {
		expect(createGoalState("obj").completedAtTurnIndex).toBeUndefined();
	});
	// FR-6.2: 4 个独立预警 flag
	it("tokenWarning70Sent = false", () => expect(createGoalState("obj").tokenWarning70Sent).toBe(false));
	it("tokenWarning90Sent = false", () => expect(createGoalState("obj").tokenWarning90Sent).toBe(false));
	it("timeWarning70Sent = false", () => expect(createGoalState("obj").timeWarning70Sent).toBe(false));
	it("timeWarning90Sent = false", () => expect(createGoalState("obj").timeWarning90Sent).toBe(false));
});

describe("createGoalState — budget 合并", () => {
	it("无 overrides 用 DEFAULT_BUDGET", () => {
		const s = createGoalState("obj");
		expect(s.budget).toEqual({});
	});
	it("tokenBudget override", () => {
		expect(createGoalState("obj", { tokenBudget: 10000 }).budget.tokenBudget).toBe(10000);
	});
	it("timeBudgetMinutes override", () => {
		expect(createGoalState("obj", { timeBudgetMinutes: 30 }).budget.timeBudgetMinutes).toBe(30);
	});
	it("多字段 override", () => {
		const s = createGoalState("obj", { tokenBudget: 5000, timeBudgetMinutes: 30 });
		expect(s.budget.tokenBudget).toBe(5000);
		expect(s.budget.timeBudgetMinutes).toBe(30);
	});
});
