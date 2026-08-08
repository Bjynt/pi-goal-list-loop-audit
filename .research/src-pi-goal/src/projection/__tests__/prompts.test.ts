/**
 * projection/prompts.ts 测试 — prompt 生成函数 + formatBudget 4 样式
 *
 * 覆盖：
 * - formatBudget 4 种 style（percent/line/remaining/report）
 * - escapeXmlText（XML 注入防护）
 * - continuationPrompt / budgetLimitPrompt / objectiveUpdatedPrompt / contextInjectionPrompt
 *
 * 全解耦后 stalenessReminderPrompt 已删（原依赖 pi.__todoGetList，跨 ext 失效）。
 *
 * 纯函数测试，不 import Pi SDK。
 */
import { describe, expect, it } from "vitest";

import { createGoalState } from "../../engine/goal";
import type { GoalRuntimeState } from "../../engine/types";
import {
	budgetLimitPrompt,
	contextInjectionPrompt,
	continuationPrompt,
	formatBudget,
	objectiveUpdatedPrompt,
} from "../prompts";

// ── 辅助 ─────────────────────────────────────────────

function makeState(overrides?: Partial<GoalRuntimeState>): GoalRuntimeState {
	return {
		...createGoalState("test objective"),
		...overrides,
	};
}

// ── formatBudget 4 样式（FR-3.4 唯一收敛出口）────────

describe("formatBudget — 4 styles (FR-3.4)", () => {
	it("percent: Token + Time 百分比", () => {
		const state = makeState({
			budget: { tokenBudget: 1000, timeBudgetMinutes: 10 },
			tokensUsed: 500,
		});
		const out = formatBudget(state, 300, "percent"); // 300s = 5min / 10min = 50%
		expect(out).toContain("Token: 50%");
		expect(out).toContain("Time: 50%");
	});

	it("percent: 无预算 → 空字符串", () => {
		const state = makeState();
		expect(formatBudget(state, 0, "percent")).toBe("");
	});

	it("line: 剩余/总量格式", () => {
		const state = makeState({
			budget: { tokenBudget: 1000, timeBudgetMinutes: 10 },
			tokensUsed: 300,
		});
		const out = formatBudget(state, 120, "line"); // 120s = 2min used, 8min remaining
		expect(out).toContain("Tokens: 700/1000");
		expect(out).toContain("Time: 8m/10m");
	});

	it("remaining: used/total (N remaining) 格式", () => {
		const state = makeState({
			budget: { tokenBudget: 1000, timeBudgetMinutes: 10 },
			tokensUsed: 400,
		});
		const out = formatBudget(state, 60, "remaining"); // 60s=1min used, 9min remaining
		expect(out).toContain("Token: 400/1000 (600 remaining)");
		expect(out).toContain("Time: 1m/10m (9m remaining)");
	});

	it("report: 多行 usage + duration", () => {
		const state = makeState({
			budget: { tokenBudget: 1000, timeBudgetMinutes: 10 },
			tokensUsed: 700,
		});
		const out = formatBudget(state, 125, "report"); // 125s = 2m5s
		expect(out).toContain("Token usage: 700/1000");
		expect(out).toContain("Duration: 2m5s");
	});

	it("report: 无 token 预算 → 只有 duration", () => {
		const state = makeState();
		const out = formatBudget(state, 65, "report"); // 65s = 1m5s
		expect(out).toBe("Duration: 1m5s");
	});

	it("remaining clamp: 超预算不出现负数", () => {
		const state = makeState({
			budget: { tokenBudget: 100, timeBudgetMinutes: 1 },
			tokensUsed: 150, // 超 tokenBudget
		});
		const out = formatBudget(state, 120, "remaining"); // 120s 超 1min budget
		expect(out).toContain("(0 remaining)"); // 不出现负数
	});
});

// ── escapeXmlText（XML 注入防护）──────────────────────

describe("XML escaping in prompts", () => {
	it("objective 中的 <>& 被转义（continuationPrompt）", () => {
		const state = makeState({ objective: "<script>alert('x')</script> & data" });
		const out = continuationPrompt(state, 0);
		expect(out).toContain("&lt;script&gt;");
		expect(out).toContain("&amp; data");
		expect(out).not.toContain("<script>");
	});

	it("objectiveUpdatedPrompt 转义新旧 objective", () => {
		const state = makeState({ objective: "new <b>x</b>" });
		const out = objectiveUpdatedPrompt(state, "old <i>y</i> & z");
		expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
		expect(out).toContain("&lt;i&gt;y&lt;/i&gt;");
		expect(out).toContain("&amp; z");
	});
});

// ── continuationPrompt ───────────────────────────────

describe("continuationPrompt", () => {
	it("含 objective + Turn + Completion audit 段落", () => {
		const state = makeState({ currentTurnIndex: 3 });
		const out = continuationPrompt(state, 0);
		expect(out).toContain("Turn 3");
		expect(out).toContain("test objective");
		expect(out).toContain("Completion audit");
	});

	it("对标 Codex 三约束：Completion audit / Fidelity / Blocked 完整", () => {
		const state = makeState();
		const out = continuationPrompt(state, 0);
		// Completion audit: 逐项证据验证
		expect(out).toContain("Completion audit");
		expect(out).toContain("Evidence must prove completion");
		expect(out).toContain("are NOT evidence");
		// Fidelity: 不缩小目标范围
		expect(out).toContain("Fidelity");
		expect(out).toContain("requested end state");
		expect(out).toContain("narrower or safer solution");
		// Blocked: 不首次就放弃
		expect(out).toContain("Blocked");
		expect(out).toContain("Do not report blocked the first time");
		expect(out).toContain("try alternative approaches first");
	});

	it("软建议 complete 前完成所有 todo（FR-6，全解耦后非强制）", () => {
		const state = makeState();
		const out = continuationPrompt(state, 0);
		expect(out).toContain("Recommend finishing all todos");
		expect(out).toContain("verification todos");
	});

	it("含 plan audit 软提醒（FR-7/D27 prompt 驱动）", () => {
		const state = makeState();
		const out = continuationPrompt(state, 0);
		expect(out).toContain("plan.md step was executed");
	});
});

// ── budgetLimitPrompt ────────────────────────────────

describe("budgetLimitPrompt", () => {
	it("token 维度 → TOKEN budget 提示", () => {
		const state = makeState({
			budget: { tokenBudget: 1000, timeBudgetMinutes: 10 },
			tokensUsed: 950,
		});
		const out = budgetLimitPrompt(state, "token", 60);
		expect(out).toContain("TOKEN budget");
		expect(out).toContain("Tokens used: 950 / 1000");
		expect(out).toContain("wrap up immediately");
	});

	it("time 维度 → time budget 提示", () => {
		const state = makeState({
			budget: { tokenBudget: 1000, timeBudgetMinutes: 10 },
		});
		const out = budgetLimitPrompt(state, "time", 540); // 540s = 9m
		expect(out).toContain("time budget");
		expect(out).toContain("Time elapsed: 9m0s / 10 min");
	});
});

// ── objectiveUpdatedPrompt ───────────────────────────

describe("objectiveUpdatedPrompt", () => {
	it("显示新旧 objective + 指令", () => {
		const state = makeState({ objective: "new obj" });
		const out = objectiveUpdatedPrompt(state, "old obj");
		expect(out).toContain("Objective updated");
		expect(out).toContain("Previous objective: old obj");
		expect(out).toContain("new obj");
		expect(out).toContain("supersedes");
	});
});

// ── contextInjectionPrompt ───────────────────────────

describe("contextInjectionPrompt", () => {
	it("包含 objective/status/turn + 预算百分比 + 规则", () => {
		const state = makeState({
			status: "active",
			currentTurnIndex: 2,
			budget: { tokenBudget: 1000, timeBudgetMinutes: 10 },
			tokensUsed: 200,
		});
		const out = contextInjectionPrompt(state, 60);
		expect(out).toContain("GOAL mode activated");
		expect(out).toContain("Status: active");
		expect(out).toContain("Turn: 2");
		expect(out).toContain("Token: 20%"); // 200/1000
		expect(out).toContain("test objective");
	});

	it("要求建 todo（含 verification todo）", () => {
		const state = makeState();
		const out = contextInjectionPrompt(state, 0);
		expect(out).toContain("todo tool");
		expect(out).toContain("separate todo for verification checks");
	});

	it("无 goal_manager 引用（#1 清理后）", () => {
		const state = makeState();
		const out = contextInjectionPrompt(state, 0);
		expect(out).not.toContain("goal_manager");
		expect(out).not.toContain("create_tasks");
		expect(out).not.toContain("add_subtasks");
	});

	it("planAvailable=false（默认）→ 不建议 plan mode（避免建议不存在的工具，FR-7）", () => {
		const state = makeState();
		const out = contextInjectionPrompt(state, 0, false);
		expect(out).not.toContain("plan mode");
		expect(out).not.toContain("__planStart");
	});

	it("planAvailable=true → 注入 plan mode 建议段落（FR-7 LLM 自主判断复杂度）", () => {
		const state = makeState();
		const out = contextInjectionPrompt(state, 0, true);
		expect(out).toContain("plan mode");
		expect(out).toContain("__planStart");
		expect(out).toContain("Complex tasks");
	});
});

// ── successCriteria 注入（完成验证基准，与 objective 成对）──

describe("successCriteria 注入（<successCriteria> 段 + 条件文案）", () => {
	it("continuationPrompt：有 successCriteria → 含 <successCriteria> 段 + 条件文案", () => {
		const state = makeState({ successCriteria: "pnpm test passes; tsc clean" });
		const out = continuationPrompt(state, 0);
		expect(out).toContain("<successCriteria>");
		expect(out).toContain("</successCriteria>");
		expect(out).toContain("pnpm test passes; tsc clean");
		// 条件文案（continuationPrompt 专属）
		expect(out).toContain("every condition there must be met");
	});

	it("budgetLimitPrompt：有 successCriteria → 含 <successCriteria> 段 + 条件文案", () => {
		const state = makeState({
			successCriteria: "all tests green",
			budget: { tokenBudget: 1000 },
		});
		const out = budgetLimitPrompt(state, "token", 0);
		expect(out).toContain("<successCriteria>");
		expect(out).toContain("all tests green");
		// 条件文案（budgetLimitPrompt 专属）
		expect(out).toContain("every successCriteria condition is met");
	});

	it("contextInjectionPrompt：有 successCriteria → 含 <successCriteria> 段 + 条件文案", () => {
		const state = makeState({ successCriteria: "file X exists" });
		const out = contextInjectionPrompt(state, 0);
		expect(out).toContain("<successCriteria>");
		expect(out).toContain("file X exists");
		// 条件文案（contextInjectionPrompt 专属）
		expect(out).toContain("every successCriteria condition above must be met");
	});

	it("无 successCriteria → 不含 <successCriteria> 段（锁定 fallback）", () => {
		const state = makeState(); // createGoalState 不带 successCriteria
		const out = continuationPrompt(state, 0);
		expect(out).not.toContain("<successCriteria>");
		expect(out).not.toContain("every condition there must be met");
	});

	it("successCriteria 中的 <>& 被转义（防注入）", () => {
		const state = makeState({ successCriteria: "<x> & y" });
		const out = continuationPrompt(state, 0);
		expect(out).toContain("&lt;x&gt;");
		expect(out).toContain("&amp; y");
		expect(out).not.toContain("<x>");
	});
});
