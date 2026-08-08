/**
 * widget.ts 测试 — projection 层渲染（TC-2）
 *
 * 覆盖：
 * - toSingleLine: 多行压缩
 * - renderStatusLine: 状态后缀 + cancelled 短路 + 预算/停滞指标
 * - renderWidgetLines: cancelled 短路 + objective + 预算进度条
 * - renderTerminalStatusLine: 终态单行 + cancelled 短路
 * - updateWidget: FR-6.6 hasUI 守卫 + 终态折叠 + cancelled 清除
 *
 * 用 passthrough ThemeLike（fg/bold 返回原文），断言渲染逻辑而非颜色。
 */
import { describe, expect, it } from "vitest";

import { createGoalState } from "../../engine/goal";
import type { GoalRuntimeState } from "../../engine/types";
import type { UiPort } from "../../ports";
import { createGoalSession } from "../../session";
import { OBJECTIVE_DISPLAY_LIMIT, OBJECTIVE_TRUNCATE_KEEP } from "../../constants";
import {
	renderStatusLine,
	renderTerminalStatusLine,
	renderWidgetLines,
	type ThemeLike,
	toSingleLine,
	updateWidget,
} from "../widget";

// ── Passthrough theme（断言渲染逻辑，不含颜色干扰）────

const theme: ThemeLike = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

// ── 辅助 ─────────────────────────────────────────────

function makeState(overrides?: Partial<GoalRuntimeState>): GoalRuntimeState {
	return {
		...createGoalState("test objective"),
		status: "active",
		...overrides,
	};
}

// ── toSingleLine ─────────────────────────────────────

describe("toSingleLine", () => {
	it("多行 → 空格分隔单行 + 去首尾空白（不折叠连续空格）", () => {
		expect(toSingleLine("hello\nworld")).toBe("hello world");
		expect(toSingleLine("a\nb\nc")).toBe("a b c");
		expect(toSingleLine("  trimmed  ")).toBe("trimmed");
	});
	it("单行原样返回（trim）", () => {
		expect(toSingleLine("  single  ")).toBe("single");
	});
});

// ── renderStatusLine ─────────────────────────────────

describe("renderStatusLine", () => {
	it("cancelled → 空字符串（短路）", () => {
		expect(renderStatusLine(makeState({ status: "cancelled" }), theme)).toBe("");
	});

	it("active 状态：标题用 slug（fallback objective）+ turn 计数", () => {
		const text = renderStatusLine(makeState({ status: "active", currentTurnIndex: 3 }), theme);
		// 无 slug 时 fallback 到 objective 截断
		expect(text).toContain("◆ test objective");
		expect(text).toContain("Turn 3"); // currentTurnIndex
	});

	it("active 状态有 slug → 标题用 slug", () => {
		const text = renderStatusLine(
			makeState({ status: "active", slug: "refactor-auth", currentTurnIndex: 2 }),
			theme,
		);
		expect(text).toContain("◆ refactor-auth");
		expect(text).not.toContain("test objective"); // slug 优先，objective 不显示
	});

	it("无预算 → 显示已消耗绝对值（token + time）", () => {
		const text = renderStatusLine(
			makeState({ status: "active", tokensUsed: 12000, timeUsedSeconds: 90 }),
			theme,
		);
		expect(text).toContain("12k tokens"); // formatTokens 缩写
		expect(text).toContain("1m30s"); // formatMinutes
	});

	it("blocked → 含 ⊘ Blocked 后缀", () => {
		const text = renderStatusLine(makeState({ status: "blocked" }), theme);
		expect(text).toContain("⊘ Blocked");
	});

	it("paused → 含 ⏸ Paused 后缀", () => {
		const text = renderStatusLine(makeState({ status: "paused" }), theme);
		expect(text).toContain("⏸ Paused");
	});

	it("complete → 含 ✓ Completed 后缀", () => {
		const text = renderStatusLine(makeState({ status: "complete" }), theme);
		expect(text).toContain("✓ Completed");
	});

	it("budget_limited → 含 ⊗ Token budget exhausted 后缀", () => {
		const text = renderStatusLine(makeState({ status: "budget_limited" }), theme);
		expect(text).toContain("⊗ Token budget exhausted");
	});

	it("time_limited → 含 ⏱ Time budget exhausted 后缀", () => {
		const text = renderStatusLine(makeState({ status: "time_limited" }), theme);
		expect(text).toContain("⏱ Time budget exhausted");
	});

	it("tokenBudget > 0 → 显示 token 百分比", () => {
		const text = renderStatusLine(
			makeState({
				status: "active",
				budget: { tokenBudget: 1000, timeBudgetMinutes: 0 },
				tokensUsed: 500,
			}),
			theme,
		);
		expect(text).toContain("50% tokens");
	});
});

// ── renderTerminalStatusLine ─────────────────────────

describe("renderTerminalStatusLine", () => {
	it("cancelled → 空字符串", () => {
		expect(renderTerminalStatusLine(makeState({ status: "cancelled" }), theme)).toBe("");
	});

	it("complete → 含 ✓ Completed", () => {
		const text = renderTerminalStatusLine(makeState({ status: "complete" }), theme);
		expect(text).toContain("✓ Completed");
	});

	it("budget_limited → 含 ⊗ Token budget exhausted", () => {
		const text = renderTerminalStatusLine(makeState({ status: "budget_limited" }), theme);
		expect(text).toContain("⊗ Token budget exhausted");
	});
});

// ── renderWidgetLines ────────────────────────────────

describe("renderWidgetLines", () => {
	it("cancelled → 空数组", () => {
		expect(renderWidgetLines(makeState({ status: "cancelled" }), theme)).toEqual([]);
	});

	it("active → 不含 objective 全文行（精简，slug 作标题）", () => {
		const lines = renderWidgetLines(makeState({ status: "active" }), theme);
		// GAP-8: 移除 Objective 全文行（slug 已作标题）
		expect(lines.some((l) => l.includes("Objective:"))).toBe(false);
	});

	it("active 无 slug → 标题 fallback objective 截断", () => {
		const lines = renderWidgetLines(makeState({ status: "active" }), theme);
		expect(lines[0]).toContain("◆ test objective");
	});

	it("tokenBudget + timeBudget → 含进度条行（used/total 格式）", () => {
		const lines = renderWidgetLines(
			makeState({
				status: "active",
				budget: { tokenBudget: 1000, timeBudgetMinutes: 30 },
				tokensUsed: 250,
				timeUsedSeconds: 540, // 9 min
			}),
			theme,
		);
		// 新格式：进度条 + used/total（缩写）
		expect(lines.some((l) => l.includes("Token:") && l.includes("250/1k"))).toBe(true);
		expect(lines.some((l) => l.includes("Time:") && l.includes("9m/30min"))).toBe(true);
	});

	it("无预算 → 显示已消耗绝对值行（no budget）", () => {
		const lines = renderWidgetLines(
			makeState({ status: "active", tokensUsed: 5000, timeUsedSeconds: 120 }),
			theme,
		);
		expect(lines.some((l) => l.includes("5k used (no budget)"))).toBe(true);
		expect(lines.some((l) => l.includes("2m elapsed (no budget)"))).toBe(true);
	});

	it("有 successCriteria → 含 ✓ 摘要行", () => {
		const lines = renderWidgetLines(
			makeState({ status: "active", successCriteria: "all tests green" }),
			theme,
		);
		expect(lines.some((l) => l.includes("✓") && l.includes("all tests green"))).toBe(true);
	});

	it("successCriteria 超长 → 截断为 ...（OBJECTIVE_TRUNCATE_KEEP）", () => {
		const long = "x".repeat(OBJECTIVE_DISPLAY_LIMIT + 10); // > 80 字符触发截断
		const lines = renderWidgetLines(
			makeState({ status: "active", successCriteria: long }),
			theme,
		);
		const criteriaLine = lines.find((l) => l.includes("✓"))!;
		expect(criteriaLine).toContain("...");
		// 截断后保留前 OBJECTIVE_TRUNCATE_KEEP(77) 字符
		expect(criteriaLine).toContain("x".repeat(OBJECTIVE_TRUNCATE_KEEP));
	});

	it("无 successCriteria → 不出现 ✓ 摘要行", () => {
		const lines = renderWidgetLines(makeState({ status: "active" }), theme);
		// active 状态行无 ✓（✓ Completed 仅出现在 complete 终态行）
		expect(lines.some((l) => l.includes("✓"))).toBe(false);
	});
});

// ── updateWidget（FR-6.6 hasUI 守卫）─────────────────

describe("updateWidget (FR-6.6 hasUI guard)", () => {
	interface RecordedCall {
		method: "setWidget" | "setStatus";
		args: unknown[];
	}

	function makeUiPort(hasUI: boolean): { ui: UiPort; calls: RecordedCall[] } {
		const calls: RecordedCall[] = [];
		const ui = {
			hasUI,
			setWidget(name: string, content: unknown) {
				calls.push({ method: "setWidget", args: [name, content] });
			},
			setStatus(name: string, text: unknown) {
				calls.push({ method: "setStatus", args: [name, text] });
			},
			notify() {},
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as UiPort;
		return { ui, calls };
	}

	it("hasUI=false → 不调 setWidget/setStatus（headless 守卫）", () => {
		const { ui, calls } = makeUiPort(false);
		const session = createGoalSession();
		session.state = makeState({ status: "active" });
		updateWidget(session, ui);
		expect(calls).toHaveLength(0); // FR-6.6
	});

	it("session.state=null → 清除 widget + status", () => {
		const { ui, calls } = makeUiPort(true);
		updateWidget(createGoalSession(), ui);
		expect(calls.some((c) => c.method === "setWidget" && c.args[1] === undefined)).toBe(true);
		expect(calls.some((c) => c.method === "setStatus" && c.args[1] === undefined)).toBe(true);
	});

	it("cancelled → 清除 widget + status", () => {
		const { ui, calls } = makeUiPort(true);
		const session = createGoalSession();
		session.state = makeState({ status: "cancelled" });
		updateWidget(session, ui);
		expect(calls.some((c) => c.method === "setWidget" && c.args[1] === undefined)).toBe(true);
		expect(calls.some((c) => c.method === "setStatus" && c.args[1] === undefined)).toBe(true);
	});

	it("终态（非 cancelled）→ setStatus 终态单行 + setWidget undefined", () => {
		const { ui, calls } = makeUiPort(true);
		const session = createGoalSession();
		session.state = makeState({ status: "complete" });
		updateWidget(session, ui);
		expect(calls.some((c) => c.method === "setStatus" && typeof c.args[1] === "string")).toBe(true);
		expect(calls.some((c) => c.method === "setWidget" && c.args[1] === undefined)).toBe(true);
	});

	it("active → setStatus + setWidget（正常渲染）", () => {
		const { ui, calls } = makeUiPort(true);
		const session = createGoalSession();
		session.state = makeState({ status: "active" });
		updateWidget(session, ui);
		expect(calls.some((c) => c.method === "setStatus" && typeof c.args[1] === "string")).toBe(true);
		expect(calls.some((c) => c.method === "setWidget" && Array.isArray(c.args[1]))).toBe(true);
	});
});
