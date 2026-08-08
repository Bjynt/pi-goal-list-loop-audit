/**
 * service.ts 测试 — 用 fake ports（内存实现 ports.ts 接口）
 *
 * FR-7.2: service 层测试，不 import Pi SDK
 */
import { describe, expect, it } from "vitest";

import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";
import { applyEvent, createGoal, finalizeGoal, persistAndUpdate, type ServicePorts } from "../service";
import { createGoalSession } from "../session";

// ── Fake Ports ───────────────────────────────────────

function makeFakePorts(): ServicePorts & {
	states: GoalRuntimeState[];
	history: unknown[];
} {
	const states: GoalRuntimeState[] = [];
	const history: unknown[] = [];
	return {
		states,
		history,
		persistence: {
			appendState: (s) => {
				states.push(s);
			},
			appendHistory: (e) => {
				history.push(e);
			},
		},
		ui: {
			setWidget: () => {},
			setStatus: () => {},
			notify: () => {},
			hasUI: true,
			// ThemeLike 直接成员（widget 经 asTheme 取出，见 projection/widget.ts）
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		},
		messaging: {
			sendContextMessage: () => {},
			sendUserMessage: () => {},
		},
		session: {
			getEntries: () => [],
			getContextUsage: () => null,
			signal: undefined,
		},
	};
}

const makeState = (): GoalRuntimeState => createGoalState("test");

// ── createGoal 测试 ──────────────────────────────────

describe("createGoal — 唯一创建入口", () => {
	it("成功创建：state 构造 + persist", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		const ok = createGoal(session, "my objective", {}, ports, false);
		expect(ok).toBe(true);
		expect(session.state).not.toBeNull();
		expect(session.state!.objective).toBe("my objective");
		expect(ports.states.length).toBeGreaterThanOrEqual(1);
	});

	it("已有 active goal → 拒绝创建（返回 false）", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		createGoal(session, "first", {}, ports, false);
		const ok = createGoal(session, "second", {}, ports, false);
		expect(ok).toBe(false);
		expect(session.state!.objective).toBe("first"); // 保持原 goal
	});

	it("终态 goal → 允许创建（覆盖）", () => {
		const session = createGoalSession();
		const ports = makeFakePorts();
		session.state = makeState();
		session.state.status = "complete"; // 终态
		const ok = createGoal(session, "new", {}, ports, false);
		expect(ok).toBe(true);
		expect(session.state.objective).toBe("new");
	});
});

// ── finalizeGoal — history 写入矩阵 ──────────────────

describe("finalizeGoal — history 写入矩阵", () => {
	it("complete → 写 history", () => {
		const ports = makeFakePorts();
		const state = makeState();
		finalizeGoal(state, "complete", ports, { completedTasks: 1 });
		expect(ports.history.length).toBe(1);
		expect((ports.history[0] as { status: string }).status).toBe("complete");
		expect(state.completedAtTurnIndex).toBe(state.currentTurnIndex);
	});

	it("cancelled → 写 history", () => {
		const ports = makeFakePorts();
		const state = makeState();
		finalizeGoal(state, "cancelled", ports, { completedTasks: 0 });
		expect(ports.history.length).toBe(1);
	});

	it("budget_limited → 写 history", () => {
		const ports = makeFakePorts();
		const state = makeState();
		finalizeGoal(state, "budget_limited", ports, { completedTasks: 2 });
		expect(ports.history.length).toBe(1);
	});

	it("time_limited → 写 history", () => {
		const ports = makeFakePorts();
		const state = makeState();
		finalizeGoal(state, "time_limited", ports, { completedTasks: 0 });
		expect(ports.history.length).toBe(1);
	});

	it("终态 goal 再 finalize → throw（查表非法转换）", () => {
		const ports = makeFakePorts();
		const state = makeState();
		state.status = "complete";
		// transitionStatus 查表：终态不可转，调用方须先 isTerminalStatus 守卫
		expect(() => finalizeGoal(state, "cancelled", ports, { completedTasks: 0 })).toThrow();
		expect(state.status).toBe("complete");
	});
});

// ── applyEvent — 简单事件（路径 B）────────────────────

describe("applyEvent — 简单事件", () => {
	it("message_end 累加 assistant token（FR-8.6）", () => {
		const session = createGoalSession();
		session.state = makeState();
		const before = session.state.tokensUsed;
		applyEvent(session, "message_end", {
			message: {
				role: "assistant",
				usage: { input: 100, output: 50, cacheRead: 20 },
			},
		}, makeFakePorts());
		// accumulateTokens: 100×1 + 20×0.02 + 50×2 = 200.4（加权口径，对齐 workflow 包）
		expect(session.state.tokensUsed).toBe(before + 200.4);
	});

	it("message_end 忽略非 assistant 消息", () => {
		const session = createGoalSession();
		session.state = makeState();
		const before = session.state.tokensUsed;
		applyEvent(session, "message_end", {
			message: { role: "user", usage: { input: 100, output: 50 } },
		}, makeFakePorts());
		expect(session.state.tokensUsed).toBe(before);
	});

	it("message_end 缺 usage → 不变", () => {
		const session = createGoalSession();
		session.state = makeState();
		const before = session.state.tokensUsed;
		applyEvent(session, "message_end", { message: { role: "assistant" } }, makeFakePorts());
		expect(session.state.tokensUsed).toBe(before);
	});

	it("回归#1: message_end 非 active（blocked）→ 不累加 token（FR-8.6 G-R2-001）", () => {
		const session = createGoalSession();
		session.state = makeState();
		session.state.status = "blocked"; // 非 active
		const before = session.state.tokensUsed;
		applyEvent(session, "message_end", {
			message: {
				role: "assistant",
				usage: { input: 100, output: 50, cacheRead: 20 },
			},
		}, makeFakePorts());
		// 回归修复：blocked 状态不累加 token（原 bug：缺 isActiveStatus 守卫）
		expect(session.state.tokensUsed).toBe(before);
	});

	it("turn_end → currentTurnIndex++ + updateWidget effect", () => {
		const session = createGoalSession();
		session.state = makeState();
		const before = session.state.currentTurnIndex;
		const effects = applyEvent(session, "turn_end", {}, makeFakePorts());
		expect(session.state.currentTurnIndex).toBe(before + 1);
		expect(effects).toContainEqual({ kind: "updateWidget" });
	});

	it("agent_start → 无副作用（task 已移除）", () => {
		const session = createGoalSession();
		session.state = makeState();
		const effects = applyEvent(session, "agent_start", {}, makeFakePorts());
		expect(effects).toEqual([]);
	});

	it("session.state=null → 返回空 effects", () => {
		const session = createGoalSession();
		const effects = applyEvent(session, "turn_end", {}, makeFakePorts());
		expect(effects).toEqual([]);
	});

	it("未知事件 → 返回空 effects（不报错）", () => {
		const session = createGoalSession();
		session.state = makeState();
		const effects = applyEvent(session, "unknown_event", {}, makeFakePorts());
		expect(effects).toEqual([]);
	});
});

// ── persistAndUpdate — #5 budget 终态检查（事件路径单一检查点，NFR F2）──

describe("persistAndUpdate — #5 budget 终态检查（事件路径单一检查点）", () => {
	it("active + token 超额（steering 已发）→ status 转 budget_limited + 写 history", () => {
		const session = createGoalSession();
		session.state = {
			...makeState(),
			status: "active",
			timeStartedAt: 0, // 关闭时间累计，保证 tick 不额外累加
			budget: { tokenBudget: 1000 },
			tokensUsed: 1000, // >= tokenBudget
			budgetLimitSteeringSent: true, // token terminal 要求 steering 已发
		};
		const ports = makeFakePorts();
		const stale = persistAndUpdate(session, ports);

		expect(stale).toBe(false);
		expect(session.state!.status).toBe("budget_limited");
		expect(ports.history.length).toBe(1); // FR-8.7: 终态写 history
		expect((ports.history[0] as { status: string }).status).toBe("budget_limited");
	});

	it("token 终态分支不重复 appendState（finalizeAndPersist 已含持久化）", () => {
		const session = createGoalSession();
		session.state = {
			...makeState(),
			status: "active",
			timeStartedAt: 0,
			budget: { tokenBudget: 1000 },
			tokensUsed: 1000,
			budgetLimitSteeringSent: true,
		};
		const ports = makeFakePorts();
		persistAndUpdate(session, ports);
		// 仅 finalizeAndPersist 内部 1 次 appendState，不再走正常 appendState
		expect(ports.states.length).toBe(1);
	});

	it("active + time 超额 → status 转 time_limited + 写 history", () => {
		const session = createGoalSession();
		session.state = {
			...makeState(),
			status: "active",
			timeStartedAt: 0,
			budget: { timeBudgetMinutes: 10 },
			timeUsedSeconds: 600, // >= 10*60
		};
		const ports = makeFakePorts();
		persistAndUpdate(session, ports);

		expect(session.state!.status).toBe("time_limited");
		expect(ports.history.length).toBe(1);
		expect((ports.history[0] as { status: string }).status).toBe("time_limited");
	});

	it("非 active（blocked）→ 不触发 budget 检查，保持 blocked", () => {
		const session = createGoalSession();
		session.state = {
			...makeState(),
			status: "blocked",
			timeStartedAt: 0,
			budget: { tokenBudget: 1000 },
			tokensUsed: 1000, // 已超额，但 blocked 不检查
			budgetLimitSteeringSent: true,
		};
		const ports = makeFakePorts();
		persistAndUpdate(session, ports);

		expect(session.state!.status).toBe("blocked"); // 未变
		expect(ports.history.length).toBe(0); // blocked 不写 history
		expect(ports.states.length).toBe(1); // 走正常 appendState 路径
	});

	it("active 但未超额 → 正常 persist（无终态、无 history）", () => {
		const session = createGoalSession();
		session.state = {
			...makeState(),
			status: "active",
			timeStartedAt: 0,
			budget: { tokenBudget: 1000 },
			tokensUsed: 100, // 未超额
		};
		const ports = makeFakePorts();
		persistAndUpdate(session, ports);

		expect(session.state!.status).toBe("active"); // 未变
		expect(ports.history.length).toBe(0);
		expect(ports.states.length).toBe(1); // 正常 appendState
	});

	it("终态处理后 checkStale 触发 → 返回 true（status 已转终态）", () => {
		const session = createGoalSession();
		session.state = {
			...makeState(),
			status: "active",
			timeStartedAt: 0,
			budget: { tokenBudget: 1000 },
			tokensUsed: 1000,
			budgetLimitSteeringSent: true,
		};
		const ports = makeFakePorts();
		const stale = persistAndUpdate(session, ports, () => true);
		expect(stale).toBe(true);
		// finalizeAndPersist 已执行，status 已转终态
		expect(session.state!.status).toBe("budget_limited");
	});
});
