/**
 * goal_control tool — execute handler RPC 分支 handler 级测试（W3 Wave __gui__ 协议）
 *
 * PR review 补测：registerGoalControlTool execute handler 中
 *   `if (ctx.mode === "rpc" && session.state)` 分支和 __gui__ 注入。
 *
 * 覆盖场景：
 * - RPC 模式 + session.state 非 null → details.__gui__ 存在（card 或 stats-line）
 * - RPC 模式 + session.state = null → 跳过路径守卫生效（前置 handler throw，验证分支不可达）
 * - TUI 模式 → __gui__ 不附加
 * - RPC 模式 + 有 budget → __gui__ 为 card 类型（progress-bar + stats-line）
 * - RPC 模式 + 无 budget → __gui__ 为 stats-line 类型
 *
 * 范式参考 ask-user/src/__tests__/index.test.ts R-1~R-7（handler 级：注册 → 捕获 → 直接调 execute）。
 * 不 mock handleCreate：走真实 createGoal 让 session.state 含完整字段（slug/objective/budget），
 * 避免 hand-rolled state 与生产路径不一致。pi/ctx 用最小 fake（对齐 index.test.ts makeFactoryFixture）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { registerGoalControlTool, type GoalControlDetails } from "../adapters/goal-control-adapter";
import { createGoalSession } from "../session";

// ── Types ─────────────────────────────────────────────

type ExecuteResult = {
	content: Array<{ type: "text"; text: string }>;
	details: GoalControlDetails;
};

interface CapturedTool {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<ExecuteResult>;
}

// ── Fake pi + ctx（最小化，对齐 index.test.ts 的 makeFactoryFixture）──

interface FakeFixture {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	notifications: Array<{ text: string; level: string }>;
}

/**
 * 构造最小 fake pi / ctx。ctx.mode 由调用方覆盖（默认 "rpc"）。
 *
 * ports.ts 的 buildPorts 读 ctx.ui.theme.fg/bold、ctx.ui.setWidget/setStatus/notify、
 * ctx.sessionManager.getEntries、ctx.getContextUsage、ctx.signal、ctx.hasUI——全部 mock。
 */
function makeFixture(mode: "rpc" | "tui" | "json" | "print" = "rpc"): FakeFixture {
	const notifications: Array<{ text: string; level: string }> = [];
	const pi = {
		registerTool: () => {},
		on: () => {},
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;

	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		signal: undefined as AbortSignal | undefined,
		cwd: "/tmp",
		getContextUsage: () => null,
		ui: {
			notify: (text: string, level: string) => {
				notifications.push({ text, level });
			},
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: { getEntries: () => [], getBranch: () => undefined },
	} as unknown as ExtensionContext;

	return { pi, ctx, notifications };
}

/** 注册 tool 并捕获其 execute handler。 */
function captureTool(pi: ExtensionAPI): CapturedTool {
	let captured: CapturedTool | undefined;
	const capturePi = {
		...pi,
		registerTool(tool: CapturedTool): void {
			captured = tool;
		},
	} as unknown as ExtensionAPI;
	registerGoalControlTool(capturePi, createGoalSession());
	if (!captured) throw new Error("registerGoalControlTool did not register a tool");
	return captured;
}

/** 调一次 create 让 session 持有带 budget 的 active state（走真实路径，state 字段完整）。 */
function createViaHandler(
	tool: CapturedTool,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: { slug: string; objective: string; tokenBudget?: number; timeBudgetMinutes?: number },
): Promise<ExecuteResult> {
	return tool.execute(
		"call-1",
		{ action: "create", successCriteria: "tests pass", ...params },
		undefined,
		undefined,
		ctx,
	);
}

// ── 测试场景 ─────────────────────────────────────────

describe("goal_control execute — RPC __gui__ 注入分支", () => {
	it("RPC + 有 state（有 budget）→ details.__gui__ 存在且为 card 类型", async () => {
		const { pi, ctx } = makeFixture("rpc");
		const tool = captureTool(pi);
		// create 后 session.state 有 tokenBudget → buildGoalGui 走 card 分支
		const result = await createViaHandler(tool, pi, ctx, {
			slug: "rpc-card",
			objective: "rpc card goal",
			tokenBudget: 10000,
		});
		expect(result.details.__gui__).toBeDefined();
		const gui = result.details.__gui__!;
		expect(gui.component.type).toBe("card");
		// card body 含 progress-bar（tokenBudget）+ stats-line
		const body = gui.component.props.body as Array<{ type: string }>;
		const types = body.map((c) => c.type);
		expect(types).toContain("progress-bar");
		expect(types).toContain("stats-line");
	});

	it("RPC + 有 state（无 budget）→ details.__gui__ 存在且为 stats-line 类型", async () => {
		const { pi, ctx } = makeFixture("rpc");
		const tool = captureTool(pi);
		// create 不传 budget → buildGoalGui 走 stats-line 分支
		const result = await createViaHandler(tool, pi, ctx, {
			slug: "rpc-stats",
			objective: "rpc stats goal",
		});
		expect(result.details.__gui__).toBeDefined();
		const gui = result.details.__gui__!;
		expect(gui.component.type).toBe("stats-line");
		// stats-line items 含 goal/status/turn/tokens
		const items = gui.component.props.items as Array<{ label: string }>;
		const labels = items.map((i) => i.label);
		expect(labels).toContain("goal");
		expect(labels).toContain("status");
	});

	it("RPC + session.state = null → 跳过路径守卫生效（前置 handler throw，分支不可达）", async () => {
		// 源码 line 380: `if (ctx.mode === "rpc" && session.state)` 的 session.state 守卫。
		// execute 路径上，create 总会 set session.state；complete/report_blocked 前置守卫
		// 要求 session.state 非 null 否则 throw——所以 session.state=null 时分支条件恒不成立。
		// 验证：全新 session（state=null）下，complete 前置守卫先 throw，不进 __gui__ 注入逻辑。
		const { pi, ctx } = makeFixture("rpc");
		let captured: CapturedTool | undefined;
		const capturePi = {
			...pi,
			registerTool(tool: CapturedTool): void {
				captured = tool;
			},
		} as unknown as ExtensionAPI;
		registerGoalControlTool(capturePi, createGoalSession());
		const tool2 = captured!;
		// complete 在 state=null 时 throw（handleComplete 前置守卫）—— 不会走到 __gui__ 分支
		await expect(
			tool2.execute(
				"id",
				{ action: "complete", evidence: "x" },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/not active/i);
	});

	it("TUI 模式 → __gui__ 不附加（即使有 state）", async () => {
		const { pi, ctx } = makeFixture("tui");
		const tool = captureTool(pi);
		const result = await createViaHandler(tool, pi, ctx, {
			slug: "tui-no-gui",
			objective: "tui goal",
			tokenBudget: 5000,
		});
		// TUI 模式不注入 __gui__
		expect(result.details.__gui__).toBeUndefined();
		// 但 content 仍正常
		expect(result.content[0]!.text).toContain("Goal created");
	});

	it("RPC + complete 动作 → __gui__ 也附加（用终态 state 渲染）", async () => {
		// 验证 __gui__ 注入不限于 create：complete 后 session.state 仍非 null（status=complete）
		const { pi, ctx } = makeFixture("rpc");
		const tool = captureTool(pi);
		// 先 create（建 active state）
		await createViaHandler(tool, pi, ctx, { slug: "comp", objective: "to complete" });
		// 再 complete —— session.state.status=complete，buildGoalGui 走 card variant=success
		const result = await tool.execute(
			"call-2",
			{ action: "complete", evidence: "tests green" },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details.__gui__).toBeDefined();
		expect(result.details.status).toBe("complete");
		const gui = result.details.__gui__!;
		// 无 budget → stats-line
		expect(gui.component.type).toBe("stats-line");
		const items = gui.component.props.items as Array<{ label: string; value: string }>;
		const statusItem = items.find((i) => i.label === "status");
		expect(statusItem!.value).toBe("complete");
	});

	it("RPC + report_blocked 动作 → __gui__ 附加，status severity danger", async () => {
		const { pi, ctx } = makeFixture("rpc");
		const tool = captureTool(pi);
		await createViaHandler(tool, pi, ctx, { slug: "blk", objective: "to block" });
		const result = await tool.execute(
			"call-3",
			{ action: "report_blocked", reason: "stuck on dependency" },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details.__gui__).toBeDefined();
		expect(result.details.status).toBe("blocked");
		// 无 budget → stats-line；blocked status severity=danger
		const gui = result.details.__gui__!;
		expect(gui.component.type).toBe("stats-line");
		const items = gui.component.props.items as Array<{ label: string; severity?: string }>;
		const statusItem = items.find((i) => i.label === "status");
		expect(statusItem!.severity).toBe("danger");
	});

	it("RPC + 有 time budget → __gui__ card 含 time progress-bar", async () => {
		const { pi, ctx } = makeFixture("rpc");
		const tool = captureTool(pi);
		const result = await createViaHandler(tool, pi, ctx, {
			slug: "time-budget",
			objective: "time boxed",
			timeBudgetMinutes: 30,
		});
		const gui = result.details.__gui__!;
		expect(gui.component.type).toBe("card");
		const body = gui.component.props.body as Array<{ type: string; props: { label?: string } }>;
		const timeBar = body.find((c) => c.type === "progress-bar" && c.props.label === "time");
		expect(timeBar).toBeDefined();
	});
});

// ── 边界：非 RPC 模式（json/print）也不注入 __gui__ ──

describe("goal_control execute — 非 RPC 模式不注入 __gui__", () => {
	it("json 模式 → __gui__ 不附加", async () => {
		const { pi, ctx } = makeFixture("json");
		const tool = captureTool(pi);
		const result = await createViaHandler(tool, pi, ctx, {
			slug: "json-mode",
			objective: "json goal",
			tokenBudget: 1000,
		});
		expect(result.details.__gui__).toBeUndefined();
	});

	it("print 模式 → __gui__ 不附加", async () => {
		const { pi, ctx } = makeFixture("print");
		const tool = captureTool(pi);
		const result = await createViaHandler(tool, pi, ctx, {
			slug: "print-mode",
			objective: "print goal",
			tokenBudget: 1000,
		});
		expect(result.details.__gui__).toBeUndefined();
	});
});
