/**
 * command-adapter.ts 测试 — /goal 子命令（FR-3 pause/resume 对称；#1 删除 abort + task CRUD）
 *
 * 覆盖：
 * - FR-3: pause（active→paused tick 前置）+ resume（paused/blocked→active 对称 + budget 重检）
 * - MF-3 回归：clear/set-overwrite 转 cancelled 前 tick 累加时间
 * - MF-6 覆盖：命令分发 + 各 FR 分支（G-R2-008/G-014/G-002）
 *
 * 用 fake pi + fake ctx（不 import Pi SDK 真实实现）。
 * handleGoalCommand(pi, session, args, ctx) → Promise<void>。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { handleGoalCommand } from "../adapters/command-adapter";
import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";
import { createGoalSession } from "../session";

// ── Fake pi / ctx ────────────────────────────────────

interface RecordedCall {
	kind: "appendState" | "appendHistory" | "notify" | "sendContext" | "sendUser";
	text?: string;
	level?: string;
	content?: string;
	deliverAs?: string;
	customType?: string;
	payload?: unknown;
}

interface FakeHarness {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	states: unknown[];
	history: unknown[];
	piCalls: RecordedCall[];
	ctxCalls: RecordedCall[];
}

function makeHarness(): FakeHarness {
	const piCalls: RecordedCall[] = [];
	const ctxCalls: RecordedCall[] = [];
	const states: unknown[] = [];
	const history: unknown[] = [];

	const pi = {
		appendEntry(customType: string, data?: unknown): void {
			if (customType === "goal-history") history.push(data);
			else states.push(data);
			piCalls.push({
				kind: customType === "goal-history" ? "appendHistory" : "appendState",
				payload: data,
			});
		},
		sendMessage(message: unknown, _options?: unknown): void {
			const msg = message as { customType?: string; content?: string };
			piCalls.push({ kind: "sendContext", content: msg.content, customType: msg.customType });
		},
		sendUserMessage(content: string | unknown[], _options?: unknown): void {
			piCalls.push({ kind: "sendUser", content: typeof content === "string" ? content : undefined });
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: true,
		signal: { aborted: false } as AbortSignal,
		getContextUsage: () => null,
		ui: {
			notify: (text: string, level: string) => ctxCalls.push({ kind: "notify", text, level }),
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: { getEntries: () => [], getBranch: () => undefined },
	} as unknown as ExtensionContext;

	return { pi, ctx, states, history, piCalls, ctxCalls };
}

// ── 辅助 ─────────────────────────────────────────────

function makeActiveState(overrides?: Partial<GoalRuntimeState>): GoalRuntimeState {
	return {
		...createGoalState("test objective"),
		status: "active",
		timeStartedAt: 0, // 默认关闭时间累计
		...overrides,
	};
}

function allCalls(h: FakeHarness): RecordedCall[] {
	return [...h.piCalls, ...h.ctxCalls];
}

function notifyText(h: FakeHarness): string[] {
	return allCalls(h)
		.filter((c) => c.kind === "notify")
		.map((c) => c.text ?? "");
}

// ── /goal status ─────────────────────────────────────

describe("handleGoalCommand — status", () => {
	it("无 active goal → 提示未激活", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		await handleGoalCommand(h.pi, session, "status", h.ctx);
		expect(notifyText(h).some((t) => t.includes("not active"))).toBe(true);
	});

	it("有 active goal → 显示 status 面板", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState();
		await handleGoalCommand(h.pi, session, "status", h.ctx);
		const text = notifyText(h).join("\n");
		expect(text).toContain("test objective");
		expect(text).toContain("Status: active");
	});
});

// ── /goal pause（FR-3 用户暂停 active→paused）──

describe("handleGoalCommand — pause (FR-3 active→paused)", () => {
	it("active → paused：tick 前置累加 + persist + notify", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		const past = Date.now() - 4000;
		session.state = makeActiveState({ timeStartedAt: past, timeUsedSeconds: 6 });
		await handleGoalCommand(h.pi, session, "pause", h.ctx);
		expect(session.state!.status).toBe("paused");
		// tick 前置：转 paused 前累加当前运行段（6 + ~4s）
		expect(session.state!.timeUsedSeconds).toBeGreaterThanOrEqual(9);
		expect(h.states.length).toBeGreaterThanOrEqual(1); // persist 调用
		expect(notifyText(h).some((t) => t.includes("paused"))).toBe(true);
		expect(notifyText(h).some((t) => t.includes("resume"))).toBe(true);
	});

	it("非 active（blocked）→ 拒绝 pause", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({ status: "blocked" });
		await handleGoalCommand(h.pi, session, "pause", h.ctx);
		expect(session.state!.status).toBe("blocked"); // 未变
		expect(notifyText(h).some((t) => t.includes("not active"))).toBe(true);
	});

	it("无 active goal → 提示未激活", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		await handleGoalCommand(h.pi, session, "pause", h.ctx);
		expect(notifyText(h).some((t) => t.includes("not active"))).toBe(true);
	});
});

// ── /goal resume（FR-3：paused/blocked→active 对称 + G-014 预算重检）──

describe("handleGoalCommand — resume (FR-3 paused/blocked→active + G-014)", () => {
	it("blocked → active：resume 成功 + persist + 触发 AI", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({ status: "blocked" });
		await handleGoalCommand(h.pi, session, "resume", h.ctx);
		expect(session.state!.status).toBe("active");
		expect(h.states.length).toBeGreaterThanOrEqual(1); // persist 调用
		// FR-8.12: resume 后触发 AI
		expect(h.piCalls.some((c) => c.kind === "sendUser")).toBe(true);
	});

	it("paused → active：resume 成功 + persist + 触发 AI（FR-3 对称）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({ status: "paused" });
		await handleGoalCommand(h.pi, session, "resume", h.ctx);
		expect(session.state!.status).toBe("active");
		expect(h.states.length).toBeGreaterThanOrEqual(1); // persist 调用
		// FR-8.12: resume 后触发 AI
		expect(h.piCalls.some((c) => c.kind === "sendUser")).toBe(true);
	});

	it("resume 重置 timeStartedAt=now（FR-3.2 重启计时器）", async () => {
		// T2.3 显式断言：resume 时 timeStartedAt 必须重置为当前时刻（command-adapter.ts:144）
		const h = makeHarness();
		const session = createGoalSession();
		const staleTimeStartedAt = Date.now() - 100_000; // 旧值，远早于现在
		session.state = makeActiveState({ status: "paused", timeStartedAt: staleTimeStartedAt });
		const before = Date.now();
		await handleGoalCommand(h.pi, session, "resume", h.ctx);
		const after = Date.now();
		expect(session.state!.status).toBe("active");
		// timeStartedAt 已重置为 resume 调用时刻（落在 [before, after] 窗口内）
		expect(session.state!.timeStartedAt).toBeGreaterThanOrEqual(before);
		expect(session.state!.timeStartedAt).toBeLessThanOrEqual(after);
		expect(session.state!.timeStartedAt).not.toBe(staleTimeStartedAt); // 旧值已废弃
	});

	it("token 预算耗尽 → resume 转 budget_limited（G-014）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({
			status: "blocked",
			budget: {
				tokenBudget: 1000,
				timeBudgetMinutes: 30,
			},
			tokensUsed: 1200, // 已超 tokenBudget
		});
		await handleGoalCommand(h.pi, session, "resume", h.ctx);
		expect(session.state!.status).toBe("budget_limited");
		expect(notifyText(h).some((t) => t.includes("Token budget exhausted"))).toBe(true);
	});

	it("time 预算耗尽 → resume 转 time_limited（G-014）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({
			status: "blocked",
			timeStartedAt: 0,
			budget: {
				tokenBudget: 1000,
				timeBudgetMinutes: 30,
			},
			tokensUsed: 100, // token 未超
			timeUsedSeconds: 30 * 60, // 已超 timeBudgetMinutes*60
		});
		await handleGoalCommand(h.pi, session, "resume", h.ctx);
		expect(session.state!.status).toBe("time_limited");
		expect(notifyText(h).some((t) => t.includes("Time budget exhausted"))).toBe(true);
		// 拒绝 resume：不触发 AI
		expect(h.piCalls.some((c) => c.kind === "sendUser")).toBe(false);
	});

	it("非 paused/blocked 状态（active）→ 无需 resume", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({ status: "active" });
		await handleGoalCommand(h.pi, session, "resume", h.ctx);
		expect(notifyText(h).some((t) => t.includes("not paused or blocked"))).toBe(true);
	});
});

// ── /goal clear（FR-6.3 强制清）──

describe("handleGoalCommand — clear (FR-6.3)", () => {
	it("clear：强制清，写 cancelled history + clearSession", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState();
		await handleGoalCommand(h.pi, session, "clear", h.ctx);
		expect(session.state).toBeNull(); // clearGoalSession 清空
		expect(h.history.length).toBe(1); // 写 cancelled history
		expect(notifyText(h).some((t) => t.includes("cleared"))).toBe(true);
	});

	it("clear：MF-3 tick — active goal 转 cancelled 前累加时间", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		const past = Date.now() - 3000;
		session.state = makeActiveState({ timeStartedAt: past, timeUsedSeconds: 5 });
		await handleGoalCommand(h.pi, session, "clear", h.ctx);
		// history 里的 elapsedSeconds 应 ≈ 8（5 + 3）
		const histEntry = h.history[0] as { elapsedSeconds?: number } | undefined;
		expect(histEntry?.elapsedSeconds).toBeGreaterThanOrEqual(7);
	});
});

// ── /goal update（FR-8.4 G-002 重塑）──────────────

describe("handleGoalCommand — update (FR-8.4 G-002)", () => {
	it("重塑：重置 objective/flags/slug，保留 goalId", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		const originalGoalId = "goal-original-123";
		session.state = makeActiveState({
			goalId: originalGoalId,
			objective: "old objective",
			currentTurnIndex: 8,
			slug: "old-slug",
		});
		await handleGoalCommand(h.pi, session, "update brand new objective", h.ctx);

		expect(session.state!.objective).toBe("brand new objective");
		expect(session.state!.goalId).toBe(originalGoalId); // 保留
		expect(session.state!.currentTurnIndex).toBe(0);
		expect(session.state!.budgetLimitSteeringSent).toBe(false);
		expect(session.state!.slug).toBeUndefined(); // GAP-6: update 重置 slug
		expect(h.states.length).toBeGreaterThanOrEqual(1); // persist
	});

	it("无参数 → usage 提示", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState();
		await handleGoalCommand(h.pi, session, "update", h.ctx);
		expect(notifyText(h).some((t) => t.includes("Usage"))).toBe(true);
	});

	it("带 --criteria → 替换 successCriteria", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({
			objective: "old objective",
			successCriteria: "old criteria",
		});
		await handleGoalCommand(h.pi, session, "update new obj --criteria new criteria text", h.ctx);

		expect(session.state!.objective).toBe("new obj");
		expect(session.state!.successCriteria).toBe("new criteria text");
	});

	it("不带 --criteria → 保留旧 successCriteria（不静默丢失验证标准）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({
			objective: "old objective",
			successCriteria: "old criteria",
		});
		await handleGoalCommand(h.pi, session, "update new obj", h.ctx);

		expect(session.state!.objective).toBe("new obj");
		expect(session.state!.successCriteria).toBe("old criteria");
	});

	it("active 状态重塑 → 注入 objectiveUpdated steering", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({ objective: "old" });
		await handleGoalCommand(h.pi, session, "update new obj", h.ctx);
		// FR-8.4: active 时发送 steering
		expect(h.piCalls.some((c) => c.kind === "sendContext")).toBe(true);
	});
});

// ── /goal set（提示词触发器：sendUserMessage 让 AI 调 goal_control create）──

describe("handleGoalCommand — set (提示词触发器 + #11/D25 拒绝非终态)", () => {
	it("无旧 goal → 发触发消息（不直接创建 state）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		await handleGoalCommand(h.pi, session, "my objective", h.ctx);
		// 提示词触发器：不直接 createGoal，state 仍为 null（由 AI 后续 toolcall 创建）
		expect(session.state).toBeNull();
		expect(h.states).toHaveLength(0); // 不写 state
		// 发送 sendUserMessage 引导 AI 调 create
		const sendUserCalls = h.piCalls.filter((c) => c.kind === "sendUser");
		expect(sendUserCalls).toHaveLength(1);
		expect(sendUserCalls[0]?.content).toContain("my objective");
		expect(sendUserCalls[0]?.content).toContain("goal_control");
	});

	it("非终态旧 goal（active）→ 拒绝 + 提示（#11/D25），不发触发消息", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({ objective: "old active goal" });
		const historyBefore = h.history.length;
		await handleGoalCommand(h.pi, session, "new objective", h.ctx);
		// #11: 拒绝，不写 history，不覆盖旧 goal，不发触发消息
		expect(h.history.length).toBe(historyBefore); // 不写 history
		expect(notifyText(h).some((t) => t.includes("Goal already active"))).toBe(true);
		expect(notifyText(h).some((t) => t.includes("resume"))).toBe(true);
		expect(notifyText(h).some((t) => t.includes("clear"))).toBe(true);
		expect(session.state!.objective).toBe("old active goal"); // 旧 goal 保留，未覆盖
		expect(h.piCalls.some((c) => c.kind === "sendUser")).toBe(false); // 不触发 AI
	});

	it("非终态旧 goal（paused）→ 拒绝创建（#11/D25）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({ status: "paused", objective: "old paused goal" });
		await handleGoalCommand(h.pi, session, "new objective", h.ctx);
		expect(notifyText(h).some((t) => t.includes("Goal already active"))).toBe(true);
		expect(session.state!.status).toBe("paused"); // 状态不变
		expect(session.state!.objective).toBe("old paused goal"); // 旧 goal 保留
		expect(h.piCalls.some((c) => c.kind === "sendUser")).toBe(false); // 不触发 AI
	});

	it("终态旧 goal → 发触发消息（AI 会覆盖终态 goal）", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		session.state = makeActiveState({ status: "complete", objective: "old done" });
		const historyBefore = h.history.length;
		await handleGoalCommand(h.pi, session, "new objective", h.ctx);
		expect(h.history.length).toBe(historyBefore); // 不写 history（触发器不直接创建）
		// 终态旧 goal 不挡触发器，发消息让 AI 创建
		expect(h.piCalls.some((c) => c.kind === "sendUser")).toBe(true);
	});

	it("空 objective → usage 提示", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		// parseGoalArgs("") → { action: "status" }，空字符串走 status 路径
		await handleGoalCommand(h.pi, session, "", h.ctx);
		// 空字符串在 parseGoalArgs 里被识别为 status，不是 set；status 路径提示 "not active"
		expect(notifyText(h).some((t) => t.includes("not active"))).toBe(true);
	});

	it("--tokens 0 → parseGoalArgs 过滤（val > 0 校验），发触发消息", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		// parseGoalArgs 对 --tokens 0 的 val>0 校验失败，budget.tokenBudget 不设置
		// handleSet 收到 budgetOverrides=undefined（无 tokenBudget），发触发消息（objective 去掉了 flag）
		await handleGoalCommand(h.pi, session, "obj --tokens 0", h.ctx);
		// 提示词触发器不直接创建 state
		expect(session.state).toBeNull();
		const sendUserCalls = h.piCalls.filter((c) => c.kind === "sendUser");
		expect(sendUserCalls).toHaveLength(1);
		expect(sendUserCalls[0]?.content).toContain("obj");
	});

	it("--tokens N --timeout M → 触发消息含 budget 值", async () => {
		const h = makeHarness();
		const session = createGoalSession();
		await handleGoalCommand(h.pi, session, "obj --tokens 5000 --timeout 30", h.ctx);
		const sendUserCalls = h.piCalls.filter((c) => c.kind === "sendUser");
		expect(sendUserCalls).toHaveLength(1);
		expect(sendUserCalls[0]?.content).toContain("5000");
		expect(sendUserCalls[0]?.content).toContain("30");
	});
});

// ── /goal history ────────────────────────────────────

describe("handleGoalCommand — history", () => {
	it("无 history → 提示", async () => {
		const h = makeHarness();
		await handleGoalCommand(h.pi, createGoalSession(), "history", h.ctx);
		expect(notifyText(h).some((t) => t.includes("No goal history"))).toBe(true);
	});
});
