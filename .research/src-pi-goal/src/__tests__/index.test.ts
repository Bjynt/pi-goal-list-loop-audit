/**
 * index.ts 测试 — 工厂入口 + 跨扩展 API（pi.__goalInit）
 *
 * 覆盖 T1.8 (NFR-AC-8)：__goalInit 忽略 tasks 参数（tasks 废弃，D-16/FR-4 双轨消除）。
 * 设计保证：__goalInit 签名仅 (objective, budget, ctx)，结构上无法接收 tasks。
 *
 * 用最小 fake pi + fake ctx 实例化 goalExtension 工厂，再调 pi.__goalInit。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import goalExtension from "../index";

// ── Minimal fake pi / ctx ─────────────────────────────

interface FactoryFixture {
	pi: ExtensionAPI & { __goalInit?: (...args: never[]) => unknown };
	ctx: ExtensionContext;
	states: unknown[];
	history: unknown[];
	sendUser: unknown[];
}

/** 工厂所需的最小 pi：registerCommand/registerTool/on/registerMessageRenderer + appendEntry/sendMessage/sendUserMessage */
function makeFactoryFixture(): FactoryFixture {
	const states: unknown[] = [];
	const history: unknown[] = [];
	const sendUser: unknown[] = [];
	const pi = {
		registerCommand: () => {},
		registerTool: () => {},
		on: () => {},
		registerMessageRenderer: () => {},
		appendEntry(customType: string, data?: unknown): void {
			if (customType === "goal-history") history.push(data);
			else states.push(data);
		},
		sendMessage: () => {},
		sendUserMessage(content: unknown): void {
			sendUser.push(content);
		},
	} as unknown as ExtensionAPI & { __goalInit?: (...args: never[]) => unknown };

	const ctx = {
		hasUI: true,
		signal: { aborted: false } as AbortSignal,
		getContextUsage: () => null,
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: { getEntries: () => [], getBranch: () => undefined },
	} as unknown as ExtensionContext;

	return { pi, ctx, states, history, sendUser };
}

// ── pi.__goalInit（NFR-AC-8 / T1.8）──────────────────

describe("pi.__goalInit — tasks 参数废弃（NFR-AC-8 / T1.8）", () => {
	it("工厂实例化后 __goalInit 存在且为函数", () => {
		const { pi } = makeFactoryFixture();
		goalExtension(pi);
		expect(typeof pi.__goalInit).toBe("function");
	});

	it("正常调用 → 创建 goal（返回 true + 持久化 state）", () => {
		const { pi, ctx, states } = makeFactoryFixture();
		goalExtension(pi);
		const ok = (pi.__goalInit as (o: string, b: unknown, c: ExtensionContext) => boolean)(
			"build feature X",
			undefined,
			ctx,
		);
		expect(ok).toBe(true);
		expect(states.length).toBeGreaterThanOrEqual(1); // appendState 调用
		const persisted = states[0] as { objective?: string };
		expect(persisted.objective).toBe("build feature X");
	});

	it("ctx 缺失 → 返回 false（创建失败，不 throw）", () => {
		// FR-4.2/D-16: ctx 必填
		const { pi } = makeFactoryFixture();
		goalExtension(pi);
		const init = pi.__goalInit as (o: string, b: unknown, c: unknown) => boolean;
		expect(() => init("obj", undefined, undefined)).not.toThrow();
		expect(init("obj", undefined, undefined)).toBe(false);
	});

	it("已有 active goal → 返回 false（拒绝重复创建）", () => {
		const { pi, ctx } = makeFactoryFixture();
		goalExtension(pi);
		const init = pi.__goalInit as (o: string, b: unknown, c: ExtensionContext) => boolean;
		expect(init("first goal", undefined, ctx)).toBe(true);
		// 再创建 → 已有 active，拒绝
		expect(init("second goal", undefined, ctx)).toBe(false);
	});

	it("传入 tasks（第 4 参数）→ 不 throw、不接收（结构保证：签名只取前 3 参）", () => {
		// NFR-AC-8 核心断言：tasks 废弃后，即便调用方误传 tasks 也不影响创建。
		// __goalInit 签名 (objective, budget, ctx) 不含 tasks 参数位，
		// JS 多余实参被静默忽略，TS 层签名也不暴露 tasks。
		const { pi, ctx, states } = makeFactoryFixture();
		goalExtension(pi);
		const init = pi.__goalInit as (...args: unknown[]) => boolean;
		// 误传第 4 参 tasks（模拟旧调用方残留）→ 不 throw + 创建成功 + tasks 被忽略
		const strayTasks = [{ id: 1, text: "legacy task" }];
		let ok = false;
		expect(() => {
			ok = init("obj with stray tasks", undefined, ctx, strayTasks);
		}).not.toThrow();
		expect(ok).toBe(true);
		// 创建的 state 不含 tasks 字段（tasks 被忽略）
		const persisted = states[states.length - 1] as { tasks?: unknown };
		expect(persisted.tasks).toBeUndefined();
	});
});
