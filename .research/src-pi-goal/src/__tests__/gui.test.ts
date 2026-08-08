/**
 * buildGoalGui 测试 — goal 的 GUI 渲染描述符构造（W3 Wave __gui__ 协议）
 *
 * 覆盖：
 * - 有 tokenBudget/timeBudget → card(progress-bar + stats-line)
 * - 预算消耗阈值（≥70% warn, ≥90% danger）
 * - 状态→severity/variant 映射
 * - 无 budget → stats-line 摘要
 */
import { describe, expect, it } from "vitest";

import { buildGoalGui } from "../adapters/goal-control-adapter";
import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";

function makeState(overrides: Partial<GoalRuntimeState> = {}): GoalRuntimeState {
	return {
		...createGoalState("test"),
		...overrides,
	};
}

describe("buildGoalGui", () => {
	it("有 tokenBudget → card 含 progress-bar + stats-line", () => {
		const gui = buildGoalGui(
			makeState({
				tokensUsed: 4200,
				budget: { tokenBudget: 10000 },
				currentTurnIndex: 3,
			}),
		);
		expect(gui.v).toBe(1);
		expect(gui.component.type).toBe("card");
		const body = gui.component.props.body as { type: string; props: Record<string, unknown> }[];
		// body[0] = progress-bar(tokens), body[1] = stats-line
		const tokenBar = body.find((c) => c.type === "progress-bar")!;
		expect(tokenBar.props).toMatchObject({ current: 4200, total: 10000, severity: "ok" });
		const stats = body.find((c) => c.type === "stats-line")!;
		expect(stats.props.items).toContainEqual(expect.objectContaining({ label: "status", value: "active" }));
	});

	it("token 消耗 ≥90% → severity danger", () => {
		const gui = buildGoalGui(
			makeState({
				tokensUsed: 9500,
				budget: { tokenBudget: 10000 },
			}),
		);
		const body = gui.component.props.body as { type: string; props: Record<string, unknown> }[];
		const tokenBar = body.find((c) => c.type === "progress-bar")!;
		expect(tokenBar.props.severity).toBe("danger");
	});

	it("token 消耗 ≥70% → severity warn", () => {
		const gui = buildGoalGui(
			makeState({
				tokensUsed: 7500,
				budget: { tokenBudget: 10000 },
			}),
		);
		const body = gui.component.props.body as { type: string; props: Record<string, unknown> }[];
		const tokenBar = body.find((c) => c.type === "progress-bar")!;
		expect(tokenBar.props.severity).toBe("warn");
	});

	it("无 budget → stats-line 摘要", () => {
		const gui = buildGoalGui(
			makeState({
				currentTurnIndex: 5,
				tokensUsed: 3000,
			}),
		);
		expect(gui.component.type).toBe("stats-line");
		const items = gui.component.props.items as { label?: string }[];
		const labels = items.map((i) => i.label);
		expect(labels).toContain("goal");
		expect(labels).toContain("status");
		expect(labels).toContain("turn");
		expect(labels).toContain("tokens");
	});

	it("blocked 状态 → card variant danger", () => {
		const gui = buildGoalGui(
			makeState({
				status: "blocked",
				budget: { tokenBudget: 10000 },
			}),
		);
		expect(gui.component.type).toBe("card");
		expect(gui.component.props.variant).toBe("danger");
	});

	it("complete 状态 → card variant success", () => {
		const gui = buildGoalGui(
			makeState({
				status: "complete",
				budget: { tokenBudget: 10000 },
			}),
		);
		expect(gui.component.type).toBe("card");
		expect(gui.component.props.variant).toBe("success");
	});

	it("time 进度条：≥90% → danger", () => {
		const gui = buildGoalGui(
			makeState({
				timeUsedSeconds: 5 * 60 + 1, // 5.01 min / 5 min budget
				budget: { timeBudgetMinutes: 5 },
			}),
		);
		const body = gui.component.props.body as { type: string; props: { label?: string; severity?: string } }[];
		const timeBar = body.find((c) => c.type === "progress-bar" && c.props.label === "time")!;
		expect(timeBar.props.severity).toBe("danger");
	});

	it("slug 缺省 → header 用 goalId 前 8 字符", () => {
		const state = makeState({ slug: undefined, budget: { tokenBudget: 10000 } });
		const gui = buildGoalGui(state);
		expect(gui.component.props.header).toBe(state.goalId.slice(0, 8));
	});

	// ── S#2: statusSeverity 完整覆盖 ──

	it("budget_limited 状态 → status severity danger（S#2）", () => {
		const gui = buildGoalGui(makeState({ status: "budget_limited", budget: { tokenBudget: 10000 } }));
		const body = gui.component.props.body as { type: string; props: { items: Array<{ label: string; severity: string }> } }[];
		const stats = body.find((c) => c.type === "stats-line")!;
		const statusItem = stats.props.items.find((i) => i.label === "status")!;
		expect(statusItem.severity).toBe("danger");
	});

	it("time_limited 状态 → status severity danger（S#2）", () => {
		const gui = buildGoalGui(makeState({ status: "time_limited", budget: { tokenBudget: 10000 } }));
		const body = gui.component.props.body as { type: string; props: { items: Array<{ label: string; severity: string }> } }[];
		const stats = body.find((c) => c.type === "stats-line")!;
		const statusItem = stats.props.items.find((i) => i.label === "status")!;
		expect(statusItem.severity).toBe("danger");
	});

	it("cancelled 状态 → status severity danger（S#2）", () => {
		const gui = buildGoalGui(makeState({ status: "cancelled", budget: { tokenBudget: 10000 } }));
		const body = gui.component.props.body as { type: string; props: { items: Array<{ label: string; severity: string }> } }[];
		const stats = body.find((c) => c.type === "stats-line")!;
		const statusItem = stats.props.items.find((i) => i.label === "status")!;
		expect(statusItem.severity).toBe("danger");
	});

	it("paused 状态 → status severity warn（S#2）", () => {
		const gui = buildGoalGui(makeState({ status: "paused", budget: { tokenBudget: 10000 } }));
		const body = gui.component.props.body as { type: string; props: { items: Array<{ label: string; severity: string }> } }[];
		const stats = body.find((c) => c.type === "stats-line")!;
		const statusItem = stats.props.items.find((i) => i.label === "status")!;
		expect(statusItem.severity).toBe("warn");
	});

	// ── S#14: 阈值边界精确值 ──

	it("token 消耗正好 90% → severity danger（边界 ≥，S#14）", () => {
		const gui = buildGoalGui(makeState({ tokensUsed: 9000, budget: { tokenBudget: 10000 } }));
		const body = gui.component.props.body as { type: string; props: { label?: string; severity?: string } }[];
		const tokenBar = body.find((c) => c.type === "progress-bar" && c.props.label === "tokens")!;
		expect(tokenBar.props.severity).toBe("danger");
	});

	it("token 消耗正好 70% → severity warn（边界 ≥，S#14）", () => {
		const gui = buildGoalGui(makeState({ tokensUsed: 7000, budget: { tokenBudget: 10000 } }));
		const body = gui.component.props.body as { type: string; props: { label?: string; severity?: string } }[];
		const tokenBar = body.find((c) => c.type === "progress-bar" && c.props.label === "tokens")!;
		expect(tokenBar.props.severity).toBe("warn");
	});

	it("time 消耗正好 70% → severity warn（边界 ≥，S#14）", () => {
		const gui = buildGoalGui(makeState({ timeUsedSeconds: 7 * 60, budget: { timeBudgetMinutes: 10 } }));
		const body = gui.component.props.body as { type: string; props: { label?: string; severity?: string } }[];
		const timeBar = body.find((c) => c.type === "progress-bar" && c.props.label === "time")!;
		expect(timeBar.props.severity).toBe("warn");
	});

	// ── I#1: tokenBudget=0 口径统一 ──

	it("tokenBudget=0 → 无 progress-bar（口径 >0，I#1）", () => {
		const gui = buildGoalGui(makeState({ tokensUsed: 0, budget: { tokenBudget: 0 } }));
		// tokenBudget=0 → hasBudget=false → 走无 budget 分支的 stats-line
		expect(gui.component.type).toBe("stats-line");
	});

	// ── 无 budget 分支的 status severity ──

	it("无 budget 时 status severity 正确（S#14）", () => {
		const gui = buildGoalGui(makeState({ status: "active" }));
		const items = gui.component.props.items as Array<{ label: string; severity?: string }>;
		const statusItem = items.find((i) => i.label === "status");
		expect(statusItem!.severity).toBe("ok");
	});

	// ── successCriteria 渲染（与 objective 成对，让用户看到「怎么算完成」）──

	it("card 分支（有 budget）+ successCriteria → body 含 stats-line {label:'done'}", () => {
		const gui = buildGoalGui(
			makeState({
				successCriteria: "all tests green",
				budget: { tokenBudget: 10000 },
			}),
		);
		expect(gui.component.type).toBe("card");
		const body = gui.component.props.body as {
			type: string;
			props: { items: Array<{ label: string; value: string }> };
		}[];
		const doneStats = body.find(
			(c) => c.type === "stats-line" && c.props.items.some((i) => i.label === "done"),
		)!;
		expect(doneStats.props.items).toContainEqual({ label: "done", value: "all tests green" });
	});

	it("无 budget 分支 + successCriteria → items 含 {label:'done'}", () => {
		const gui = buildGoalGui(makeState({ successCriteria: "all tests green" }));
		expect(gui.component.type).toBe("stats-line");
		const items = gui.component.props.items as Array<{ label: string; value: string }>;
		expect(items).toContainEqual({ label: "done", value: "all tests green" });
	});
});
